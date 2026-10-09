/**
 * 离线冒烟测试：不依赖 DSH 宿主，用假的 ctx（subprocess 由 node:child_process 实现）
 * 直接驱动插件 apply()，取出注册的工具/命令并跑真实的 ocr 命令。
 *
 * 用法：node test/smoke.mjs [被测仓库路径]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.argv[2] ?? "C:\\Users\\吴礼凯\\.dsh\\tmp-ocr-test";
const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function log(message) {
  console.log(`      · ${message}`);
}

function which(cmd) {
  if (isAbsolute(cmd)) return existsSync(cmd) ? cmd : "";
  const exts = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";");
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of ["", ...exts]) {
      const candidate = join(dir, cmd + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* 继续找 */
      }
    }
  }
  return "";
}

/** 最小的 SubprocessRuntime 替身。 */
function spawnFake(spec) {
  const [exe, ...argv] = spec.argv;
  const child = spawn(exe, argv, { cwd: spec.cwd, env: spec.env ?? process.env, windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  try {
    child.stdin.end();
  } catch {
    /* 没有 stdin 管道 */
  }
  const done = new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ exitCode: code, signal }));
    child.on("error", () => resolve({ exitCode: null, signal: null }));
  });
  const reader = (get) => ({ readFrom: () => ({ text: get(), nextOffset: get().length, lossy: false }) });
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: { stdout: reader(() => stdout), stderr: reader(() => stderr) },
    done,
    terminate: () => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    },
    waitForExit: () => done.then(() => true),
  };
}

const tools = new Map();
const commands = new Map();
const listeners = new Map();
/** 凭据替身：只有 credentialStub.ref 指向的引用能解析出值。 */
const credentialStub = { ref: "", value: "" };
/** 假的 DSH 默认模型服务返回的路由（desktop profile 的 agent-default-model 实测值）。 */
const DSH_DEFAULT_MODEL = { provider: "commandcode", model: "deepseek/deepseek-v4.1-flash-fast" };
const resolvedRefs = [];

/** 假的 llm 服务：脚本化吐 chunk，并记录每次收到的 options（用来验证本机桥的翻译）。 */
function fakeLlmService(script) {
  const calls = [];
  return {
    calls,
    async *stream(options) {
      calls.push(options);
      const chunks = typeof script === "function" ? script(options, calls.length) : script;
      for (const chunk of chunks) yield chunk;
    },
  };
}

function makeCtx(overrides = {}) {
  /** ctx.effect / ctx.inject 的替身：effect 立刻执行并记住清理函数，inject 只在服务齐全时回调。 */
  const effects = [];
  /** 事件监听表：默认共用全局那张（端到端那几段依赖它），独立场景可以传自己的免得互相串。 */
  const listenerMap = overrides.listeners ?? listeners;
  const ctx = {
    effects,
    effect(callback, label) {
      const dispose = callback();
      effects.push({ label, dispose });
      return () => {
        if (typeof dispose === "function") dispose();
      };
    },
    inject(deps, callback) {
      const list = Array.isArray(deps) ? deps : [deps];
      const missing = list.filter((key) => ctx[key] === undefined || ctx[key] === null);
      if (missing.length > 0) return undefined;
      return callback(ctx);
    },
    /** 真子进程替身；罐头场景用 overrides.subprocess 换成脚本化的假 spawn。 */
    subprocess: overrides.subprocess ?? {
      async resolveExecutable(cmd) {
        const found = which(cmd);
        if (!found) throw new Error(`not found on PATH: ${cmd}`);
        return found;
      },
      spawn: spawnFake,
    },
    logger: { info: (m) => log(m), warn: (m) => log(`warn: ${m}`), debug: () => {} },
    credentials: {
      async resolve(ref) {
        resolvedRefs.push(ref);
        if (ref === credentialStub.ref && credentialStub.value) return { value: credentialStub.value, source: "smoke-stub" };
        return undefined;
      },
    },
    on(name, handler) {
      if (!listenerMap.has(name)) listenerMap.set(name, []);
      listenerMap.get(name).push(handler);
      return () => {
        const list = listenerMap.get(name) ?? [];
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition);
        return () => commands.delete(definition.name);
      },
    },
    /**
     * 可选服务的读取口（官方插件用 ctx.get("llm") / ctx.get("agentDefaultModel") 读可选服务）：
     * agentDefaultModel 默认给一个替身（真机 profile 里就有这个服务），传 null 模拟它不存在。
     */
    get(name) {
      if (name === "agentDefaultModel") {
        return overrides.agentDefaultModel === undefined ? { currentSelection: () => DSH_DEFAULT_MODEL } : overrides.agentDefaultModel;
      }
      return ctx[name];
    },
  };
  if (overrides.llm) ctx.llm = overrides.llm;
  if (overrides.subagents) ctx.subagents = overrides.subagents;
  return ctx;
}

function emit(name, ...args) {
  for (const handler of listeners.get(name) ?? []) handler(...args);
}

const deliver = { injected: [], followed: [] };
function makeAgent() {
  return {
    status: "idle",
    session: { header: { cwd: REPO, origin: "user" } },
    inject: (message) => deliver.injected.push(message),
    followup: (message) => deliver.followed.push(message),
  };
}

function textOf(message) {
  return message?.content?.map((block) => block.text ?? "").join("\n") ?? "";
}

/* ------------------------------------------------------------------ 单元检查 */

const mod = await import(new URL("../lib/index.js", import.meta.url));
const review = await import(new URL("../lib/review.js", import.meta.url));
const cli = await import(new URL("../lib/ocr-cli.js", import.meta.url));
const cfgMod = await import(new URL("../lib/config.js", import.meta.url));

check("模块导出 name/inject/apply", mod.name === "dsh-open-code-review" && Array.isArray(mod.inject) && typeof mod.apply === "function", `inject=${JSON.stringify(mod.inject)}`);

/* ------------------------------------------------------------ 清单（Plugin Manager 展示） */

/* 卡片/详情/设置清单不加载插件也要可读：图标与展示文案来自清单本身
   （references/host-plugin.md：icon 是相对路径、≤256KiB；标题与描述在 locale/<lang>.json 的 meta）。 */
const pluginDir = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
const iconPath = typeof pkg.icon === "string" ? join(pluginDir, pkg.icon) : "";
check(
  "清单声明了图标且文件存在（相对路径、≤256KiB）",
  Boolean(iconPath) && pkg.icon.startsWith("./") && existsSync(iconPath) && statSync(iconPath).size <= 256 * 1024,
  `icon=${pkg.icon}`
);
check(
  "exports/files 覆盖 package.json 与 locale",
  Boolean(pkg.exports?.["./package.json"]) &&
    Boolean(pkg.exports?.["./locale/*.json"]) &&
    Array.isArray(pkg.files) &&
    pkg.files.includes("locale/*.json") &&
    pkg.files.includes("icon.svg"),
  JSON.stringify({ exports: Object.keys(pkg.exports ?? {}), files: pkg.files }),
);
const localeMeta = (file) => {
  try {
    return JSON.parse(readFileSync(join(pluginDir, "locale", file), "utf8"));
  } catch {
    return null;
  }
};
const zhMeta = localeMeta("zh.json");
const enMeta = localeMeta("en.json");
check(
  "locale/{zh,en}.json 带 meta.title/description",
  Boolean(zhMeta?.meta?.title && zhMeta?.meta?.description && enMeta?.meta?.title && enMeta?.meta?.description),
  `zh=${zhMeta?.meta?.title} en=${enMeta?.meta?.title}`
);
check(
  "dsh.client 声明 platform/immediately/inject",
  pkg.dsh?.client?.platform === "web" && pkg.dsh?.client?.immediately === true && Array.isArray(pkg.dsh?.client?.inject),
  JSON.stringify(pkg.dsh?.client),
);

const env = cli.buildEnv({ llm: { baseUrl: "https://api.deepseek.com", protocol: "openai", apiKey: "sk-test", model: "deepseek-chat" }, env: { FOO: "bar" } });
check(
  "buildEnv 映射 llm → OCR_LLM_URL/PROTOCOL/TOKEN/MODEL",
  env.OCR_LLM_URL === "https://api.deepseek.com" &&
    env.OCR_LLM_PROTOCOL === "openai" &&
    env.OCR_LLM_TOKEN === "sk-test" &&
    env.OCR_LLM_MODEL === "deepseek-chat" &&
    env.FOO === "bar",
  `url=${env.OCR_LLM_URL} protocol=${env.OCR_LLM_PROTOCOL}`,
);

/* --------------------------------------------------- 设置页 schema（volatile） */

check("导出 schemastery Config（DSH 据此生成设置页）", mod.SCHEMA_AVAILABLE === true && Boolean(mod.Config), `SCHEMA_AVAILABLE=${mod.SCHEMA_AVAILABLE}`);
const schema = mod.Config;
let schemaRefs = null;
try {
  schemaRefs = typeof schema === "function" ? schema({ llmModel: "deepseek/deepseek-v4.1-flash", llmApiKeyRef: "SMOKE_OCR_KEY" }) : null;
} catch (err) {
  log(`schema 解析失败：${err?.message ?? err}`);
}
check(
  "设置页字段是 volatile 引用（有 .get()）",
  Boolean(schemaRefs) && typeof schemaRefs?.llmApiKeyRef?.get === "function" && schemaRefs.llmApiKeyRef.get() === "SMOKE_OCR_KEY",
  `llmApiKeyRef=${typeof schemaRefs?.llmApiKeyRef?.get === "function" ? schemaRefs.llmApiKeyRef.get() : "(无)"}`,
);

const ref = (value) => Object.freeze({ get: () => value });
const overrides = cfgMod.schemaOverrides({
  engine: ref("ocr"),
  autoReview: ref("off"),
  timeoutMinutes: ref(20),
  llmModel: ref("deepseek/deepseek-v4.1-flash"),
  llmApiKeyRef: ref("SMOKE_OCR_KEY"),
  ocrPath: ref(""),
  verbose: ref(false),
});
check(
  "schemaOverrides：扁平字段名 → 生效配置路径（llm.* / autoReview→auto / 空串回落）",
  overrides?.llm?.model === "deepseek/deepseek-v4.1-flash" &&
    overrides?.llm?.apiKeyRef === "SMOKE_OCR_KEY" &&
    overrides?.engine === "ocr" &&
    overrides?.auto === "off" &&
    overrides?.timeoutMinutes === 20 &&
    overrides?.ocrPath === undefined &&
    overrides?.verbose === false &&
    cfgMod.schemaOverrides(null) === null,
  JSON.stringify(overrides),
);

const synthetic = {
  files: [{ path: "a.js", status: "modified", insertions: 3, deletions: 1 }],
  issues: [
    { file: "a.js", line: 12, severity: "high", message: "空指针风险" },
    { location: { path: "b.js", line: 7 }, title: "未处理异常", level: "medium" },
    { file: "a.js", line: 12, severity: "high", message: "空指针风险" },
  ],
};
const issues = review.extractIssues(review.parseJsonLoose(`前置日志\n${JSON.stringify(synthetic)}\n尾部日志`));
check("parseJsonLoose + extractIssues 兼容两种字段形态并去重", issues.length === 2 && issues[0].file === "a.js" && issues[1].file === "b.js" && issues[1].line === 7, JSON.stringify(issues));

const argv = review.buildOcrArgv(review.normalizeTarget({ scope: "range", from: "main", to: "dev", effort: "high", exclude: ["**/dist/**"] }, { timeoutMinutes: 15, maxTimeoutMinutes: 45, audience: "agent" }, REPO), {});
check("buildOcrArgv(range) 参数拼装", argv.argv.join(" ") === "review --from main --to dev --format json --audience agent --color never --effort high --exclude **/dist/** --timeout 15", argv.argv.join(" "));

/* ------------------------------------------------------------- 端到端：工具 */

const ctx = makeCtx();
mod.apply(ctx, schemaRefs);
check("注册了 ocr_review / ocr_status / ocr-review", tools.has("ocr_review") && tools.has("ocr_status") && commands.has("ocr-review"), [...tools.keys()].join(","));
check("工具声明了 output.schema + render", typeof tools.get("ocr_review").output?.render === "function" && tools.get("ocr_review").output.schema?.type === "object");

const agent = makeAgent();
const exec = { name: "ocr_review", callId: "call-1", arguments: {}, agent, signal: undefined };

const preview = await tools.get("ocr_review").execute({ preview: true }, exec);
check("preview：拿到可审文件", preview.ok === true && preview.reviewableFiles.length >= 1, `${preview.summary} | files=${preview.reviewableFiles.map((f) => f.path).join(",")}`);
check("设置页里的凭据引用被真的解析（ctx.credentials.resolve）", resolvedRefs.includes("SMOKE_OCR_KEY"), `resolvedRefs=${JSON.stringify([...new Set(resolvedRefs)])}`);

const delegated = await tools.get("ocr_review").execute({ engine: "delegate" }, exec);
check(
  "delegate：产出审查规格（含文件/规则/diff）",
  delegated.ok === true && delegated.engine === "delegate" && delegated.reviewSpec.includes("委派审查规格") && delegated.reviewSpec.includes("calc.js") && /^###\s+组/m.test(delegated.reviewSpec) && delegated.reviewSpec.includes("```diff"),
  `${delegated.summary} | spec=${delegated.reviewSpec.length} 字符`,
);

const auto = await tools.get("ocr_review").execute({}, exec);
check(
  "auto：无 LLM 端点时降级 delegate 并给出配置指引",
  auto.ok === true && auto.engine === "delegate" && auto.configHint.includes("no valid LLM endpoint configured"),
  `${auto.summary} | notes=${auto.notes.join(" / ")}`,
);

const bad = await tools.get("ocr_review").execute({ scope: "commit" }, exec);
check("参数缺失时明确报错且不执行命令", bad.ok === false && bad.code === "OCR_INVALID_ARGS" && bad.summary.includes("需要 commit"), `${bad.code} | ${bad.summary}`);

/* 用全新空目录当"非 git 仓库"样本：插件自己现在是个 git 仓库（用户要求建 GitHub 仓库时 git init 过），
   不能再拿它当反例。 */
const nonRepoDir = mkdtempSync(join(tmpdir(), "ocr-nongit-"));
const notRepo = await tools.get("ocr_review").execute({ preview: true, repo: nonRepoDir }, exec);
check("非 git 仓库：给出可读诊断而不是裸 stderr", notRepo.ok === false && notRepo.code === "OCR_NOT_GIT_REPO" && notRepo.summary.includes("不是 git 仓库") && notRepo.configHint.length > 0, `${notRepo.code} | ${notRepo.summary}`);

const status = await tools.get("ocr_status").execute({}, exec);
check(
  "ocr_status：定位 exe + 版本 + LLM 连通性",
  status.ok === true && status.executable.includes("opencodereview") && status.version.length > 0 && status.llmTest.startsWith("不可用"),
  `${status.version} | ${status.llmTest.slice(0, 90)}`,
);

const rendered = tools.get("ocr_review").output.render({}, delegated)[0].text;
check("render 输出人类/模型可读文本", rendered.includes("委派审查规格") && rendered.includes("engine=delegate"), `${rendered.length} 字符`);

/* ------------------------------------------------------------- 端到端：自动 */

const autoAgent = makeAgent();
emit("tools/result", { name: "edit", agent: autoAgent, callId: "c2", arguments: {} }, { isError: false });
emit("agent/turn-stopping", { agent: autoAgent, turn: 7, signal: undefined });
const deadline = Date.now() + 120000;
while (deliver.followed.length === 0 && deliver.injected.length === 0 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}
const autoText = textOf(deliver.followed[0] ?? deliver.injected[0]);
check(
  "自动评审：写文件后回合结束自动注入评审结果",
  autoText.includes("自动代码评审") && autoText.includes("OpenCodeReview") && /engine=(delegate|ocr)/.test(autoText),
  `followup=${deliver.followed.length} inject=${deliver.injected.length} 长度=${autoText.length}`,
);

const before = deliver.followed.length + deliver.injected.length;
emit("agent/turn-stopping", { agent: autoAgent, turn: 8, signal: undefined });
await new Promise((resolve) => setTimeout(resolve, 1500));
check("自动评审：同一改动签名不重复触发", deliver.followed.length + deliver.injected.length === before, `新增交付 ${deliver.followed.length + deliver.injected.length - before} 条`);

/* ------------------------------------------------- 设置页：总开关（热更新） */

const listenersBefore = (listeners.get("agent/turn-stopping") ?? []).length;
emit("loader/volatile-update", {});
check(
  "loader/volatile-update：设置页改动即时同步（开关未变则不重挂监听）",
  (listeners.get("agent/turn-stopping") ?? []).length === listenersBefore,
  `turn-stopping 监听=${(listeners.get("agent/turn-stopping") ?? []).length}`,
);

mod.apply(makeCtx(), cfgMod.Config({ enabled: false }));
const offReview = await tools.get("ocr_review").execute({ preview: true }, exec);
check("enabled=false：ocr_review 拒绝执行并指向设置页", offReview.ok === false && offReview.code === "OCR_DISABLED" && offReview.summary.includes("已在设置里关闭"), `${offReview.code} | ${offReview.summary}`);

const offCmd = await commands.get("ocr-review").handler({ agent: makeAgent(), rawInput: "", attachments: [], signal: undefined });
check("enabled=false：/ocr-review 返回错误", offCmd?.kind === "error" && String(offCmd.text).includes("已在设置里关闭"), JSON.stringify(offCmd));

const offStatus = await tools.get("ocr_status").execute({ checkLlm: false }, exec);
check("enabled=false：ocr_status 仍可用于诊断", offStatus.ok === true && offStatus.enabled === false, `enabled=${offStatus.enabled} ref=${offStatus.credentialRef}`);

/* ------------------------------------------------ dsh 路由：ocr ⇄ 本机桥 ⇄ ctx.llm.stream */

const llmStub = fakeLlmService((options) => {
  const last = options.messages.at(-1);
  // 第 1 跳让它调工具（ocr llm test 会验证工具往返），第 2 跳（带 role=tool）才给正文。
  if (last && last.role === "tool") {
    return [{ type: "text-delta", index: 0, text: "pong" }, { type: "finish", reason: { kind: "stop" } }];
  }
  return [
    { type: "tool-call-delta", index: 0, id: "call_smoke", name: "ocr_selftest", argumentsDelta: '{"note":"smoke"}' },
    { type: "finish", reason: { kind: "stop" } },
  ];
});
const bridgeCtx = makeCtx({ llm: llmStub });
mod.apply(bridgeCtx, cfgMod.Config({ llmMode: "dsh", llmProvider: "commandcode", llmModel: "deepseek/deepseek-v4.1-flash" }));
await new Promise((resolve) => setTimeout(resolve, 150)); // 等桥 listen 完成（startLlmBridge 是异步的）

const bridgeStatus = await tools.get("ocr_status").execute({ checkLlm: false }, exec);
check(
  "dsh 路由：宿主有 llm 服务时桥自动就绪（只监听 127.0.0.1）",
  bridgeStatus.llmMode === "dsh" && Boolean(bridgeStatus.bridge) && String(bridgeStatus.bridge.url).startsWith("http://127.0.0.1:"),
  `mode=${bridgeStatus.llmMode} bridge=${JSON.stringify(bridgeStatus.bridge)}`,
);
check(
  "dsh 路由：LLM 端点指向本机桥，不再指向 api.commandcode.ai",
  String(bridgeStatus.llmEndpoint).includes("127.0.0.1") && !String(bridgeStatus.llmEndpoint).includes("api.commandcode.ai"),
  bridgeStatus.llmEndpoint,
);
check(
  "dsh 路由：凭据由 DSH 提供（不再解析 llmApiKeyRef）",
  String(bridgeStatus.credentialSource).includes("由 DSH 提供") && String(bridgeStatus.credentialRef).includes("dsh 模式不需要"),
  `${bridgeStatus.credentialRef} → ${bridgeStatus.credentialSource}`,
);
check(
  "dsh 路由：子进程只拿到桥的 URL 与打码 token",
  bridgeStatus.llmEnv.some((line) => line.startsWith("OCR_LLM_URL=http://127.0.0.1:")) && bridgeStatus.llmEnv.includes("OCR_LLM_TOKEN=***"),
  JSON.stringify(bridgeStatus.llmEnv),
);

const badAuth = await fetch(bridgeStatus.bridge.url + "/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer not-the-token" },
  body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
});
check("dsh 路由：桥校验随机 token（错 token → 401）", badAuth.status === 401, String(badAuth.status));

if (which("ocr")) {
  // 真端到端：插件 → ocr 子进程（OCR_LLM_* 指向桥）→ 桥 → 假 llm 服务。
  const live = await tools.get("ocr_status").execute({}, exec);
  check(
    "dsh 路由：真 ocr llm test 经桥打通（含工具往返）",
    String(live.llmTest).startsWith("可用") && String(live.llmTest).includes("Tool-call round trip verified"),
    String(live.llmTest).slice(0, 200),
  );
  check("dsh 路由：桥的请求打进 ctx.llm.stream（两跳：工具 + 正文）", llmStub.calls.length === 2 && llmStub.calls[0].provider === "commandcode", `calls=${llmStub.calls.length} provider=${llmStub.calls[0]?.provider}`);
  check(
    "dsh 路由：第 2 跳把 role=tool 翻成 DSH 的 tool 消息",
    llmStub.calls[1]?.messages?.some((message) => message.role === "tool" && message.toolCallId === "call_smoke"),
    JSON.stringify((llmStub.calls[1]?.messages ?? []).map((message) => message.role)),
  );
  check(
    "dsh 路由：桥的 stats 计入 ocr_status 的探测请求（并记下那次故意打错的 token）",
    Number(live.bridge?.requests ?? 0) >= 2 && Number(live.bridge?.failed ?? 0) === 1 && String(live.bridge?.lastModel).length > 0,
    JSON.stringify(live.bridge),
  );
} else {
  log("本机没有 ocr，跳过 dsh 路由的真端到端断言");
}

// 关掉插件（模拟插件卸载/服务消失）：桥必须一起关，端口不泄漏。
for (const entry of bridgeCtx.effects) {
  if (typeof entry.dispose === "function") entry.dispose();
}
await new Promise((resolve) => setTimeout(resolve, 50));
let bridgeClosed = false;
try {
  await fetch(bridgeStatus.bridge.url + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer not-the-token" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
  });
} catch {
  bridgeClosed = true;
}
check("dsh 路由：ctx.effect 清理后桥随之关闭（端口不泄漏）", bridgeClosed === true);

/* ------------------- dsh 路由：设置页留空 = 跟随 DSH 默认模型（agentDefaultModel） ------- */

const defaultLlmStub = fakeLlmService(() => [
  { type: "text-delta", index: 0, text: "pong" },
  { type: "finish", reason: { kind: "stop" } },
]);
const defaultCtx = makeCtx({ llm: defaultLlmStub });
mod.apply(defaultCtx, cfgMod.Config({ llmMode: "dsh", llmProvider: "", llmModel: "" }));
await new Promise((resolve) => setTimeout(resolve, 150));

const defStatus = await tools.get("ocr_status").execute({ checkLlm: false }, exec);
check(
  "dsh 路由：设置页留空时用 DSH 默认模型（provider/model 都从 agentDefaultModel 读）",
  String(defStatus.llmEndpoint).includes("commandcode/deepseek/deepseek-v4.1-flash-fast") && String(defStatus.llmRoute).includes("DSH 默认模型"),
  `${defStatus.llmRoute} | ${defStatus.llmEndpoint}`,
);
check(
  "dsh 路由：留空时 OCR_LLM_MODEL 写的也是 DSH 默认模型",
  defStatus.llmEnv.includes("OCR_LLM_MODEL=deepseek/deepseek-v4.1-flash-fast"),
  JSON.stringify(defStatus.llmEnv),
);

if (which("ocr")) {
  const defLive = await tools.get("ocr_status").execute({}, exec); // checkLlm=true：真跑 ocr llm test
  const firstCall = defaultLlmStub.calls[0];
  check(
    "dsh 路由：真 ocr 请求经桥转发到 DSH 默认模型",
    String(defLive.llmTest).startsWith("可用") &&
      defaultLlmStub.calls.length > 0 &&
      firstCall?.provider === "commandcode" &&
      firstCall?.model === "deepseek/deepseek-v4.1-flash-fast",
    `llmTest=${String(defLive.llmTest).slice(0, 60)} calls=${defaultLlmStub.calls.length} ${firstCall ? `${firstCall.provider}/${firstCall.model}` : ""}`,
  );
} else {
  log("本机没有 ocr，跳过 dsh 默认模型的真端到端断言");
}
for (const entry of defaultCtx.effects) {
  if (typeof entry.dispose === "function") entry.dispose();
}

mod.apply(makeCtx({ llm: undefined, agentDefaultModel: null }), cfgMod.Config({ llmMode: "dsh", llmProvider: "", llmModel: "" }));
const bareStatus = await tools.get("ocr_status").execute({ checkLlm: false }, exec);
check(
  "dsh 路由：设置与 DSH 默认模型都缺模型名时说清回落原因",
  String(bareStatus.llmMode) === "dsh" && String(bareStatus.llmRoute).includes("都没给出可用模型名"),
  bareStatus.llmRoute,
);

/* --------------------------- 结果码与 fail-closed（罐头子进程，不依赖真 ocr） --------- */

const codeKeys = Object.keys(review.CODES ?? {});
check(
  "结果码表：15 个稳定码齐全、都是 OCR_ 前缀、互不重复",
  codeKeys.length === 15 && new Set(Object.values(review.CODES)).size === 15 && codeKeys.every((key) => String(review.CODES[key]).startsWith("OCR_")),
  codeKeys.join(","),
);

const coded = review.valueToText({
  ok: false,
  code: review.CODES.RUN_FAILED,
  engine: "ocr",
  scope: "workspace",
  exitCode: 1,
  durationMs: 12,
  summary: "失败",
  issues: [],
  notes: [],
  reviewableFiles: [],
  excludedFiles: [],
});
check("valueToText：结果码出现在首行", coded.includes("code=OCR_RUN_FAILED"), coded.split("\n")[0]);

check(
  "hasIssueCollection：空数组算「确实没问题」，缺字段算「形状不认识」",
  review.hasIssueCollection({ issues: [] }) === true &&
    review.hasIssueCollection({ findings: [{ message: "x" }] }) === true &&
    review.hasIssueCollection({ files: [{ path: "a.js" }] }) === false &&
    review.hasIssueCollection(null) === false,
);

/** 罐头 SubprocessRuntime：不起真进程，按脚本顺序吐出每个子进程的 stdout/stderr/exitCode。 */
function cannedSubprocess(runs) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async resolveExecutable(cmd) {
      return "C:\\fake\\" + cmd + ".exe";
    },
    spawn(spec) {
      const run = runs[Math.min(index, runs.length - 1)] ?? {};
      index += 1;
      const call = { spec, run, terminated: false };
      calls.push(call);
      let settle = () => {};
      const done = new Promise((resolve) => {
        settle = () =>
          resolve({
            exitCode: typeof run.exitCode === "number" ? run.exitCode : 0,
            signal: call.terminated ? "SIGTERM" : null,
          });
      });
      if (run.delayMs) setTimeout(settle, run.delayMs);
      else if (!run.manual) settle();
      const reader = (text) => ({
        readFrom: () => ({ text: String(text ?? ""), nextOffset: String(text ?? "").length, lossy: false }),
      });
      return {
        collected: { stdout: reader(run.stdout), stderr: reader(run.stderr) },
        done,
        terminate() {
          call.terminated = true;
          settle();
        },
        waitForExit: () => done.then(() => true),
      };
    },
  };
}

/** 用罐头子进程跑一次 ocr_review（engine=ocr 是一次 spawn，正好一次脚本）。 */
function cannedHarness(runs, config = {}, overrides = {}) {
  const canned = cannedSubprocess(runs);
  const ctx2 = makeCtx({ subprocess: canned, ...overrides });
  mod.apply(ctx2, cfgMod.Config({ engine: "ocr", llmMode: "dsh", llmProvider: "commandcode", llmModel: "deepseek/deepseek-v4.1-flash", ...config }));
  const exec2 = { name: "ocr_review", callId: "canned", arguments: {}, agent: makeAgent(), signal: undefined };
  return { canned, ctx: ctx2, exec: exec2, call: (args) => tools.get("ocr_review").execute(args, exec2) };
}

const shapeCase = cannedHarness([
  { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "a.js", insertions: 2, deletions: 0 }], summary: "looks fine" }) },
]);
const shapeRun = await shapeCase.call({ engine: "ocr" });
check(
  "fail-closed：exit=0 但没有问题清单字段 → OCR_OUTPUT_SHAPE_UNKNOWN（不当作「没问题」）",
  shapeRun.ok === false && shapeRun.code === "OCR_OUTPUT_SHAPE_UNKNOWN" && shapeRun.rawJson.length > 0 && shapeRun.notes.some((n) => n.includes("ISSUE_KEYS")),
  `${shapeRun.code} | ${shapeRun.summary}`,
);

const junkCase = cannedHarness([{ exitCode: 0, stdout: "这不是 JSON，只是 OCR 的一段日志" }]);
const junkRun = await junkCase.call({ engine: "ocr" });
check(
  "fail-closed：exit=0 但输出不是 JSON → OCR_OUTPUT_UNPARSABLE",
  junkRun.ok === false && junkRun.code === "OCR_OUTPUT_UNPARSABLE" && junkRun.rawJson.includes("这不是 JSON"),
  `${junkRun.code} | ${junkRun.summary}`,
);

const silentCase = cannedHarness([{ exitCode: 0, stdout: "" }]);
const silentRun = await silentCase.call({ engine: "ocr" });
check(
  "fail-closed：exit=0 但 stdout 为空 → OCR_OUTPUT_UNPARSABLE 且说明可能没改动",
  silentRun.ok === false && silentRun.code === "OCR_OUTPUT_UNPARSABLE" && silentRun.notes.some((n) => n.includes("标准输出是空的")),
  `${silentRun.code} | ${silentRun.notes.join(" / ")}`,
);

const cleanCase = cannedHarness([{ exitCode: 0, stdout: JSON.stringify({ files: [{ path: "a.js", insertions: 1, deletions: 1 }], issues: [] }) }]);
const cleanRun = await cleanCase.call({ engine: "ocr" });
check(
  "fail-closed 不误报：带 issues:[] 的成功输出仍然是 ok（code 为空）",
  cleanRun.ok === true && cleanRun.code === "" && cleanRun.summary.includes("未发现问题（返回的 JSON 带问题清单字段且为空）"),
  `${cleanRun.code} | ${cleanRun.summary}`,
);

const issueCase = cannedHarness([
  {
    exitCode: 0,
    stdout: JSON.stringify({
      files: [{ path: "a.js", insertions: 3, deletions: 0 }],
      issues: [{ file: "a.js", line: 9, severity: "high", message: "空指针风险" }],
    }),
  },
]);
const issueRun = await issueCase.call({ engine: "ocr" });
check(
  "正常路径：issue 数组被解析出来",
  issueRun.ok === true && issueRun.issues.length === 1 && issueRun.issues[0].line === 9 && issueRun.code === "",
  `${issueRun.summary} | issues=${JSON.stringify(issueRun.issues)}`,
);

/* 取消（工具调用被中断 / 插件卸载）：signal 一 abort，子进程立刻被终结。 */
const abortCase = cannedHarness([{ exitCode: 0, stdout: JSON.stringify({ files: [], issues: [] }), manual: true }]);
const abortController = new AbortController();
abortController.abort();
const abortedRun = await tools.get("ocr_review").execute(
  { engine: "ocr" },
  { name: "ocr_review", callId: "aborted", arguments: {}, agent: makeAgent(), signal: abortController.signal },
);
check(
  "取消：signal 已 abort 时子进程被终结，结果报 OCR_ABORTED",
  abortedRun.ok === false && abortedRun.code === "OCR_ABORTED" && abortCase.canned.calls[0]?.terminated === true,
  `${abortedRun.code} terminated=${abortCase.canned.calls[0]?.terminated} | ${abortedRun.summary}`,
);

/* dispose：abort 在飞评审 + 等它收尾（不留孤儿进程，也不丢半截结果）。 */
const disposeCase = cannedHarness([{ exitCode: 0, stdout: JSON.stringify({ files: [], issues: [] }), delayMs: 300 }]);
const inflight = disposeCase.call({ engine: "ocr" });
await new Promise((resolve) => setTimeout(resolve, 40)); // 等 spawn 真的发生
const lifecycleEntry = disposeCase.ctx.effects.find((entry) => String(entry.label).includes("在飞"));
check(
  "生命周期：apply 注册了「在飞 ocr 评审的收尾」effect",
  Boolean(lifecycleEntry) && typeof lifecycleEntry.dispose === "function",
  (disposeCase.ctx.effects ?? []).map((entry) => entry.label).join(" / "),
);
let inflightSettled = false;
inflight.then(() => {
  inflightSettled = true;
});
const disposePromise = lifecycleEntry.dispose();
check("生命周期：dispose 返回 promise（可以等）", disposePromise instanceof Promise, typeof disposePromise);
await disposePromise;
check(
  "生命周期：dispose 等评审真的收尾后 promise 才 settle（不是立刻返回）",
  inflightSettled === true,
  `inflightSettled=${inflightSettled}`,
);
const disposeValue = await inflight;
check(
  "生命周期：dispose 会 abort 在飞的子进程（terminate 被调用）",
  disposeCase.canned.calls[0]?.terminated === true,
  `terminated=${disposeCase.canned.calls[0]?.terminated}`,
);
check(
  "生命周期：被 dispose 掐掉的评审标记为 OCR_ABORTED（不会当成功结果投递）",
  disposeValue.ok === false && disposeValue.code === "OCR_ABORTED",
  `${disposeValue.code} | ${disposeValue.summary}`,
);

/* ------------------------------------------- 独立评审 agent（只读子 agent + findings 往返） */

/** 罐头 SubagentRuntime：契约照 dsh-subagent 的 SubagentService（list / getProvider / start / interrupt）。 */
function cannedSubagents(script) {
  const calls = { start: [], interrupt: [], dispose: 0, list: 0, settle: null };
  const runtime = {
    list() {
      calls.list += 1;
      return ["spawn"];
    },
    getProvider(name) {
      return name === "spawn" ? { name: "spawn", agentRouteDefaults: { provider: "commandcode" } } : null;
    },
    start(provider, request) {
      calls.start.push({ provider, request });
      const item = (typeof script === "function" ? script(provider, request, calls.start.length) : script) || {};
      let resolvePending = () => {};
      const pending = new Promise((resolve) => {
        resolvePending = () => resolve(item.result ?? { stopReason: "aborted" });
      });
      calls.settle = resolvePending;
      const signal = request && request.signal;
      if (signal) {
        if (signal.aborted) resolvePending();
        else signal.addEventListener("abort", () => resolvePending(), { once: true });
      }
      const done = Promise.resolve(item.result ?? { stopReason: "completed", structured: item.structured });
      return {
        id: item.id ?? "child-" + calls.start.length,
        localAgent: { session: { header: { cwd: REPO } } },
        result: item.pending ? pending : done,
        dispose: async () => {
          calls.dispose += 1;
        },
      };
    },
    async interrupt(id, reason) {
      calls.interrupt.push({ id, reason });
      if (calls.settle) calls.settle();
      return true;
    },
  };
  return { runtime, calls };
}

/** 评审 agent 的规格来源：delegate preview → delegate rule → git diff（三条罐头命令）。 */
function reviewerSpecRuns(files = [{ path: "lib/a.js", insertions: 3, deletions: 1 }]) {
  return [
    { exitCode: 0, stdout: JSON.stringify({ files, excluded: [] }) },
    { exitCode: 0, stdout: JSON.stringify({ groups: [{ group_id: "g1", pattern: "**/*.js", rule: "不要把 undefined 当空值" }] }) },
    { exitCode: 0, stdout: "diff --git a/lib/a.js b/lib/a.js\n+if (x == null) {}\n" },
  ];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (predicate, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(25);
  return predicate();
};
const emitOn = (map, name, ...args) => {
  for (const handler of map.get(name) ?? []) handler(...args);
};
/** 把交付到某个 agent 的用户消息收进本地数组（不写全局 deliver，免得跟别的段串）。 */
function localAgent(sink, status = "idle") {
  return {
    status,
    session: { header: { cwd: REPO, origin: "user" } },
    inject: (message) => sink.push(message),
    followup: (message) => sink.push(message),
  };
}
const FINDINGS_ONE = {
  verdict: "issues",
  summary: "空值判断漏了 undefined",
  findings: [
    {
      file: "lib/a.js",
      line: 12,
      severity: "major",
      message: "x == null 之外的路径会读到 undefined",
      evidence: "调用方可能传 undefined",
      suggestion: "先做空值收敛再比较",
    },
  ],
};

/* 先跑「宿主没有 subagents 服务」的两条：reviewerRuntime 是插件模块级状态，后面的场景会把它绑上。 */
const bareCase = cannedHarness(reviewerSpecRuns(), { engine: "ocr" });
const bareForced = await bareCase.call({ reviewer: true });
check(
  "reviewer:true 但宿主没有 subagents：报 OCR_REVIEWER_UNAVAILABLE（不回落 ocr/delegate）",
  bareForced.ok === false && bareForced.code === "OCR_REVIEWER_UNAVAILABLE" && bareForced.engine === "agent" && bareForced.issues.length === 0,
  bareForced.code + " | " + bareForced.summary,
);
check(
  "缺 subagents 时的说明可执行（指向 reviewerProvider 与 off 两条出路）",
  bareForced.notes.some((n) => n.includes("reviewerProvider")) && bareForced.summary.includes("不可用"),
  JSON.stringify(bareForced.notes),
);

/* 自动档：开了 spawn 但宿主没有 subagents → 回落静态引擎，并在备注里说明。 */
const fbMap = new Map();
const fbSink = [];
const fbAgent = localAgent(fbSink);
const fbCase = cannedHarness(
  [
    { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "lib/a.js", insertions: 3, deletions: 1 }], excluded: [] }) },
    { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "lib/a.js", insertions: 3, deletions: 1 }], issues: [] }) },
  ],
  { engine: "ocr", reviewerAgent: "spawn", autoMinIntervalMs: 0 },
  { listeners: fbMap },
);
emitOn(fbMap, "tools/result", { name: "edit", agent: fbAgent }, { isError: false });
emitOn(fbMap, "agent/turn-stopping", { agent: fbAgent, reason: "test" });
await waitUntil(() => fbSink.length > 0);
const fbText = fbSink.length > 0 ? textOf(fbSink[0]) : "";
check(
  "自动档 reviewer.agent=spawn 但缺 subagents：回落 ocr/delegate 并在备注里说明",
  fbSink.length === 1 && !fbText.includes("【独立评审 agent ·") && fbText.includes("独立评审 agent 不可用") && fbText.includes("engine=ocr"),
  fbSink.length + " 条交付 | " + fbText.slice(0, 160),
);

/* 设置里关着 reviewer.agent（默认 off）：即使宿主有 subagents 也一次都不起。 */
const offSub = cannedSubagents({ structured: { verdict: "clean", summary: "审完没问题", findings: [] } });
const offRuns = [{ exitCode: 0, stdout: JSON.stringify({ files: [{ path: "lib/a.js", insertions: 1, deletions: 0 }], issues: [] }) }];
const offCase = cannedHarness(offRuns, { engine: "ocr", reviewerAgent: "off" }, { subagents: offSub.runtime });
const offRun = await offCase.call({});
check(
  "reviewer.agent=off（默认）：评审走 ocr，子 agent 零调用",
  offRun.engine === "ocr" && offRun.code === "" && offSub.calls.start.length === 0,
  offRun.engine + " code=" + offRun.code + " start=" + offSub.calls.start.length,
);
const offForced = cannedHarness(offRuns, { engine: "ocr", reviewerAgent: "spawn" }, { subagents: offSub.runtime });
const offForcedRun = await offForced.call({ reviewer: false });
check(
  "reviewer:false 会压过设置里的 spawn（强制走 ocr/delegate）",
  offForcedRun.engine === "ocr" && offSub.calls.start.length === 0,
  offForcedRun.engine + " start=" + offSub.calls.start.length,
);
check("给的 subagents 服务在 apply 时被登记过（list 被调用）", offSub.calls.list >= 1, "list=" + offSub.calls.list);

/* 工具入口 reviewer:true：起一个只读子 agent，拿结构化 findings。 */
const okSub = cannedSubagents({ structured: FINDINGS_ONE });
const okCase = cannedHarness(reviewerSpecRuns(), { engine: "ocr" }, { subagents: okSub.runtime });
const okRun = await okCase.call({ reviewer: true });
const okStart = okSub.calls.start[0];
const okPrompt = okStart ? okStart.request.prompt.map((b) => b.text).join("") : "";
check(
  "工具入口 reviewer:true：engine=agent、findings 进 issues、单轮（第 1/1 轮）",
  okRun.ok === true && okRun.engine === "agent" && okRun.issues.length === 1 && okRun.issues[0].severity === "major" && okRun.reviewer.round === 1 && okRun.reviewer.rounds === 1 && okRun.reviewer.childId === "child-1",
  okRun.engine + " issues=" + okRun.issues.length + " reviewer=" + JSON.stringify(okRun.reviewer),
);
check(
  "子 agent 只拿到只读工具、结构化 schema、父 agent 与人格（不共享编码上下文）",
  Boolean(okStart) && okStart.provider === "spawn" && okStart.request.toolFilter.allow.join(",") === "read,grep,glob" && okStart.request.outputSchema.properties.verdict.enum.join(",") === "clean,issues,uncertain" && okStart.request.parent === okCase.exec.agent && String(okStart.request.persona || "").length > 0 && okStart.request.label.includes("第 1/1 轮"),
  okStart ? JSON.stringify({ provider: okStart.provider, allow: okStart.request.toolFilter.allow, label: okStart.request.label }) : "start 没被调用",
);
check(
  "评审提示词带着 ocr 的规则正文与 diff（规格仍来自 ocr，不由 agent 自己找范围）",
  okPrompt.includes("不要把 undefined 当空值") && okPrompt.includes("diff --git a/lib/a.js") && okPrompt.includes("## 审查规格"),
  "prompt 长度=" + okPrompt.length + " | " + okPrompt.slice(0, 200).replace(/\n/g, " / "),
);
check("每次子 agent 跑完都 dispose（不泄漏子会话）", okSub.calls.dispose === 1, "dispose=" + okSub.calls.dispose);

/* 失败路径：一律不当作通过。 */
const errSub = cannedSubagents({ result: { stopReason: "error", diagnostic: "provider 502" } });
const errCase = cannedHarness(reviewerSpecRuns(), { engine: "ocr" }, { subagents: errSub.runtime });
const errRun = await errCase.call({ reviewer: true });
check(
  "评审 agent 结束理由不是 completed：OCR_REVIEWER_FAILED（绝不当作通过）",
  errRun.ok === false && errRun.code === "OCR_REVIEWER_FAILED" && errRun.reviewer.stopReason === "error" && errRun.notes.some((n) => n.includes("502")),
  errRun.code + " | " + errRun.summary,
);
const noStructSub = cannedSubagents({ result: { stopReason: "completed" } });
const noStructCase = cannedHarness(reviewerSpecRuns(), { engine: "ocr" }, { subagents: noStructSub.runtime });
const noStructRun = await noStructCase.call({ reviewer: true });
check(
  "structured 缺失：OCR_REVIEWER_FAILED 且 ok=false（fail-closed）",
  noStructRun.ok === false && noStructRun.code === "OCR_REVIEWER_FAILED" && noStructRun.notes.some((n) => n.includes("fail-closed")),
  noStructRun.code + " | " + noStructRun.summary,
);
const unsureSub = cannedSubagents({ structured: { verdict: "uncertain", summary: "看不到调用方，无法判断" } });
const unsureCase = cannedHarness(reviewerSpecRuns(), { engine: "ocr" }, { subagents: unsureSub.runtime });
const unsureRun = await unsureCase.call({ reviewer: true });
check(
  "verdict=uncertain：OCR_REVIEWER_UNCERTAIN 且 ok=false（不算通过）",
  unsureRun.ok === false && unsureRun.code === "OCR_REVIEWER_UNCERTAIN" && unsureRun.reviewer.verdict === "uncertain" && unsureRun.notes.some((n) => n.includes("uncertain 不算通过")),
  unsureRun.code + " | " + unsureRun.summary,
);

/* 自动档：第 1 轮由独立子 agent 执行并交付 findings 清单。 */
const autoSub = cannedSubagents({ structured: FINDINGS_ONE });
const autoMap = new Map();
const autoSink = [];
const revAutoAgent = localAgent(autoSink);
const autoCase = cannedHarness(
  [
    { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "lib/a.js", insertions: 3, deletions: 1 }], excluded: [] }) },
    ...reviewerSpecRuns(),
  ],
  { engine: "ocr", reviewerAgent: "spawn", reviewerRounds: 3, autoMinIntervalMs: 0 },
  { subagents: autoSub.runtime, listeners: autoMap },
);
emitOn(autoMap, "tools/result", { name: "edit", agent: revAutoAgent }, { isError: false });
emitOn(autoMap, "agent/turn-stopping", { agent: revAutoAgent, reason: "test" });
await waitUntil(() => autoSink.length > 0);
const revAutoText = autoSink.length > 0 ? textOf(autoSink[0]) : "";
check(
  "自动档第 1 轮：交付带轮次 + findings 清单 + 「请逐条修复或说明理由」",
  autoSink.length === 1 && revAutoText.includes("【独立评审 agent · 第 1/3 轮】") && revAutoText.includes("lib/a.js:12") && revAutoText.includes("[major]") && revAutoText.includes("请逐条修复或说明理由"),
  autoSink.length + " 条 | " + revAutoText.slice(0, 200).replace(/\n/g, " / "),
);
check(
  "自动档：子 agent 的 parent 就是编码 agent，且只给只读工具",
  autoSub.calls.start.length === 1 && autoSub.calls.start[0].request.parent === revAutoAgent && autoSub.calls.start[0].request.toolFilter.allow.join(",") === "read,grep,glob",
  "start=" + autoSub.calls.start.length,
);

/* clean 之后线程关闭：换签名再来一次，又该从「第 1/3 轮」开始（不是第 2 轮）。 */
const cleanSub = cannedSubagents({ structured: { verdict: "clean", summary: "审完没问题", findings: [] } });
const cleanMap = new Map();
const cleanSink = [];
const cleanAgent = localAgent(cleanSink);
const cleanRoundCase = cannedHarness(
  [
    { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "lib/a.js", insertions: 3, deletions: 1 }], excluded: [] }) },
    ...reviewerSpecRuns(),
    { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "lib/a.js", insertions: 9, deletions: 1 }], excluded: [] }) },
    ...reviewerSpecRuns([{ path: "lib/a.js", insertions: 9, deletions: 1 }]),
  ],
  { engine: "ocr", reviewerAgent: "spawn", reviewerRounds: 3, autoMinIntervalMs: 0 },
  { subagents: cleanSub.runtime, listeners: cleanMap },
);
emitOn(cleanMap, "tools/result", { name: "edit", agent: cleanAgent }, { isError: false });
emitOn(cleanMap, "agent/turn-stopping", { agent: cleanAgent, reason: "test" });
await waitUntil(() => cleanSink.length >= 1);
emitOn(cleanMap, "tools/result", { name: "edit", agent: cleanAgent }, { isError: false });
emitOn(cleanMap, "agent/turn-stopping", { agent: cleanAgent, reason: "test" });
await waitUntil(() => cleanSink.length >= 2);
const cleanText1 = cleanSink[0] ? textOf(cleanSink[0]) : "";
const cleanText2 = cleanSink[1] ? textOf(cleanSink[1]) : "";
check(
  "clean 之后线程关闭：换签名再评又回到「第 1/3 轮」",
  cleanSink.length === 2 && cleanText1.includes("第 1/3 轮") && cleanText1.includes("未发现问题") && cleanText2.includes("第 1/3 轮") && cleanSub.calls.start.length === 2,
  "交付=" + cleanSink.length + " start=" + cleanSub.calls.start.length + " | " + cleanText2.slice(0, 140),
);

/* 轮次上限：reviewerRounds=1 且还有未确认的问题 → 第二轮不再起子 agent。 */
const capSub = cannedSubagents({ structured: FINDINGS_ONE });
const capMap = new Map();
const capSink = [];
const capAgent = localAgent(capSink);
const capCase = cannedHarness(
  [
    { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "lib/a.js", insertions: 3, deletions: 1 }], excluded: [] }) },
    ...reviewerSpecRuns(),
    { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "lib/a.js", insertions: 9, deletions: 1 }], excluded: [] }) },
  ],
  { engine: "ocr", reviewerAgent: "spawn", reviewerRounds: 1, autoMinIntervalMs: 0 },
  { subagents: capSub.runtime, listeners: capMap },
);
emitOn(capMap, "tools/result", { name: "edit", agent: capAgent }, { isError: false });
emitOn(capMap, "agent/turn-stopping", { agent: capAgent, reason: "test" });
await waitUntil(() => capSink.length >= 1);
emitOn(capMap, "tools/result", { name: "edit", agent: capAgent }, { isError: false });
emitOn(capMap, "agent/turn-stopping", { agent: capAgent, reason: "test" });
await waitUntil(() => capSink.length >= 2);
const capText2 = capSink[1] ? textOf(capSink[1]) : "";
check(
  "reviewerRounds=1：还有未确认的问题就到上限收工（不再起子 agent）",
  capSink.length === 2 && capText2.includes("已达轮次上限") && capText2.includes("lib/a.js:12") && capSub.calls.start.length === 1,
  "交付=" + capSink.length + " start=" + capSub.calls.start.length + " | " + capText2.slice(0, 160),
);

/* ocr_status 的 reviewer 诊断段：把「为什么没起来」摆给用户看。 */
const stSub = cannedSubagents({ structured: { verdict: "clean", summary: "x", findings: [] } });
const stCase = cannedHarness([{ exitCode: 0, stdout: "ocr 9.9.9" }], { reviewerAgent: "spawn", reviewerProvider: "spawn", reviewerRounds: 3 }, { subagents: stSub.runtime });
const stRun = await tools.get("ocr_status").execute({ checkLlm: false }, stCase.exec);
check(
  "ocr_status 报出评审 agent 的可用性 / provider 清单 / 轮数",
  stRun.reviewer.enabled === true && stRun.reviewer.available === true && stRun.reviewer.providers.join(",") === "spawn" && stRun.reviewer.rounds === 3 && stRun.reviewer.ready === true,
  JSON.stringify(stRun.reviewer),
);

/* dispose：在飞的评审子 agent 会被 abort + dispose（不留孤儿子会话）。 */
const hangSub = cannedSubagents({ pending: true });
const hangCase = cannedHarness(reviewerSpecRuns(), { engine: "ocr" }, { subagents: hangSub.runtime });
const hangRun = hangCase.call({ reviewer: true });
await waitUntil(() => hangSub.calls.start.length > 0);
const hangEntry = hangCase.ctx.effects.find((entry) => String(entry.label).includes("在飞"));
await hangEntry.dispose();
const hangValue = await hangRun;
check(
  "dispose：在飞的评审子 agent 收到 abort，结果报 OCR_ABORTED（不留孤儿）",
  hangValue.ok === false && hangValue.code === "OCR_ABORTED" && hangSub.calls.dispose >= 1,
  hangValue.code + " | " + hangValue.summary + " dispose=" + hangSub.calls.dispose,
);
if (which("ocr")) {
  /* 罐头 ctx 覆盖了同名工具，先切回真子进程的注册再跑真 ocr。 */
  mod.apply(ctx, schemaRefs);
  const ocrOnly = await tools.get("ocr_review").execute({ engine: "ocr" }, exec);
  check(
    "engine=ocr 且没配 LLM 端点：返回 OCR_LLM_MISSING（真 ocr，不静默降级）",
    ocrOnly.ok === false && ocrOnly.code === "OCR_LLM_MISSING",
    `${ocrOnly.code} | ${ocrOnly.summary}`,
  );
}

/* ------------------------------------------------------------------ 汇总 */

console.log("\n=== 结果 ===");
for (const line of results) console.log(line);
console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}（共 ${results.length} 项）`);
process.exit(failures === 0 ? 0 : 1);
