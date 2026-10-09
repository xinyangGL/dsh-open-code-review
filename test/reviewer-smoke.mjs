/**
 * 独立评审 agent 模块的离线冒烟测试：不接 DSH、不起子 agent，用罐头 subagents 运行时
 * 驱动真实的 runReviewerAgent，覆盖「拿不到结果一律 fail-closed」的全部分支。
 *
 * 用法：node test/reviewer-smoke.mjs
 */
import {
  DEFAULT_REVIEWER_PERSONA,
  DEFAULT_REVIEWER_ROUNDS,
  FINDINGS_SCHEMA,
  MAX_FINDINGS,
  REVIEWER_CODES,
  REVIEWER_SEVERITIES,
  REVIEWER_TOOL_ALLOW,
  REVIEWER_VERDICTS,
  buildReviewerPrompt,
  formatFindings,
  listProviders,
  newThread,
  parseFindings,
  roundLabel,
  runReviewerAgent,
  signatureOf,
  threadExpired,
  toIssues,
} from "../lib/reviewer.js";
import { CODES } from "../lib/review.js";

const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
  if (!ok) failures += 1;
}

function text(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 罐头 subagents：只实现契约里的 4 个方法（list / getProvider / start / interrupt）。 */
function canned(options = {}) {
  const providers = Array.isArray(options.providers) ? options.providers : ["spawn"];
  const calls = { start: [], interrupt: [], dispose: 0, getProvider: [] };
  const subagents = {
    list: () => {
      if (options.listThrows) throw new Error("list boom");
      return providers.slice();
    },
    getProvider: (name) => {
      calls.getProvider.push(name);
      if (!providers.includes(name)) return null;
      return { name, agentRouteDefaults: { provider: "commandcode" } };
    },
    start: async (name, request) => {
      calls.start.push({ name, request });
      if (options.startThrows) throw new Error("start boom");
      if (options.noResult) {
        return { id: "run-noresult", dispose: async () => { calls.dispose += 1; } };
      }
      const result = typeof options.result === "function" ? options.result() : options.result ?? { stopReason: "completed", structured: { verdict: "clean", summary: "没问题", findings: [] } };
      return {
        id: options.runId ?? "run-1",
        result: options.rejectResult ? Promise.reject(result instanceof Error ? result : new Error(String(result?.reason ?? "result boom"))) : Promise.resolve(result),
        dispose: async () => {
          calls.dispose += 1;
          if (options.disposeThrows) throw new Error("dispose boom");
        },
      };
    },
    interrupt: (id, info) => {
      calls.interrupt.push({ id, info });
    },
  };
  return { subagents, calls };
}

/* ------------------------------------------------------------- 常量与提示词 */

{
  const codes = Object.values(REVIEWER_CODES);
  check(
    "结果码：三个 REVIEWER 码都在 OCR_ 命名空间里、互不重复、且被 CODES 收录",
    codes.length === 3 &&
      new Set(codes).size === 3 &&
      codes.every((code) => String(code).startsWith("OCR_REVIEWER_")) &&
      codes.every((code) => Object.values(CODES).includes(code)),
    codes.join(","),
  );
  check(
    "只读三件套：allow 只有 read/grep/glob（不含任何写工具）",
    REVIEWER_TOOL_ALLOW.length === 3 &&
      ["read", "grep", "glob"].every((name) => REVIEWER_TOOL_ALLOW.includes(name)) &&
      !["edit", "write", "bash", "pwsh", "subagent"].some((name) => REVIEWER_TOOL_ALLOW.includes(name)),
    REVIEWER_TOOL_ALLOW.join(","),
  );
  check(
    "FINDINGS_SCHEMA：顶层 required 三件套、additionalProperties=false、verdict 枚举与 REVIEWER_VERDICTS 一致",
    FINDINGS_SCHEMA.required.join(",") === "verdict,summary,findings" &&
      FINDINGS_SCHEMA.additionalProperties === false &&
      FINDINGS_SCHEMA.properties.verdict.enum.join(",") === REVIEWER_VERDICTS.join(",") &&
      FINDINGS_SCHEMA.properties.findings.items.required.includes("file") &&
      FINDINGS_SCHEMA.properties.findings.items.required.includes("message"),
    text(FINDINGS_SCHEMA.required),
  );
  check(
    "常量：默认 3 轮、严重程度四档、findings 上限 200",
    DEFAULT_REVIEWER_ROUNDS === 3 && REVIEWER_SEVERITIES.join(",") === "blocker,major,minor,nit" && MAX_FINDINGS === 200,
    [DEFAULT_REVIEWER_ROUNDS, REVIEWER_SEVERITIES.join(","), MAX_FINDINGS].join(" / "),
  );
  check(
    "listProviders：正常返回字符串数组；抛异常或没有 list() 时退化成空数组",
    listProviders(canned({ providers: ["spawn", "other"] }).subagents).join(",") === "spawn,other" &&
      listProviders(canned({ listThrows: true }).subagents).length === 0 &&
      listProviders({}).length === 0 &&
      listProviders(null).length === 0,
    "",
  );

  const plan1 = {
    cwd: "C:/work/repo",
    scope: "workspace",
    reviewableFiles: [{ path: "lib/a.js" }, { path: "lib/b.js" }],
    excludedFiles: ["vendor/x.js"],
  };
  const prompt1 = buildReviewerPrompt({ plan: plan1, spec: "## 规则(a) 必须处理错误", round: 1, rounds: 3 });
  check(
    "提示词第 1 轮：身份 + 第 N/M 轮 + 仓库/模式/文件清单/已排除文件 + 规格正文 + 输出约定",
    prompt1.includes("独立评审 agent（第 1/3 轮）") &&
      prompt1.includes("C:/work/repo") &&
      prompt1.includes("workspace（engine=agent）") &&
      prompt1.includes("可审文件 2 个：lib/a.js, lib/b.js") &&
      prompt1.includes("已排除（不要审）：vendor/x.js") &&
      prompt1.includes("必须处理错误") &&
      prompt1.includes("## 输出") &&
      prompt1.includes("verdict 与 findings 必须自洽"),
    prompt1.length + " 字符",
  );
  check(
    "提示词第 1 轮：只读与证据两条硬约束写进去了",
    prompt1.includes("你只有只读工具（read / grep / glob）：禁止修改仓库里的任何文件") && prompt1.includes("每条结论都要能定位到「文件:行」"),
    "",
  );
  check("提示词第 1 轮：不出现「上一轮」段落（没有可核对的旧 findings）", !prompt1.includes("上一轮（第 1 轮）"), "");

  const open = [
    { file: "lib/a.js", line: 12, severity: "major", message: "没有处理 reject", suggestion: "加 catch" },
    { file: "lib/b.js", severity: "nit", message: "拼写" },
  ];
  const prompt2 = buildReviewerPrompt({ plan: plan1, spec: "spec", round: 2, rounds: 3, openFindings: open });
  check(
    "提示词第 2 轮：把上一轮 findings 列出来并要求逐条核对（stillOpen / 以现码为准 / 别只信说法）",
    prompt2.includes("独立评审 agent（第 2/3 轮）") &&
      prompt2.includes("上一轮（第 1 轮）你报了 2 条") &&
      prompt2.includes("- lib/a.js:12 [major] 没有处理 reject") &&
      prompt2.includes("仍存在就带 stillOpen=true 重新报") &&
      prompt2.includes("不要只相信它的说法"),
    "",
  );
  check(
    "提示词第 2 轮但上一轮 clean：说明这是复审、请重审（不编造旧 findings）",
    buildReviewerPrompt({ plan: plan1, spec: "s", round: 2 }).includes("上一轮没有问题结论，请重新审一遍当前代码"),
    "",
  );
  check(
    "提示词：round 超过 rounds 会被夹到上限；spec 为空时给出兜底提示",
    buildReviewerPrompt({ plan: plan1, spec: "", round: 9, rounds: 2 }).includes("独立评审 agent（第 2/2 轮）") &&
      buildReviewerPrompt({ plan: plan1, spec: "  " }).includes("(规格为空：请用 git diff / read 自己确认改动范围)"),
    "",
  );
  {
    const big = "x".repeat(500) + "TAIL_MARKER";
    const clipped = buildReviewerPrompt({ plan: plan1, spec: big, maxBytes: 100 });
    check(
      "提示词：规格超过 maxBytes 会截断并说明（丢掉尾部内容）",
      clipped.includes("规格已截断") && !clipped.includes("TAIL_MARKER"),
      clipped.length + " 字符",
    );
  }
}

/* ------------------------------------------------------------- parseFindings */

{
  const bad1 = parseFindings(undefined);
  const bad2 = parseFindings([]);
  const bad3 = parseFindings({ verdict: "lgtm", summary: "s", findings: [] });
  const bad4 = parseFindings({ verdict: "issues", summary: "s", findings: "nope" });
  check(
    "parseFindings fail-closed：非对象 / 数组 / verdict 不合法 / findings 不是数组 都 ok=false",
    bad1.ok === false && bad2.ok === false && bad3.ok === false && bad4.ok === false &&
      bad1.error.includes("没有返回结构化结果") &&
      bad3.error.includes("verdict 不合法") &&
      bad4.error.includes("findings 不是数组"),
    bad1.error + " | " + bad4.error,
  );

  const messy = parseFindings({
    verdict: "issues",
    summary: "s",
    findings: [
      { file: "a.js", line: 3, severity: "HIGH", message: "m1" },
      { file: "", message: "丢掉" },
      { file: "b.js" },
      null,
      { file: "c.js", line: "9", severity: "major", message: "m2", stillOpen: true },
    ],
  });
  check(
    "parseFindings：缺 file/message 的条目丢弃并记 notes；未知 severity 归 minor；line 支持字符串",
    messy.ok === true &&
      messy.findings.length === 2 &&
      messy.findings[0].severity === "minor" &&
      messy.findings[1].line === 9 &&
      messy.findings[1].stillOpen === true &&
      messy.notes.some((n) => n.includes("严重程度")) &&
      messy.notes.some((n) => n.includes("3 条 findings 缺少 file/message")),
    text(messy.notes),
  );
  check(
    "parseFindings：verdict=clean 却有 findings → 按 issues 处理（自相矛盾不放过）",
    parseFindings({ verdict: "clean", summary: "s", findings: [{ file: "a.js", message: "m" }] }).verdict === "issues",
    "",
  );
  check(
    "parseFindings：verdict=issues 却没有 findings → 按 uncertain 处理（不算通过）",
    parseFindings({ verdict: "issues", summary: "s", findings: [] }).verdict === "uncertain",
    "",
  );
  check(
    "parseFindings：findings 缺字段当空数组（clean 仍 clean）；message 截断到 2000",
    parseFindings({ verdict: "clean", summary: "s" }).verdict === "clean" &&
      parseFindings({ verdict: "issues", summary: "s", findings: [{ file: "a.js", message: "x".repeat(3000) }] }).findings[0].message.length === 2000,
    "",
  );
  {
    const many = Array.from({ length: MAX_FINDINGS + 3 }, (_v, i) => ({ file: "f" + i + ".js", message: "m" }));
    const parsed = parseFindings({ verdict: "issues", summary: "s", findings: many });
    check(
      "parseFindings：超过 MAX_FINDINGS 的条目被截掉并记 notes",
      parsed.findings.length === MAX_FINDINGS && parsed.notes.some((n) => n.includes("超过上限")),
      parsed.findings.length + " 条",
    );
  }
}

/* ------------------------------------------------------------ toIssues / 格式化 / 线程 */

{
  const sorted = toIssues([
    { file: "b.js", line: 2, severity: "nit", message: "n1" },
    { file: "b.js", line: 1, severity: "blocker", message: "b1" },
    { file: "a.js", line: 9, severity: "blocker", message: "b2" },
    { file: "a.js", line: 9, severity: "major", message: "m1" },
  ]);
  check(
    "toIssues：按 severity → file → line 排序，且只留 {file,line,severity,message} 四个键",
    sorted.map((i) => i.severity + "@" + i.file + ":" + i.line).join(" ") === "blocker@a.js:9 blocker@b.js:1 major@a.js:9 nit@b.js:2" &&
      Object.keys(sorted[0]).join(",") === "file,line,severity,message",
    sorted.map((i) => i.severity + "@" + i.file + ":" + i.line).join(" "),
  );

  const line1 = formatFindings([{ file: "a.js", line: 3, severity: "major", message: "没处理 reject", stillOpen: true, suggestion: "加 catch" }]);
  check(
    "formatFindings：一行一条、带 stillOpen 标记与 suggestion",
    line1 === "- a.js:3 [major] 没处理 reject（上一轮就报过） → 加 catch",
    line1,
  );
  check(
    "formatFindings：超过 40 条时补一行「其余 N 条」",
    formatFindings(Array.from({ length: 45 }, (_v, i) => ({ file: "f" + i, message: "m" }))).includes("其余 5 条见结果数据"),
    "",
  );

  check(
    "signatureOf：path:insertions:deletions 用 | 拼接（与宿主侧签名同格式）",
    signatureOf([{ path: "a.js", insertions: 3, deletions: 1 }, { path: "b.js" }]) === "a.js:3:1|b.js:0:0",
    signatureOf([{ path: "a.js", insertions: 3, deletions: 1 }, { path: "b.js" }]),
  );

  const thread = newThread({ rounds: 4, signature: "sig", files: [{ path: "a.js" }, { path: "" }, {}], now: 1000 });
  check(
    "newThread：round 从 1 起、rounds 生效、files 只留非空路径、带 uuid 与时间戳",
    thread.round === 1 &&
      thread.rounds === 4 &&
      thread.files.join(",") === "a.js" &&
      thread.open.length === 0 &&
      thread.failures === 0 &&
      thread.startedAt === 1000 &&
      thread.lastAt === 1000 &&
      typeof thread.id === "string" &&
      thread.id.length > 10,
    text({ round: thread.round, rounds: thread.rounds, files: thread.files }),
  );
  check(
    "threadExpired：idleMs<=0 永不过期；刚建/未超阈值不过期；超阈值才过期；空 thread 不过期",
    threadExpired(thread, 1000 + 99999, 0) === false &&
      threadExpired(thread, 1000, 1000) === false &&
      threadExpired(thread, 1000 + 1001, 1000) === true &&
      threadExpired(null, 1, 1) === false,
    "",
  );
  check(
    "roundLabel：第 N/M 轮（缺参数时按默认 1/3）",
    roundLabel({ round: 2, rounds: 5 }) === "第 2/5 轮" && roundLabel({}) === "第 1/3 轮",
    roundLabel({ round: 2, rounds: 5 }),
  );
}

/* ------------------------------------------------------------ runReviewerAgent */

{
  const parent = { id: "parent-agent" };
  const base = { provider: "spawn", prompt: "审一下", parent, timeoutMs: 5000 };

  const noService = await runReviewerAgent({ ...base, subagents: null });
  check(
    "没有 subagents 服务 → OCR_REVIEWER_UNAVAILABLE（不抛异常）",
    noService.ok === false && noService.code === REVIEWER_CODES.UNAVAILABLE && noService.diagnostic.includes("没有 subagents 服务"),
    noService.code + " / " + noService.diagnostic,
  );

  const wrongProvider = await runReviewerAgent({ ...base, subagents: canned({ providers: ["other"] }).subagents, provider: "spawn" });
  check(
    "provider 名不存在 → UNAVAILABLE，诊断里列出可用的 provider",
    wrongProvider.code === REVIEWER_CODES.UNAVAILABLE &&
      wrongProvider.diagnostic.includes("没有名为 spawn 的子 agent provider") &&
      wrongProvider.diagnostic.includes("other"),
    wrongProvider.diagnostic,
  );

  const noParent = await runReviewerAgent({ ...base, parent: null, subagents: canned().subagents });
  check(
    "拿不到父 agent → UNAVAILABLE（不会用别的 agent 顶替）",
    noParent.code === REVIEWER_CODES.UNAVAILABLE && noParent.diagnostic.includes("拿不到父 agent"),
    noParent.diagnostic,
  );

  const startBoom = await runReviewerAgent({ ...base, subagents: canned({ startThrows: true }).subagents });
  check(
    "subagents.start 抛异常 → UNAVAILABLE（附错误原文）",
    startBoom.code === REVIEWER_CODES.UNAVAILABLE && startBoom.diagnostic.includes("起子 agent 失败") && startBoom.diagnostic.includes("start boom"),
    startBoom.diagnostic,
  );

  const noResultRun = canned({ noResult: true });
  const noResult = await runReviewerAgent({ ...base, subagents: noResultRun.subagents });
  check(
    "start 返回没有 result 的 run → UNAVAILABLE，且那次 run 仍被 dispose",
    noResult.code === REVIEWER_CODES.UNAVAILABLE && noResult.diagnostic.includes("缺少 result") && noResultRun.calls.dispose === 1,
    noResult.diagnostic + " dispose=" + noResultRun.calls.dispose,
  );

  const happy = canned();
  const happyRun = await runReviewerAgent({ ...base, subagents: happy.subagents, label: "ocr 评审（第 2/3 轮）", model: "deepseek/deepseek-v4.1-flash", persona: "自定义人格" });
  const req = happy.calls.start[0].request;
  check(
    "start 的请求契约：provider / label / prompt 文本块 / parent / outputSchema / persona / 只读 toolFilter",
    happy.calls.start.length === 1 &&
      happy.calls.start[0].name === "spawn" &&
      req.label === "ocr 评审（第 2/3 轮）" &&
      Array.isArray(req.prompt) &&
      req.prompt[0].type === "text" &&
      req.prompt[0].text === "审一下" &&
      req.parent === parent &&
      req.outputSchema === FINDINGS_SCHEMA &&
      req.persona === "自定义人格" &&
      req.toolFilter.allow.join(",") === "read,grep,glob",
    text({ label: req.label, persona: req.persona, allow: req.toolFilter.allow }),
  );
  check(
    "start 的 agentOptions：给了 model 才带 model，并取 provider.agentRouteDefaults.provider",
    Boolean(req.agentOptions) && req.agentOptions.model === "deepseek/deepseek-v4.1-flash" && req.agentOptions.provider === "commandcode",
    text(req.agentOptions),
  );
  check(
    "happy path：completed + 合法 structured → ok=true、verdict/findings/runId 透传、dispose 恰好一次",
    happyRun.ok === true &&
      happyRun.code === "" &&
      happyRun.verdict === "clean" &&
      happyRun.runId === "run-1" &&
      happyRun.stopReason === "completed" &&
      happyRun.findings.length === 0 &&
      happy.calls.dispose === 1,
    text({ ok: happyRun.ok, verdict: happyRun.verdict, dispose: happy.calls.dispose }),
  );

  const noModel = canned();
  await runReviewerAgent({ ...base, subagents: noModel.subagents, model: "" });
  check(
    "不给 model 时 agentOptions 是 undefined（跟随 provider 默认路由）；persona 空则用内置人格",
    noModel.calls.start[0].request.agentOptions === undefined && noModel.calls.start[0].request.persona === DEFAULT_REVIEWER_PERSONA,
    "",
  );

  const issuesCanned = canned({
    result: {
      stopReason: "completed",
      structured: {
        verdict: "issues",
        summary: "有 2 条",
        findings: [
          { file: "a.js", line: 1, severity: "major", message: "m1" },
          { file: "a.js", line: 2, severity: "minor", message: "m2", suggestion: "s" },
        ],
      },
    },
  });
  const issuesRes = await runReviewerAgent({ ...base, subagents: issuesCanned.subagents });
  check(
    "issues 结论：findings 逐条规范化（severity/line/suggestion 保留）",
    issuesRes.ok === true && issuesRes.verdict === "issues" && issuesRes.findings.length === 2 && issuesRes.findings[1].suggestion === "s",
    text(issuesRes.findings),
  );

  const missingStructured = canned({ result: { stopReason: "completed" } });
  const missingRes = await runReviewerAgent({ ...base, subagents: missingStructured.subagents });
  check(
    "completed 但 structured 缺失 → FAILED，notes 写明 fail-closed，run 被 dispose",
    missingRes.ok === false &&
      missingRes.code === REVIEWER_CODES.FAILED &&
      missingRes.notes.some((n) => n.includes("fail-closed：不当作通过")) &&
      missingStructured.calls.dispose === 1,
    missingRes.notes.join(" / "),
  );

  const stringStructured = canned({ result: { stopReason: "completed", structured: "not-object" } });
  const stringRes = await runReviewerAgent({ ...base, subagents: stringStructured.subagents });
  check(
    "structured 不是对象（字符串）→ FAILED（fail-closed）",
    stringRes.code === REVIEWER_CODES.FAILED && stringRes.notes.some((n) => n.includes("fail-closed")),
    stringRes.notes.join(" / "),
  );

  const refused = canned({ result: { stopReason: "refusal", diagnostic: "不干" } });
  const refusedRes = await runReviewerAgent({ ...base, subagents: refused.subagents });
  check(
    "stopReason=refusal → FAILED（绝不当作通过）",
    refusedRes.ok === false && refusedRes.code === REVIEWER_CODES.FAILED && refusedRes.stopReason === "refusal" && refusedRes.notes.some((n) => n.includes("结束理由不是 completed")),
    refusedRes.notes.join(" / "),
  );

  const errored = await runReviewerAgent({ ...base, subagents: canned({ result: { stopReason: "error" } }).subagents });
  const noReason = await runReviewerAgent({ ...base, subagents: canned({ result: {} }).subagents });
  check(
    "stopReason=error → FAILED；stopReason 缺失时按 error 兜底",
    errored.code === REVIEWER_CODES.FAILED && noReason.code === REVIEWER_CODES.FAILED && noReason.stopReason === "error",
    errored.code + " / " + noReason.stopReason,
  );

  const abortCtl = new AbortController();
  abortCtl.abort();
  const abortedRes = await runReviewerAgent({ ...base, subagents: canned({ result: { stopReason: "aborted" } }).subagents, signal: abortCtl.signal });
  check(
    "stopReason=aborted 且调用方 signal 已中止 → OCR_ABORTED（区别于普通失败）",
    abortedRes.ok === false && abortedRes.code === CODES.ABORTED && abortedRes.notes.some((n) => n.includes("被取消")),
    abortedRes.code,
  );

  const hang = canned({ result: new Promise(() => {}) });
  const timedOut = await runReviewerAgent({ ...base, subagents: hang.subagents, timeoutMs: 30 });
  check(
    "超时 → OCR_TIMEOUT，interrupt(id, {kind:ancestor,agent:parent}) 掐子会话 + dispose 一次",
    timedOut.ok === false &&
      timedOut.code === CODES.TIMEOUT &&
      timedOut.runId === "run-1" &&
      hang.calls.interrupt.length === 1 &&
      hang.calls.interrupt[0].id === "run-1" &&
      hang.calls.interrupt[0].info.kind === "ancestor" &&
      hang.calls.interrupt[0].info.agent === parent &&
      hang.calls.dispose === 1,
    text({ code: timedOut.code, interrupt: hang.calls.interrupt.map((c) => c.id + "/" + c.info.kind) }),
  );
  /* 一次性子 agent 只有 start 的 signal 真能取消（interrupt 对非 resident 静默 return）。
     评审 agent 默认 timeoutMs 很大，写代码/工具调用卡住时过去只能干等。 */
  check(
    "超时真的掐掉 start 的 signal（否则子会话还在跑，dispose 会一直等 result）",
    hang.calls.start.length === 1 && hang.calls.start[0].request.signal instanceof AbortSignal && hang.calls.start[0].request.signal.aborted === true,
    text({ started: hang.calls.start.length, abortedAtStart: hang.calls.start[0]?.request.signal?.aborted, startSignal: String(hang.calls.start[0]?.request.signal) }),
  );

  const outer = canned({ result: new Promise(() => {}) });
  const outerCtl = new AbortController();
  const outerRun = runReviewerAgent({ ...base, subagents: outer.subagents, timeoutMs: 60000, signal: outerCtl.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  outerCtl.abort();
  await outerRun;
  check(
    "调用方 signal 中止 → 传到子 agent 的 start signal 也中止（插件卸载/停止按钮能真取消）",
    outer.calls.start.length === 1 && outer.calls.start[0].request.signal.aborted === true,
    text({ aborted: outer.calls.start[0]?.request.signal?.aborted }),
  );

  const disposeBoom = canned({ disposeThrows: true });
  const disposeRes = await runReviewerAgent({ ...base, subagents: disposeBoom.subagents });
  check(
    "dispose 抛异常不影响评审结论（只是收尾失败），且仍被调用一次",
    disposeRes.ok === true && disposeBoom.calls.dispose === 1,
    "",
  );

  const rejectCanned = canned({ rejectResult: true, result: new Error("result boom") });
  const rejectRes = await runReviewerAgent({ ...base, subagents: rejectCanned.subagents });
  check(
    "等待结果时被拒 → FAILED（附原因），run 仍被 dispose",
    rejectRes.ok === false && rejectRes.code === REVIEWER_CODES.FAILED && rejectRes.notes.some((n) => n.includes("result boom")) && rejectCanned.calls.dispose === 1,
    rejectRes.notes.join(" / "),
  );
}

/* ------------------------------------------------------------------ 摘要 */

console.log("=== 独立评审 agent 模块（test/reviewer-smoke.mjs）===");
for (const line of results) console.log(line);
console.log("");
console.log(failures === 0 ? "全部通过（共 " + results.length + " 项）" : failures + " 项失败（共 " + results.length + " 项）");
process.exit(failures === 0 ? 0 : 1);