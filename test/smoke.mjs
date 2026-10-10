/**
 * 离线冒烟测试：不依赖 DSH 宿主，用假的 ctx（subprocess 由 node:child_process 实现）
 * 直接驱动插件 apply()，取出注册的工具/命令并跑真实的 ocr 命令。
 *
 * 用法：node test/smoke.mjs [被测仓库路径]
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertToolContract, assertToolPayload, assertToolSchemas, losslessViolations, payloadViolations, schemaViolations, snapshotJsonValue } from "./schema-subset.mjs";

/** 夹具仓库的基线版本（已提交）。 */
const FIXTURE_BASE = `export function add(a, b) {
  return a + b
}

export function divide(a, b) {
  return a / b
}
`;

/** 夹具仓库的工作区版本（未提交改动：修了除零、加了一个函数）。 */
const FIXTURE_CHANGED = `export function add(a, b) {
  return a + b
}

export function divide(a, b) {
  if (b === 0) throw new Error('division by zero')
  return a / b
}

export function parseConfig(raw) {
  return JSON.parse(raw)
}
`;

/**
 * 离线测试夹具：一个「有未提交改动」的 git 仓库，在系统临时目录里自建。
 * 这样测试不依赖任何机器上的既有目录；传 argv[2] 可以改用别的仓库。
 */
function ensureFixtureRepo() {
  const dir = join(tmpdir(), "ocr-smoke-repo");
  const file = join(dir, "calc.js");
  const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, FIXTURE_BASE, "utf8");
    git("init", "-q");
    git("config", "user.email", "ocr-smoke@example.invalid");
    git("config", "user.name", "ocr smoke");
    git("add", "calc.js");
    git("commit", "-q", "-m", "fixture: baseline");
  }
  // 保证「有未提交改动」这个前提始终成立（重复跑、上次被谁改过都能自愈）。
  writeFileSync(file, FIXTURE_CHANGED, "utf8");
  return dir;
}

const REPO = process.argv[2] ?? ensureFixtureRepo();
const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
  // 默认不打印（结果统一在文件末尾输出，保持输出整洁）；排查卡死时用 OCR_SMOKE_TRACE=1 看进度。
  if (process.env.OCR_SMOKE_TRACE === "1") console.log(`      [trace ${Date.now() - startedAt}ms] ${ok ? "PASS" : "FAIL"} ${name}`);
}
const startedAt = Date.now();

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
        // 真宿主在 register 时会用 dsh-tools 的 assertSupportedJsonSchema 检查 output.schema，
        // 违反就抛 JsonSchemaError，让整个插件 fiber 加载失败（v0.3.0 就这么炸过一次）。
        // 这里照同一套规则校验，免得只有真人重启 DSH 才暴露。
        assertToolSchemas(definition.name, definition);
        // 宿主在**调用期**还有两道门（dsh-tools/lib/index.js:3541-3571）：先 snapshotJsonValue
        // 要求返回值无损 JSON，再用 output.schema 校验（多一个未声明字段就报
        // `"value.aborted" is not a declared property`），所以这里也把 execute 包一层。
        const schema = definition?.output?.schema;
        const execute = definition?.execute;
        if (schema && typeof execute === "function") {
          const wrapped = { ...definition };
          wrapped.execute = async (...args) => {
            const value = await execute.apply(wrapped, args);
            assertToolContract(definition.name, definition, value);
            return value;
          };
          definition = wrapped;
        }
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
  if (overrides.jobs) ctx.jobs = overrides.jobs;
  /* 命令注册服务也可以替换：用来模拟「register() 抛错」这种宿主侧失败。 */
  if (overrides.commands) ctx.commands = overrides.commands;
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

/**
 * CI（裸 clone + node，不跑 pnpm install）里没有 DSH 的 @deepseek-ai/schemastery：
 * lib/config.js 的动态 import 会失败，SCHEMA_AVAILABLE=false / Config=undefined。这不是 bug，
 * 是设计好的降级（schema 由宿主提供，设置页据此生成）。所以这里按环境挑写法：
 *   · 有 schema：Config(patch) —— 和宿主真实调用一致（含 volatile 引用）
 *   · 没有：普通对象 —— apply() 内部走 schemaOverrides()，只认 SCHEMA_KEY_MAP 里的键，语义相同
 * package.json 已把 @deepseek-ai/schemastery 声明为「可选 peerDependency」（社区插件 dshmarket 同款做法），
 * 真实安装（pnpm/git）会把它链到插件目录或由 profile 提供，用户侧不会掉设置页。
 */
const HAS_SCHEMA = mod.SCHEMA_AVAILABLE === true && typeof mod.Config === "function";
const mkConfig = (patch = {}) => (HAS_SCHEMA ? mod.Config(patch) : { ...patch });

/**
 * CI（裸 clone + node，不跑 pnpm/npm 全局安装）里没有真 ocr：@alibaba-group/open-code-review 是 npm
 * 全局包，Actions 上不存在。本机开发机装了，所以以前这些用例只在「有 ocr」的机器上验过。
 * 现在两种环境都跑，同一条 check 换期望值（断言数恒定）：
 *   · 有 ocr：真实链路（定位 → 跑 ocr → 解析 → 进度 job）全验
 *   · 没有：验「定位失败」的诊断路径 —— 新用户最常见的第一屏（OCR_NOT_FOUND + 安装指引），
 *     以及 fail-closed 行为（不装 ocr 时绝不开一个假装在评审的 job）
 * 探测方式与插件一致（lib/ocr-cli.js 的 resolveOcr：显式路径 → 候选目录 → PATH），
 * 顺带把命中的路径写进它的模块级 cachedExecutable，后面的真实用例就不用再找一遍。
 */
const HAS_OCR = await (async () => {
  try {
    const probe = {
      subprocess: {
        resolveExecutable: async (cmd) => {
          const found = which(cmd);
          if (!found) throw new Error(`not found on PATH: ${cmd}`);
          return found;
        },
      },
    };
    const resolved = await cli.resolveOcr(probe, cfgMod.loadConfig({}), undefined);
    return Boolean(resolved?.path);
  } catch {
    return false;
  }
})();

/** 两种环境都跑同一条 check，只是期望值不同。 */
function checkEither(name, withOcr, withoutOcr, detail) {
  check(name, HAS_OCR ? withOcr : withoutOcr, detail);
}

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

if (HAS_SCHEMA) {
  check("导出 schemastery Config（DSH 据此生成设置页）", mod.SCHEMA_AVAILABLE === true && Boolean(mod.Config), `SCHEMA_AVAILABLE=${mod.SCHEMA_AVAILABLE}`);
} else {
  check(
    "没有 @deepseek-ai/schemastery 时优雅降级（CI 就是这种环境）：Config 为 undefined，其余导出照常可用",
    mod.Config === undefined &&
      typeof cfgMod.loadConfig === "function" &&
      typeof cfgMod.normalizeConfig === "function" &&
      typeof cfgMod.schemaOverrides === "function",
    `SCHEMA_AVAILABLE=${mod.SCHEMA_AVAILABLE}`,
  );
}
const schema = HAS_SCHEMA ? mod.Config : null;
let schemaRefs = null;
try {
  schemaRefs = typeof schema === "function" ? schema({ llmModel: "deepseek/deepseek-v4.1-flash", llmApiKeyRef: "SMOKE_OCR_KEY" }) : null;
} catch (err) {
  log(`schema 解析失败：${err?.message ?? err}`);
}
if (HAS_SCHEMA) {
  check(
    "设置页字段是 volatile 引用（有 .get()）",
    Boolean(schemaRefs) && typeof schemaRefs?.llmApiKeyRef?.get === "function" && schemaRefs.llmApiKeyRef.get() === "SMOKE_OCR_KEY",
    `llmApiKeyRef=${typeof schemaRefs?.llmApiKeyRef?.get === "function" ? schemaRefs.llmApiKeyRef.get() : "(无)"}`,
  );
} else {
  check(
    "没有 schema 时不解析 volatile 引用，但扁平字段映射照常（CI 路径：插件功能不依赖这个包）",
    schemaRefs === null && cfgMod.schemaOverrides({ autoReview: { get: () => "adaptive" } })?.auto === "adaptive",
    `schemaRefs=${schemaRefs ? "有" : "无"}`,
  );
}

/**
 * 宿主（设置页 / host 持久层）交给 apply() 的那份补丁：有 schema 时是 Config 实例（设置页字段是 volatile
 * 引用），CI 上没有这个包就退化成同形状的普通对象 —— apply 内部走 schemaOverrides()，两者语义一致。
 */
const settingsPatch = schemaRefs ?? mkConfig({ llmModel: "deepseek/deepseek-v4.1-flash", llmApiKeyRef: "SMOKE_OCR_KEY" });

const ref = (value) => Object.freeze({ get: () => value });
const overrides = cfgMod.schemaOverrides({
  engine: ref("ocr"),
  autoReview: ref("adaptive"),
  timeoutMinutes: ref(20),
  llmModel: ref("deepseek/deepseek-v4.1-flash"),
  llmApiKeyRef: ref("SMOKE_OCR_KEY"),
  ocrPath: ref(""),
  verbose: ref(true),
});
check(
  "schemaOverrides：扁平字段名 → 生效配置路径（llm.* / autoReview→auto / 空串回落）",
  overrides?.llm?.model === "deepseek/deepseek-v4.1-flash" &&
    overrides?.llm?.apiKeyRef === "SMOKE_OCR_KEY" &&
    overrides?.engine === "ocr" &&
    overrides?.auto === "adaptive" &&
    overrides?.timeoutMinutes === 20 &&
    overrides?.ocrPath === undefined &&
    overrides?.verbose === true &&
    cfgMod.schemaOverrides(null) === null,
  JSON.stringify(overrides),
);
check(
  "schemaOverrides（v0.5.8）：取值恰好等于出厂默认的字段不算覆盖项（否则 schema 默认值会把 config.json 整层遮住）",
  cfgMod.schemaOverrides({ preTest: ref("off"), timeoutMinutes: ref(15), enabled: ref(true), onDemand: ref(true) }) === null &&
    cfgMod.schemaOverrides({ preTest: ref("gate") })?.preTest === "gate",
  `${JSON.stringify(cfgMod.schemaOverrides({ preTest: ref("off"), timeoutMinutes: ref(15), enabled: ref(true), onDemand: ref(true) }))} / ${JSON.stringify(cfgMod.schemaOverrides({ preTest: ref("gate") }))}`,
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

/* 评审进度（可选 jobs 服务）替身：ctx 上有它，插件才会把每次评审登记成 job。
   定义在文件末尾那节，函数声明会提升；这里先建实例（const 不提升）。 */
const progressRegistry = makeJobsRegistry();
const ctx = makeCtx();
ctx.jobs = progressRegistry;
mod.apply(ctx, settingsPatch);
check("注册了 ocr_review / ocr_status / ocr-review", tools.has("ocr_review") && tools.has("ocr_status") && commands.has("ocr-review"), [...tools.keys()].join(","));
check("工具声明了 output.schema + render", typeof tools.get("ocr_review").output?.render === "function" && tools.get("ocr_review").output.schema?.type === "object");

/* 调用期的第二道关卡（宿主拿 output.schema 校验 execute 的返回值）：makeCtx 的 register 已经把
   execute 包了一层（见上面 tools.register），所以本文件里每一次工具调用都真的被校验过。
   v0.3.1 真机上暴露的 `"value.aborted" is not a declared property` 就是这么被抓出来的。 */
const payloadSelfCheck = {
  extra: payloadViolations(
    { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
    { ok: true, aborted: true },
    "value",
  ),
  missing: payloadViolations({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, {}, "value"),
  wrongType: payloadViolations({ type: "object", properties: { ok: { type: "boolean" } } }, { ok: "yes" }, "value"),
  nullable: payloadViolations(
    {
      type: "object",
      properties: {
        bridge: { oneOf: [{ type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false }, { type: "null" }] },
        files: { type: "array", items: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
      },
      required: ["bridge"],
    },
    { bridge: null, files: [{ path: "a.js" }] },
    "value",
  ),
};
check(
  "返回值校验器自检：未声明字段 / 缺必填 / 类型不符能抓出来，oneOf 可空与数组元素不误报",
  payloadSelfCheck.extra.includes('"value.aborted" is not a declared property (additionalProperties: false)') &&
    payloadSelfCheck.missing.includes("value.ok is required") &&
    payloadSelfCheck.wrongType.includes("value.ok must be a boolean, got string") &&
    payloadSelfCheck.nullable.length === 0,
  `extra=${payloadSelfCheck.extra.length} missing=${payloadSelfCheck.missing.join("|")} type=${payloadSelfCheck.wrongType.join("|")} nullable=${payloadSelfCheck.nullable.length}`,
);

/* ------------------------------- 注册的工具 schema 必须属于 DSH 支持的子集 */
/* v0.3.0 的教训：ocr_status 的 output.schema 里 `bridge: { type: ["object","null"] }`
   被 dsh-tools 的 assertSupportedJsonSchema 拒绝（type 数组/anyOf 都不支持），
   register 抛 JsonSchemaError → 整个 host fiber 加载失败 → ocr_review 变 unknown tool，
   而六套单测依旧全绿（假 ctx 的 register 不校验）。这里补上同一套规则。 */
const toolSchemasOk = [...tools.values()].map((definition) => ({
  name: definition.name,
  problems: [
    ...schemaViolations(definition.parameters ?? {}, `${definition.name}.parameters`),
    ...schemaViolations(definition.output?.schema ?? {}, `${definition.name}.output.schema`),
  ],
}));
for (const entry of toolSchemasOk) for (const problem of entry.problems) log(`${entry.name}：${problem}`);
check(
  "注册的工具 schema 属于 DSH 子集（宿主 register 不会抛 JsonSchemaError）",
  tools.size >= 2 && toolSchemasOk.every((entry) => entry.problems.length === 0),
  toolSchemasOk.map((entry) => `${entry.name}${entry.problems.length ? `(${entry.problems.length} 处违规)` : ""}`).join(", "),
);
const bridgeSchema = tools.get("ocr_status")?.output?.schema?.properties?.bridge;
check(
  "ocr_status.bridge 用 oneOf 表达「对象或 null」（桥没起来时 payload 仍是 null）",
  Array.isArray(bridgeSchema?.oneOf) && bridgeSchema.oneOf.length === 2 && bridgeSchema.oneOf[1]?.type === "null" && bridgeSchema.type === undefined,
  `oneOf 分支=${bridgeSchema?.oneOf?.length ?? 0}`,
);
check(
  "schema 子集校验器自检：type 数组 / anyOf / 单分支 oneOf / 关键字挂错类型都能抓出来",
  schemaViolations({ type: "object", properties: { x: { type: ["string", "null"] } } }, "s").some((line) => line.includes("type arrays are not supported")) &&
    schemaViolations({ type: "object", properties: { x: { anyOf: [{ type: "string" }] } } }, "s").some((line) => line.includes("not a supported keyword")) &&
    schemaViolations({ type: "object", properties: { x: { oneOf: [{ type: "string" }] } } }, "s").some((line) => line.includes("at least two")) &&
    schemaViolations({ type: "object", properties: { x: { type: "string", properties: {} } } }, "s").some((line) => line.includes('not supported on type "string"')) &&
    schemaViolations({ type: "object", properties: { x: { oneOf: [{ type: "object", properties: { y: { type: "null" } }, required: ["y"], additionalProperties: false }, { type: "null" }] } } }, "s").length === 0,
);

const agent = makeAgent();
const exec = { name: "ocr_review", callId: "call-1", arguments: {}, agent, signal: undefined };

const preview = await tools.get("ocr_review").execute({ preview: true }, exec);
checkEither(
  "preview：拿到可审文件（没装 ocr 时给出 OCR_NOT_FOUND + 安装指引）",
  preview.ok === true && preview.reviewableFiles.length >= 1,
  preview.ok === false &&
    preview.code === "OCR_NOT_FOUND" &&
    preview.summary.includes("无法定位 ocr") &&
    preview.notes.some((n) => n.includes("@alibaba-group/open-code-review")),
  HAS_OCR ? `${preview.summary} | files=${preview.reviewableFiles.map((f) => f.path).join(",")}` : `${preview.code} | ${preview.summary} | 安装指引=${preview.notes.some((n) => n.includes("npm i -g"))}`,
);
check("设置页里的凭据引用被真的解析（ctx.credentials.resolve）", resolvedRefs.includes("SMOKE_OCR_KEY"), `resolvedRefs=${JSON.stringify([...new Set(resolvedRefs)])}`);

const delegated = await tools.get("ocr_review").execute({ engine: "delegate" }, exec);
checkEither(
  "delegate：产出审查规格（含文件/规则/diff；没装 ocr 时先报 OCR_NOT_FOUND）",
  delegated.ok === true && delegated.engine === "delegate" && delegated.reviewSpec.includes("委派审查规格") && delegated.reviewSpec.includes("calc.js") && /^###\s+组/m.test(delegated.reviewSpec) && delegated.reviewSpec.includes("```diff"),
  delegated.ok === false && delegated.code === "OCR_NOT_FOUND",
  HAS_OCR ? `${delegated.summary} | spec=${delegated.reviewSpec.length} 字符` : `${delegated.code} | ${delegated.summary}`,
);

const auto = await tools.get("ocr_review").execute({}, exec);
checkEither(
  "auto：无 LLM 端点时降级 delegate 并给出配置指引（没装 ocr 时先报 OCR_NOT_FOUND）",
  auto.ok === true && auto.engine === "delegate" && auto.configHint.includes("no valid LLM endpoint configured"),
  auto.ok === false && auto.code === "OCR_NOT_FOUND",
  `${auto.summary} | notes=${auto.notes.join(" / ")}`,
);

const bad = await tools.get("ocr_review").execute({ scope: "commit" }, exec);
check("参数缺失时明确报错且不执行命令", bad.ok === false && bad.code === "OCR_INVALID_ARGS" && bad.summary.includes("需要 commit"), `${bad.code} | ${bad.summary}`);

/* 用全新空目录当"非 git 仓库"样本：插件自己现在是个 git 仓库（用户要求建 GitHub 仓库时 git init 过），
   不能再拿它当反例。 */
const nonRepoDir = mkdtempSync(join(tmpdir(), "ocr-nongit-"));
const notRepo = await tools.get("ocr_review").execute({ preview: true, repo: nonRepoDir }, exec);
checkEither(
  "非 git 仓库：给出可读诊断而不是裸 stderr（没装 ocr 时先报 OCR_NOT_FOUND）",
  notRepo.ok === false && notRepo.code === "OCR_NOT_GIT_REPO" && notRepo.summary.includes("不是 git 仓库") && notRepo.configHint.length > 0,
  notRepo.ok === false && notRepo.code === "OCR_NOT_FOUND",
  `${notRepo.code} | ${notRepo.summary}`,
);

const status = await tools.get("ocr_status").execute({}, exec);
checkEither(
  "ocr_status：定位 exe + 版本 + LLM 连通性（没装 ocr 时给出 OCR_NOT_FOUND + 安装指引，且字段自洽）",
  status.ok === true && status.executable.includes("opencodereview") && status.version.length > 0 && status.llmTest.startsWith("不可用"),
  status.ok === false &&
    status.code === "OCR_NOT_FOUND" &&
    status.executable === "" &&
    status.version === "" &&
    status.installHint.includes("@alibaba-group/open-code-review") &&
    status.skill?.name === "ocr-on-demand-review" &&
    status.bridge === null,
  `${status.version} | ${status.llmTest.slice(0, 90)} | installHint=${status.installHint.length} 字符`,
);

const rendered = tools.get("ocr_review").output.render({}, delegated)[0].text;
checkEither(
  "render 输出人类/模型可读文本",
  rendered.includes("委派审查规格") && rendered.includes("engine=delegate"),
  rendered.includes("OCR_NOT_FOUND"),
  `${rendered.length} 字符`,
);

/* v0.5.0 步骤 3：按需评审（按钮 + skill）的状态必须在 ocr_status 里可见；
   这个实例的宿主没有 skills 服务 → registered=false 且给出原因（真机核验时必须是 true）。 */
check(
  "ocr_status（v0.5.0 步骤 3）：报出 onDemand 与 skill 状态（没有 skills 服务时说明原因）",
  status.onDemand === true &&
    status.skill?.name === "ocr-on-demand-review" &&
    status.skill?.registered === false &&
    String(status.skill?.reason).includes("skills 服务") &&
    status.notes.some((n) => n.includes("按需评审")),
  `onDemand=${status.onDemand} skill=${JSON.stringify(status.skill)}`,
);
check(
  "ocr_status（v0.5.7/v0.6.0）：报出 preTest 的 mode / mechanism / 累计次数 / fail-open 与最后一次判定",
  status.preTest !== null &&
    typeof status.preTest === "object" &&
    ["off", "remind", "gate"].includes(status.preTest.mode) &&
    ["pre-execute", "none"].includes(status.preTest.mechanism) &&
    Number.isFinite(status.preTest.denials) &&
    Number.isFinite(status.preTest.reminders) &&
    Number.isFinite(status.preTest.failOpen) &&
    typeof status.preTest.lastError === "string" &&
    typeof status.preTest.lastDecision === "object" &&
    typeof status.preTest.lastDecision.tool === "string" &&
    typeof status.preTest.lastDecision.kind === "string" &&
    Number.isFinite(status.preTest.lastDecision.at),
  JSON.stringify(status.preTest),
);

/* ------------------------------------------------------------- 端到端：按需 / 自动 */

/* v0.5.0 起出厂默认 auto=off（按需评审：回合尾部按钮 + skill）：写完文件的回合结束**不该**自动注入。
   这条以前是「默认就会注入」，默认改了以后它变成第一道断言。 */
const autoAgent = makeAgent();
emit("tools/result", { name: "edit", agent: autoAgent, callId: "c2", arguments: {} }, { isError: false });
emit("agent/turn-stopping", { agent: autoAgent, turn: 7, signal: undefined });
await new Promise((resolve) => setTimeout(resolve, 3000));
check(
  "默认按需（auto=off）：写文件后回合结束不自动注入评审",
  deliver.followed.length === 0 && deliver.injected.length === 0,
  `followup=${deliver.followed.length} inject=${deliver.injected.length}（期望都是 0）`,
);

/* 显式打开自动档（老行为）后照旧：另起一个 auto=adaptive 的实例，
   证明四档自动模式仍然可用，只是不再默认替用户打开。 */
mod.apply(makeCtx(), mkConfig({ autoReview: "adaptive", autoMaxPerSession: 3, autoMinIntervalMs: 0 }));
emit("tools/result", { name: "edit", agent: autoAgent, callId: "c2b", arguments: {} }, { isError: false });
emit("agent/turn-stopping", { agent: autoAgent, turn: 7, signal: undefined });
const deadline = Date.now() + 120000;
while (deliver.followed.length === 0 && deliver.injected.length === 0 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}
const autoText = textOf(deliver.followed[0] ?? deliver.injected[0]);
checkEither(
  "自动档（显式 auto=adaptive）：写文件后回合结束自动注入评审结果",
  autoText.includes("自动代码评审") && autoText.includes("OpenCodeReview") && /engine=(delegate|ocr)/.test(autoText),
  /* 没装 ocr 时自动档照样要投递一条**说明白为什么没跑成**的结果（含安装指引），而不是静默。 */
  autoText.includes("自动代码评审") && autoText.includes("无法定位 ocr 可执行文件") && autoText.includes("@alibaba-group/open-code-review"),
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

mod.apply(makeCtx(), mkConfig({ enabled: false }));
const offReview = await tools.get("ocr_review").execute({ preview: true }, exec);
check("enabled=false：ocr_review 拒绝执行并指向设置页", offReview.ok === false && offReview.code === "OCR_DISABLED" && offReview.summary.includes("已在设置里关闭"), `${offReview.code} | ${offReview.summary}`);

const offCmd = await commands.get("ocr-review").handler({ agent: makeAgent(), rawInput: "", attachments: [], signal: undefined });
check("enabled=false：/ocr-review 返回错误", offCmd?.kind === "error" && String(offCmd.text).includes("已在设置里关闭"), JSON.stringify(offCmd));

const offStatus = await tools.get("ocr_status").execute({ checkLlm: false }, exec);
check(
  "enabled=false：ocr_status 仍可用于诊断",
  offStatus.enabled === false && offStatus.ok === HAS_OCR && (HAS_OCR || offStatus.code === "OCR_NOT_FOUND"),
  `enabled=${offStatus.enabled} ok=${offStatus.ok} code=${offStatus.code} ref=${offStatus.credentialRef}`,
);

/* ------------------------------------------------ dsh 路由：ocr ⇄ 本机桥 ⇄ ctx.llm.stream */

const llmStub = fakeLlmService((options) => {
  const last = options.messages.at(-1);
  // 第 1 跳让它调工具（ocr llm test 会验证工具往返），第 2 跳（带 role=tool）才给正文。
  if (last && last.role === "tool") {
    return [
      { type: "text-delta", index: 0, text: "pong" },
      /* v0.5.4：按真机口径给 usage —— DSH 的 inputTokens 不含缓存命中/写入，两个缓存字段单列
         （totalTokens = input + output + cacheRead + cacheWrite）。没有它们，界面就会显示成
         「合计 500（输入 100 / 输出 20）」这种自相矛盾的假 bug。 */
      {
        type: "usage",
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 500, cacheReadTokens: 360, cacheWriteTokens: 20 },
      },
      { type: "finish", reason: { kind: "stop" } },
    ];
  }
  return [
    { type: "tool-call-delta", index: 0, id: "call_smoke", name: "ocr_selftest", argumentsDelta: '{"note":"smoke"}' },
    { type: "finish", reason: { kind: "stop" } },
  ];
});
const bridgeCtx = makeCtx({ llm: llmStub });
mod.apply(bridgeCtx, mkConfig({ llmMode: "dsh", llmProvider: "commandcode", llmModel: "deepseek/deepseek-v4.1-flash" }));

// 立刻查（不再 sleep）：桥是异步 listen 的，插件内部会等它就绪再算路由 —— 这条断言就是钉这件事。
// 之前这里靠 `setTimeout(150)` 赌 timing，CI 上桥 listen 慢过 150ms 就拿到 bridge=null 并崩在下面。
const bridgeStatus = await tools.get("ocr_status").execute({ checkLlm: false }, exec);
check(
  "v0.5.2：apply 之后立刻查 ocr_status 也拿得到桥（内部等桥就绪，不再赌 sleep）",
  bridgeStatus.llmMode === "dsh" && Boolean(bridgeStatus.bridge),
  `bridge=${JSON.stringify(bridgeStatus.bridge)} route=${bridgeStatus.llmRoute}`,
);
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
/* ocr_status.bridge 在 schema 里声明的键（且 additionalProperties:false）：多一个键
   宿主会在调用期拒收整个返回值——这一支以前零覆盖。M1（v0.4.0）给 describe() 加了
   retrySkips/retrySkipReason/tokens 三个键，所以这里从 10 个键变成 13 个。 */
const bridgeKeys = Object.keys(bridgeStatus.bridge ?? {}).sort().join(",");
check(
  "ocr_status：bridge 对象恰好是 schema 声明的 13 个键（否则宿主调用期拒收）",
  bridgeKeys === "failed,inflight,lastError,lastModel,lastProvider,requests,retries,retrySkipReason,retrySkips,tokenMasked,tokens,uptimeMs,url",
  bridgeKeys,
);
check(
  "v0.5.4：bridge.tokens 六个键（输入/输出/合计/缓存命中/缓存写入/partial），桥刚起来时六键都是 0",
  bridgeStatus.bridge?.tokens &&
    Object.keys(bridgeStatus.bridge.tokens).sort().join(",") ===
      "cache_read_tokens,cache_write_tokens,completion_tokens,partial,prompt_tokens,total_tokens" &&
    bridgeStatus.bridge.tokens.partial === 0 &&
    bridgeStatus.bridge.tokens.cache_read_tokens === 0,
  JSON.stringify(bridgeStatus.bridge?.tokens ?? null),
);
/* v0.5.4：斜杠命令的注册状态可自查 —— 以前整条链路都假设 /ocr-review 在，没人证明 register() 成功。 */
check(
  "v0.5.4：ocr_status 报出 /ocr-review 的注册状态（回合尾部按钮走的就是这条命令）",
  bridgeStatus.command?.name === "ocr-review" &&
    bridgeStatus.command?.registered === true &&
    bridgeStatus.command?.reason === "",
  JSON.stringify(bridgeStatus.command),
);
{
  const declared = tools.get("ocr_status")?.output?.schema?.properties?.bridge?.oneOf?.[0]?.properties ?? {};
  const declaredKeys = Object.keys(declared).sort().join(",");
  check(
    "M1：bridge 的 schema 声明与实际返回值逐键对齐（漏声明 = 真机 additionalProperties 拒收）",
    declaredKeys === bridgeKeys,
    declaredKeys,
  );
}
check(
  "ocr_status：bridge schema 也声明了 retries（返回值多键会被宿主拒收）",
  JSON.stringify(tools.get("ocr_status")?.output?.schema ?? null).includes("\"retries\""),
  JSON.stringify(tools.get("ocr_status")?.output?.schema ?? null).slice(0, 120),
);
check(
  "ocr_status：状态里不出现桥的明文 token",
  /…/.test(String(bridgeStatus.bridge?.tokenMasked)) && !/[0-9a-f]{32,}/.test(JSON.stringify(bridgeStatus.bridge)),
  String(bridgeStatus.bridge?.tokenMasked),
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

// bridge 为空时不要崩（上面那条断言已经会 FAIL）；这里只是别把「桥没起来」变成进程级异常。
let badAuth = { status: 0 };
if (bridgeStatus.bridge) {
  badAuth = await fetch(bridgeStatus.bridge.url + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer not-the-token" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
  });
}
check("dsh 路由：桥校验随机 token（错 token → 401）", badAuth.status === 401, String(badAuth.status));

if (HAS_OCR) {
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
  check(
    "v0.5.4：真端到端 —— 上游的缓存命中/写入进到 ocr_status.bridge.tokens（真机 452422 那组数字的解释）",
    Number(live.bridge?.tokens?.prompt_tokens ?? 0) === 100 &&
      Number(live.bridge?.tokens?.completion_tokens ?? 0) === 20 &&
      Number(live.bridge?.tokens?.total_tokens ?? 0) === 500 &&
      Number(live.bridge?.tokens?.cache_read_tokens ?? 0) === 360 &&
      Number(live.bridge?.tokens?.cache_write_tokens ?? 0) === 20 &&
      Number(live.bridge?.tokens?.partial ?? -1) === 0,
    JSON.stringify(live.bridge?.tokens),
  );
} else {
  log("本机没有 ocr，跳过 dsh 路由的真端到端断言");
}

// 关掉插件（模拟插件卸载/服务消失）：桥必须一起关，端口不泄漏。
for (const entry of bridgeCtx.effects) {
  if (typeof entry.dispose === "function") entry.dispose();
}
await new Promise((resolve) => setTimeout(resolve, 50));
let bridgeClosed = !bridgeStatus.bridge; // 桥本来就没起来 = 没有端口可泄漏（上面已有断言盯这件事）
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
mod.apply(defaultCtx, mkConfig({ llmMode: "dsh", llmProvider: "", llmModel: "" }));
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

if (HAS_OCR) {
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

mod.apply(makeCtx({ llm: undefined, agentDefaultModel: null }), mkConfig({ llmMode: "dsh", llmProvider: "", llmModel: "" }));
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
  /* 复刻宿主 dsh-subprocess-local 的硬校验（runner-launch 的 launch 前置检查）：
     不合规的 spec 在真机上直接抛，测试里也必须抛，否则契约漂移会被静默吞掉。 */
  const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
  const validateSpec = (spec) => {
    if (!spec || typeof spec !== "object") throw new Error("subprocess.spawn 需要 spec");
    if (!Array.isArray(spec.argv) || spec.argv.length === 0 || typeof spec.argv[0] !== "string" || spec.argv[0] === "") {
      throw new Error("spec.argv[0] 必须是非空字符串");
    }
    const graceMs = spec.graceMs ?? 0;
    if (!Number.isFinite(graceMs) || graceMs <= 0 || graceMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`spec.graceMs 必须是 (0, ${MAX_TIMER_DELAY_MS}] 的有限数，收到 ${graceMs}`);
    }
    if (spec.signal?.aborted) throw new Error("aborted before spawn");
  };
  return {
    calls,
    async resolveExecutable(cmd) {
      const name = String(cmd ?? "");
      if (!name) throw new Error("executable 不能是空串");
      if (!isAbsolute(name) && name.includes("/")) throw new Error(`executable 必须是裸名字或绝对路径：${name}`);
      if (name === "definitely-not-here") throw new Error(`找不到可执行文件：${name}`);
      return "C:\\fake\\" + name + ".exe";
    },
    spawn(spec) {
      validateSpec(spec);
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
  mod.apply(ctx2, mkConfig({ engine: "ocr", llmMode: "dsh", llmProvider: "commandcode", llmModel: "deepseek/deepseek-v4.1-flash", ...config }));
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

/* 步骤 2（v0.5.0）：问题逐条列到「文件 → 行 [severity] 问题」，摘要不再出现「0 个文件却有 N 条问题」。 */
const listJobs = makeJobsRegistry();
const listCase = cannedHarness(
  [
    {
      exitCode: 0,
      stdout: JSON.stringify({
        /* 真机复现：整文件扫描的正式结果里文件清单是空的，问题条目各自带 file。 */
        files: [],
        total_files: 2,
        issues: [
          { file: "lib/b.js", line: 42, severity: "low", message: "变量名太短", rule: "naming" },
          { file: "lib/a.js", line: 12, severity: "high", message: "空指针风险", suggestion: "先判空", rule: "null-check", end_line: 14, column: 3 },
          { file: "lib/a.js", line: 7, severity: "medium", message: "缺少错误处理" },
        ],
      }),
    },
  ],
  {},
  { jobs: listJobs },
);
const listRun = await listCase.call({ engine: "ocr" });
check(
  "0 文件口径（真机回归）：文件清单空但有 total_files → 摘要报 2 个文件",
  listRun.ok === true && listRun.summary.includes("审查 2 个文件") && listRun.summary.includes("发现 3 条问题"),
  `${listRun.code} | ${listRun.summary}`,
);
const listText = review.valueToText(listRun, {});
check(
  "逐条展示：按文件分组 + 组内按行号升序 + 严重程度/规则名",
  listText.includes("发现问题 3 条（涉及 2 个文件）：") &&
    listText.includes("\n  lib/a.js") &&
    listText.includes("\n  lib/b.js") &&
    listText.indexOf("- 7 [medium]") < listText.indexOf("- 12-14 [high]") &&
    listText.includes("- 12-14 [high] 空指针风险（null-check）"),
  listText.split("\n").slice(-5).join(" / "),
);
const listJobText = (listJobs.records.get("ocr-review-1")?.output ?? []).map((o) => o.text).join("");
check(
  "job 行也逐条列出问题（文件 → 行 [severity] 问题）",
  listJobText.includes("lib/a.js") &&
    listJobText.includes("- 12-14 [high] 空指针风险（null-check）") &&
    listJobText.includes("lib/b.js") &&
    listJobText.includes("2 个文件 · 3 条问题"),
  listJobText.split("\n").slice(-6).join(" / "),
);
const capped = review.issuesToLines(
  [
    { file: "a.js", line: 1, severity: "low", message: "m" },
    { file: "b.js", line: 2, severity: "low", message: "m" },
    { file: "b.js", line: 3, severity: "low", message: "m" },
  ],
  { max: 2 },
);
check("issuesToLines：超上限只列 max 条并回报 hidden", capped.shown === 2 && capped.hidden === 1 && capped.files === 2, JSON.stringify(capped));
check(
  "groupIssues：按首次出现顺序分组",
  review.groupIssues([{ file: "b.js" }, { file: "a.js" }, { file: "b.js" }]).map((g) => g.file).join(",") === "b.js,a.js",
  JSON.stringify(review.groupIssues([{ file: "b.js" }, { file: "a.js" }]).map((g) => g.file)),
);
const detailed = review.extractIssuesDetailed({
  issues: [
    { file: "a.js", line: 1, severity: "low", message: "m", end_line: 3, column: 2, rule: "r", suggestion: "s" },
    { file: "a.js", line: 2, severity: "low", message: "m2" },
  ],
}).issues;
check(
  "extractIssuesDetailed：有值才写 endLine/column/rule/suggestion（旧键集合不变）",
  Object.keys(detailed[0]).join(",") === "file,line,severity,message,endLine,column,rule,suggestion" &&
    Object.keys(detailed[1]).join(",") === "file,line,severity,message",
  JSON.stringify(detailed),
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
  "取消：signal 已 abort 时不开子进程，结果报 OCR_ABORTED（真机宿主会抛 aborted before spawn）",
  abortedRun.ok === false && abortedRun.code === "OCR_ABORTED" && abortCase.canned.calls.length === 0,
  `${abortedRun.code} spawn=${abortCase.canned.calls.length} | ${abortedRun.summary}`,
);

/* 跑到一半才取消：子进程必须被 terminate（不是只在开跑前挡一下）。 */
const midCase = cannedHarness([{ exitCode: 0, stdout: JSON.stringify({ files: [], issues: [] }), manual: true }]);
const midCtl = new AbortController();
const midRun = midCase.call
  ? tools.get("ocr_review").execute({ engine: "ocr" }, { ...midCase.exec, signal: midCtl.signal })
  : null;
for (let i = 0; i < 200 && midCase.canned.calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
midCtl.abort();
const midValue = await midRun;
check(
  "取消：跑到一半被中断 → 子进程被 terminate，结果报 OCR_ABORTED",
  midValue.ok === false && midValue.code === "OCR_ABORTED" && midCase.canned.calls[0]?.terminated === true,
  `${midValue.code} terminated=${midCase.canned.calls[0]?.terminated} | ${midValue.summary}`,
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

/* ----------------------------------------------- 评审进度可见（可选 jobs 服务） */

/**
 * jobs 服务替身：契约照 @deepseek-ai/dsh-jobs-local —— start 同步跑 spec.run(handle) 并返回
 * `<kind>-N`，handle.append/updateProgress 写进环，hooks.done 落地即结算，hooks.cancel 由 kill 触发。
 * 进度是旁路能力，这一节只断言「看得见、停得掉」，不影响上面任何评审结果。
 */
function makeJobsRegistry() {
  const records = new Map();
  const starts = [];
  const waits = [];
  const kills = [];
  return {
    records,
    starts,
    waits,
    kills,
    start(spec) {
      const id = `${spec.kind}-${starts.length + 1}`;
      const record = {
        id,
        kind: spec.kind,
        label: spec.label,
        owner: spec.owner,
        progress: "",
        progressLines: [],
        output: [],
        status: "running",
        detail: undefined,
        awaited: false,
      };
      records.set(id, record);
      starts.push(record);
      const handle = {
        id,
        append: (text, opts = {}) => record.output.push({ text, channel: opts.channel ?? "stdout" }),
        updateProgress: (line) => {
          record.progress = line;
          record.progressLines.push(line);
        },
      };
      const hooks = spec.run(handle);
      record.hooks = hooks;
      hooks.done.then(
        (outcome) => {
          record.status = outcome?.status ?? "completed";
          record.detail = outcome?.detail;
          record.finishedAt = Date.now();
        },
        () => {
          record.status = "failed";
        },
      );
      return id;
    },
    wait(id, timeoutMs, owner) {
      const record = records.get(id);
      waits.push({ id, timeoutMs, owner });
      return new Promise((resolve) => {
        const poll = setInterval(() => {
          if (!record || record.status !== "running") {
            clearInterval(poll);
            record.awaited = true;
            resolve(records.get(id));
          }
        }, 5);
      });
    },
    kill(id, caller, reason) {
      kills.push({ id, caller, reason });
      records.get(id)?.hooks?.cancel(reason);
      return { ok: true };
    },
  };
}

/** 等一次 job 结算的微任务链走完（status/detail 是 hooks.done.then 里落的）。 */
const settleJobs = () => new Promise((resolve) => setImmediate(resolve));

/** 轮询等一个条件成立（等 spawn 真的发生之类）。 */
async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  return predicate();
}

/* 没装 ocr 时（CI）：真实工具调用在「定位 ocr」那一步就返回了，**根本不会开 job** —— 这是有意的
   fail-closed（绝不显示一条假装在评审的进度行）。所以这里按环境换期望值：
   有 ocr 时前四条 job 就是那四次真实调用；没有时它们只会来自后面的罐头场景。 */
if (HAS_OCR) await until(() => progressRegistry.starts.length >= 4);
else await until(() => progressRegistry.starts.length >= 1, 500);
await settleJobs();

const repoName = REPO.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
/* 前四条 = 工具链路那四次调用（参数错误那条在开 job 之前就返回了，不该占位）。 */
const allJobs = () => progressRegistry.starts;
const toolJobs = HAS_OCR ? allJobs().slice(0, 4) : [];
checkEither(
  "进度：真实工具链路每次评审登记一条 job（preview/delegate/auto/非 git 仓库 = 4 条，参数错误不登记）",
  toolJobs.length === 4 && toolJobs.every((job) => job.id.startsWith("ocr-review-")),
  /* 没 ocr 时至少守住「登记的 job 都是本插件的」这条不变量。 */
  allJobs().length >= 1 && allJobs().every((job) => job.id.startsWith("ocr-review-")),
  allJobs().map((job) => job.id).join(","),
);
checkEither(
  "进度：kind 统一是 ocr-review（Jobs 面板按它显示徽章、会话内进度行按它筛选）",
  toolJobs.length === 4 && toolJobs.every((job) => job.kind === "ocr-review"),
  allJobs().length >= 1 && allJobs().every((job) => job.kind === "ocr-review"),
  [...new Set(allJobs().map((job) => job.kind))].join(","),
);
checkEither(
  "进度：标题 = 来源 · 范围 · 仓库名（非 git 那条指向它自己的临时目录）",
  toolJobs[0]?.label === `评审 · 工作区改动 · ${repoName}` && toolJobs[3]?.label?.includes("ocr-nongit-"),
  allJobs().every((job) => String(job.label).startsWith("评审 · ")),
  allJobs().map((job) => job.label).join(" | "),
);
checkEither(
  "进度：结算状态 3 成功 1 失败，失败明细带结果码",
  toolJobs.filter((job) => job.status === "completed").length === 3 &&
    toolJobs[3]?.status === "failed" &&
    String(toolJobs[3]?.detail).startsWith("OCR_NOT_GIT_REPO"),
  /* 没 ocr 时的关键不变量：没有任何 job 停在 running（否则面板/进度行会永远转圈）。 */
  allJobs().every((job) => job.status !== "running"),
  allJobs().map((job) => `${job.id}=${job.status}:${job.detail}`).join(" | "),
);
checkEither(
  "进度：成功行的明细带耗时（评审结束后面板行仍可读）",
  /（\d+(\.\d+)?(s|m\d+s)）$/.test(String(toolJobs[0]?.detail)),
  allJobs().some((job) => job.status === "completed" && /（\d+(\.\d+)?(s|m\d+s)）$/.test(String(job.detail))),
  String(toolJobs[0]?.detail ?? allJobs()[0]?.detail),
);
checkEither(
  "进度：过程行覆盖「跑 ocr」与「delegate」两种引擎",
  toolJobs.some((job) => job.progressLines.some((line) => line.includes("运行 ocr review（超时"))) &&
    toolJobs.some((job) => job.progressLines.some((line) => line.startsWith("delegate："))),
  /* 没 ocr 时退回可验的那一半：进度行里必须写清「要跑什么命令」。 */
  allJobs().some((job) => job.progressLines.some((line) => line.includes("运行 ocr review（超时"))),
  allJobs().map((job) => job.progress).join(" / "),
);
checkEither(
  "进度：输出环里有带时间戳的日志行 + 结算行（面板可展开的实时流）",
  toolJobs[0]?.output.some((chunk) => chunk.channel === "log" && /^\[\d\d:\d\d:\d\d\]/.test(chunk.text)) &&
    toolJobs[0]?.output.some((chunk) => chunk.text.includes("完成：")),
  allJobs().some((job) => job.output.some((chunk) => chunk.channel === "log" && /^\[\d\d:\d\d:\d\d\]/.test(chunk.text))),
  (toolJobs[0]?.output ?? allJobs()[0]?.output ?? []).slice(-2).map((chunk) => `[${chunk.channel}]${chunk.text}`).join(""),
);
/* v0.3.6：Jobs 行的截止时间改成读 plan.timeoutMs（= 分钟 + 60s 宽限，lib/review.js:118），
   不再读 cfg 的裸分钟数 —— 这里守住「等待者 = plan 截止 + 60s」这条链。 */
const hrDefaultPlan = review.normalizeTarget({ scope: "workspace" }, {}, "C:/tmp");
check(
  "进度：每条 job 都挂了等待者；等待者 = plan 截止（分钟 + 60s 宽限）+ 60s（否则结算事件会往会话灌唤醒消息）",
  progressRegistry.waits.length === progressRegistry.starts.length &&
    hrDefaultPlan.timeoutMs === (cfgMod.DEFAULTS.timeoutMinutes + 1) * 60000 &&
    progressRegistry.waits.every((waiter) => waiter.timeoutMs === hrDefaultPlan.timeoutMs + 60000),
  JSON.stringify([...new Set(progressRegistry.waits.map((waiter) => waiter.timeoutMs))]),
);
check(
  "进度：owner 透传（这里的 agent 没有 id，所以不传 owner）",
  progressRegistry.starts.every((job) => job.owner === undefined),
  JSON.stringify([...new Set(progressRegistry.starts.map((job) => job.owner))]),
);
/* owner 语义（宿主 jobs 契约）：owner 就是「按会话 id 栅栏」的归属键 ——
   jobs.start 会拒绝没有对应 job controller 的 owner，list/get/kill/wait 都按它过滤，
   「有主」的记录一直留到 owner dispose。所以插件必须把调用方 agent 的 id 原样传下去。 */
const ownerRegistry = makeJobsRegistry();
const ownerCase = cannedHarness(
  [{ exitCode: 0, stdout: JSON.stringify({ files: [{ path: "a.js", insertions: 1, deletions: 0 }], issues: [] }) }],
  {},
  { jobs: ownerRegistry },
);
const ownerAgent = Object.assign(makeAgent(), { id: "session-owner-1" });
const ownerRun = await tools.get("ocr_review").execute(
  { engine: "ocr" },
  { name: "ocr_review", callId: "owner", arguments: {}, agent: ownerAgent, signal: undefined },
);
await settleJobs();
check(
  "进度：agent 有 id 时 owner 一路透传到 start 与 wait（归属栅栏；缺 owner 会变成所有人可见的无主 job）",
  ownerRun.ok === true &&
    ownerRegistry.starts.length === 1 &&
    ownerRegistry.starts[0].owner === "session-owner-1" &&
    ownerRegistry.waits.length === 1 &&
    ownerRegistry.waits[0].owner === "session-owner-1",
  `starts=${JSON.stringify(ownerRegistry.starts.map((job) => job.owner))} waits=${JSON.stringify(ownerRegistry.waits.map((waiter) => waiter.owner))}`,
);
const autoJobs = allJobs().filter((job) => String(job.label).startsWith("自动评审 · "));
checkEither(
  "进度：自动评审那条也登记了 job 且已结算（label 用「自动评审」区分）",
  autoJobs.length >= 1 && autoJobs.every((job) => job.status === "completed"),
  /* 没 ocr 时这条自动评审在定位就失败（fail-closed 不开假 job）—— 守住「不留 running」。 */
  autoJobs.every((job) => job.status !== "running"),
  autoJobs.map((job) => `${job.label}=${job.status}`).join(" | ") || "(无)",
);

/* 停止链路：面板「停止」→ job cancel → 评审自己的 AbortController → 终结子进程 → 结算成 killed。 */
const killRegistry = makeJobsRegistry();
const killCase = cannedHarness([{ exitCode: 0, stdout: JSON.stringify({ files: [], issues: [] }), manual: true }], {}, { jobs: killRegistry });
check("进度：cannedHarness 能把 jobs 服务带进 makeCtx（kill 场景的前提）", killCase.ctx.jobs === killRegistry);
const killRun = killCase.call({ engine: "ocr" });
await until(() => killRegistry.starts.length === 1 && killCase.canned.calls.length >= 1);
const stopping = killRegistry.starts[0];
check("进度：评审一开始就登记（面板/进度行立刻看得见，无需等结果）", Boolean(stopping) && stopping.status === "running", `${stopping?.id} ${stopping?.progress}`);
const killed = killRegistry.kill(stopping.id, {}, "用户停止");
const killedValue = await killRun;
await settleJobs();
check(
  "停止：kill 记录带原因，job 结算成 killed 且明细以停止原因为准（不显示成「评审完成」）",
  killed.ok === true && killRegistry.kills[0]?.reason === "用户停止" &&
    stopping.status === "killed" && String(stopping.detail).startsWith("用户停止") && String(stopping.detail).includes("OCR_ABORTED"),
  `${stopping.status} | ${stopping.detail} | kills=${JSON.stringify(killRegistry.kills)}`,
);
check(
  "停止：子进程被终结，结果报 OCR_ABORTED（不会当成功结果投递）",
  killCase.canned.calls[0]?.terminated === true && killedValue.ok === false && killedValue.code === "OCR_ABORTED",
  `${killedValue.code} terminated=${killCase.canned.calls[0]?.terminated}`,
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
  { engine: "ocr", reviewerAgent: "spawn", autoReview: "adaptive", autoMinIntervalMs: 0 },
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
  { engine: "ocr", reviewerAgent: "spawn", reviewerRounds: 3, autoReview: "adaptive", autoMinIntervalMs: 0 },
  { subagents: autoSub.runtime, listeners: autoMap },
);
emitOn(autoMap, "tools/result", { name: "edit", agent: revAutoAgent }, { isError: false });
emitOn(autoMap, "agent/turn-stopping", { agent: revAutoAgent, reason: "test" });
await waitUntil(() => autoSink.length > 0);
const revAutoText = autoSink.length > 0 ? textOf(autoSink[0]) : "";
check(
  "自动档第 1 轮：交付带轮次 + 按文件分组的 findings 清单 + 「请逐条修复或说明理由」",
  autoSink.length === 1 &&
    revAutoText.includes("【独立评审 agent · 第 1/3 轮】") &&
    revAutoText.includes("lib/a.js") &&
    revAutoText.includes("- 12 [major]") &&
    revAutoText.includes("请逐条修复或说明理由"),
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
  { engine: "ocr", reviewerAgent: "spawn", reviewerRounds: 3, autoReview: "adaptive", autoMinIntervalMs: 0 },
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
  { engine: "ocr", reviewerAgent: "spawn", reviewerRounds: 1, autoReview: "adaptive", autoMinIntervalMs: 0 },
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
check("ocr_status：没有 llm 服务时 bridge=null（schema 里的另一支）", stRun.bridge === null, JSON.stringify(stRun.bridge));

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
if (HAS_OCR) {
  /* 罐头 ctx 覆盖了同名工具，先切回真子进程的注册再跑真 ocr。 */
  mod.apply(ctx, settingsPatch);
  const ocrOnly = await tools.get("ocr_review").execute({ engine: "ocr" }, exec);
  check(
    "engine=ocr 且没配 LLM 端点：返回 OCR_LLM_MISSING（真 ocr，不静默降级）",
    ocrOnly.ok === false && ocrOnly.code === "OCR_LLM_MISSING",
    `${ocrOnly.code} | ${ocrOnly.summary}`,
  );
}

/* ---------------------------------------------------------- 加固回归
   （审计发现的 fail-open / job 不结算 / 参数越界；这些形状以前都会「静默通过」。） */

/* P0：ocr 输出里没有可识别的问题清单字段时，过去会被当成「未发现问题」——
   只要被审仓库能影响 ocr 的输出，评审就能静默变成通过。现在必须 fail-closed。 */
const hrBadShapes = [
  ["问题清单里是纯字符串", { issues: ["这是个字符串，不是对象"] }],
  ["条目缺 message 字段（只有 file/line/severity）", { files: [{ path: "a.js" }], issues: [{ file: "a.js", line: 3, severity: "high" }] }],
  ["message 只有空白", { issues: [{ file: "a.js", line: 1, message: "   " }] }],
  ["空 JSON 对象", {}],
  ["只有 summary 与插入行数（没有清单）", { summary: "x", total_insertions: 3 }],
  ["findings 是对象不是数组", { findings: { a: 1 } }],
  ["清单埋在 7 层嵌套里（超过深度上限 6）", { a: { b: { c: { d: { e: { f: { g: { issues: [] } } } } } } } }],
];
for (const [label, payload] of hrBadShapes) {
  const hrCase = cannedHarness([{ exitCode: 0, stdout: JSON.stringify(payload) }]);
  const hrRun = await hrCase.call({ engine: "ocr" });
  check(
    `fail-closed（P0 回归）：${label} → 不当作通过`,
    hrRun.ok === false && hrRun.code === "OCR_OUTPUT_SHAPE_UNKNOWN",
    `${hrRun.code || "(无 code)"} ok=${hrRun.ok} | ${hrRun.summary}`,
  );
}
const hrEmptyCase = cannedHarness([{ exitCode: 0, stdout: JSON.stringify({ files: [], issues: [] }) }]);
const hrEmptyRun = await hrEmptyCase.call({ engine: "ocr" });
check(
  "fail-closed（P0 回归）：空文件清单 + 空问题清单才算真的「未发现问题」",
  hrEmptyRun.ok === true && hrEmptyRun.summary.includes("未发现问题"),
  `${hrEmptyRun.code || "(无 code)"} ok=${hrEmptyRun.ok} | ${hrEmptyRun.summary}`,
);
const hrMixedCase = cannedHarness([
  { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "a.js" }], issues: [{ file: "a.js", line: 2, message: "真问题" }, { file: "b.js", line: 5 }] }) },
]);
const hrMixedRun = await hrMixedCase.call({ engine: "ocr" });
check(
  "fail-closed 不误报：能读的条目照常交付，读不出的只记一条备注",
  hrMixedRun.ok === true &&
    hrMixedRun.issues.length === 1 &&
    hrMixedRun.issues[0].message === "真问题" &&
    hrMixedRun.notes.some((note) => note.includes("1 条无法解析")),
  `ok=${hrMixedRun.ok} issues=${hrMixedRun.issues.length} | ${hrMixedRun.notes.join(" / ")}`,
);

/* P1：自动评审到「轮次上限」时过去直接 return，job 永远停在运行中。 */
const hrCapJobs = makeJobsRegistry();
const hrCapSub = cannedSubagents({ structured: FINDINGS_ONE });
const hrCapMap = new Map();
const hrCapSink = [];
const hrCapAgent = localAgent(hrCapSink);
const hrCapCase = cannedHarness(
  [
    { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "lib/a.js", insertions: 3, deletions: 1 }], excluded: [] }) },
    ...reviewerSpecRuns(),
    { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "lib/a.js", insertions: 9, deletions: 1 }], excluded: [] }) },
  ],
  { engine: "ocr", reviewerAgent: "spawn", reviewerRounds: 1, autoReview: "adaptive", autoMinIntervalMs: 0 },
  { subagents: hrCapSub.runtime, listeners: hrCapMap, jobs: hrCapJobs },
);
emitOn(hrCapMap, "tools/result", { name: "edit", agent: hrCapAgent }, { isError: false });
emitOn(hrCapMap, "agent/turn-stopping", { agent: hrCapAgent, reason: "test" });
await waitUntil(() => hrCapSink.length >= 1);
emitOn(hrCapMap, "tools/result", { name: "edit", agent: hrCapAgent }, { isError: false });
emitOn(hrCapMap, "agent/turn-stopping", { agent: hrCapAgent, reason: "test" });
await waitUntil(() => hrCapSink.length >= 2);
await settleJobs();
await settleJobs();
const hrCapJob = hrCapJobs.starts.at(-1);
check(
  "进度（P1 回归）：自动评审到轮次上限也结算 job（否则面板永远显示运行中）",
  Boolean(hrCapJob) && hrCapJob.status === "failed" && String(hrCapJob.detail).includes("已达轮次上限"),
  hrCapJob ? `${hrCapJob.id}=${hrCapJob.status} | ${hrCapJob.detail}` : "(没有 job)",
);

/* P1：maxTimeoutMinutes 为负会让插件侧硬超时整条消失，还把 `--timeout -5` 交给 ocr。
   （走不到 apply 的 schema 校验——手写 config.json 是插件自己读的，这里直接测解析函数。） */
const hrNegCfg = { timeoutMinutes: -3, maxTimeoutMinutes: -5 };
const hrNegPlan = review.normalizeTarget({ scope: "workspace" }, hrNegCfg, "C:/tmp");
const hrNegArgv = review.buildOcrArgv(hrNegPlan, hrNegCfg).argv.join(" ");
check(
  "参数（P1 回归）：timeoutMinutes / maxTimeoutMinutes 为负时收敛成合法值（不再出现 --timeout -5）",
  hrNegPlan.timeoutMinutes === 15 && hrNegPlan.timeoutMs === 16 * 60000 && hrNegArgv.includes("--timeout 15") && !/--timeout\s+-/.test(hrNegArgv),
  `timeoutMinutes=${hrNegPlan.timeoutMinutes} timeoutMs=${hrNegPlan.timeoutMs} argv=${hrNegArgv}`,
);

/* P2：手写 config 里的 "false" / false / -1 这类写法过去会被当成「启用 / 不节流」。 */
const hrCfgWeird = cfgMod.loadConfig({ enabled: "false", auto: false, autoMinIntervalMs: -1, autoMaxPerSession: "2" });
check(
  "配置（P2 回归）：字符串/布尔/负数写法被归一（enabled:'false' 不再当启用，'2' 认成 2，-1 回落默认）",
  hrCfgWeird.enabled === false &&
    hrCfgWeird.auto === "off" &&
    hrCfgWeird.autoMinIntervalMs === cfgMod.DEFAULTS.autoMinIntervalMs &&
    hrCfgWeird.autoMaxPerSession === 2,
  JSON.stringify({
    enabled: hrCfgWeird.enabled,
    auto: hrCfgWeird.auto,
    autoMinIntervalMs: hrCfgWeird.autoMinIntervalMs,
    autoMaxPerSession: hrCfgWeird.autoMaxPerSession,
  }),
);
const hrCfgTrue = cfgMod.loadConfig({ enabled: "true", auto: "OFF" });
check(
  "配置（P2 回归）：'true' / 'OFF' 这类写法认得出来",
  hrCfgTrue.enabled === true && hrCfgTrue.auto === "off",
  JSON.stringify({ enabled: hrCfgTrue.enabled, auto: hrCfgTrue.auto }),
);

/* v0.5.0 步骤 3：默认改成「按需」—— auto 出厂 off，onDemand 出厂 true（回合尾部按钮 + runtime skill）。 */
check(
  "配置（v0.5.0 步骤 3）：出厂 auto=off、onDemand=true",
  cfgMod.DEFAULTS.auto === "off" && cfgMod.DEFAULTS.onDemand === true,
  `auto=${cfgMod.DEFAULTS.auto} onDemand=${cfgMod.DEFAULTS.onDemand}`,
);
check(
  "配置（v0.5.0 步骤 3）：onDemand 的 'false' / false 都归一成 false，缺省 true",
  cfgMod.loadConfig({ onDemand: "false" }).onDemand === false &&
    cfgMod.loadConfig({ onDemand: false }).onDemand === false &&
    cfgMod.loadConfig({}).onDemand === true,
  JSON.stringify({
    str: cfgMod.loadConfig({ onDemand: "false" }).onDemand,
    bool: cfgMod.loadConfig({ onDemand: false }).onDemand,
    dflt: cfgMod.loadConfig({}).onDemand,
  }),
);
if (HAS_SCHEMA) {
  check(
    "配置（v0.5.0 步骤 3）：设置页 schema 的 auto / onDemand 默认值引用 DEFAULTS（不写死）",
    schema?.dict?.autoReview?.meta?.default === cfgMod.DEFAULTS.auto && schema?.dict?.onDemand?.meta?.default === cfgMod.DEFAULTS.onDemand,
    JSON.stringify({ autoReview: schema?.dict?.autoReview?.meta?.default, onDemand: schema?.dict?.onDemand?.meta?.default }),
  );
} else {
  check(
    "配置（v0.5.0 步骤 3）：没有 schema 时这两个默认值仍由 DEFAULTS 单点决定（CI 路径：auto=off / onDemand=true）",
    cfgMod.DEFAULTS.auto === "off" &&
      cfgMod.DEFAULTS.onDemand === true &&
      cfgMod.loadConfig({}).auto === cfgMod.DEFAULTS.auto &&
      cfgMod.loadConfig({}).onDemand === cfgMod.DEFAULTS.onDemand,
    JSON.stringify({ auto: cfgMod.loadConfig({}).auto, onDemand: cfgMod.loadConfig({}).onDemand }),
  );
}

/* v0.3.5：真机 `ocr scan` 评审 lib/config.js 报出来的 6 条，这里守住其中可断言的部分。 */
const schemaDefault = (name) => schema?.dict?.[name]?.meta?.default;
if (HAS_SCHEMA) {
  check(
    "配置（v0.3.5 回归）：设置页默认值直接引用 DEFAULTS（不再两处硬编码），timeoutMinutes 上界也是",
    schemaDefault("timeoutMinutes") === cfgMod.DEFAULTS.timeoutMinutes &&
      schemaDefault("autoMaxPerSession") === cfgMod.DEFAULTS.autoMaxPerSession &&
      schemaDefault("autoMinReviewableFiles") === cfgMod.DEFAULTS.autoMinReviewableFiles &&
      schemaDefault("autoMinIntervalMs") === cfgMod.DEFAULTS.autoMinIntervalMs &&
      schemaDefault("autoSkipSubagents") === cfgMod.DEFAULTS.autoSkipSubagents &&
      schemaDefault("autoIncludeDiff") === cfgMod.DEFAULTS.autoIncludeDiff &&
      schema?.dict?.timeoutMinutes?.meta?.max === cfgMod.DEFAULTS.maxTimeoutMinutes,
    JSON.stringify({
      timeoutMinutes: schemaDefault("timeoutMinutes"),
      max: schema?.dict?.timeoutMinutes?.meta?.max,
      DEFAULTS: cfgMod.DEFAULTS.maxTimeoutMinutes,
    }),
  );
} else {
  check(
    "配置（v0.3.5 回归）：没有 schema 时上下界仍由 DEFAULTS 单点决定（CI 路径：显式分钟被 maxTimeoutMinutes 夹住）",
    cfgMod.timeoutMsOf({ timeoutMinutes: 9999 }) === cfgMod.DEFAULTS.maxTimeoutMinutes * 60000 &&
      cfgMod.timeoutMsOf({}) === cfgMod.DEFAULTS.timeoutMinutes * 60000,
    `clamped=${cfgMod.timeoutMsOf({ timeoutMinutes: 9999 })} default=${cfgMod.timeoutMsOf({})}`,
  );
}

const hrMergedLayers = cfgMod.mergeLayers(
  { env: { FROM_FILE: "1" }, extraArgs: ["--file"], ocrCandidates: ["ocr-file"] },
  { env: { FROM_SETTINGS: "1" }, extraArgs: ["--settings"] },
);
check(
  "配置（v0.3.5 回归）：env / extraArgs / ocrCandidates 三层叠加（设置页与文件层都不再被静默丢掉）",
  hrMergedLayers.env.FROM_FILE === "1" &&
    hrMergedLayers.env.FROM_SETTINGS === "1" &&
    hrMergedLayers.extraArgs.join(" ") === "--settings" &&
    hrMergedLayers.ocrCandidates.join(" ") === "ocr-file",
  JSON.stringify({
    env: hrMergedLayers.env,
    extraArgs: hrMergedLayers.extraArgs,
    ocrCandidates: hrMergedLayers.ocrCandidates,
  }),
);

const hrZeroCfg = cfgMod.loadConfig({ includeDiffMaxBytes: 0, maxIssuesInText: 0 });
check(
  "配置（v0.3.5 回归）：显式 0 不再被当成「没配」（不带 diff / 正文不列问题）",
  hrZeroCfg.includeDiffMaxBytes === 0 && hrZeroCfg.maxIssuesInText === 0,
  JSON.stringify({ includeDiffMaxBytes: hrZeroCfg.includeDiffMaxBytes, maxIssuesInText: hrZeroCfg.maxIssuesInText }),
);

const hrCapPlan = review.normalizeTarget({ scope: "workspace", timeoutMinutes: 999 }, {}, "C:/tmp");
check(
  "配置（v0.3.5 回归）：maxTimeoutMinutes 回落值取自 DEFAULTS（此前硬编码 45，与 60 的声明不一致）",
  hrCapPlan.timeoutMinutes === cfgMod.DEFAULTS.maxTimeoutMinutes && hrCapPlan.timeoutMinutes > 45,
  `timeoutMinutes=${hrCapPlan.timeoutMinutes} fallback=${cfgMod.DEFAULTS.maxTimeoutMinutes}`,
);

/* v0.5.9：把「schema 默认值必须引用 DEFAULTS」从 6 个键扩到全部 —— schemaOverrides() 靠
   「值等于出厂默认 ⇒ 不算覆盖项」来让 config.json 生效，字面量一旦漂移就会整层遮住文件层。 */
if (HAS_SCHEMA) {
  const pairs = [
    ["enabled", cfgMod.DEFAULTS.enabled],
    ["engine", cfgMod.DEFAULTS.engine],
    ["audience", cfgMod.DEFAULTS.audience],
    ["autoReview", cfgMod.DEFAULTS.auto],
    ["onDemand", cfgMod.DEFAULTS.onDemand],
    ["autoScope", cfgMod.DEFAULTS.autoScope],
    ["autoMaxPerSession", cfgMod.DEFAULTS.autoMaxPerSession],
    ["autoMinReviewableFiles", cfgMod.DEFAULTS.autoMinReviewableFiles],
    ["autoMinIntervalMs", cfgMod.DEFAULTS.autoMinIntervalMs],
    ["autoSkipSubagents", cfgMod.DEFAULTS.autoSkipSubagents],
    ["autoIncludeDiff", cfgMod.DEFAULTS.autoIncludeDiff],
    ["preTest", cfgMod.DEFAULTS.preTest],
    ["timeoutMinutes", cfgMod.DEFAULTS.timeoutMinutes],
    ["progress", cfgMod.DEFAULTS.progress],
    ["verbose", cfgMod.DEFAULTS.verbose],
  ];
  const drifted = pairs.filter(([name, want]) => schemaDefault(name) !== want).map(([name]) => `${name}=${schemaDefault(name)}≠${cfgMod.DEFAULTS[name] ?? "?"}`);
  check(
    "配置（v0.5.9）：设置页里所有带默认值的字段都引用 DEFAULTS（漂移会让 config.json 整层失效）",
    drifted.length === 0,
    drifted.length === 0 ? `${pairs.length} 个字段一致` : drifted.join(", "),
  );
} else {
  check(
    "配置（v0.5.9）：没有 schema 时默认值仍由 DEFAULTS 单点决定（CI 路径）",
    cfgMod.loadConfig({}).enabled === cfgMod.DEFAULTS.enabled &&
      cfgMod.loadConfig({}).engine === cfgMod.DEFAULTS.engine &&
      cfgMod.loadConfig({}).progress === cfgMod.DEFAULTS.progress &&
      cfgMod.loadConfig({}).verbose === cfgMod.DEFAULTS.verbose,
    JSON.stringify({ engine: cfgMod.loadConfig({}).engine, progress: cfgMod.loadConfig({}).progress }),
  );
}

const autoEngineCases = {
  empty: cfgMod.normalizeConfig({ ...cfgMod.DEFAULTS, autoEngine: "" }).autoEngine,
  padded: cfgMod.normalizeConfig({ ...cfgMod.DEFAULTS, autoEngine: " Delegate " }).autoEngine,
  bogus: cfgMod.normalizeConfig({ ...cfgMod.DEFAULTS, autoEngine: "nope" }).autoEngine,
};
check(
  "配置（v0.5.9）：autoEngine 与 engine 同样收敛（去空白小写；非法值回落空串 = 跟随 engine，不悄悄改成别的引擎）",
  autoEngineCases.empty === "" && autoEngineCases.padded === "delegate" && autoEngineCases.bogus === "",
  JSON.stringify(autoEngineCases),
);

const bigCfg = cfgMod.loadConfig({ includeDiffMaxBytes: 120000000000, maxIssuesInText: 999999 });
const negCfg = cfgMod.loadConfig({ includeDiffMaxBytes: -1, maxIssuesInText: -5 });
check(
  "配置（v0.5.9）：includeDiffMaxBytes / maxIssuesInText 有上界（防手误按「几乎不限制」拼 diff）；负数回落默认，显式 0 仍合法",
  bigCfg.includeDiffMaxBytes === 10 * 1024 * 1024 &&
    bigCfg.maxIssuesInText === 2000 &&
    negCfg.includeDiffMaxBytes === cfgMod.DEFAULTS.includeDiffMaxBytes &&
    negCfg.maxIssuesInText === cfgMod.DEFAULTS.maxIssuesInText &&
    hrZeroCfg.includeDiffMaxBytes === 0,
  JSON.stringify({
    big: [bigCfg.includeDiffMaxBytes, bigCfg.maxIssuesInText],
    neg: [negCfg.includeDiffMaxBytes, negCfg.maxIssuesInText],
  }),
);

/* v0.3.6：真机 `ocr scan` 复审报出的 5 条。high 那条 = 「ocr 的 --timeout 被夹到 60，
   插件侧硬超时却按 999 分钟算」：同一个分钟数必须只有一个来源，且处处被上限夹住。 */
const hrMaxCfg = cfgMod.loadConfig({ timeoutMinutes: 999, maxTimeoutMinutes: 120 });
check(
  "配置（v0.3.6 回归）：timeoutMinutes 被 maxTimeoutMinutes 夹住（不会再出现「ocr 60 分钟、插件 999 分钟」）",
  hrMaxCfg.timeoutMinutes === 120 &&
    hrMaxCfg.maxTimeoutMinutes === 120 &&
    cfgMod.timeoutMsOf(hrMaxCfg, 999) === 120 * 60000 &&
    cfgMod.timeoutMsOf(hrMaxCfg) === 120 * 60000,
  JSON.stringify({ timeoutMinutes: hrMaxCfg.timeoutMinutes, ms: cfgMod.timeoutMsOf(hrMaxCfg, 999) }),
);
check(
  "配置（v0.3.6 回归）：未配 maxTimeoutMinutes 时回落到出厂上限；maxTimeoutMinutes 自身也有 24h 硬上界",
  cfgMod.loadConfig({ timeoutMinutes: 999 }).timeoutMinutes === cfgMod.DEFAULTS.maxTimeoutMinutes &&
    cfgMod.loadConfig({ maxTimeoutMinutes: 5000 }).maxTimeoutMinutes === cfgMod.MAX_TIMEOUT_MINUTES &&
    cfgMod.MAX_TIMEOUT_MINUTES === 24 * 60,
  JSON.stringify({
    fallback: cfgMod.loadConfig({ timeoutMinutes: 999 }).timeoutMinutes,
    capped: cfgMod.loadConfig({ maxTimeoutMinutes: 5000 }).maxTimeoutMinutes,
  }),
);
check(
  "配置（v0.3.6 回归）：数字字符串（手写 config.json 常见）不再静默回落默认，空串也不当 0",
  cfgMod.loadConfig({ timeoutMinutes: "20" }).timeoutMinutes === 20 &&
    cfgMod.loadConfig({ autoMinIntervalMs: "250" }).autoMinIntervalMs === 250 &&
    cfgMod.loadConfig({ timeoutMinutes: "" }).timeoutMinutes === cfgMod.DEFAULTS.timeoutMinutes,
  JSON.stringify({
    str: cfgMod.loadConfig({ timeoutMinutes: "20" }).timeoutMinutes,
    interval: cfgMod.loadConfig({ autoMinIntervalMs: "250" }).autoMinIntervalMs,
    empty: cfgMod.loadConfig({ timeoutMinutes: "" }).timeoutMinutes,
  }),
);
check(
  "配置（v0.3.6 回归）：显式分钟优先于生效配置，且两者都受同一个上限约束",
  cfgMod.timeoutMsOf({ timeoutMinutes: 15 }, 30) === 30 * 60000 &&
    cfgMod.timeoutMsOf({ timeoutMinutes: "20" }) === 20 * 60000 &&
    cfgMod.timeoutMsOf({ timeoutMinutes: 15 }, 999) === cfgMod.DEFAULTS.maxTimeoutMinutes * 60000,
  JSON.stringify([
    cfgMod.timeoutMsOf({ timeoutMinutes: 15 }, 30),
    cfgMod.timeoutMsOf({ timeoutMinutes: "20" }),
    cfgMod.timeoutMsOf({ timeoutMinutes: 15 }, 999),
  ]),
);
const hrSameSrcCfg = { timeoutMinutes: 999, maxTimeoutMinutes: 120 };
const hrSameSrcPlan = review.normalizeTarget({ scope: "workspace", timeoutMinutes: 999 }, hrSameSrcCfg, "C:/tmp");
check(
  "配置（v0.3.6 回归）：Jobs 行的截止时间与 run 同源（plan.timeoutMs = 分钟 + 60s 宽限，job 不早于 run 触发）",
  hrSameSrcPlan.timeoutMinutes === 120 &&
    hrSameSrcPlan.timeoutMs === 121 * 60000 &&
    cfgMod.timeoutMsOf(hrSameSrcCfg, hrSameSrcPlan.timeoutMinutes) === hrSameSrcPlan.timeoutMs - 60000,
  `plan.timeoutMs=${hrSameSrcPlan.timeoutMs} jobBase=${cfgMod.timeoutMsOf(hrSameSrcCfg, hrSameSrcPlan.timeoutMinutes)}`,
);
const reviewerMod = await import(new URL("../lib/reviewer.js", import.meta.url));
check(
  "配置（v0.3.6 回归）：DEFAULT_REVIEWER_ROUNDS 只有一份定义（lib/config.js，reviewer.js 只转发）",
  reviewerMod.DEFAULT_REVIEWER_ROUNDS === cfgMod.DEFAULT_REVIEWER_ROUNDS && cfgMod.DEFAULT_REVIEWER_ROUNDS === 3,
  `reviewer=${reviewerMod.DEFAULT_REVIEWER_ROUNDS} config=${cfgMod.DEFAULT_REVIEWER_ROUNDS}`,
);
check(
  "可见性（v0.3.6 回归）：endpoint 模式仍用出厂默认地址时点名提醒（换了供应商忘改地址 → 凭据发到旧地址）",
  cfgMod.endpointDisplay() === "(未设置)" &&
    cfgMod.endpointDisplay("https://api.example.com/v1") === "https://api.example.com/v1" &&
    cfgMod.endpointDisplay(cfgMod.DEFAULTS.llm.baseUrl).includes("出厂默认地址"),
  `${cfgMod.endpointDisplay(cfgMod.DEFAULTS.llm.baseUrl)} | ${cfgMod.endpointDisplay("https://api.example.com/v1")}`,
);


/* 读 config.example.json（真实的 config.json 已被 .gitignore 忽略、也不再进包，
   CI 里只有模板）+ 两份 README，断言「别把明文密钥写进文件」这条警示没被删掉。 */
const hrDocsText = [
  JSON.stringify(JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8"))._readme),
  readFileSync(new URL("../README.md", import.meta.url), "utf8"),
  readFileSync(new URL("../README.zh.md", import.meta.url), "utf8"),
].join("\n");
check(
  "文档（v0.3.5 回归）：config.example.json 的 _readme 与两份 README 都警示「别把明文密钥写进文件」",
  /不要[^"]*明文密钥/.test(hrDocsText) && /llm\.apiKeyRef/.test(hrDocsText) && /(不会被提交|不该被提交|不写明文|no plaintext)/.test(hrDocsText),
  `len=${hrDocsText.length}`,
);

/* P2：from/to/commit 原样进 git 命令（在 -- 之前），以 - 开头会被 git 当选项。 */
const hrRefCase = cannedHarness([{ exitCode: 0, stdout: "{}" }]);
const hrRefRun = await hrRefCase.call({ scope: "range", from: "--output=C:/tmp/x", to: "HEAD" });
check(
  "参数（P2 回归）：from/to/commit 以 - 开头时直接拒绝，且不开子进程",
  hrRefRun.ok === false && hrRefRun.code === "OCR_INVALID_ARGS" && /不能以 - 开头/.test(hrRefRun.summary) && hrRefCase.canned.calls.length === 0,
  `${hrRefRun.code} | ${hrRefRun.summary} | spawn=${hrRefCase.canned.calls.length}`,
);

/* P2：ocr 的输出可能带 ANSI 颜色 / 进度行 + 结果行。 */
const hrAnsi = review.parseJsonLoose(`\u001b[32m${JSON.stringify({ files: [], issues: [] })}\u001b[0m`);
check(
  "解析（P2 回归）：带 ANSI 颜色的 JSON 能解析出来",
  Boolean(hrAnsi) && Array.isArray(hrAnsi.issues),
  JSON.stringify(hrAnsi),
);
const hrJsonl = review.parseJsonLoose('starting review\nscanned 3 files\n{"files":[],"issues":[{"message":"x"}]}');
check(
  "解析（P2 回归）：进度行 + JSON 结果行也能解析出来",
  Boolean(hrJsonl) && Array.isArray(hrJsonl.issues),
  JSON.stringify(hrJsonl),
);

/* M1（v0.4.0）：成本可见、未重试原因、ocr 安装指引、外部配置文件。
   这四样都来自「真跑一次才发现」的缺口：桥在丢 token、该重试却没重试、新手装不上 ocr、
   从 GitHub 安装后改包内 config.json 会被升级覆盖 —— 工具输出里当时一个字都没有。 */
{
  const hintWin = cli.installHint("win32");
  const hintNix = cli.installHint("darwin");
  check(
    "M1：installHint（Windows）是一份能照着做的指引（npm 包名 + 真 exe + .cmd shim 的 EINVAL 坑）",
    hintWin.includes("@alibaba-group/open-code-review") &&
      hintWin.includes("opencodereview.exe") &&
      hintWin.includes(".cmd") &&
      hintWin.includes("EINVAL") &&
      hintWin.split("\n").length >= 5,
    `${hintWin.split("\n").length} 行`,
  );
  check(
    "M1：installHint 按平台分叉（macOS/Linux 说 which opencodereview，不提 Windows 的 .cmd 坑）",
    hintNix.includes("which opencodereview") && !hintNix.includes("EINVAL"),
    hintNix.split("\n")[2] ?? "",
  );
}
{
  /* 配置文件解析顺序：env DSH_OPEN_CODE_REVIEW_CONFIG > <DSH_HOME>/dsh-open-code-review.json
     > <插件目录>/config.json。修的是真机上的隐形坑：从 GitHub（git）安装后，包内 config.json
     落在 node_modules 里，用户改它、下次升级就被覆盖。 */
  const dir = mkdtempSync(join(tmpdir(), "ocr-cfg-"));
  const homeFile = join(dir, "dsh-open-code-review.json");
  const envFile = join(dir, "custom.json");
  writeFileSync(homeFile, JSON.stringify({ timeoutMinutes: 42 }));
  writeFileSync(envFile, JSON.stringify({ timeoutMinutes: 7 }));
  const beforeHome = process.env.DSH_HOME;
  const beforeExplicit = process.env.DSH_OPEN_CODE_REVIEW_CONFIG;
  try {
    process.env.DSH_HOME = dir;
    delete process.env.DSH_OPEN_CODE_REVIEW_CONFIG;
    const resolvedHome = cfgMod.resolveConfigFile();
    const cfgHome = cfgMod.loadConfig();
    process.env.DSH_OPEN_CODE_REVIEW_CONFIG = envFile;
    const resolvedEnv = cfgMod.resolveConfigFile();
    const cfgEnv = cfgMod.loadConfig();
    check(
      "M1：配置文件解析顺序 —— <DSH_HOME>/dsh-open-code-review.json 优先于插件目录，env 指定则只认它",
      resolvedHome.source === "home" &&
        resolvedHome.path === homeFile &&
        cfgHome.timeoutMinutes === 42 &&
        cfgHome.__configSource === "home" &&
        cfgHome.__fileKeys.includes("timeoutMinutes") &&
        resolvedEnv.source === "env" &&
        resolvedEnv.path === envFile &&
        cfgEnv.timeoutMinutes === 7,
      JSON.stringify({ home: resolvedHome.source, env: resolvedEnv.source, t1: cfgHome.timeoutMinutes, t2: cfgEnv.timeoutMinutes }),
    );
  } finally {
    if (beforeHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = beforeHome;
    if (beforeExplicit === undefined) delete process.env.DSH_OPEN_CODE_REVIEW_CONFIG;
    else process.env.DSH_OPEN_CODE_REVIEW_CONFIG = beforeExplicit;
  }
  const back = cfgMod.resolveConfigFile();
  check(
    "M1：撤掉 env 后回到插件目录里的 config.json；reportPath 也报得出来（没有文件时报推荐位置）",
    (back.source === "plugin" || back.source === "none") && typeof back.path === "string" && back.path.length > 0,
    `${back.source} ${back.path}`,
  );
  const sample = { _readme: "x", timeoutMinutes: 30, llm: { model: "m", baseUrl: "u" }, env: { A: "1" } };
  check(
    "M1：fileValuePaths 把 llm/env 这类对象展开成点号路径、跳过 _ 注释、排序稳定",
    JSON.stringify(cfgMod.fileValuePaths(sample)) === JSON.stringify(["env.A", "llm.baseUrl", "llm.model", "timeoutMinutes"]),
    JSON.stringify(cfgMod.fileValuePaths(sample)),
  );
}
{
  /* v0.5.0 步骤 5：env 指定的文件不存在时**不再终止解析**，继续回落 home → 插件目录。
     老行为（OCR 真机扫描报的第 1 条）：路径写错时静默按「出厂默认 + 设置页」跑，用户以为配置生效了。 */
  const dir = mkdtempSync(join(tmpdir(), "ocr-cfg-env-"));
  const homeFile = join(dir, "dsh-open-code-review.json");
  const missing = join(dir, "nope.json");
  writeFileSync(homeFile, JSON.stringify({ audience: "human" }));
  const beforeHome = process.env.DSH_HOME;
  const beforeExplicit = process.env.DSH_OPEN_CODE_REVIEW_CONFIG;
  try {
    process.env.DSH_HOME = dir;
    process.env.DSH_OPEN_CODE_REVIEW_CONFIG = missing;
    const resolved = cfgMod.resolveConfigFile();
    const cfg = cfgMod.loadConfig();
    check(
      "v0.5.0 步骤 5：DSH_OPEN_CODE_REVIEW_CONFIG 指向不存在的文件时回落到 home（不再当成 env 命中）",
      resolved.source === "home" &&
        resolved.path === homeFile &&
        resolved.envMissing === true &&
        resolved.envPath === missing &&
        cfg.audience === "human" &&
        cfg.__envConfigMissing === true &&
        String(cfg.__configSourceHint).includes("不存在"),
      JSON.stringify({ source: resolved.source, envMissing: resolved.envMissing, hint: cfg.__configSourceHint }),
    );
    check(
      "v0.5.0 步骤 5：envConfigPath() 只认非空白的 DSH_OPEN_CODE_REVIEW_CONFIG，configSourceText 覆盖四种来源",
      cfgMod.envConfigPath() === missing &&
        cfgMod.configSourceText("env").includes("DSH_OPEN_CODE_REVIEW_CONFIG") &&
        cfgMod.configSourceText("home").includes("DSH_HOME") &&
        cfgMod.configSourceText("plugin").includes("config.json") &&
        cfgMod.configSourceText("none").includes("出厂默认"),
      `${cfgMod.envConfigPath()} · ${cfgMod.configSourceText("home")}`,
    );
    process.env.DSH_OPEN_CODE_REVIEW_CONFIG = "   ";
    check("v0.5.0 步骤 5：env 变量是空白串时等同于没设置（不会去找一个叫空的文件）", cfgMod.envConfigPath() === "", JSON.stringify(cfgMod.envConfigPath()));
  } finally {
    if (beforeHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = beforeHome;
    if (beforeExplicit === undefined) delete process.env.DSH_OPEN_CODE_REVIEW_CONFIG;
    else process.env.DSH_OPEN_CODE_REVIEW_CONFIG = beforeExplicit;
  }
}
{
  /* v0.5.0 步骤 5：三层合并必须**先深合并、再归一**，否则合并进来的坏类型会原样漏过去；
     数值再夹一层上下界（config.json 能绕过设置页 schema 的 min/max）。 */
  const merged = cfgMod.mergeLayers(
    { llm: { model: "from-file", protocol: "OpenAI " }, env: { A: "1" }, reviewer: { rounds: "3" } },
    { llm: { mode: "Endpoint" }, reviewer: { agent: "SPAWN" } },
  );
  check(
    "v0.5.0 步骤 5：mergeLayers 先深合并再归一（file 的 llm/env/reviewer 与 patch 的键都在，坏类型被收敛）",
    merged.llm.model === "from-file" &&
      merged.llm.mode === "endpoint" &&
      merged.llm.protocol === "openai" &&
      merged.env.A === "1" &&
      merged.reviewer.agent === "spawn" &&
      merged.reviewer.rounds === 3,
    JSON.stringify({ llm: merged.llm, env: merged.env, reviewer: merged.reviewer }),
  );
  const guarded = cfgMod.mergeLayers({ llm: ["x"] }, { reviewer: ["y"], env: "nope" });
  check(
    "v0.5.0 步骤 5：嵌套块传数组/字符串时整块回落默认（不会展开成数字键对象污染配置）",
    guarded.llm.mode === "dsh" &&
      guarded.reviewer.agent === "off" &&
      Object.keys(guarded.llm).every((key) => !/^\d+$/.test(key)) &&
      JSON.stringify(guarded.env) === "{}",
    JSON.stringify({ llm: guarded.llm, reviewer: guarded.reviewer, env: guarded.env }),
  );
  const clamped = cfgMod.normalizeConfig({
    engine: "OCR",
    audience: "nope",
    autoMaxPerSession: 99999,
    autoMinReviewableFiles: 0,
    autoMinIntervalMs: -1,
    timeoutMinutes: 0,
    maxTimeoutMinutes: 99999,
    llm: { mode: "Endpoint", protocol: "Anthropic " },
    reviewer: { agent: "Spawn", rounds: 99 },
  });
  check(
    "v0.5.0 步骤 5：越界值 — 大于上界夹住，小于下界回落到默认（负数不是「要更小」而是写错）",
    clamped.autoMaxPerSession === 50 &&
      clamped.autoMinReviewableFiles === 1 &&
      clamped.autoMinIntervalMs === 60000 &&
      clamped.timeoutMinutes === 15 &&
      clamped.maxTimeoutMinutes === 1440,
    JSON.stringify({ autoMaxPerSession: clamped.autoMaxPerSession, autoMinReviewableFiles: clamped.autoMinReviewableFiles, autoMinIntervalMs: clamped.autoMinIntervalMs, timeoutMinutes: clamped.timeoutMinutes, maxTimeoutMinutes: clamped.maxTimeoutMinutes }),
  );
  check(
    "v0.5.0 步骤 5：枚举非法值回落默认、合法值去空白小写（engine/audience/llm.mode/llm.protocol/reviewer.agent）",
    clamped.engine === "ocr" &&
      clamped.audience === "agent" &&
      clamped.llm.mode === "endpoint" &&
      clamped.llm.protocol === "anthropic" &&
      clamped.reviewer.agent === "spawn" &&
      clamped.reviewer.rounds === 10,
    JSON.stringify({ engine: clamped.engine, audience: clamped.audience, llm: clamped.llm, reviewer: clamped.reviewer }),
  );
}
{
  const statusForM1 = await tools.get("ocr_status").execute({ checkLlm: false }, exec);
  check(
    "M1：ocr_status 报出配置文件的来源与「文件层实际设了哪些键」，installHint 字段恒在（找不到 ocr 时才有内容）",
    typeof statusForM1.configPath === "string" &&
      statusForM1.configPath.length > 0 &&
      ["env", "home", "plugin", "none"].includes(statusForM1.configSource) &&
      Array.isArray(statusForM1.fileValues) &&
      typeof statusForM1.installHint === "string",
    `${statusForM1.configSource} · ${statusForM1.configPath} · fileValues=${JSON.stringify(statusForM1.fileValues)}`,
  );
  check(
    "M1：来源是插件目录时，notes 里提醒「git 安装后会随升级被覆盖」并给出推荐路径",
    statusForM1.configSource !== "plugin" ||
      statusForM1.notes.some((line) => line.includes("node_modules") && line.includes("dsh-open-code-review.json")),
    String(statusForM1.notes.find((line) => line.includes("node_modules")) ?? "").slice(0, 120),
  );
}
{
  const reviewSchema = tools.get("ocr_review")?.output?.schema ?? {};
  const usageSchema = reviewSchema?.properties?.usage ?? null;
  check(
    "v0.5.4：ocr_review 的 usage 声明了缓存命中/写入（六个数字键），且都不在 required 里（endpoint 路由没有桥数据时不写）",
    Boolean(usageSchema) &&
      Object.keys(usageSchema.properties ?? {}).sort().join(",") ===
        "cache_read_tokens,cache_write_tokens,completion_tokens,partial,prompt_tokens,requests,total_tokens" &&
      !(reviewSchema.required ?? []).includes("usage") &&
      !(usageSchema.required ?? []).includes("partial") &&
      !(usageSchema.required ?? []).includes("cache_read_tokens"),
    JSON.stringify(usageSchema).slice(0, 200),
  );
  const statusSchema = tools.get("ocr_status")?.output?.schema ?? {};
  const bridgeDecl = JSON.stringify(statusSchema?.properties?.bridge ?? null);
  check(
    "v0.5.4：ocr_status 的 schema 声明了 command（name/registered/reason）并进 required（漏声明 = 真机拒收）",
    (statusSchema?.properties?.command?.required ?? []).join(",") === "name,registered,reason" &&
      (statusSchema?.required ?? []).includes("command"),
    JSON.stringify(statusSchema?.properties?.command ?? null).slice(0, 160),
  );
  check(
    "M1：ocr_status 的 bridge schema 声明了 tokens / retrySkips / retrySkipReason（返回值多键会被宿主拒收）",
    bridgeDecl.includes("\"tokens\"") && bridgeDecl.includes("\"retrySkips\"") && bridgeDecl.includes("\"retrySkipReason\""),
    bridgeDecl.slice(0, 120),
  );
  check(
    "v0.5.4：bridge.tokens 的 schema 也声明了 partial 与两个缓存字段（additionalProperties:false，漏声明 = 真机拒收）",
    bridgeDecl.includes("\"partial\"") &&
      bridgeDecl.includes("\"cache_read_tokens\"") &&
      bridgeDecl.includes("\"cache_write_tokens\"") &&
      (statusSchema?.properties?.bridge?.oneOf?.[0]?.properties?.tokens?.required ?? []).includes("partial") &&
      (statusSchema?.properties?.bridge?.oneOf?.[0]?.properties?.tokens?.required ?? []).includes("cache_read_tokens"),
    bridgeDecl.slice(0, 200),
  );
  check(
    "M1：ocr_status 的 schema 声明了 configPath / configSource / fileValues / installHint",
    ["configPath", "configSource", "fileValues", "installHint"].every((key) => Boolean(statusSchema?.properties?.[key])),
    Object.keys(statusSchema.properties ?? {}).join(","),
  );
  check(
    "v0.5.0 步骤 3：ocr_status 的 schema 声明了 onDemand 与 skill（返回值多键会被宿主拒收）",
    statusSchema?.properties?.onDemand?.type === "boolean" &&
      statusSchema?.properties?.skill?.type === "object" &&
      ["name", "registered", "reason"].every((key) => Boolean(statusSchema?.properties?.skill?.properties?.[key])) &&
      (statusSchema?.required ?? []).includes("onDemand") &&
      (statusSchema?.required ?? []).includes("skill"),
    `${JSON.stringify(statusSchema?.properties?.skill).slice(0, 160)} | required=${(statusSchema?.required ?? []).join(",")}`,
  );
  check(
    "v0.5.7/v0.6.0：ocr_status 的 schema 声明了 preTest（含 failOpen/lastError/lastDecision）并进 required",
    statusSchema?.properties?.preTest?.type === "object" &&
      (statusSchema?.properties?.preTest?.properties?.mode?.enum ?? []).join(",") === "off,remind,gate" &&
      (statusSchema?.properties?.preTest?.required ?? []).join(",") === "mode,mechanism,denials,reminders,failOpen,lastError,lastDecision" &&
      (statusSchema?.properties?.preTest?.properties?.lastDecision?.required ?? []).join(",") === "tool,kind,at" &&
      (statusSchema?.required ?? []).includes("preTest"),
    `${JSON.stringify(statusSchema?.properties?.preTest ?? null).slice(0, 200)}`,
  );
}

/* v0.6.0：preTest 只有 tools/pre-execute 一条注册路径（不再注册全局单调 guard ——
   0.5.7~0.5.9 那次事故就是它：放行返回 "" 被宿主当成拒绝理由，所有工具都变成 Error: ）。
   这里按宿主的 waterfall 语义驱动：有决定权就返回 {kind:"deny",reason}，否则必须 next()。 */
const preExecute = (listeners) => {
  const handlers = listeners.get("tools/pre-execute") ?? [];
  return {
    handlers,
    ask: (exec) => {
      let nexted = false;
      let out = null;
      for (const handler of handlers) {
        out = handler(exec, () => {
          nexted = true;
          return { kind: "allow" };
        });
        if (out && out.kind === "deny") return { kind: "deny", reason: String(out.reason ?? ""), nexted };
        if (nexted) break;
      }
      return { kind: nexted ? "allow" : "none", reason: "", nexted };
    },
  };
};

/* v0.5.7：评审先于测试（preTest）—— gate 档挡住没评审就开跑的测试命令，
   remind 档放行但回来提醒；覆盖状态由成功的 ocr_review 置位、成功的写工具清位。 */
{
  check(
    "preTest：出厂默认 off，且三档归一（GATE → gate，不认识的写法回落默认）——只看出厂默认与归一，这样本机 config.json 写什么都不影响这条",
    cfgMod.DEFAULTS.preTest === "off" &&
      cfgMod.normalizeConfig({ ...cfgMod.DEFAULTS, preTest: undefined }).preTest === "off" &&
      cfgMod.normalizeConfig({ ...cfgMod.DEFAULTS, preTest: " GATE " }).preTest === "gate" &&
      cfgMod.normalizeConfig({ ...cfgMod.DEFAULTS, preTest: "nope" }).preTest === "off" &&
      cfgMod.normalizeConfig({ ...cfgMod.DEFAULTS, preTest: "Remind" }).preTest === "remind",
    `${cfgMod.DEFAULTS.preTest} / ${cfgMod.normalizeConfig({ ...cfgMod.DEFAULTS, preTest: " GATE " }).preTest} / ${
      cfgMod.normalizeConfig({ ...cfgMod.DEFAULTS, preTest: "nope" }).preTest
    }`,
  );
  const exec = (command, name = "pwsh") => ({ name, arguments: { command }, agent: makeAgent() });
  check(
    "preTest：只认 shell 类工具里**命令开头**的测试入口（read/write 里出现 test 字样不算，只是提了一嘴的普通命令也不算）",
    mod.isTestCommand(exec("pnpm test")) === true &&
      mod.isTestCommand(exec("node --test test/smoke.mjs")) === true &&
      mod.isTestCommand(exec("npx vitest run")) === true &&
      mod.isTestCommand(exec("python -m pytest -q")) === true &&
      mod.isTestCommand(exec("cargo test")) === true &&
      mod.isTestCommand(exec("cd lib && npm test")) === true &&
      mod.isTestCommand(exec("ls -la")) === false &&
      mod.isTestCommand(exec('git commit -m "fix jest tests"')) === false &&
      mod.isTestCommand(exec("grep -r pytest src/")) === false &&
      mod.isTestCommand(exec("cat vitest.config.js")) === false &&
      mod.isTestCommand(exec("pnpm test", "read")) === false &&
      mod.isTestCommand({ name: "pwsh", arguments: {} }) === false,
    [exec("pnpm test"), exec("ls -la")].map((e) => mod.isTestCommand(e)).join(","),
  );
  const ptAgent = Object.assign(makeAgent(), { id: "session-pretest" });
  const ptExec = (command) => ({ name: "pwsh", arguments: { command }, agent: ptAgent });
  const onResult = (map, name, result) => {
    for (const handler of map.get("tools/result") ?? []) handler({ name, arguments: {}, agent: ptAgent }, result);
  };

  const gateListeners = new Map();
  const gateCase = makeCtx({ listeners: gateListeners });
  let guardRegistrations = 0;
  gateCase.tools.guard = () => {
    guardRegistrations += 1;
    return () => {};
  };
  mod.apply(gateCase, mkConfig({ preTest: "gate" }));
  const gateDrive = preExecute(gateListeners);
  check(
    "v0.6.0：preTest 只注册 tools/pre-execute，完全不碰全局 ctx.tools.guard()（限定爆炸范围）",
    gateDrive.handlers.length === 1 && guardRegistrations === 0 && mod.preTestStats().mechanism === "pre-execute",
    `handlers=${gateDrive.handlers.length} guard=${guardRegistrations} mechanism=${mod.preTestStats().mechanism}`,
  );
  const denied = gateDrive.ask(ptExec("npm test"));
  check(
    "preTest：没有评审覆盖 → 闸门给拒绝理由（理由点明先跑 ocr_review，非测试命令放行）",
    denied.kind === "deny" && denied.reason.includes("ocr_review") && denied.reason.includes("评审先于测试") && gateDrive.ask(ptExec("ls -la")).kind === "allow",
    denied.reason.slice(0, 120),
  );
  onResult(gateListeners, "ocr_review", { isError: false, value: { ok: true } });
  check("preTest：一次成功的 ocr_review 覆盖这批改动后放行", gateDrive.ask(ptExec("npm test")).kind === "allow");
  onResult(gateListeners, "write", { isError: false, value: { ok: true } });
  check(
    "preTest：写文件成功后覆盖立刻作废（改完必须重新评审）",
    gateDrive.ask(ptExec("npm test")).kind === "deny",
  );
  onResult(gateListeners, "ocr_review", { isError: true, value: { ok: false, code: "OCR_RUN_FAILED" } });
  check(
    "preTest：失败的 ocr_review 不算「评过了」（fail-closed）",
    gateDrive.ask(ptExec("npm test")).kind === "deny",
  );
  onResult(gateListeners, "ocr_review", { isError: false, value: { ok: true, preview: true } });
  check(
    "preTest：preview 的 ocr_review 也不算「评过了」（只列文件、没调 LLM，否则一条 preview 就能绕过闸门）",
    gateDrive.ask(ptExec("npm test")).kind === "deny",
  );
  const denialsBefore = mod.preTestStats().denials;
  const sameCall = (callId) => ({ name: "pwsh", arguments: { command: "npm test" }, agent: ptAgent, callId });
  gateDrive.ask(sameCall("call-1"));
  gateDrive.ask(sameCall("call-1"));
  check(
    "preTest：同一次工具调用被询问多次只记一次拦截（按 callId 去重）",
    mod.preTestStats().denials - denialsBefore === 1,
    `Δ=${mod.preTestStats().denials - denialsBefore}`,
  );
  onResult(gateListeners, "ocr_review", { isError: false, value: { ok: true, preview: false } });
  check("preTest：真正调过 LLM 的评审（preview=false）才放行", gateDrive.ask(ptExec("npm test")).kind === "allow");

  /* 非 shell 工具：一次 Set 查找后立刻 next()，完全不读配置、不参与判定。 */
  const nonShell = gateDrive.ask({ name: "glob", arguments: { pattern: "*" }, agent: ptAgent });
  check(
    "preTest：非 shell 工具直接 next()（一次 Set 查找后就不参与判定，也不会为它读配置）",
    nonShell.kind === "allow" && nonShell.nexted === true,
    JSON.stringify(nonShell),
  );

  /* fail-open：闸门自身出任何错都必须放行并留下痕迹（可选功能不能拖垮工具面）。 */
  const failOpenBefore = mod.preTestStats().failOpen;
  const boomExec = {
    name: "pwsh",
    get arguments() {
      throw new Error("注入的爆炸");
    },
    agent: ptAgent,
  };
  const boom = gateDrive.ask(boomExec);
  const failOpenStats = mod.preTestStats();
  check(
    "preTest：闸门自身抛异常 → fail-open（放行 + 计数 + lastError + lastDecision.kind=fail-open）",
    boom.kind === "allow" &&
      boom.nexted === true &&
      failOpenStats.failOpen - failOpenBefore === 1 &&
      failOpenStats.lastError.includes("注入的爆炸") &&
      failOpenStats.lastDecision.kind === "fail-open",
    `failOpen=${failOpenStats.failOpen} lastError=${JSON.stringify(failOpenStats.lastError)} last=${JSON.stringify(failOpenStats.lastDecision)}`,
  );
  check(
    "preTest：lastDecision 记下最后一次判定（工具名 + kind + 时间戳）",
    (() => {
      gateDrive.ask(sameCall("call-last"));
      const d = mod.preTestStats().lastDecision;
      return d.tool === "pwsh" && d.kind === "allow" && Number.isFinite(d.at) && d.at > 0;
    })(),
    JSON.stringify(mod.preTestStats().lastDecision),
  );

  /* remind：闸门照样挂上（只记账、不拦），否则测试结果回来时没有任何 pending 可提醒。 */
  const remindListeners = new Map();
  const remindCase = makeCtx({ listeners: remindListeners });
  let remindGuardCalls = 0;
  remindCase.tools.guard = () => {
    remindGuardCalls += 1;
    return () => {};
  };
  mod.apply(remindCase, mkConfig({ preTest: "remind" }));
  const remindAgent = Object.assign(makeAgent(), { id: "session-remind" });
  const followed = [];
  remindAgent.followup = (message) => followed.push(message);
  const remindExec = { name: "pwsh", arguments: { command: "npm test" }, agent: remindAgent };
  const remindDrive = preExecute(remindListeners);
  const remindVerdict = remindDrive.ask(remindExec);
  check(
    "preTest：remind 档也挂闸门但一律放行（只记账；不挂的话测试结果回来时根本没有 pending）",
    remindDrive.handlers.length === 1 &&
      remindGuardCalls === 0 &&
      remindVerdict.kind === "allow" &&
      remindVerdict.nexted === true &&
      mod.preTestStats().mode === "remind" &&
      mod.preTestStats().mechanism === "pre-execute",
    `handlers=${remindDrive.handlers.length} guard=${remindGuardCalls} verdict=${JSON.stringify(remindVerdict)} mode=${mod.preTestStats().mode}/${mod.preTestStats().mechanism}`,
  );
  for (const handler of remindListeners.get("tools/result") ?? []) {
    handler(remindExec, { isError: false, value: { ok: true } });
  }
  check(
    "preTest：remind 档在测试结果回来后给模型一条「这批改动还没评审」的提醒",
    followed.length === 1 && textOf(followed[0]).includes("ocr_review"),
    followed.map(textOf).join(" | ").slice(0, 120),
  );

  /* v0.6.0 事故回归（源码级）：0.5.7~0.5.9 的全局 guard 是「放行返回 "" 被宿主当成拒绝
     理由 ⇒ 所有工具变成 Error: 」的直接来源。防线是**压根不注册**它，所以这里直接检查
     源码里不再有 tools.guard 调用（比行为断言更难绕过：无论配置是什么都不该出现）。 */
  const indexSource = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  /* 注释里提到这次事故是允许的（甚至是希望的文档），所以先把注释剥掉再看调用点。 */
  const indexCode = indexSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  check(
    "v0.6.0 事故回归：lib/index.js 的代码里不再出现 ctx.tools.guard（唯一的注册面是 tools/pre-execute）",
    !/tools\s*\.\s*guard\s*\(/.test(indexCode) && !/\bguards?\s*\.\s*append\s*\(/.test(indexCode),
    `matches=${(indexCode.match(/tools\s*\.\s*guard\s*\(/g) ?? []).length}（注释里提到 ${(indexSource.match(/tools\s*\.\s*guard/g) ?? []).length} 次）`,
  );
}

/* v0.6.0 契约回归：宿主对 tools/pre-execute（waterfall）的语义是「返回
   {kind:"deny",reason} 即拒绝，必须 next() 才继续」。这条用例自己实现该语义，
   防止再把「放行」写成假值/空字符串而让整个工具面变成 Error: —— 0.5.7~0.5.9 就是这样坏的。 */
{
  const contractListeners = new Map();
  const contractCase = makeCtx({ listeners: contractListeners });
  let contractGuardCalls = 0;
  contractCase.tools.guard = () => {
    contractGuardCalls += 1;
    return () => {};
  };
  mod.apply(contractCase, mkConfig({ preTest: "gate" }));
  const contractDrive = preExecute(contractListeners);
  const contractAgent = Object.assign(makeAgent(), { id: "session-pretest-contract" });
  const nonTest = contractDrive.ask({ name: "glob", arguments: { pattern: "*" }, agent: contractAgent });
  const test = contractDrive.ask({ name: "pwsh", arguments: { command: "npm test" }, agent: contractAgent });
  check(
    "v0.6.0 契约回归：闸门一个全局 tools.guard 都不注册，只走 pre-execute（非测试命令 next() 放行、测试命令给 {kind:deny,reason}）",
    contractGuardCalls === 0 &&
      contractDrive.handlers.length === 1 &&
      nonTest.kind === "allow" &&
      nonTest.nexted === true &&
      test.kind === "deny" &&
      test.reason.includes("ocr_review"),
    `guard=${contractGuardCalls} handlers=${contractDrive.handlers.length} nonTest=${JSON.stringify(nonTest)} test=${JSON.stringify(test).slice(0, 120)}`,
  );
}

/* v0.5.8：文件层（config.json）没有事件通知，而 auto / onDemand / preTest 的启停是
   「装/卸监听器」级别的决定 —— 真机上把 preTest 写成 gate，闸门一直没挂上、ocr_status
   也跟着报 off。修法：闸门只要插件没被关掉就挂着（off 只是放行）+ 借本来就会流的事件
   对配置指纹、需要时才重新 sync。 */
{
  const offListeners = new Map();
  const offCase = makeCtx({ listeners: offListeners });
  let offGuardCalls = 0;
  offCase.tools.guard = () => {
    offGuardCalls += 1;
    return () => {};
  };
  mod.apply(offCase, mkConfig({ preTest: "off" }));
  const offAgent = Object.assign(makeAgent(), { id: "session-pretest-off" });
  const offExec = { name: "pwsh", arguments: { command: "npm test" }, agent: offAgent };
  const offDrive = preExecute(offListeners);
  const offVerdict = offDrive.ask(offExec);
  check(
    "v0.5.8：preTest=off 时闸门也挂着（只是放行）—— 这样 config.json 改成 gate 立刻按新档位办事，不用重挂",
    offDrive.handlers.length === 1 &&
      offGuardCalls === 0 &&
      offVerdict.kind === "allow" &&
      offVerdict.nexted === true &&
      mod.preTestStats().mode === "off" &&
      mod.preTestStats().mechanism === "pre-execute",
    `handlers=${offDrive.handlers.length} guard=${offGuardCalls} verdict=${JSON.stringify(offVerdict)} mode=${mod.preTestStats().mode}/${mod.preTestStats().mechanism}`,
  );

  const disabledListeners = new Map();
  const disabledCase = makeCtx({ listeners: disabledListeners });
  mod.apply(disabledCase, mkConfig({ enabled: false }));
  check(
    "v0.5.8：enabled=false 才真的卸掉闸门（mechanism=none，一个 pre-execute 监听都不注册）",
    (disabledListeners.get("tools/pre-execute") ?? []).length === 0 &&
      mod.preTestStats().mode === "off" &&
      mod.preTestStats().mechanism === "none",
    `handlers=${(disabledListeners.get("tools/pre-execute") ?? []).length} mode=${mod.preTestStats().mode}/${mod.preTestStats().mechanism}`,
  );

  const syncListeners = new Map();
  const syncCase = makeCtx({ listeners: syncListeners });
  /* autoReview 是设置页 schema 的字段名（schemaOverrides 才把它映射成 auto）：
     有 schema 时只写 auto 会被丢掉，两个都写上，两种环境下的前提才是真的（OCR 自审指出）。 */
  mod.apply(syncCase, mkConfig({ auto: "off", autoReview: "off", preTest: "off" }));
  const resultHooks = (syncListeners.get("tools/result") ?? []).length;
  const stoppingHooks = (syncListeners.get("agent/turn-stopping") ?? []).length;
  check(
    "v0.5.8：auto=off 时也挂了配置指纹钩子（tools/result 与 agent/turn-stopping）——文件层改动靠它们被发现",
    resultHooks >= 2 && stoppingHooks >= 1,
    `tools/result=${resultHooks} agent/turn-stopping=${stoppingHooks}`,
  );

  const stampA = cfgMod.loadConfig({}).__configStamp;
  const stampB = cfgMod.loadConfig({ preTest: "gate" }).__configStamp;
  check(
    "v0.5.8：loadConfig 带文件层指纹 __configStamp（含生效路径；设置页 patch 不影响它，只有文件层变了才变）",
    typeof stampA === "string" && stampA.length > 0 && stampA.includes(String(cfgMod.loadConfig({}).__configPath)) && stampA === stampB,
    `${String(stampA).slice(0, 90)} / 相等=${stampA === stampB}`,
  );
  /* 轻量指纹（只 stat）必须与完整读取的指纹逐字相等，否则 syncAutoReviewer 的去重会永远失效 ——
     这条断言就是防两处实现漂移的（OCR 自审要求「别只断钩子挂上了，要断真的会重新同步」）。 */
  const cheapStamp = cfgMod.configFileStamp();
  check(
    "v0.5.8：configFileStamp()（只 stat 的轻量指纹）与 loadConfig().__configStamp 完全一致",
    typeof cheapStamp === "string" && cheapStamp !== "" && cheapStamp === stampA,
    `cheap=${String(cheapStamp).slice(0, 60)} full=${String(stampA).slice(0, 60)} 相等=${cheapStamp === stampA}`,
  );
}

/* v0.5.8 端到端：把文件层真的从 off 改成 gate，只靠「本来就会流的事件」+ 指纹去重，
   闸门就必须按新档位拦下测试命令（这是那条真机缺陷的回归测试，不是「钩子挂上了」级别的检查）。 */
{
  const tmpConfig = join(tmpdir(), `ocr-smoke-pretest-${process.pid}.json`);
  const prevEnv = process.env.DSH_OPEN_CODE_REVIEW_CONFIG;
  const flipListeners = new Map();
  const flipCase = makeCtx({ listeners: flipListeners });
  let flipGuardCalls = 0;
  flipCase.tools.guard = () => {
    flipGuardCalls += 1;
    return () => {};
  };
  try {
    writeFileSync(tmpConfig, JSON.stringify({ preTest: "off" }));
    process.env.DSH_OPEN_CODE_REVIEW_CONFIG = tmpConfig;
    mod.apply(flipCase, mkConfig({ auto: "off", autoReview: "off" }));
    const modeBefore = mod.preTestStats().mode;
    const keep = preExecute(flipListeners).ask({ name: "pwsh", arguments: { command: "npm test" }, agent: Object.assign(makeAgent(), { id: "s-flip-keep" }) });

    /* 文件层改成 gate：不改任何设置页字段、不重挂监听器 */
    writeFileSync(tmpConfig, JSON.stringify({ preTest: "gate" }));
    for (const hook of flipListeners.get("tools/result") ?? []) {
      hook({ name: "read", arguments: { path: "x" }, isError: false, value: {} });
    }
    /* syncIfConfigChanged 把重活放在微任务里，等两轮宏任务确保跑完 */
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const modeAfter = mod.preTestStats().mode;
    /* 宿主对 waterfall 的契约是「返回 {kind:"deny",reason} = 拒绝，next() = 继续」；
       这里按真实契约断（不是按我们自己的返回值形状）。 */
    const verdict = preExecute(flipListeners).ask({ name: "pwsh", arguments: { command: "npm test" }, agent: Object.assign(makeAgent(), { id: "s-flip-deny" }) });
    check(
      "v0.5.8：文件层 off → gate 之后，下一次 tools/result 就按新档位拦下测试命令（端到端，不用重启也不用设置页）",
      modeBefore === "off" &&
        keep.kind === "allow" &&
        keep.nexted === true &&
        flipGuardCalls === 0 &&
        modeAfter === "gate" &&
        verdict.kind === "deny" &&
        verdict.reason.includes("评审先于测试"),
      `before=${modeBefore} keep=${JSON.stringify(keep)} after=${modeAfter} verdict=${JSON.stringify(verdict)}`,
    );
  } finally {
    if (prevEnv === undefined) delete process.env.DSH_OPEN_CODE_REVIEW_CONFIG;
    else process.env.DSH_OPEN_CODE_REVIEW_CONFIG = prevEnv;
    try {
      rmSync(tmpConfig, { force: true });
    } catch {
      /* 清理失败不影响断言 */
    }
    cfgMod.loadConfig({});
  }
}

/* v0.5.8 三层优先级修（真机决定性实验的回归）：Host 把 schema 实例化后，用户没动过的字段
   也带着 schema 默认值（true / 3 / "off" / 15 …），旧实现只跳过「空值」⇒ 布尔/数字/枚举
   的默认值恒被当成设置页覆盖项，把 config.json（第二层）整个遮住。真机上表现为
   config.json 写 timeoutMinutes:7 → 运行时仍按 15、写 preTest:"gate" → 闸门不生效。
   规则：取值恰好等于出厂默认的字段不算覆盖（与设置页「没标已改」一致）。 */
{
  const tmpConfig = join(tmpdir(), `ocr-smoke-layer-${process.pid}.json`);
  const prevEnv = process.env.DSH_OPEN_CODE_REVIEW_CONFIG;
  try {
    check(
      "v0.5.8：设置页没动过任何字段时不产生覆盖项（schema 实例带着默认值，但文件层因此仍拿得到话事权）",
      cfgMod.schemaOverrides(mkConfig({})) === null,
      `overrides=${JSON.stringify(cfgMod.schemaOverrides(mkConfig({})))}`,
    );
    check(
      "v0.5.8：设置页真改过的字段仍然覆盖文件层（preTest=gate 不是默认值，必须留下）",
      cfgMod.schemaOverrides(mkConfig({ preTest: "gate" }))?.preTest === "gate",
      `overrides=${JSON.stringify(cfgMod.schemaOverrides(mkConfig({ preTest: "gate" })))}`,
    );
    /* 带 BOM 写：记事本 / PowerShell 另存为 UTF-8 会加 BOM，旧实现直接 parse 失败、
       整份配置被当坏文件回落到出厂默认（用户以为配置生效了）。 */
    writeFileSync(tmpConfig, `\uFEFF${JSON.stringify({ preTest: "gate", timeoutMinutes: 7 })}`, "utf8");
    process.env.DSH_OPEN_CODE_REVIEW_CONFIG = tmpConfig;
    const merged = cfgMod.loadConfig(cfgMod.schemaOverrides(mkConfig({})));
    check(
      "v0.5.8：config.json 的 preTest=gate / timeoutMinutes=7 真的生效（设置页没改过这两项，不再被 schema 默认值遮住）",
      merged.preTest === "gate" && merged.timeoutMinutes === 7 && !merged.__configError,
      `preTest=${merged.preTest} timeoutMinutes=${merged.timeoutMinutes} error=${String(merged.__configError)}`,
    );
    check(
      "v0.5.8：配置文件带 UTF-8 BOM（记事本/PowerShell 另存）不再被当成坏文件",
      cfgMod.loadConfig({}).preTest === "gate" && !cfgMod.loadConfig({}).__configError,
      `preTest=${cfgMod.loadConfig({}).preTest} error=${String(cfgMod.loadConfig({}).__configError)}`,
    );
    const withSetting = cfgMod.loadConfig(cfgMod.schemaOverrides(mkConfig({ timeoutMinutes: 20 })));
    check(
      "v0.5.8：设置页真改过的项仍然优先（timeoutMinutes=20 压过文件层的 7），同一份文件的其它键照常生效",
      withSetting.timeoutMinutes === 20 && withSetting.preTest === "gate",
      `timeoutMinutes=${withSetting.timeoutMinutes} preTest=${withSetting.preTest}`,
    );
  } finally {
    if (prevEnv === undefined) delete process.env.DSH_OPEN_CODE_REVIEW_CONFIG;
    else process.env.DSH_OPEN_CODE_REVIEW_CONFIG = prevEnv;
    try {
      rmSync(tmpConfig, { force: true });
    } catch {
      /* 清理失败不影响断言 */
    }
    cfgMod.loadConfig({});
  }
}

/* v0.5.8 二批（OCR 自审 lib/config.js 的发现）：归一过程不能就地改掉调用方传入的嵌套块
   （`plain()` 返回浅拷贝）；auto 是四档枚举，但 config.json 里写成开关键（true/"on"/1）
   也得按 boolLike 的宽容度认。注意断言要看**调用方那个对象**有没有被改写 ——
   只断 DEFAULTS 会不会变是不够的（传进去的是新副本时旧实现也能过，等于没测到）。 */
{
  const llmInput = { ...cfgMod.DEFAULTS.llm, protocol: " OpenAI " };
  const reviewerInput = { ...cfgMod.DEFAULTS.reviewer, rounds: "3" };
  const norm = cfgMod.normalizeConfig({ ...cfgMod.DEFAULTS, llm: llmInput, reviewer: reviewerInput });
  check(
    "v0.5.8：normalizeConfig 不就地改调用方传入的嵌套块（llmInput/reviewerInput 保持原样），但结果照常收敛",
    llmInput.protocol === " OpenAI " &&
      reviewerInput.rounds === "3" &&
      norm.llm !== llmInput &&
      norm.reviewer !== reviewerInput &&
      norm.llm.protocol === "openai" &&
      norm.reviewer.rounds === 3,
    `输入 protocol=${JSON.stringify(llmInput.protocol)} rounds=${JSON.stringify(reviewerInput.rounds)} 结果 protocol=${
      norm.llm.protocol
    } rounds=${norm.reviewer.rounds} 同一引用=${norm.llm === llmInput}`,
  );

  const llmBefore = JSON.stringify(cfgMod.DEFAULTS.llm);
  const reviewerBefore = JSON.stringify(cfgMod.DEFAULTS.reviewer);
  const shallow = cfgMod.normalizeConfig({ ...cfgMod.DEFAULTS }); // 浅拷贝 DEFAULTS：嵌套块与 DEFAULTS 同一个引用
  check(
    "v0.5.8：浅拷贝 DEFAULTS 进去也不会把出厂默认的嵌套块就地写掉（normalizeConfig 换了新对象）",
    JSON.stringify(cfgMod.DEFAULTS.llm) === llmBefore &&
      JSON.stringify(cfgMod.DEFAULTS.reviewer) === reviewerBefore &&
      shallow.llm !== cfgMod.DEFAULTS.llm &&
      shallow.reviewer !== cfgMod.DEFAULTS.reviewer,
    `llm 未变=${JSON.stringify(cfgMod.DEFAULTS.llm) === llmBefore} reviewer 未变=${
      JSON.stringify(cfgMod.DEFAULTS.reviewer) === reviewerBefore
    } 新对象=${shallow.llm !== cfgMod.DEFAULTS.llm}/${shallow.reviewer !== cfgMod.DEFAULTS.reviewer}`,
  );

  const autoCases = [
    ["on", "adaptive"],
    ["true", "adaptive"],
    [1, "adaptive"],
    ["off", "off"],
    ["0", "off"],
    [false, "off"],
    ["inject", "inject"],
    ["nope", cfgMod.DEFAULTS.auto],
  ];
  const autoGot = autoCases.map(([input]) => cfgMod.normalizeConfig({ ...cfgMod.DEFAULTS, auto: input }).auto);
  check(
    "v0.5.8：auto 写成开关键也认（true/\"on\"/1 → adaptive，false/\"0\" → off），枚举值与非法值照旧",
    autoCases.every(([, want], i) => autoGot[i] === want),
    autoCases.map(([input], i) => `${JSON.stringify(input)}→${autoGot[i]}`).join(" · "),
  );
}
{
  const registered = [];
  const skillCtx = makeCtx();
  skillCtx.skills = {
    register(def) {
      registered.push(def);
      return () => {};
    },
  };
  mod.apply(skillCtx, mkConfig({ onDemand: true }));
  const onDemandStatus = await tools.get("ocr_status").execute({ checkLlm: false }, exec);
  const def = registered[0];
  /* SCHEMA_AVAILABLE=false 有两种原因，状态文本要分得清（别把「生成失败」说成「缺包」）—— OCR 自审发现。*/
  check(
    "v0.5.8：SCHEMA_ERROR 与 SCHEMA_AVAILABLE 自洽（有 schema 就没错误；否则状态文本分得清「缺包」与「生成失败」）",
    (cfgMod.SCHEMA_AVAILABLE === true && cfgMod.SCHEMA_ERROR === "") ||
      (cfgMod.SCHEMA_AVAILABLE === false &&
        typeof cfgMod.SCHEMA_ERROR === "string" &&
        String(onDemandStatus.settingsPage).includes(cfgMod.SCHEMA_ERROR ? "生成设置页 schema 失败" : "缺少 @deepseek-ai/schemastery")),
    `available=${cfgMod.SCHEMA_AVAILABLE} error=${JSON.stringify(cfgMod.SCHEMA_ERROR)} settingsPage=${String(onDemandStatus.settingsPage)}`,
  );
  check(
    "v0.5.0 步骤 3：有 skills 服务时注册 ocr-on-demand-review（描述/触发条件/汇报格式齐全，ocr_status 报 registered=true）",
    registered.length === 1 &&
      def?.name === "ocr-on-demand-review" &&
      typeof def.description === "string" &&
      def.description.length > 0 &&
      typeof def.whenToUse === "string" &&
      def.whenToUse.length > 0 &&
      typeof def.content === "string" &&
      def.content.includes("ocr_review") &&
      def.content.includes("[severity]") &&
      onDemandStatus.onDemand === true &&
      onDemandStatus.skill?.registered === true &&
      onDemandStatus.skill?.reason === "",
    `registered=${registered.length} name=${def?.name} status=${JSON.stringify(onDemandStatus.skill)}`,
  );

  const registeredOff = [];
  const offCtx = makeCtx();
  offCtx.skills = {
    register(def2) {
      registeredOff.push(def2);
      return () => {};
    },
  };
  mod.apply(offCtx, mkConfig({ onDemand: false }));
  const offStatus = await tools.get("ocr_status").execute({ checkLlm: false }, exec);
  check(
    "v0.5.0 步骤 3：onDemand=false 时不注册 skill，reason 说明是「按需评审已关闭」",
    registeredOff.length === 0 && offStatus.onDemand === false && offStatus.skill?.registered === false && String(offStatus.skill?.reason).includes("按需评审已关闭"),
    `registered=${registeredOff.length} status=${JSON.stringify(offStatus.skill)}`,
  );
}

/* v0.5.4：命令注册失败这条路以前是静默的（register() 抛错 → 命令没了，但 ocr_status 与回合尾部按钮
   都以为它在）。放在最后跑：会重新 apply 一个「commands 服务坏掉」的实例并覆盖全局 tools 注册表。 */
{
  const brokenCmdCtx = makeCtx({
    commands: {
      register() {
        throw new Error("definitionId 撞车了");
      },
    },
  });
  mod.apply(brokenCmdCtx, mkConfig({ llmMode: "endpoint" }));
  const brokenStatus = await tools.get("ocr_status").execute({ checkLlm: false }, exec);
  const flagged = brokenStatus.notes.filter((line) => line.includes("ocr-review"));
  check(
    "v0.5.4：命令注册抛错时 ocr_status 报 registered=false + 原因，并在备注里点名按钮会失败（不再静默）",
    brokenStatus.command?.registered === false &&
      String(brokenStatus.command?.reason).includes("definitionId 撞车了") &&
      flagged.some((line) => line.includes("按钮")),
    JSON.stringify({ command: brokenStatus.command, notes: flagged }),
  );
}

/* ------------------------------------------------------------------ 汇总 */

console.log("\n=== 结果 ===");
for (const line of results) console.log(line);
console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}（共 ${results.length} 项）`);
process.exit(failures === 0 ? 0 : 1);
