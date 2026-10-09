/**
 * dsh-open-code-review —— 把阿里 OpenCodeReview（ocr）接进 DeepSeek Harness。
 *
 * 三条入口：
 *  1) 工具 ocr_review / ocr_status：模型可主动调用（也可由用户让模型调用）；
 *  2) 命令 /ocr-review：用户在输入框直接拉起评审；
 *  3) 自动：本回合有文件写入且回合即将结束时，自动跑一次评审并把结果注入/开新回合。
 *
 * 引擎三种模式：
 *  - ocr：跑 OCR 自己的"确定性工程 × LLM Agent"流水线（需要 provider/model/key）；
 *  - delegate：不调 LLM，用 `ocr delegate preview|rule` 拿到 OCR 解析出的规则+文件，拼成审查规格交给当前模型。
 *  engine=auto 时先试 ocr，遇到“未配置 LLM 端点”自动降级 delegate。
 *  - agent（opt-in，reviewer.agent=spawn）：规格仍来自 ocr（delegate preview + rule + diff），
 *    但「审查」由一个独立的只读子 agent（ctx.subagents，自己的会话/人格/上下文）执行，
 *    产出结构化 findings；自动档会把它回传编码 agent，并在编码 agent 改完后开下一轮，直到干净或到轮次上限。
 *
 * 配置（三条入口共用一份）：
 *  - 设置页：本模块导出 schemastery `Config`，DSH 把 schema 里 volatile 的字段投影成
 *    "设置 → 插件"里本插件的表单，编辑后写进 profile 的 patch 并广播 loader/volatile-update → 立即生效，无需重启；
 *  - <插件目录>/config.json：可选文件层（mtime 热读），用于设置页未覆盖的键（extraArgs / env / 字面密钥 / autoEngine …）；
 *  - 密钥默认不落配置文件：按 llmApiKeyRef 从 DSH 凭据库（或同名环境变量）解析。
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startLlmBridge } from "./bridge.js";
import {
  CONFIG_PATH,
  DEFAULTS,
  PLUGIN_DIR,
  SCHEMA_AVAILABLE,
  Config as ConfigSchema,
  endpointDisplay,
  loadConfig,
  schemaOverrides,
  timeoutMsOf,
} from "./config.js";
import { buildEnv, gitDiff, resolveOcr, runCommand } from "./ocr-cli.js";
import {
  CODES,
  buildDelegateArgvs,
  buildDelegateSpec,
  buildOcrArgv,
  configHintText,
  extractFiles,
  extractIssuesDetailed,
  hasFileCollection,
  hasIssueCollection,
  looksLikeMissingLlm,
  normalizeTarget,
  num,
  parseJsonLoose,
  valueToText,
} from "./review.js";
import { REVIEW_JOB_KIND, hasJobs, humanMs, noJob, oneLine, startJob } from "./job.js";
import {
  DEFAULT_REVIEWER_ROUNDS,
  REVIEWER_CODES,
  buildReviewerPrompt,
  formatFindings,
  listProviders,
  newThread,
  roundLabel,
  runReviewerAgent,
  signatureOf,
  threadExpired,
  toIssues,
} from "./reviewer.js";

export const name = "dsh-open-code-review";
export const inject = ["tools", "commands", "subprocess", "credentials"];
/** 插件配置 schema：Host 把 meta.volatile 节点投影成设置页表单（缺 schemastery 时为 undefined）。 */
export const Config = ConfigSchema;
/** schemastery 是否可用（false = 没有设置页，其余功能照旧）。 */
export { SCHEMA_AVAILABLE };

const RAW_JSON_LIMIT = 100000;
const MAX_ISSUES = 200;
/** 自动评审的瞬时失败重试次数（同一批改动），超了就等下一次写入。 */
const AUTO_RETRY_LIMIT = 2;
const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "multiedit",
  "multi_edit",
  "notebook_edit",
  "apply_patch",
  "create_file",
  "str_replace_editor",
]);

function msgOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------- 生命周期：在飞评审的 abort 与等待 */

/** apply() 注册的生命周期信号；插件卸载（dispose）时 abort，用来终结在飞的 ocr 子进程。 */
let lifecycleAbort = null;
/** 在飞评审（工具调用 + 自动评审）：dispose 时等它们收尾，避免留下孤儿进程。 */
const inflightRuns = new Set();

/** 记录一次在飞评审，返回同一个 promise（成功/失败都会自动出列）。 */
function trackRun(promise) {
  const run = Promise.resolve(promise);
  inflightRuns.add(run);
  const drop = () => inflightRuns.delete(run);
  run.then(drop, drop);
  return run;
}

/** 把调用方的 signal 与插件生命周期信号合起来：任一 abort，子进程就收工。 */
function linkSignal(signal) {
  const life = lifecycleAbort ? lifecycleAbort.signal : null;
  if (!life) return signal;
  if (!signal) return life;
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return AbortSignal.any([life, signal]);
  }
  // 手写回退分支：只在宿主没有 AbortSignal.any 时才会走到（DSH 的 Node ≥ 20.3 都有，真机是 Node 24）。
  // 监听器只在 abort 时摘除，正常完成的 run 会把这个小监听器留到插件卸载——数量等于本次装载的评审次数、
  // 回调只有几行，评估为可接受的量级；换成 any 路径则完全不建监听器。
  const merged = new AbortController();
  const onAbort = () => {
    life.removeEventListener("abort", onAbort);
    signal.removeEventListener("abort", onAbort);
    merged.abort();
  };
  if (life.aborted || signal.aborted) {
    merged.abort();
    return merged.signal;
  }
  life.addEventListener("abort", onAbort, { once: true });
  signal.addEventListener("abort", onAbort, { once: true });
  return merged.signal;
}

/** 统一的失败出口：ok=false + 稳定结果码 + 人读摘要（可附加备注与修复指引）。 */
function failResult(out, code, summary, extra = {}) {
  out.ok = false;
  out.code = code;
  out.summary = summary;
  if (Array.isArray(extra.notes)) out.notes.push(...extra.notes);
  if (extra.hint) out.configHint = extra.hint;
  return out;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** 自造一条 user 消息（等价 @deepseek-ai/dsh-llm 的 createUserMessage，避免插件侧引入包依赖）。 */
function makeUserMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
}

function cwdOf(source) {
  try {
    const cwd = source?.session?.header?.cwd ?? source?.agent?.session?.header?.cwd;
    if (typeof cwd === "string" && cwd !== "") return cwd;
  } catch {
    /* 忽略 */
  }
  return process.cwd();
}

function isSubagent(agent) {
  try {
    const header = agent?.session?.header;
    if (!header) return false;
    if (header.origin === "subagent") return true;
    return typeof header.delegationDepth === "number" && header.delegationDepth > 0;
  } catch {
    return false;
  }
}

/**
 * 解析本次评审要用的 API Key：
 *  1) config.json 里的字面密钥 llm.apiKey（显式覆盖）；
 *  2) DSH 凭据库里 llm.apiKeyRef 指向的引用（设置页的凭据选择器写的就是这个名字）；
 *  3) 同名环境变量。
 * 返回 {key, source}；key 为空表示没解析到（engine=auto 会因此降级 delegate）。
 */
async function resolveLlmKey(ctx, cfg, signal) {
  const literal = typeof cfg?.llm?.apiKey === "string" ? cfg.llm.apiKey.trim() : "";
  if (literal) return { key: literal, source: "config.json 的 llm.apiKey（字面密钥）" };
  const ref = typeof cfg?.llm?.apiKeyRef === "string" ? cfg.llm.apiKeyRef.trim() : "";
  if (!ref) return { key: "", source: "未指定凭据引用（llmApiKeyRef 为空）" };
  let failure = "";
  const creds = ctx?.credentials;
  if (creds && typeof creds.resolve === "function") {
    try {
      const found = await creds.resolve(ref, signal);
      const value = typeof found === "string" ? found : found?.value;
      if (value) return { key: String(value), source: `DSH 凭据 ${ref}（来源：${found?.source ?? "已配置"}）` };
    } catch (err) {
      failure = msgOf(err);
    }
  }
  const fromEnv = process.env?.[ref];
  if (fromEnv) return { key: String(fromEnv), source: `环境变量 ${ref}` };
  return { key: "", source: `凭据 ${ref} 未配置${failure ? `（DSH 凭据解析失败：${failure}）` : ""}` };
}

function mkResult(plan) {
  return {
    ok: false,
    code: "",
    engine: plan?.engine ?? "auto",
    scope: plan?.scope ?? "workspace",
    repository: plan?.cwd ?? "",
    command: "",
    exitCode: -1,
    durationMs: 0,
    reviewableFiles: [],
    excludedFiles: [],
    issues: [],
    summary: "",
    reviewSpec: "",
    configHint: "",
    notes: [],
    rawJson: "",
    stderr: "",
    lostOutput: false,
    spillPath: "",
    llmMissing: false,
    timedOut: false,
    aborted: false,
  };
}

function excludedNames(parsed) {
  const list = Array.isArray(parsed?.excluded_files) ? parsed.excluded_files : [];
  return list
    .map((item) => (typeof item === "string" ? item : typeof item?.path === "string" ? item.path : ""))
    .filter(Boolean);
}

/* ----------------------------------------------------- 评审进度（可选：jobs） */

/**
 * jobs 服务（可选）：apply 里用 ctx.inject(["jobs"]) 绑定。
 * 不写进 export inject —— cordis 的注入是全有全无，把 "jobs" 写进去会让
 * 「宿主没装 job controller」升级成「插件永远 inactive、工具全没了」。
 */
let jobsRuntime = null;

/** 进度开关：设置页的「评审进度」+ 服务可用性。 */
function jobsReady(cfg) {
  return cfg?.progress !== false && hasJobs(jobsRuntime);
}

/** 评审范围的中文短语（进度文案与 job 标题共用）。 */
function scopePhrase(plan) {
  const scope = String(plan?.scope || "workspace");
  if (scope === "range") return `提交区间 ${String(plan.from || "HEAD")}${plan.to ? `..${plan.to}` : ""}`;
  if (scope === "commit") return `提交 ${String(plan.commit || "HEAD").slice(0, 12)}`;
  if (scope === "scan") return "整文件扫描";
  return "工作区改动";
}

/** 目录名（job 标题里标出是哪个仓库；不为了这一处引入 node:path）。 */
function dirName(p) {
  const text = String(p || "").replace(/[\\/]+$/, "");
  const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  return cut >= 0 ? text.slice(cut + 1) : text;
}

/** 合并两个中止信号（评审自己的 + job 被 kill 的）。 */
function withAbort(signal, extra) {
  const list = [signal, extra].filter((item) => item && typeof item === "object" && typeof item.aborted === "boolean");
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  try {
    return AbortSignal.any(list);
  } catch {
    return list[0];
  }
}

/**
 * 开一次「看得见」的评审：登记 job，并把 Jobs 面板的「停止」转成评审自己的 abort。
 * 返回报告器（服务不可用/被拒时是 noJob()，调用方不必分支）。
 */
function openReviewJob(cfg, { plan, agent, source = "review" }) {
  if (!jobsReady(cfg)) return noJob(hasJobs(jobsRuntime) ? "设置里关闭了评审进度" : "宿主没有 jobs 服务");
  const controller = new AbortController();
  const repo = dirName(plan?.cwd);
  const label = `${source === "auto" ? "自动评审" : "评审"} · ${scopePhrase(plan)}${repo ? ` · ${repo}` : ""}`;
  const job = startJob(jobsRuntime, {
    kind: REVIEW_JOB_KIND,
    label,
    owner: agent?.id,
    /* 面板行的截止时间跟 run 同源：plan.timeoutMs = 分钟数 + 60s 宽限（lib/review.js:118），
       这样 job 永远不会先于 run 自己的硬超时触发（旧写法读 cfg.timeoutMinutes，配了 999 分钟时
       会和 ocr 那边的 --timeout 60 完全脱节）。 */
    timeoutMs: plan?.timeoutMs ?? timeoutMsOf(cfg, plan?.timeoutMinutes),
    onCancel: (reason) => {
      try {
        controller.abort(reason ? new Error(reason) : undefined);
      } catch {
        controller.abort();
      }
    },
  });
  job.signal = controller.signal;
  if (job.live) job.phase(`${label}｜启动（引擎 ${plan?.engine || "auto"}）`);
  return job;
}

/** 评审落地：把结果收成一行写进 job 并结算。 */
function finishReviewJob(job, value) {
  if (!job || !job.live) return;
  const text = value && typeof value === "object" ? value : {};
  const failed = text.ok === false || Boolean(text.code);
  const summary = oneLine(text.summary || text.code || "", 160);
  const detail = failed
    ? `${text.code || "OCR_RUN_FAILED"}${summary ? `：${summary}` : ""}`
    : `${summary || "已完成"}（${humanMs(job.elapsedMs)}）`;
  job.log(`${failed ? "失败" : "完成"}：${detail}`);
  job.finish({ status: failed ? "failed" : "completed", detail });
}

/**
 * 把子进程输出接到 job 的输出环上（可选）。
 * stdout 里的最终 JSON 正文不进环：它在工具结果的 rawJson 里，几十上百 KB 会把环填满，
 * 这里只留 ocr 自己的进度/横幅行；stderr 全收。
 */
function chunkSink(job) {
  if (!job || !job.live) return null;
  let jsonStarted = false;
  let stdoutBytes = 0;
  return (text, stream) => {
    if (stream !== "stdout") {
      job.out(text, "stderr");
      return;
    }
    if (jsonStarted) return;
    const head = String(text).replace(/^[\s\uFEFF]+/, "");
    if (head.startsWith("{") || head.startsWith("[")) {
      jsonStarted = true;
      return;
    }
    if (stdoutBytes >= 64 * 1024) return;
    stdoutBytes += text.length;
    job.out(text, "stdout");
  };
}

/* ------------------------------------------------------------------ 引擎：ocr */

async function runOcrOnce(ctx, { cfg, plan, env, ocrPath, signal, job = null }) {
  const out = mkResult(plan);
  const { argv, label } = buildOcrArgv(plan, cfg);
  out.command = label;
  if (job) job.phase(`运行 ocr review（超时 ${plan.timeoutMinutes} 分钟；${label}）`);
  const run = await runCommand(ctx, {
    exe: ocrPath,
    argv,
    cwd: plan.cwd,
    env,
    signal,
    timeoutMs: plan.timeoutMs,
    onChunk: chunkSink(job),
  });
  const parsed = parseJsonLoose(run.stdout);
  const files = extractFiles(parsed);
  const issueScan = plan.preview
    ? { issues: [], rawCount: 0, dropped: 0, droppedSamples: [] }
    : extractIssuesDetailed(parsed);
  const issues = issueScan.issues;
  const combined = `${run.stdout}\n${run.stderr}`;
  out.llmMissing = looksLikeMissingLlm(combined);
  out.exitCode = typeof run.exitCode === "number" ? run.exitCode : -1;
  out.durationMs = run.durationMs;
  out.timedOut = run.timedOut;
  out.aborted = Boolean(run.aborted);
  // fail-closed：非 preview 时必须真的拿到可解析 JSON，且里面有问题清单字段（哪怕是空数组）；
  // 否则一律不当作「未发现问题」——宁可说「无法确认」。
  // 另外两种「有字段但读不出内容」的形状也不能算通过：
  //   ① 空 JSON（既没有 issues 也没有 files）——之前 files.length === 0 会放行，现在要求真有文件清单字段；
  //   ② 清单里有条目、却一条都解析不出来（ocr 换了条目字段名）——这是评审工具最危险的失败方向。
  const shapeKnown = hasIssueCollection(parsed) || (files.length === 0 && hasFileCollection(parsed));
  const unreadableIssues = issueScan.rawCount > 0 && issueScan.issues.length === 0;
  out.ok = run.exitCode === 0 && !run.aborted && !unreadableIssues && (plan.preview || (parsed !== null && shapeKnown));
  out.reviewableFiles = files;
  out.excludedFiles = excludedNames(parsed);
  out.issues = issues.slice(0, MAX_ISSUES);
  out.rawJson = run.stdout ? run.stdout.slice(0, RAW_JSON_LIMIT) : "";
  out.stderr = run.stderr ? run.stderr.slice(0, 4000) : "";
  out.lostOutput = Boolean(run.lostOutput);
  out.spillPath = run.spillPath ?? "";
  if (run.error) out.notes.push(`子进程异常：${run.error}`);
  if (run.timedOut) out.notes.push(`超过 ${plan.timeoutMinutes} 分钟被终止。`);
  if (run.aborted) out.notes.push("评审被取消（工具调用中断或插件卸载）。");
  if (issueScan.dropped > 0) {
    out.notes.push(`问题清单里有 ${issueScan.dropped} 条无法解析（${issueScan.droppedSamples.join("；")}）。`);
  }

  if (/not a git repository/i.test(combined)) {
    failResult(out, CODES.NOT_GIT_REPO, `不是 git 仓库，无法计算改动范围：${plan.cwd}`, {
      hint: "把 repo 指向一个 git 仓库，或改在 git 仓库目录下的会话里调用；ocr 依赖 git 判断改动范围。",
    });
  } else if (plan.preview) {
    out.summary = `preview：将审查 ${files.length} 个文件（排除 ${num(parsed?.excluded_count, 0)} 个，+${num(parsed?.total_insertions, 0)} -${num(parsed?.total_deletions, 0)}）；未调用 LLM。`;
  } else if (out.ok && issues.length > 0) {
    out.summary = `OCR 评审完成：${files.length} 个文件，发现 ${issues.length} 条问题。`;
  } else if (out.ok) {
    out.summary = `OCR 评审完成：${files.length} 个文件，未发现问题（返回的 JSON 带问题清单字段且为空）。`;
  } else if (unreadableIssues) {
    failResult(
      out,
      CODES.OUTPUT_SHAPE_UNKNOWN,
      `ocr 退出码 0，但问题清单里的 ${issueScan.rawCount} 条一条都没能解析：无法确认「未发现问题」是真的（fail-closed，不当作通过）。`,
      {
        notes: [
          `条目样例：${issueScan.droppedSamples.join("；") || "（无法描述）"}`,
          "多半是 ocr 换了条目字段名：把它们加进 lib/review.js 的 extractIssuesDetailed 的字段名猜测表即可。",
        ],
      },
    );
  } else if (out.llmMissing) {
    failResult(out, CODES.LLM_MISSING, "OCR 未配置 LLM 端点，评审没有执行。", { hint: configHintText() });
  } else if (run.timedOut) {
    failResult(out, CODES.TIMEOUT, `OCR 评审超时（>${plan.timeoutMinutes} 分钟）被终止。`);
  } else if (run.aborted) {
    failResult(out, CODES.ABORTED, "OCR 评审被取消（工具调用中断或插件卸载），没有评审结果。");
  } else if (parsed === null && run.exitCode === 0) {
    failResult(
      out,
      CODES.OUTPUT_UNPARSABLE,
      "ocr 退出码 0，但输出不是可解析的 JSON：无法确认评审真的跑过（fail-closed，不当作通过）。原始输出见 rawJson。",
      {
        notes: [
          run.stdout.trim() === "" ? "标准输出是空的（可能确实没有改动，也可能输出丢了）。" : "标准输出不是 JSON。",
          "可手工跑 `ocr review --format json` 确认输出形态，或改用 engine=delegate（不依赖 LLM 端点）。",
        ],
      },
    );
  } else if (run.exitCode === 0 && parsed !== null) {
    failResult(
      out,
      CODES.OUTPUT_SHAPE_UNKNOWN,
      `ocr 退出码 0，但返回的 JSON 里没有可识别的问题清单字段（文件清单 ${files.length} 个）：无法确认「未发现问题」是真的（fail-closed）。请复核 rawJson。`,
      { notes: ["若 ocr 换了输出字段名，把新字段名加进 lib/review.js 的 ISSUE_KEYS / FILE_KEYS 即可。"] },
    );
  } else {
    failResult(out, CODES.RUN_FAILED, `OCR 评审失败（exit=${out.exitCode}）。`);
  }
  if (job && job.live) {
    job.log(`ocr 结果：exit=${out.exitCode} · ${files.length} 个文件 · ${issues.length} 条问题 · ${humanMs(run.durationMs)}${out.rawJson ? ` · rawJson ${out.rawJson.length} 字符` : ""}`);
  }
  return out;
}

/* -------------------------------------------------------------- 引擎：delegate */

async function runDelegate(ctx, { cfg, plan, env, ocrPath, signal, notes = [], job = null }) {
  const out = mkResult(plan);
  out.engine = "delegate";
  const { previewArgv, ruleArgv, label } = buildDelegateArgvs(plan, cfg);
  out.command = label;

  if (job) job.phase(`delegate：列出可审文件（preview，单步最多 3 分钟）`);
  const previewRun = await runCommand(ctx, {
    exe: ocrPath,
    argv: previewArgv,
    cwd: plan.cwd,
    env,
    signal,
    timeoutMs: 180000,
    onChunk: chunkSink(job),
  });
  out.durationMs += previewRun.durationMs;
  const previewParsed = parseJsonLoose(previewRun.stdout);
  const files = extractFiles(previewParsed);
  out.reviewableFiles = files;
  out.excludedFiles = excludedNames(previewParsed);
  out.rawJson = previewRun.stdout ? previewRun.stdout.slice(0, RAW_JSON_LIMIT) : "";

  if (previewRun.exitCode !== 0 || previewParsed === null) {
    out.ok = false;
    out.exitCode = typeof previewRun.exitCode === "number" ? previewRun.exitCode : -1;
    out.stderr = (previewRun.stderr || previewRun.stdout || "").slice(0, 4000);
    out.aborted = Boolean(previewRun.aborted);
    if (previewRun.aborted) out.notes.push("delegate preview 被取消（工具调用中断或插件卸载）。");
    if (/not a git repository/i.test(out.stderr)) {
      failResult(out, CODES.NOT_GIT_REPO, `不是 git 仓库，无法计算改动范围：${plan.cwd}`, {
        hint: "把 repo 指向一个 git 仓库，或改在 git 仓库目录下的会话里调用；ocr 依赖 git 判断改动范围。",
      });
    } else if (previewRun.aborted) {
      failResult(out, CODES.ABORTED, "delegate preview 被取消（工具调用中断或插件卸载），没有规格可交付。");
    } else if (previewRun.timedOut) {
      failResult(out, CODES.TIMEOUT, "delegate preview 超时被终止，无法获得可审文件清单（delegate 模式单步超时 3 分钟）。");
    } else {
      failResult(out, CODES.DELEGATE_PREVIEW_FAILED, `delegate preview 失败（exit=${out.exitCode}）；无法获得可审文件清单。`);
    }
    return out;
  }

  const targetFiles = plan.paths.length > 0 ? plan.paths : files.map((f) => f.path);
  if (job) job.progress(`delegate：可审 ${files.length} 个文件（排除 ${out.excludedFiles.length} 个）`);
  let rulesParsed = null;
  if (targetFiles.length > 0) {
    if (job) job.phase(`delegate：解析审查规则（${targetFiles.length} 个文件）`);
    const ruleRun = await runCommand(ctx, {
      exe: ocrPath,
      argv: ruleArgv(targetFiles),
      cwd: plan.cwd,
      env,
      signal,
      timeoutMs: 180000,
      onChunk: chunkSink(job),
    });
    out.durationMs += ruleRun.durationMs;
    rulesParsed = parseJsonLoose(ruleRun.stdout);
    if (ruleRun.exitCode !== 0 || rulesParsed === null) {
      notes.push("delegate rule 未返回可解析 JSON（fail-closed：结果会带上 OCR_DELEGATE_RULE_UNPARSABLE，规格里没有规则正文）。");
    }
  } else {
    notes.push("没有可审文件，规格里只有空清单。");
  }

  let diff = "";
  if (plan.includeDiff && plan.scope !== "scan") {
    if (job) job.progress("delegate：采集 git diff…");
    const refArgs =
      plan.scope === "range"
        ? [`${plan.from || "HEAD"}..${plan.to || "HEAD"}`]
        : plan.scope === "commit"
          ? [`${plan.commit}^!`]
          : ["HEAD"];
    const collected = await gitDiff(ctx, {
      cwd: plan.cwd,
      refArgs,
      files: plan.paths,
      env,
      signal,
      maxBytes: num(cfg.includeDiffMaxBytes, 120000) || 120000,
    });
    diff = collected.text;
    if (!collected.ok) notes.push(`git diff 不可用：${collected.note}`);
    else if (!diff.trim()) notes.push("git diff 为空（改动可能已是 HEAD 状态，或只有未跟踪文件）。");
  }

  const groups = Array.isArray(rulesParsed?.groups) ? rulesParsed.groups : [];
  out.ok = true;
  out.exitCode = 0;
  out.reviewSpec = buildDelegateSpec({
    plan,
    preview: previewParsed,
    rules: rulesParsed,
    diff,
    files,
    maxBytes: (num(cfg.includeDiffMaxBytes, 120000) || 120000) + 80000,
  });
  out.summary = `委派模式：${files.length} 个可审文件、${groups.length} 组审查规则，规格已生成（未调用 LLM，请按 reviewSpec 自行审查）。`;
  /* fail-closed：有可审文件却拿不到规则 JSON 时，规格是不完整的——明确报错，
     但仍然返回 reviewSpec（文件清单 + diff 仍能用来人工审查）。 */
  if (targetFiles.length > 0 && rulesParsed === null) {
    failResult(
      out,
      CODES.DELEGATE_RULE_UNPARSABLE,
      `委派模式的规格不完整：${files.length} 个可审文件拿到了，但 ocr delegate rule 没返回可解析的规则 JSON（fail-closed：按 OCR 规则审查需要规则正文）。reviewSpec 里只有文件清单与 diff。`,
      { notes: ["可手工跑 `ocr delegate rule` 拿规则，或检查 ocr 版本与 extraArgs。"] },
    );
  }
  if (job && job.live) {
    job.log(`delegate 规格：${files.length} 个可审文件 · ${groups.length} 组规则 · diff ${diff.length} 字符 · ${humanMs(out.durationMs)}`);
  }
  return out;
}

/* -------------------------------------------------------------- 引擎：独立评审 agent */

/**
 * 第三档引擎（opt-in）：规格仍来自 ocr —— delegate preview 的可审文件清单 + rule 的规则正文 + git diff，
 * 但「审查」这一步交给一个独立的只读子 agent（自己的会话、人格、上下文），不替写代码的人找理由。
 *
 * 返回 { out, findings }：out 是标准结果对象（engine="agent"）；findings 是原始结构化清单
 * （含 evidence/suggestion/stillOpen，下一轮 prompt 要用，因此不进工具输出 schema）。
 */
async function runReviewerReview(ctx, { cfg, plan, env, ocrPath, signal, runtime, thread, parent, timeoutMs, job = null }) {
  const out = mkResult(plan);
  out.engine = "agent";
  const reviewer = cfg && typeof cfg.reviewer === "object" && cfg.reviewer ? cfg.reviewer : {};
  const provider = String(reviewer.provider ?? "").trim() || "spawn";
  const model = String(reviewer.model ?? "").trim();
  const round = Math.max(1, num(thread?.round, 1));
  const rounds = Math.max(1, num(thread?.rounds, DEFAULT_REVIEWER_ROUNDS));
  out.reviewer = { provider, model, round, rounds, childId: "", stopReason: "", verdict: "" };

  /* 规格：复用 delegate 的 preview / rule / git diff（不调 OCR 自己的 LLM 流水线）。 */
  const spec = await runDelegate(ctx, { cfg, plan, env, ocrPath, signal, notes: [], job });
  out.durationMs += spec.durationMs;
  out.command = spec.command;
  out.reviewableFiles = spec.reviewableFiles;
  out.excludedFiles = spec.excludedFiles;
  out.rawJson = spec.rawJson;
  out.exitCode = spec.exitCode;
  for (const note of spec.notes) out.notes.push(note);
  if (!spec.ok) {
    for (const key of ["code", "summary", "stderr", "configHint", "llmMissing", "timedOut", "aborted"]) out[key] = spec[key];
    if (spec.code === CODES.DELEGATE_RULE_UNPARSABLE) {
      /* 规格不完整（没有规则正文）但文件清单与 diff 还有用：让评审 agent 凭 diff 审，别整单失败。 */
      out.ok = true;
      out.code = "";
      out.notes.push("规格里没有规则正文（ocr delegate rule 没返回 JSON）：评审 agent 只能凭文件清单与 diff 判断。");
    } else {
      out.notes.push("评审 agent 未启动：拿不到可审范围（delegate preview 失败）。");
      return { out, findings: [] };
    }
  } else {
    out.exitCode = 0;
    out.ok = true;
  }

  const prompt = buildReviewerPrompt({
    plan: { ...plan, reviewableFiles: out.reviewableFiles, excludedFiles: out.excludedFiles },
    spec: spec.reviewSpec,
    round,
    rounds,
    openFindings: Array.isArray(thread?.open) ? thread.open : [],
    maxBytes: (num(cfg.includeDiffMaxBytes, 120000) || 120000) + 80000,
    cwd: plan.cwd,
  });
  if (job) job.phase(`独立评审 agent 第 ${round}/${rounds} 轮（provider=${provider}${model ? ` · ${model}` : ""}）`);
  const run = await runReviewerAgent({
    subagents: runtime,
    provider,
    persona: String(reviewer.persona ?? ""),
    model,
    label: `ocr 评审（第 ${round}/${rounds} 轮）`,
    prompt,
    parent,
    signal,
    timeoutMs,
  });
  out.durationMs += run.durationMs;
  out.reviewer.childId = run.runId;
  out.reviewer.stopReason = run.stopReason;
  out.reviewer.verdict = run.verdict;
  out.timedOut = run.code === CODES.TIMEOUT;
  out.aborted = run.code === CODES.ABORTED;
  for (const note of run.notes) out.notes.push(note);
  if (run.diagnostic) out.notes.push(`评审 agent 诊断：${run.diagnostic}`);
  if (job && job.live) {
    job.log(`评审 agent 第 ${round}/${rounds} 轮：${run.verdict || (run.ok ? "?" : "失败")} · ${run.runId || "无子会话"} · ${humanMs(run.durationMs)}${run.summary ? ` · ${oneLine(run.summary, 120)}` : ""}`);
  }

  if (!run.ok) {
    const code = run.code || REVIEWER_CODES.FAILED;
    const head =
      code === REVIEWER_CODES.UNAVAILABLE
        ? "独立评审 agent 不可用"
        : code === REVIEWER_CODES.FAILED
          ? "独立评审 agent 没给出可用结论"
          : code === CODES.TIMEOUT
            ? "独立评审 agent 超时被中断"
            : code === CODES.ABORTED
              ? "独立评审 agent 被取消"
              : "独立评审 agent 失败";
    const details = run.diagnostic || run.notes.join("；") || run.stopReason || "未知原因";
    return {
      out: failResult(out, code, `${head}：${details}`, {
        notes:
          code === REVIEWER_CODES.UNAVAILABLE
            ? ["把 reviewerProvider 填成可用的 provider（ocr_status 的 reviewer 段会列出可用的），或把「独立评审 agent」设为 off 改用 ocr/delegate。"]
            : [],
      }),
      findings: [],
    };
  }

  const issues = toIssues(run.findings);
  out.issues = issues;
  if (run.verdict === "clean") {
    out.summary = `独立评审 agent（第 ${round}/${rounds} 轮）审了 ${out.reviewableFiles.length} 个文件，未发现问题。`;
  } else if (run.verdict === "uncertain") {
    failResult(out, REVIEWER_CODES.UNCERTAIN, `独立评审 agent 无法确认（第 ${round}/${rounds} 轮）：${run.summary || "信息不足"}`, {
      notes: ["uncertain 不算通过：补足信息（例如扩大范围、把关键上下文写进要求）后重试，或改用 ocr 引擎。"],
    });
  } else {
    out.summary = `独立评审 agent（第 ${round}/${rounds} 轮）发现 ${issues.length} 条问题${run.summary ? `：${run.summary}` : ""}`;
  }
  return { out, findings: run.findings };
}

/* ------------------------------------------------------------------ LLM 路由 */

/**
 * 当前活着的本机 LLM 桥（apply 里用 ctx.inject(["llm"]) 起）。
 * ocr 是独立子进程，进不了 cordis；桥把它接回 DSH 的 ctx.llm.stream：
 * 模型目录、provider 凭据、账号轮换、配额与重试全由 DSH 决定。
 */
let activeBridge = null;
/** 桥起不来的原因（ocr_status 会报出来）。 */
let bridgeError = "";

/**
 * 独立评审 agent 的运行时（apply 里用 ctx.inject(["subagents"]) 绑定；没装子代理插件时为 null）。
 * 可选服务不能写进 export const inject：cordis 的注入是全有全无，缺服务会把插件打成 inactive。
 */
let reviewerRuntime = null;
/** 评审 agent 用不了的原因（ocr_status 与回落说明会报出来）。 */
let reviewerError = "";

/** 一次评审 agent 运行的硬超时（与插件单次评审超时同源：plan 分钟 > 生效配置，且夹在 maxTimeoutMinutes 内）。 */
function reviewerTimeoutMs(cfg, plan = null) {
  return timeoutMsOf(cfg, plan?.timeoutMinutes);
}

/**
 * 这次 ocr 该用哪个 provider/model（与官方插件同源）：
 *  - 设置页 / config.json 里填了就用（llm.provider + llm.model）；
 *  - 缺的部分用 DSH 的默认模型 agentDefaultModel.currentSelection() —— 官方读「全局默认路由」
 *    的同一个来源（dsh-api-session-controller/lib/types/catalog.js:10），于是设置页可以留空，
 *    模型、provider、密钥、配额全跟着 DSH 走。
 * llm 与 agentDefaultModel 都是可选服务：用 ctx.get() 读，拿不到就只用插件设置（不抛注入守卫）。
 */
function effectiveLlmRoute(ctx, cfg) {
  const wantProvider = String(cfg?.llm?.provider ?? "").trim();
  const wantModel = String(cfg?.llm?.model ?? "").trim();
  if (wantProvider && wantModel) return { provider: wantProvider, model: wantModel, source: "插件设置", fallback: false };
  let def = null;
  try {
    const svc = ctx && typeof ctx.get === "function" ? ctx.get("agentDefaultModel") : null;
    if (svc && typeof svc.currentSelection === "function") def = svc.currentSelection();
  } catch (err) {
    def = null;
  }
  const defProvider = def && def.provider ? String(def.provider).trim() : "";
  const defModel = def && def.model ? String(def.model).trim() : "";
  const provider = wantProvider || defProvider;
  const model = wantModel || defModel;
  if (!provider || !model) return { provider, model, source: "", fallback: false };
  const fromSettings = Boolean(wantProvider || wantModel);
  return { provider, model, source: fromSettings ? "插件设置 + DSH 默认模型补缺" : "DSH 默认模型", fallback: true };
}

/**
 * 决定这次 ocr 子进程走哪条 LLM 路由：
 *  - dsh：ocr → 本机桥（127.0.0.1 随机端口 + 随机 token）→ ctx.llm.stream；
 *  - endpoint：ocr → llm.baseUrl 静态端点，密钥按 llm.apiKeyRef 解析（老行为）。
 * dsh 模式但桥没就绪或没有可用模型时回落 endpoint，并在 note 里说明原因（不静默）。
 */
async function resolveLlmRoute(ctx, cfg, signal) {
  const mode = String(cfg?.llm?.mode ?? "dsh") === "endpoint" ? "endpoint" : "dsh";
  const effective = effectiveLlmRoute(ctx, cfg);
  if (mode === "dsh" && activeBridge && effective.model) {
    const via = effective.source ? ` · 来自${effective.source}` : "";
    return {
      mode,
      env: buildEnv(cfg, { bridge: activeBridge, model: effective.model }),
      source: `DSH 本机桥 ${activeBridge.url}（provider=${effective.provider || "(未选)"} · model=${effective.model}${via}）`,
      key: "",
      ready: true,
      note: "",
      bridgeUrl: activeBridge.url,
      provider: effective.provider,
      model: effective.model,
      routeSource: effective.source,
    };
  }
  const llmKey = await resolveLlmKey(ctx, cfg, signal);
  let note = "";
  if (mode === "dsh") {
    note = !effective.model
      ? "路由模式是 dsh，但设置页与 DSH 默认模型都没给出可用模型名"
      : bridgeError
        ? `路由模式是 dsh，但本机桥没起起来：${bridgeError}`
        : "路由模式是 dsh，但本机桥还没就绪（宿主没有 llm 服务，或正在启动）";
  }
  return {
    mode: "endpoint",
    env: buildEnv(cfg, { apiKey: llmKey.key }),
    source: llmKey.source,
    key: llmKey.key,
    ready: false,
    note: note ? `${note} → 这次回落成静态端点。` : "",
    bridgeUrl: "",
    provider: "",
    model: "",
    routeSource: "",
  };
}

/** engine=auto 时是否该因为"LLM 没配好"降级 delegate：dsh 模式有桥就不降级。 */
function canDegradeLlm(route) {
  return route.mode === "endpoint" && !route.key;
}

/* ------------------------------------------------------------------ 工具实现 */

async function runReview(ctx, args, exec, cfgNow) {
  const cfg = cfgNow();
  const signal = linkSignal(exec?.signal);
  if (cfg.enabled === false) {
    const off = mkResult(null);
    failResult(
      off,
      CODES.DISABLED,
      "插件已在设置里关闭（enabled=false），未执行评审。请到「DSH 设置 → 插件 → dsh-open-code-review」打开开关，或把 config.json 的 enabled 改成 true。",
      { notes: ["ocr_status 不受总开关影响，仍可用于诊断。"] },
    );
    return off;
  }
  const plan = normalizeTarget(args, cfg, cwdOf(exec?.agent));
  if (plan.error) {
    const bad = mkResult(plan);
    failResult(bad, CODES.INVALID_ARGS, plan.error, { notes: ["参数不完整，未执行任何命令。"] });
    return bad;
  }

  const route = await resolveLlmRoute(ctx, cfg, signal);
  const env = route.env;
  let ocrPath = "";
  try {
    ocrPath = (await resolveOcr(ctx, cfg, signal)).path;
  } catch (err) {
    const failed = mkResult(plan);
    failResult(failed, CODES.NOT_FOUND, `无法定位 ocr 可执行文件：${msgOf(err)}`, {
      notes: [`请在设置页（设置 → 插件 → dsh-open-code-review）或 ${CONFIG_PATH} 里设置 ocrPath。`],
    });
    return failed;
  }

  /* 评审进度可见（可选）：一次调用一条 job —— GUI 的 Jobs 面板读它，会话内的进度行也从
     同一份快照派生。job 不可用时是空操作，评审路径完全不变。 */
  const job = openReviewJob(cfg, { plan, agent: exec?.agent, source: "review" });
  const runSignal = withAbort(signal, job.signal);
  const settled = (value) => {
    finishReviewJob(job, value);
    return value;
  };

  try {
    /* 第三档引擎：独立评审 agent（opt-in；args.reviewer 可显式强制开/关）。 */
    const reviewerWanted =
      plan.engine !== "delegate" &&
      !plan.preview &&
      (args?.reviewer === true || (args?.reviewer !== false && String(cfg.reviewer?.agent ?? "off") === "spawn"));
    let reviewerFallback = "";
    if (reviewerWanted) {
      if (reviewerRuntime || args?.reviewer === true) {
        /* 工具调用是一次性的：单轮（rounds=1）。多轮往返由自动评审那侧负责。 */
        const thread = { round: 1, rounds: 1, open: [] };
        const { out } = await runReviewerReview(ctx, {
          cfg,
          plan,
          env,
          ocrPath,
          signal: runSignal,
          runtime: reviewerRuntime,
          thread,
          parent: exec?.agent,
          timeoutMs: reviewerTimeoutMs(cfg, plan),
          job,
        });
        return settled(out);
      }
      reviewerFallback = `独立评审 agent 不可用（${
        reviewerError || "宿主没有 subagents 服务，或 profile 没装子代理插件"
      }）：本次回落 ocr/delegate。显式传 reviewer:true 时不会回落，而是直接报 OCR_REVIEWER_UNAVAILABLE。`;
    }

    if (plan.engine === "delegate") {
      const value = await runDelegate(ctx, { cfg, plan, env, ocrPath, signal: runSignal, job });
      if (reviewerFallback) value.notes.unshift(reviewerFallback);
      return settled(value);
    }
    const result = await runOcrOnce(ctx, { cfg, plan, env, ocrPath, signal: runSignal, job });
    if (plan.engine === "auto" && !result.ok && result.llmMissing && !plan.preview && canDegradeLlm(route)) {
      const notes = [
        ...(reviewerFallback ? [reviewerFallback] : []),
        `OCR 的 LLM 端点未配置：自动降级为 delegate，由当前模型按 OCR 规则审查。`,
        `可执行文件：${ocrPath}`,
        `LLM 路由：${route.source}${route.note ? `（${route.note}）` : ""}`,
        `LLM 端点：${endpointDisplay(cfg.llm.baseUrl)} · ${cfg.llm.protocol || "?"} · ${cfg.llm.model || "(未设置)"}`,
      ];
      const delegated = await runDelegate(ctx, { cfg, plan, env, ocrPath, signal: runSignal, notes, job });
      delegated.notes = [...notes, ...delegated.notes];
      delegated.configHint = configHintText();
      return settled(delegated);
    }
    result.notes.unshift(`可执行文件：${ocrPath}`, `LLM 路由：${route.source}${route.note ? `（${route.note}）` : ""}`);
    if (reviewerFallback) result.notes.unshift(reviewerFallback);
    return settled(result);
  } catch (err) {
    const failed = mkResult(plan);
    failResult(failed, CODES.RUN_FAILED, `执行失败：${msgOf(err)}`);
    finishReviewJob(job, failed);
    return failed;
  }
}

async function runStatus(ctx, args, exec, cfgNow) {
  const cfg = cfgNow();
  const signal = linkSignal(exec?.signal);
  const out = {
    ok: false,
    code: "",
    executable: "",
    version: "",
    pluginConfigPath: CONFIG_PATH,
    pluginDir: PLUGIN_DIR,
    pluginConfigPresent: Boolean(cfg.__configPresent),
    pluginConfigError: cfg.__configError ? String(cfg.__configError) : "",
    settingsPage: SCHEMA_AVAILABLE
      ? "可用：DSH 设置 → 插件 → dsh-open-code-review 里的配置表单（改完立即生效，无需重启）"
      : "不可用：缺少 @deepseek-ai/schemastery（只能用 config.json）",
    enabled: cfg.enabled !== false,
    engine: String(cfg.engine),
    auto: String(cfg.auto),
    llmMode: "",
    llmRoute: "",
    llmEndpoint: "",
    bridge: null,
    reviewer: {
      enabled: false,
      provider: "",
      model: "",
      rounds: 0,
      available: false,
      providers: [],
      ready: false,
      error: "",
    },
    credentialRef: "",
    credentialSource: "",
    ocrHomeConfig: "",
    llmEnv: [],
    llmTest: "",
    notes: [],
  };
  // 诊断工具本身不能因为上游报错就变成「工具内部错误」：每一步都降级成一条备注。
  let route;
  try {
    route = await resolveLlmRoute(ctx, cfg, signal);
  } catch (err) {
    route = {
      mode: "endpoint",
      env: {},
      source: `解析 LLM 路由失败：${msgOf(err)}`,
      note: "",
      key: "",
      provider: "",
      model: "",
      bridgeUrl: "",
      routeSource: "",
    };
    out.notes.push(`解析 LLM 路由失败：${msgOf(err)}`);
  }
  const env = route.env;
  out.llmMode = String(cfg.llm.mode ?? "dsh");
  out.llmRoute = `${route.source}${route.note ? `（${route.note}）` : ""}`;
  out.llmEndpoint =
    route.mode === "dsh"
      ? `本机桥 ${route.bridgeUrl} · openai · ${route.provider || "(未选)"}/${route.model || "(未设置)"}${route.routeSource ? `（${route.routeSource}）` : ""}`
      : `${endpointDisplay(cfg.llm.baseUrl)} · ${cfg.llm.protocol || "?"} · ${cfg.llm.model || "(未设置)"}`;
  out.credentialRef = route.mode === "dsh" ? "(dsh 模式不需要：密钥由 DSH 的 provider 配置提供)" : String(cfg.llm.apiKeyRef || "") || "(未设置)";
  out.credentialSource = route.mode === "dsh" ? "由 DSH 提供（密钥不进 ocr 子进程）" : `${route.key ? "已解析" : "未解析"}（${route.source}）`;
  try {
    out.executable = (await resolveOcr(ctx, cfg, signal)).path;
    out.ok = true;
  } catch (err) {
    out.code = CODES.NOT_FOUND;
    out.notes.push(`定位 ocr 失败：${msgOf(err)}`);
    return out;
  }
  const cwd = cwdOf(exec?.agent);
  let versionRun;
  try {
    versionRun = await runCommand(ctx, {
      exe: out.executable,
      argv: ["--version", "--color", "never"],
      cwd,
      env,
      signal,
      timeoutMs: 30000,
      stdoutMaxBytes: 65536,
      stderrMaxBytes: 65536,
    });
  } catch (err) {
    versionRun = { exitCode: -1, stdout: "", stderr: msgOf(err) };
    out.notes.push(`跑 ocr --version 失败：${msgOf(err)}`);
  }
  out.version = (versionRun.stdout || versionRun.stderr || "").trim().split(/\r?\n/)[0] ?? "";
  out.notes.push(`--version exit=${versionRun.exitCode}`);

  const homeConfig = join(homedir(), ".opencodereview", "config.json");
  try {
    const parsed = JSON.parse(readFileSync(homeConfig, "utf8"));
    const providerNames = parsed?.providers && typeof parsed.providers === "object" ? Object.keys(parsed.providers) : [];
    out.ocrHomeConfig = `${homeConfig} → provider=${parsed?.provider ?? "(未设置)"}, model=${parsed?.model ?? "(未设置)"}, 已配置凭据的 provider: ${providerNames.length > 0 ? providerNames.join("/") : "(无)"}`;
  } catch {
    out.ocrHomeConfig = `${homeConfig}（不存在或不可解析 → OCR 未做过全局配置）`;
  }

  for (const key of ["OCR_LLM_URL", "OCR_LLM_PROTOCOL", "OCR_LLM_TOKEN", "OCR_LLM_MODEL", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL"]) {
    if (env[key]) out.llmEnv.push(`${key}=${/(TOKEN|KEY)/i.test(key) ? "***" : env[key]}`);
  }

  if (args?.checkLlm !== false) {
    let test;
    try {
      test = await runCommand(ctx, {
        exe: out.executable,
        argv: ["llm", "test", "--color", "never"],
        cwd,
        env,
        signal,
        timeoutMs: 120000,
        stdoutMaxBytes: 65536,
        stderrMaxBytes: 65536,
      });
    } catch (err) {
      test = { exitCode: -1, stdout: "", stderr: msgOf(err) };
    }
    const text = (test.stdout || test.stderr || "").trim().replace(/\s+/g, " ").slice(0, 600);
    out.llmTest = test.exitCode === 0 ? `可用：${text}` : `不可用（exit=${test.exitCode}）：${text}`;
  }

  out.bridge = activeBridge ? activeBridge.describe() : null;
  if (out.llmMode !== "endpoint" && !activeBridge) {
    out.notes.push(
      `dsh 路由要用的本机 LLM 桥没有就绪：${bridgeError || "宿主没有可用的 llm 服务，或桥还在启动"}；本次已回落成静态端点。`,
    );
  }
  const reviewerCfg = cfg.reviewer && typeof cfg.reviewer === "object" ? cfg.reviewer : {};
  const reviewerOn = String(reviewerCfg.agent ?? "off") === "spawn";
  out.reviewer = {
    enabled: reviewerOn,
    provider: String(reviewerCfg.provider ?? "") || "spawn",
    model: String(reviewerCfg.model ?? ""),
    rounds: Math.max(1, num(reviewerCfg.rounds, DEFAULT_REVIEWER_ROUNDS)),
    available: Boolean(reviewerRuntime),
    providers: listProviders(reviewerRuntime),
    ready: Boolean(reviewerOn && reviewerRuntime),
    error:
      reviewerOn && !reviewerRuntime
        ? reviewerError || "宿主没有 subagents 服务（profile 里没装子代理插件）"
        : "",
  };
  if (reviewerOn && !reviewerRuntime) {
    out.notes.push(
      `独立评审 agent 已开启但不可用：${out.reviewer.error}；评审会回落 ocr/delegate（显式传 reviewer:true 才会直接报 OCR_REVIEWER_UNAVAILABLE）。`,
    );
  }
  if (route.note) out.notes.push(route.note);
  if (cfg.enabled === false) {
    out.notes.push("插件总开关为关闭：ocr_review / ocr_status / /ocr-review 与自动评审都不会生效。");
  }
  if (!cfg.__configPresent) {
    out.notes.push(`插件配置文件 ${CONFIG_PATH} 不存在，当前用「出厂默认 + 设置页」的值（该文件是可选的，用于设置页未覆盖的键）。`);
  }
  if (cfg.__configError) out.notes.push(`插件配置解析失败：${cfg.__configError}`);
  return out;
}

function statusText(value) {
  const v = value ?? {};
  const lines = [
    `OpenCodeReview 接入状态：${v.ok ? "可执行文件已就绪" : "未就绪"}${v.code ? `（code=${v.code}）` : ""}`,
    `- ocr：${v.executable || "(未找到)"}`,
    `- 版本：${v.version || "(未取到)"}`,
    `- OCR 全局配置：${v.ocrHomeConfig || "(未知)"}`,
    `- LLM 路由模式：${v.llmMode === "endpoint" ? "endpoint（直连静态端点）" : "dsh（走 DSH：本机桥 → ctx.llm.stream）"}`,
    `- LLM 实际路由：${v.llmRoute || "(未知)"}`,
    `- LLM 端点：${v.llmEndpoint || "(未知)"}`,
    `- LLM 凭据：${v.credentialRef || "(未设置)"} → ${v.credentialSource || "(未解析)"}`,
    `- LLM 相关环境变量：${Array.isArray(v.llmEnv) && v.llmEnv.length > 0 ? v.llmEnv.join(", ") : "(无)"}`,
    `- LLM 连通性：${v.llmTest || "(未测试)"}`,
    `- 设置页：${v.settingsPage || "(未知)"}`,
    `- 插件配置文件：${v.pluginConfigPath}${v.pluginConfigPresent ? "" : "（不存在，用默认值+设置页）"}`,
    `- 开关：${v.enabled === false ? "已关闭" : "已启用"} / 默认引擎：${v.engine} / 自动评审：${v.auto}`,
    `- 独立评审 agent：${
      v.reviewer?.enabled
        ? v.reviewer.ready
          ? `已开启（provider=${v.reviewer.provider}${v.reviewer.model ? ` · model=${v.reviewer.model}` : ""} · 最多 ${v.reviewer.rounds} 轮）`
          : `已开启但不可用（${v.reviewer.error || "没有 subagents 服务"}）→ 回落 ocr/delegate`
        : "未启用（评审走 ocr/delegate）"
    }${
      Array.isArray(v.reviewer?.providers) && v.reviewer.providers.length > 0
        ? ` · 可用 provider：${v.reviewer.providers.join("/")}`
        : ""
    }`,
  ];
  if (v.bridge && typeof v.bridge === "object") {
    const lastModel = v.bridge.lastModel ? ` · 最近模型：${v.bridge.lastModel}` : "";
    const lastError = v.bridge.lastError ? ` · 最近错误：${v.bridge.lastError}` : "";
    lines.push(`- 本地桥：${v.bridge.url}（请求 ${v.bridge.requests} 次 · 失败 ${v.bridge.failed} 次${lastError}${lastModel}）`);
  } else if (v.llmMode && v.llmMode !== "endpoint") {
    lines.push("- 本地桥：未就绪（dsh 路由会回落成静态端点）");
  }
  if (v.pluginConfigError) lines.push(`- 配置解析错误：${v.pluginConfigError}`);
  if (Array.isArray(v.notes) && v.notes.length > 0) lines.push(`- 备注：${v.notes.join("；")}`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ 自动评审 */

const REVIEW_TOOL_PARAMS = {
  type: "object",
  properties: {
    scope: {
      type: "string",
      enum: ["workspace", "range", "commit", "scan"],
      description:
        "审查范围：workspace=未提交的工作区改动（默认，等价 ocr review）；range=分支/提交区间（配合 from/to）；commit=单个提交（配合 commit）；scan=整文件扫描（配合 paths，不需要 diff）。",
    },
    from: { type: "string", description: "scope=range 的起始 ref，例如 main。" },
    to: { type: "string", description: "scope=range 的结束 ref，例如 feature-x（省略表示到工作区）。" },
    commit: { type: "string", description: "scope=commit 的提交哈希或标签。" },
    paths: {
      type: "array",
      items: { type: "string" },
      description: "scope=scan 要扫描的文件/目录（也用于 delegate 模式的 git diff 过滤）。",
    },
    engine: {
      type: "string",
      enum: ["auto", "ocr", "delegate"],
      description:
        "auto（默认）=先跑 OCR 自己的 LLM 流水线，若 LLM 未配置则自动降级 delegate；ocr=只跑 OCR 流水线；delegate=不调 LLM，返回 OCR 解析出的规则+文件+diff，由你自己按规则审查。",
    },
    reviewer: {
      type: "boolean",
      description:
        "是否用独立评审 agent（只读子 agent）执行本次评审：true=强制用（不可用就报 OCR_REVIEWER_UNAVAILABLE，不回落）；false=强制走 ocr/delegate；省略=按设置里的 reviewer.agent。规格仍来自 ocr（规则+文件清单+diff）。",
    },
    preview: { type: "boolean", description: "只列出将审查的文件与排除情况，不调 LLM（等价 ocr review -p）。" },
    effort: { type: "string", enum: ["low", "medium", "high"], description: "评审力度预设（OCR 的 --effort）。" },
    model: { type: "string", description: "覆盖 OCR 本次使用的模型。" },
    provider: { type: "string", description: "覆盖 OCR 本次使用的 provider。" },
    exclude: { type: "array", items: { type: "string" }, description: "gitignore 风格的排除模式（逗号合并后传给 --exclude）。" },
    rulePath: { type: "string", description: "自定义系统规则 JSON 文件路径（OCR 的 --rule）。" },
    timeoutMinutes: { type: "number", description: "单次评审超时（分钟），默认取插件配置。" },
    repo: { type: "string", description: "git 仓库根目录；默认用当前会话工作目录。" },
    includeDiff: { type: "boolean", description: "delegate 模式下是否把 unified diff 一起放进 reviewSpec（默认 true）。" },
    extraArgs: { type: "array", items: { type: "string" }, description: "追加给 ocr 的原始参数（高级用法）。" },
  },
  required: [],
  additionalProperties: false,
};

const REVIEW_TOOL_OUTPUT = {
  type: "object",
  properties: {
    ok: { type: "boolean", description: "是否成功完成（或成功拿到预览/规格）。" },
    code: {
      type: "string",
      description:
        "失败时的稳定结果码（OCR_INVALID_ARGS/OCR_DISABLED/OCR_NOT_GIT_REPO/OCR_NOT_FOUND/OCR_TIMEOUT/OCR_ABORTED/OCR_RUN_FAILED/OCR_LLM_MISSING/OCR_OUTPUT_UNPARSABLE/OCR_OUTPUT_SHAPE_UNKNOWN/OCR_DELEGATE_PREVIEW_FAILED/OCR_DELEGATE_RULE_UNPARSABLE/OCR_REVIEWER_UNAVAILABLE/OCR_REVIEWER_FAILED/OCR_REVIEWER_UNCERTAIN）；成功时为空串。",
    },
    engine: { type: "string", description: "实际使用的引擎：ocr / delegate / agent（agent=独立评审子 agent）。" },
    reviewer: {
      type: "object",
      description: "独立评审 agent 的本次运行信息（engine=agent 时有意义）。",
      properties: {
        provider: { type: "string" },
        model: { type: "string" },
        round: { type: "number", description: "第几轮（1 起）。" },
        rounds: { type: "number", description: "本次往返的轮次上限。" },
        childId: { type: "string", description: "评审子会话 id。" },
        stopReason: { type: "string", description: "子 agent 的结束理由（completed 才是正常结束）。" },
        verdict: { type: "string", description: "clean | issues | uncertain。" },
      },
      required: ["provider", "round", "rounds"],
      additionalProperties: false,
    },
    scope: { type: "string" },
    repository: { type: "string" },
    command: { type: "string", description: "实际执行的 ocr 命令行。" },
    exitCode: { type: "number" },
    durationMs: { type: "number" },
    reviewableFiles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          status: { type: "string" },
          insertions: { type: "number" },
          deletions: { type: "number" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    excludedFiles: { type: "array", items: { type: "string" } },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          severity: { type: "string" },
          message: { type: "string" },
        },
        required: ["message"],
        additionalProperties: false,
      },
    },
    summary: { type: "string" },
    reviewSpec: { type: "string", description: "delegate 模式产出的审查规格（规则+文件+diff+任务说明）。" },
    configHint: { type: "string", description: "LLM 端点未配置时的修复指引。" },
    notes: { type: "array", items: { type: "string" } },
    rawJson: { type: "string", description: "ocr 原始 stdout（最多 10 万字符）。" },
    stderr: { type: "string" },
    lostOutput: { type: "boolean" },
    spillPath: { type: "string" },
    llmMissing: { type: "boolean", description: "失败原因是 OCR 的 LLM 端点未配置。" },
    timedOut: { type: "boolean" },
    aborted: { type: "boolean", description: "本次运行是否被取消（工具调用中断 / 停止按钮 / 插件卸载）。" },
  },
  required: ["ok", "engine", "scope", "summary"],
  additionalProperties: false,
};

const STATUS_TOOL_OUTPUT = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    code: { type: "string", description: "诊断失败时的稳定结果码（目前为 OCR_NOT_FOUND：定位不到 ocr 可执行文件）。" },
    executable: { type: "string" },
    version: { type: "string" },
    pluginConfigPath: { type: "string" },
    pluginDir: { type: "string" },
    pluginConfigPresent: { type: "boolean" },
    pluginConfigError: { type: "string" },
    settingsPage: { type: "string", description: "DSH 设置页是否可用，以及在哪里打开。" },
    enabled: { type: "boolean", description: "插件总开关（设置页里的 enabled）。" },
    engine: { type: "string" },
    auto: { type: "string" },
    llmMode: { type: "string", description: "LLM 路由模式：dsh=走 DSH（本机桥 → ctx.llm.stream），endpoint=直连静态端点。" },
    llmRoute: { type: "string", description: "本次实际生效的路由，以及回落原因。" },
    llmEndpoint: { type: "string", description: "生效的 LLM 端点：dsh 模式是本机桥地址，endpoint 模式是 baseUrl · protocol · model。" },
    bridge: {
      // 可空对象：DSH 的 tool schema 子集（dsh-tools 的 assertSupportedJsonSchema）不接受 type 数组，
      // 也不允许一个节点同时声明 type 与 oneOf —— 「对象或 null」只能用 oneOf 表达。
      description: "本机 LLM 桥的实时状态（dsh 模式）；桥没起来时为 null。",
      oneOf: [
        {
          type: "object",
          properties: {
            url: { type: "string" },
            tokenMasked: { type: "string" },
            requests: { type: "number" },
            failed: { type: "number" },
            lastError: { oneOf: [{ type: "string" }, { type: "null" }], description: "最近一次桥内失败的原因；没有失败过时为 null。" },
            lastProvider: { oneOf: [{ type: "string" }, { type: "null" }], description: "最近一次转发用的 provider；还没转发过时为 null。" },
            lastModel: { oneOf: [{ type: "string" }, { type: "null" }], description: "最近一次转发用的 model；还没转发过时为 null。" },
            inflight: { type: "number" },
            uptimeMs: { type: "number" },
          },
          required: ["url", "requests", "failed"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
    reviewer: {
      type: "object",
      description: "独立评审 agent 的接入状态（reviewer.agent=spawn 时生效）。",
      properties: {
        enabled: { type: "boolean", description: "设置里是否开启了独立评审 agent（reviewer.agent=spawn）。" },
        provider: { type: "string", description: "子 agent provider 名（默认 spawn）。" },
        model: { type: "string", description: "评审用的模型覆盖（空=跟随 provider 默认）。" },
        rounds: { type: "number", description: "一次往返最多几轮（reviewer.rounds）。" },
        available: { type: "boolean", description: "宿主是否提供了 subagents 服务。" },
        providers: { type: "array", items: { type: "string" }, description: "当前可用的子 agent provider 名单。" },
        ready: { type: "boolean", description: "开启且可用（本次评审会真的走独立评审 agent）。" },
        error: { type: "string", description: "不可用的原因（空=正常）。" },
      },
      required: ["enabled", "provider", "available"],
      additionalProperties: false,
    },
    credentialRef: { type: "string", description: "API Key 的凭据引用名。" },
    credentialSource: { type: "string", description: "凭据是否解析成功，以及来自哪里（不回显密钥）。" },
    ocrHomeConfig: { type: "string" },
    llmEnv: { type: "array", items: { type: "string" } },
    llmTest: { type: "string" },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["ok", "executable", "version", "notes"],
  additionalProperties: false,
};

function createAutoReviewer(ctx, cfgNow) {
  const states = new WeakMap();
  const stateOf = (agent) => {
    let state = states.get(agent);
    if (!state) {
      state = { dirty: false, running: false, runs: 0, notified: false, lastRunAt: 0, lastSignature: "", thread: null, failures: 0, failKey: "" };
      states.set(agent, state);
    }
    return state;
  };

  const deliver = (agent, text, mode) => {
    try {
      const message = makeUserMessage(text);
      const running = String(agent?.status) === "running";
      if (mode === "inject" || (mode === "adaptive" && running)) agent.inject(message);
      else agent.followup(message);
      return true;
    } catch (err) {
      // 交付失败是「用户看不到评审结果」，不该只在 verbose 下留痕。
      ctx.logger?.warn?.(`[open-code-review] 交付自动评审结果失败：${msgOf(err)}`);
      return false;
    }
  };

  const runAutoReview = async (agent, state, cfg, reason) => {
    state.running = true;
    /* 自动评审也要能被 dispose 掐掉：合并成同一路 signal。 */
    const autoSignal = linkSignal();
    /* 自动评审同样登记一条 job（在拿到 plan 之后开），catch 里也要能收尾。 */
    let job = null;
    let runSignal = autoSignal;
    // 这两个要在 catch 里用，不能声明在 try 块内（块级作用域）。
    let signature = "";
    let prevSignature = "";
    try {
      const cwd = cwdOf(agent);
      const route = await resolveLlmRoute(ctx, cfg);
      const env = route.env;
      let ocrPath = "";
      try {
        ocrPath = (await resolveOcr(ctx, cfg, undefined)).path;
      } catch (err) {
        state.dirty = false;
        if (!state.notified) {
          state.notified = true;
          deliver(agent, `【自动代码评审 · 阿里 OpenCodeReview】\n无法定位 ocr 可执行文件：${msgOf(err)}\n请在设置页（设置 → 插件 → dsh-open-code-review）或 ${CONFIG_PATH} 里设置 ocrPath。`, "adaptive");
        }
        return;
      }

      const autoScope = ["workspace", "range", "commit", "scan"].includes(String(cfg.autoScope))
        ? String(cfg.autoScope)
        : "workspace";
      const previewPlan = normalizeTarget({ scope: autoScope, preview: true, engine: "ocr" }, cfg, cwd);
      const previewRun = await runCommand(ctx, {
        exe: ocrPath,
        argv: buildOcrArgv(previewPlan, cfg).argv,
        cwd,
        env,
        signal: autoSignal,
        timeoutMs: 120000,
      });
      const previewParsed = parseJsonLoose(previewRun.stdout);
      const files = extractFiles(previewParsed);
      if (files.length < num(cfg.autoMinReviewableFiles, 1)) {
        state.dirty = false;
        return;
      }
      signature = signatureOf(files);
      if (signature !== "" && signature === state.lastSignature) {
        state.dirty = false;
        return;
      }
      prevSignature = state.lastSignature;
      state.lastSignature = signature;

      const engineWanted = String(cfg.autoEngine || "").trim() || String(cfg.engine || "auto");
      const plan = normalizeTarget(
        { scope: autoScope, engine: engineWanted, includeDiff: cfg.autoIncludeDiff !== false },
        cfg,
        cwd,
      );
      /* 第三档引擎：独立评审 agent 的多轮往返编排（opt-in）。 */
      job = openReviewJob(cfg, { plan, agent, source: "auto" });
      runSignal = withAbort(autoSignal, job.signal);
      const reviewerCfg = cfg.reviewer && typeof cfg.reviewer === "object" ? cfg.reviewer : {};
      const reviewerWanted = String(reviewerCfg.agent ?? "off") === "spawn" && plan.engine !== "delegate";
      const roundsWanted = Math.max(1, Math.min(10, num(reviewerCfg.rounds, DEFAULT_REVIEWER_ROUNDS)));
      const idleMs = timeoutMsOf(cfg, plan.timeoutMinutes);
      const unavailableNote = `独立评审 agent 不可用（${reviewerError || "宿主没有 subagents 服务"}）：本次回落 ocr/delegate（要它直接报错就显式传 reviewer:true）。`;
      let value = null;
      let reviewerFindings = [];
      let fallbackNote = "";
      if (reviewerWanted) {
        if (state.thread && threadExpired(state.thread, Date.now(), idleMs)) {
          deliver(
            agent,
            `【独立评审 agent】上一轮往返闲置超过 ${Math.round(idleMs / 60000)} 分钟，已关闭（下次写入会重新开一轮）。`,
            String(cfg.auto ?? "adaptive"),
          );
          state.thread = null;
        }
        if (state.thread && state.thread.round > state.thread.rounds) {
          const roundsDone = state.thread.rounds;
          const leftOpen = state.thread.open.length;
          const left = formatFindings(state.thread.open);
          deliver(
            agent,
            `【独立评审 agent · 已达轮次上限（${roundsDone} 轮）】停止自动复审；仍有 ${leftOpen} 条未确认的问题：\n${left || "(无)"}\n要继续就调用 ocr_review（reviewer: true），或把设置里的「最多轮数」调大。`,
            String(cfg.auto ?? "adaptive"),
          );
          state.thread = null;
          state.dirty = false;
          // 这一档已经开过 job：不结算的话 Jobs 面板会永远留一条 running 的「自动评审 · …」。
          finishReviewJob(job, {
            ok: false,
            code: "OCR_REVIEWER_UNCERTAIN",
            summary: `已达轮次上限（${roundsDone} 轮），仍有 ${leftOpen} 条未确认的问题。`,
          });
          return;
        }
        if (!state.thread) {
          state.thread = newThread({ rounds: roundsWanted, signature, files });
        }
        if (reviewerRuntime) {
          const res = await runReviewerReview(ctx, {
            cfg,
            plan,
            env,
            ocrPath,
            signal: runSignal,
            runtime: reviewerRuntime,
            thread: state.thread,
            parent: agent,
            timeoutMs: reviewerTimeoutMs(cfg),
            job,
          });
          reviewerFindings = res.findings;
          if (res.out.code === REVIEWER_CODES.UNAVAILABLE) {
            fallbackNote = unavailableNote;
          } else {
            value = res.out;
          }
        } else {
          fallbackNote = unavailableNote;
        }
      }

      if (value === null) {
        if (plan.engine === "delegate") {
          value = await runDelegate(ctx, { cfg, plan, env, ocrPath, signal: runSignal, job });
        } else {
          value = await runOcrOnce(ctx, { cfg, plan, env, ocrPath, signal: runSignal, job });
          if (!value.ok && value.llmMissing && canDegradeLlm(route)) {
            const notes = [
              ...(fallbackNote ? [fallbackNote] : []),
              "OCR 的 LLM 端点未配置：自动降级为 delegate，由当前模型按 OCR 规则审查。",
              `LLM 路由：${route.source}${route.note ? `（${route.note}）` : ""}`,
              `LLM 端点：${endpointDisplay(cfg.llm.baseUrl)} · ${cfg.llm.protocol || "?"} · ${cfg.llm.model || "(未设置)"}`,
            ];
            value = await runDelegate(ctx, { cfg, plan, env, ocrPath, signal: runSignal, notes, job });
            value.notes = [...notes, ...value.notes];
            value.configHint = configHintText();
          }
        }
        if (fallbackNote) value.notes.unshift(fallbackNote);
      } else if (state.thread) {
        /* 轮次记账：只有评审 agent 自己的结论才推进/关闭往返。 */
        if (value.ok && value.reviewer?.verdict === "clean") {
          state.thread = null;
        } else if (value.ok) {
          state.thread.open = reviewerFindings;
          state.thread.round += 1;
          state.thread.failures = 0;
          state.thread.lastAt = Date.now();
        } else {
          state.thread.failures += 1;
          state.thread.lastAt = Date.now();
          if (state.thread.failures >= 2) {
            state.thread = null;
            value.notes.push("评审 agent 连续 2 轮无法确认/失败，已关闭本轮往返（下次写入会重新开一轮）。");
          }
        }
      }

      finishReviewJob(job, value);
      state.runs += 1;
      state.lastRunAt = Date.now();
      state.dirty = false;
      // 成功一次后复位失败记账与提示开关：之后再有失败能重新提示，不会被一次旧失败永久静音。
      state.failures = 0;
      state.failKey = "";
      state.notified = false;
      const maxRuns = num(cfg.autoMaxPerSession, 3);
      const agentRound = value.engine === "agent";
      const header = agentRound
        ? `【独立评审 agent · ${roundLabel({ round: value.reviewer.round, rounds: value.reviewer.rounds })}】触发点：回合即将结束（${reason}）；本会话自动评审 ${state.runs}/${maxRuns} 次。若不需要自动评审：在 DSH「设置 → 插件 → dsh-open-code-review」里把「自动评审」设为 off（或改 ${CONFIG_PATH} 的 auto）。`
        : `【自动代码评审 · 阿里 OpenCodeReview】触发点：回合即将结束（${reason}）；本会话自动评审 ${state.runs}/${maxRuns} 次。若不需要自动评审：在 DSH「设置 → 插件 → dsh-open-code-review」里把「自动评审」设为 off（或改 ${CONFIG_PATH} 的 auto）。`;
      const roundTrip =
        agentRound && value.reviewer?.verdict === "issues"
          ? `\n\n请逐条修复或说明理由（误报也要说明）；本回合结束后会自动开下一轮复审（最多 ${value.reviewer.rounds} 轮）。`
          : "";
      deliver(agent, `${header}\n\n${valueToText(value, cfg)}${roundTrip}`, String(cfg.auto ?? "adaptive"));
    } catch (err) {
      // 瞬时失败（网络抖动 / LLM 5xx / 超时）不能让这批改动「一次失败就永远不再评审」：
      // 回滚签名、保留 dirty，下一条写工具结果到达时再试；但同一批改动最多重试
      // AUTO_RETRY_LIMIT 次，永久性失败（没配 key、ocr 缺失）不会每回合空跑。
      state.lastSignature = prevSignature;
      state.failures = state.failKey === signature ? state.failures + 1 : 1;
      state.failKey = signature;
      const willRetry = state.failures <= AUTO_RETRY_LIMIT;
      state.dirty = willRetry;
      if (job && job.live) finishReviewJob(job, { ok: false, code: "OCR_RUN_FAILED", summary: msgOf(err) });
      if (!state.notified || state.failures === AUTO_RETRY_LIMIT + 1) {
        state.notified = true;
        deliver(
          agent,
          `【自动代码评审 · 阿里 OpenCodeReview】执行失败${willRetry ? "（下次写入会自动重试）" : "（已重试到上限，这批改动不再自动评审；改完再写入或手动调用 ocr_review）"}：${msgOf(err)}`,
          "adaptive",
        );
      }
    } finally {
      state.running = false;
    }
  };

  const disposeToolsResult = ctx.on("tools/result", (exec, result) => {
    const cfg = cfgNow();
    if (String(cfg.auto) === "off") return;
    const agent = exec?.agent;
    if (!agent) return;
    if (!WRITE_TOOLS.has(String(exec.name ?? ""))) return;
    if (result && result.isError === true) return;
    const state = stateOf(agent);
    state.dirty = true;
    if (cfg.verbose) ctx.logger?.info?.(`[open-code-review] ${exec.name} 写入完成，已标记待评审。`);
  });

  const disposeTurnStopping = ctx.on("agent/turn-stopping", (payload) => {
    const cfg = cfgNow();
    if (String(cfg.auto) === "off") return;
    const agent = payload?.agent;
    if (!agent) return;
    const state = states.get(agent);
    if (!state || !state.dirty) return;
    if (state.running) return;
    if (state.runs >= num(cfg.autoMaxPerSession, 3)) return;
    if (Date.now() - state.lastRunAt < num(cfg.autoMinIntervalMs, 60000)) return;
    if (cfg.autoSkipSubagents !== false && isSubagent(agent)) return;
    state.running = true;
    /* 交给 trackRun：dispose 时能等这一次评审收尾。 */
    void trackRun(runAutoReview(agent, state, cfg, "agent/turn-stopping"));
  });

  return {
    states,
    /** 关掉自动评审时摘掉监听（工具/命令由各自的 disposer 负责）。 */
    dispose() {
      for (const dispose of [disposeToolsResult, disposeTurnStopping]) {
        try {
          if (typeof dispose === "function") dispose();
        } catch {
          /* 已经卸载 */
        }
      }
    },
  };
}

/* ---------------------------------------------------------------------- 插件 */

export function apply(ctx, config) {
  /** 每次调用都重新取活配置：设置页（volatile 引用）→ config.json → 出厂默认。 */
  const cfgNow = () => loadConfig(schemaOverrides(config));
  let autoReviewer = null;

  /* 生命周期：插件卸载（dispose）时先 abort 在飞的评审，再等它们收尾——
     不给系统留孤儿 ocr 子进程，也不让半截评审结果继续往会话里投递。 */
  const lifecycle = new AbortController();
  lifecycleAbort = lifecycle;
  ctx.effect(
    () => () => {
      if (lifecycleAbort === lifecycle) lifecycleAbort = null;
      lifecycle.abort();
      return Promise.allSettled([...inflightRuns]).then(() => undefined);
    },
    "在飞 ocr 评审的收尾（abort + 等待）",
  );


  const log = (level, text) => {
    try {
      ctx.logger?.[level]?.(`[open-code-review] ${text}`);
    } catch {
      /* logger 不可用则忽略 */
    }
  };

  /** 自动评审按开关启停：关闭时摘掉监听，重新打开时再挂上（无需重启）。 */
  const syncAutoReviewer = (reason) => {
    let cfg;
    try {
      cfg = cfgNow();
    } catch (err) {
      log("warn", `读取配置失败：${msgOf(err)}`);
      return;
    }
    const wanted = cfg.enabled !== false && String(cfg.auto ?? "adaptive") !== "off";
    if (wanted && !autoReviewer) {
      autoReviewer = createAutoReviewer(ctx, cfgNow);
      log("info", `自动评审已启用（回合结束且有文件写入时触发；引擎 ${cfg.engine}）。`);
    } else if (!wanted && autoReviewer) {
      autoReviewer.dispose();
      autoReviewer = null;
      log("info", `自动评审已关闭（${cfg.enabled === false ? "enabled=false" : "auto=off"}）。`);
    }
    if (reason === "apply") {
      log(
        "info",
        `已加载：工具 ocr_review / ocr_status、命令 /ocr-review；设置页 ${
          SCHEMA_AVAILABLE ? "可用（DSH 设置 → 插件 → dsh-open-code-review）" : "不可用"
        }；配置文件 ${CONFIG_PATH}（可选，热读）。`,
      );
    }
  };

  ctx.tools.register({
    name: "ocr_review",
    description:
      "用阿里 OpenCodeReview（ocr）做代码评审。默认审查当前仓库未提交的工作区改动；也支持分支区间、单个提交、整文件扫描。engine=ocr 走 OCR 自己的「确定性工程 × LLM」流水线（需要已配置 provider/model/key）；engine=delegate 不需要 key：插件用 ocr delegate 拿到按内容分组的审查规则+可审文件（并附上 unified diff），由你按规则自行审查。engine=auto（默认）先试 ocr，未配置 LLM 时自动降级 delegate。reviewer:true 时改由独立评审 agent（只读子 agent，规格仍来自 ocr）评审，需要宿主提供 subagents 服务；也可用 reviewer:false 强制走 ocr/delegate。建议：改动完成后、提交前调用一次。",
    parameters: REVIEW_TOOL_PARAMS,
    output: {
      schema: REVIEW_TOOL_OUTPUT,
      render(_args, value) {
        return [{ type: "text", text: valueToText(value, cfgNow()) }];
      },
    },
    timeoutMs: 30 * 60 * 1000,
    execute: (args, exec) => trackRun(runReview(ctx, args, exec, cfgNow)),
  });

  ctx.tools.register({
    name: "ocr_status",
    description:
      "检查阿里 OpenCodeReview 在本机的接入状态：ocr 可执行文件与版本、OCR 全局配置、LLM 相关环境变量、LLM 连通性（ocr llm test）、以及本插件的配置文件状态。评审失败或首次使用时先调用它。",
    parameters: {
      type: "object",
      properties: {
        checkLlm: { type: "boolean", description: "是否真的发一次最小请求测试 LLM 连通性（ocr llm test），默认 true。" },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: STATUS_TOOL_OUTPUT,
      render(_args, value) {
        return [{ type: "text", text: statusText(value) }];
      },
    },
    timeoutMs: 3 * 60 * 1000,
    execute: (args, exec) => trackRun(runStatus(ctx, args, exec, cfgNow)),
  });

  ctx.commands.register({
    definitionId: "dsh-open-code-review",
    name: "ocr-review",
    description: "阿里 OpenCodeReview：让模型立刻对本仓库当前改动跑一次 OCR 评审",
    input: { hint: "[可选] 附加要求，例如：只审 src/ 下的改动，重点看并发安全与错误处理", attachments: false },
    handler: (invocation) => {
      const agent = invocation?.agent;
      const extra = typeof invocation?.rawInput === "string" ? invocation.rawInput.trim() : "";
      if (!agent || typeof agent.followup !== "function") {
        return { kind: "error", text: "当前没有可用的会话 Agent，无法拉起 OpenCodeReview 评审。" };
      }
      if (cfgNow().enabled === false) {
        return {
          kind: "error",
          text: "插件已在设置里关闭（enabled=false）：请到「DSH 设置 → 插件 → dsh-open-code-review」打开开关后再用 /ocr-review。",
        };
      }
      const text = [
        "请立刻用 OpenCodeReview（阿里 ocr）对当前仓库的代码改动做一次评审：",
        "1. 若不确定接入状态（首次使用，或上次评审失败/报 LLM 未配置），先调用 `ocr_status`；",
        "2. 然后调用 `ocr_review`：默认 scope=workspace 审未提交改动；想先看范围可 `preview: true`；没有 LLM key 时用 `engine: \"delegate\"` 拿规则自己审；",
        "3. 若设置里开启了「独立评审 agent」（reviewer.agent=spawn），评审由独立的只读子 agent 执行（规格仍来自 ocr）；也可显式传 `reviewer: true` 强制用它、`reviewer: false` 强制走 ocr/delegate；",
        "4. 逐条判断评审结果：真实缺陷就修复，误报或规则不适用要说明理由，最后给出结论与改动摘要。",
        extra ? `\n用户的附加要求：${extra}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      try {
        agent.followup(makeUserMessage(text));
      } catch (err) {
        return { kind: "error", text: `拉起 OpenCodeReview 失败：${msgOf(err)}` };
      }
      return { kind: "success", text: "已向当前会话注入 OpenCodeReview 评审指令，模型将调用 ocr_review 执行。" };
    },
  });

  // ocr 进不了 cordis：起一个只监听 127.0.0.1 的 OpenAI 兼容桥，把模型/密钥/配额都交回 DSH。
  // llm 是可选服务 → 用 ctx.inject 声明；缺它时插件照常工作（dsh 路由回落静态端点）。
  ctx.inject(["llm"], (scoped) => {
    scoped.effect(() => {
      let disposed = false;
      let handle = null;
      startLlmBridge({
        stream: (options) => scoped.llm.stream(options),
        target: () => {
          const route = effectiveLlmRoute(scoped, cfgNow());
          return { provider: route.provider, model: route.model };
        },
        logger: ctx.logger,
        timeoutMs: timeoutMsOf(cfgNow()),
      })
        .then((bridge) => {
          if (disposed) {
            void bridge.close();
            return;
          }
          handle = bridge;
          activeBridge = bridge;
          bridgeError = "";
          log("info", `本机 LLM 桥已就绪：${bridge.url}（只监听 127.0.0.1、随机端口、随机 token）`);
        })
        .catch((err) => {
          bridgeError = msgOf(err);
          log("warn", `本机 LLM 桥起不来：${bridgeError}；dsh 路由会回落成静态端点。`);
        });
      return () => {
        disposed = true;
        if (activeBridge === handle) activeBridge = null;
        void handle?.close();
      };
    }, "本机 LLM 桥（ocr ⇄ ctx.llm.stream）");
  });

  // subagents 同样是可选服务：缺它时插件照常工作，「独立评审 agent」回落 ocr/delegate。
  ctx.inject(["subagents"], (scoped) => {
    scoped.effect(() => {
      const service = scoped.subagents;
      if (!service || typeof service.start !== "function") {
        reviewerError = "subagents 服务不可用（没有 start 方法）";
        return () => {};
      }
      reviewerRuntime = service;
      reviewerError = "";
      const providers = listProviders(service);
      log("info", `独立评审 agent 可用（provider：${providers.join(", ") || "未注册"}）。`);
      return () => {
        if (reviewerRuntime === service) {
          reviewerRuntime = null;
          reviewerError = "subagents 服务已卸载";
        }
      };
    }, "独立评审 agent 的 subagents 运行时");
  });

  // jobs 也是可选服务：缺它（宿主没装 job controller）时只是没有进度可见，评审照跑。
  ctx.inject(["jobs"], (scoped) => {
    scoped.effect(() => {
      const service = scoped.jobs;
      if (!service || typeof service.start !== "function") return () => {};
      jobsRuntime = service;
      return () => {
        if (jobsRuntime === service) jobsRuntime = null;
      };
    }, "评审进度（ctx.jobs）");
  });

  syncAutoReviewer("apply");

  // 设置页改动的热通道：Loader 把新值写进 volatile 引用后广播，这里据此启停自动评审。
  ctx.on("loader/volatile-update", () => syncAutoReviewer("settings"));
}
