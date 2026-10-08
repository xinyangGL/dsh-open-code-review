/**
 * 离线冒烟测试：不依赖 DSH 宿主，用假的 ctx（subprocess 由 node:child_process 实现）
 * 直接驱动插件 apply()，取出注册的工具/命令并跑真实的 ocr 命令。
 *
 * 用法：node test/smoke.mjs [被测仓库路径]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, statSync } from "node:fs";
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
const resolvedRefs = [];

function makeCtx() {
  return {
    subprocess: {
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
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
      return () => {
        const list = listeners.get(name) ?? [];
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
  };
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
check("参数缺失时明确报错且不执行命令", bad.ok === false && bad.summary.includes("需要 commit"), bad.summary);

/* 用全新空目录当"非 git 仓库"样本：插件自己现在是个 git 仓库（用户要求建 GitHub 仓库时 git init 过），
   不能再拿它当反例。 */
const nonRepoDir = mkdtempSync(join(tmpdir(), "ocr-nongit-"));
const notRepo = await tools.get("ocr_review").execute({ preview: true, repo: nonRepoDir }, exec);
check("非 git 仓库：给出可读诊断而不是裸 stderr", notRepo.ok === false && notRepo.summary.includes("不是 git 仓库") && notRepo.configHint.length > 0, notRepo.summary);

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
check("enabled=false：ocr_review 拒绝执行并指向设置页", offReview.ok === false && offReview.summary.includes("已在设置里关闭"), offReview.summary);

const offCmd = await commands.get("ocr-review").handler({ agent: makeAgent(), rawInput: "", attachments: [], signal: undefined });
check("enabled=false：/ocr-review 返回错误", offCmd?.kind === "error" && String(offCmd.text).includes("已在设置里关闭"), JSON.stringify(offCmd));

const offStatus = await tools.get("ocr_status").execute({ checkLlm: false }, exec);
check("enabled=false：ocr_status 仍可用于诊断", offStatus.ok === true && offStatus.enabled === false, `enabled=${offStatus.enabled} ref=${offStatus.credentialRef}`);

/* ------------------------------------------------------------------ 汇总 */

console.log("\n=== 结果 ===");
for (const line of results) console.log(line);
console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}（共 ${results.length} 项）`);
process.exit(failures === 0 ? 0 : 1);
