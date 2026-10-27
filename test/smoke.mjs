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

/**
 * 文件层隔离（D7：插件目录里的活 `config.json` 一直没有被测试隔离）。
 *
 * 这个 checkout 里的 `config.json` 是**活的** —— 作者本机可能写了 `llm.provider` 之类，
 * 而路由相关的断言全都默认「文件层是空的」。不隔离的话，本机配置一改，测试就跟着红。
 * 这里把文件层指到一个空 JSON；需要文件层的用例自己会临时覆盖这个环境变量再还原
 * （见下文「配置文件解析顺序」那几条）。
 */
const HERMETIC_CONFIG = join(tmpdir(), `ocr-smoke-config-${process.pid}.json`);
try {
  writeFileSync(HERMETIC_CONFIG, "{}\n");
} catch {
  /* 写不进去就让环境变量指向它，效果一样：这个路径不存在 ⇒ 文件层为空 */
}
process.env.DSH_OPEN_CODE_REVIEW_CONFIG = HERMETIC_CONFIG;

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
  /* 本地复现「CI 等价环境（机器上没装 ocr）」：`OCR_TEST_FORCE_NO_OCR=1` 时，任何 ocr 可执行文件的
     查找都返回空 —— **绝对路径也要挡**（工作区 config.json 常把 ocrPath 钉成绝对路径，只挡 PATH
     查找是挡不住的；上一次就是因此没复现出来）。正则只匹配 ocr，免得连 git 一起挡掉（那会连锁 10 项）。 */
  if (process.env.OCR_TEST_FORCE_NO_OCR === "1" && /ocr|opencodereview/i.test(cmd)) return "";
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
  /* v0.11.0：路由要读「当前会话正在用的模型」，所以这两级也要能替换（不传就是没有）。 */
  if (overrides.agents) ctx.agents = overrides.agents;
  if (overrides.sessions) ctx.sessions = overrides.sessions;
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
 *   · 有 ocr：真实链路（定位 → 跑 ocr → 解析）全验
 *   · 没有：验「定位失败」的诊断路径 —— 新用户最常见的第一屏（OCR_NOT_FOUND + 安装指引），
 *     以及 fail-closed 行为（不装 ocr 时绝不真的跑一个假装在评审的子进程）
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
  /* llmMode 显式给 endpoint（v0.11.0 起 dsh 模式不再回落静态端点）：这一份是整套 smoke 的环境配置，
     它考的是 ocr 子进程那条流水线。dsh 路由另有专门用例（桥就绪 / 缺模型名 / 桥不可用即失败）。 */
  schemaRefs = typeof schema === "function" ? schema({ llmMode: "endpoint", llmModel: "deepseek/deepseek-v4.1-flash", llmApiKeyRef: "SMOKE_OCR_KEY" }) : null;
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
    schemaRefs === null && cfgMod.schemaOverrides({ llmModel: { get: () => "m" } })?.llm?.model === "m",
    `schemaRefs=${schemaRefs ? "有" : "无"}`,
  );
}

/**
 * 宿主（设置页 / host 持久层）交给 apply() 的那份补丁：有 schema 时是 Config 实例（设置页字段是 volatile
 * 引用），CI 上没有这个包就退化成同形状的普通对象 —— apply 内部走 schemaOverrides()，两者语义一致。
 */
const settingsPatch = schemaRefs ?? mkConfig({ llmMode: "endpoint", llmModel: "deepseek/deepseek-v4.1-flash", llmApiKeyRef: "SMOKE_OCR_KEY" });

const ref = (value) => Object.freeze({ get: () => value });
const overrides = cfgMod.schemaOverrides({
  engine: ref("delegate"),
  timeoutMinutes: ref(20),
  llmModel: ref("deepseek/deepseek-v4.1-flash"),
  llmApiKeyRef: ref("SMOKE_OCR_KEY"),
  ocrPath: ref(""),
  verbose: ref(true),
});
check(
  "schemaOverrides：扁平字段名 → 生效配置路径（llm.* / 空串回落）",
  overrides?.llm?.model === "deepseek/deepseek-v4.1-flash" &&
    overrides?.llm?.apiKeyRef === "SMOKE_OCR_KEY" &&
    overrides?.engine === "delegate" &&
    overrides?.timeoutMinutes === 20 &&
    overrides?.ocrPath === undefined &&
    overrides?.verbose === true &&
    cfgMod.schemaOverrides(null) === null,
  JSON.stringify(overrides),
);
check(
  "schemaOverrides（v0.5.8）：取值恰好等于出厂默认的字段不算覆盖项（否则 schema 默认值会把 config.json 整层遮住）",
  cfgMod.schemaOverrides({ timeoutMinutes: ref(15), enabled: ref(true), onDemand: ref(true) }) === null &&
    cfgMod.schemaOverrides({ timeoutMinutes: ref(20) })?.timeoutMinutes === 20,
  `${JSON.stringify(cfgMod.schemaOverrides({ timeoutMinutes: ref(15), enabled: ref(true), onDemand: ref(true) }))} / ${JSON.stringify(cfgMod.schemaOverrides({ timeoutMinutes: ref(20) }))}`,
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

/* v0.12.0（E1）：scope=workspace 配 paths 过去被**静默忽略**（ocr review 没有 --path，用户点名的路径根本没进命令）。
   现在显式拒绝，并给出三条出路；delegate 档与 scan 档不受影响（它们真的会用 paths）。 */
const wsPathsPlan = review.normalizeTarget({ scope: "workspace", paths: ["src/a.js"] }, {}, REPO);
check(
  "E1：scope=workspace + paths（ocr/auto 档）→ 显式报错，且指出 scan / commit-range / delegate 三条出路",
  !!wsPathsPlan.error &&
    wsPathsPlan.error.includes("不接受 paths") &&
    wsPathsPlan.error.includes("scope=scan") &&
    wsPathsPlan.error.includes("engine=delegate"),
  wsPathsPlan.error,
);
const wsPathsDelegatePlan = review.normalizeTarget({ scope: "workspace", paths: ["src/a.js"], engine: "delegate" }, {}, REPO);
const scanPathsPlan = review.normalizeTarget({ scope: "scan", paths: ["src/a.js"] }, {}, REPO);
check(
  "E1 不误伤：delegate 档（用 paths 过滤规格）与 scan 档的 paths 都不报错",
  wsPathsDelegatePlan.error === "" && scanPathsPlan.error === "",
  `delegate=${JSON.stringify(wsPathsDelegatePlan.error)} scan=${JSON.stringify(scanPathsPlan.error)}`,
);

/* ------------------------------------------------------------- 端到端：工具 */

const ctx = makeCtx();
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

/* v1.0：auto 引擎已删除 —— 传 engine:"auto" 不再有「自动降级」，按非法值回落到默认档。 */
check(
  "v1.0：auto 引擎已删除（配置/工具枚举只剩 ocr 与 delegate，传 auto 回落默认）",
  !review.ENGINES.includes("auto") &&
    review.pickEngine("auto", {}) === "ocr" &&
    cfgMod.normalizeConfig({ engine: "auto" }).engine === "ocr" &&
    !(tools.get("ocr_review").parameters?.properties?.engine?.enum ?? []).includes("auto"),
  `ENGINES=${review.ENGINES.join(",")} pickEngine(auto)=${review.pickEngine("auto", {})}`,
);

const bad = await tools.get("ocr_review").execute({ scope: "commit" }, exec);
check("参数缺失时明确报错且不执行命令", bad.ok === false && bad.code === "OCR_INVALID_ARGS" && bad.summary.includes("需要 commit"), `${bad.code} | ${bad.summary}`);

/* -------- v0.8.0：成本前置 / 失败给下一步 / 长评审心跳；v0.10.0：手动默认 ocr -------- */

check(
  "v0.10.0：默认引擎是 ocr（跑 OCR 流水线、跑前给成本预估）",
  cfgMod.DEFAULTS.engine === "ocr" &&
    cfgMod.normalizeConfig({}).engine === "ocr" &&
    review.pickEngine(undefined, {}) === "ocr" &&
    review.pickEngine("delegate", {}) === "delegate" &&
    review.pickEngine("bogus", { engine: "也坏" }) === "ocr",
  `DEFAULTS=${cfgMod.DEFAULTS.engine} normalizeConfig(空)=${cfgMod.normalizeConfig({}).engine} pickEngine(空)=${review.pickEngine(undefined, {})}`,
);

const allCodes = Object.values(review.CODES);
const missingSteps = allCodes.filter((code) => review.nextStepForCode(code) === "");
check(
  "v0.8.0：每个失败码都有「下一步」文案，且不写「请联系维护者」这类空话",
  missingSteps.length === 0 && allCodes.every((code) => !/请联系|无法解决|自行排查/.test(review.nextStepForCode(code))),
  `缺失=${missingSteps.join(",") || "无"} 共 ${allCodes.length} 个码`,
);
check(
  "v0.8.0：失败结果自带 nextStep，并渲染成「下一步：…」一行",
  bad.nextStep.includes("字段名") &&
    review
      .valueToText(
        { ok: false, engine: "ocr", scope: "workspace", exitCode: 1, durationMs: 1000, code: "OCR_RUN_FAILED", nextStep: "先用 engine=delegate 确认工具链" },
        {},
      )
      .includes("下一步：先用 engine=delegate 确认工具链"),
  `${bad.code} nextStep=${bad.nextStep.slice(0, 30)}…`,
);
check(
  "v0.8.0：成本前置提示只在会烧 LLM 的档出现（delegate 不提示），并说清规模与计费口径",
  review.costHint({ engine: "delegate" }) === "" &&
    /2 个路径/.test(review.costHint({ engine: "ocr", scope: "scan", paths: ["a.js", "b.js"] })) &&
    /按 tokens 计费/.test(review.costHint({ engine: "ocr", scope: "workspace" })) &&
    /engine=delegate/.test(review.costHint({ engine: "ocr" })),
  review.costHint({ engine: "ocr", scope: "scan", paths: ["a.js", "b.js"] }).slice(0, 60),
);
check(
  "v0.8.0：心跳文案区分「一直没输出」与「刚刚还在输出」（真机 600s 那次就是前者）",
  review.heartbeatLine(95000).includes("还没有任何输出") &&
    review.heartbeatLine(95000).includes("1m35s") &&
    review.heartbeatLine(95000, 4000, 15).includes("最近一次输出在 4.0s 前") &&
    review.heartbeatLine(95000, 4000, 15).includes("超时 15 分钟"),
  review.heartbeatLine(95000),
);
const nextStepSchema = tools.get("ocr_review")?.output?.schema?.properties?.nextStep;
check(
  "v0.8.0：ocr_review 的输出 schema 声明 nextStep（string、不进 required，成功时是空串）",
  nextStepSchema?.type === "string" && !(tools.get("ocr_review").output.schema.required ?? []).includes("nextStep"),
  JSON.stringify(nextStepSchema),
);
{
  const indexSource = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  check(
    "v0.8.0：成本前置提示进了结果 notes（out.notes.push(cost)）",
    /out\.notes\.push\(cost\)/.test(indexSource),
    `cost=${(indexSource.match(/out\.notes\.push\(cost\)/g) ?? []).length}`,
  );
}

/* ---------------- v0.8.1：真机自审（第 6 轮）在 lib/review.js 上审出的 6 条 ---------------- */
{
  const dirtyArgs = review.normalizeTarget({}, { extraArgs: ["--a", 7, null, ["--b"], "  ", "--c"] }, REPO);
  check(
    "v0.8.1：config.extraArgs 里的非字符串被过滤掉（以前原样进 argv，spawn 抛 TypeError 整轮崩）",
    dirtyArgs.extraArgs.length === 2 && dirtyArgs.extraArgs[0] === "--a" && dirtyArgs.extraArgs[1] === "--c",
    JSON.stringify(dirtyArgs.extraArgs),
  );

  const resultFirst = review.parseJsonLoose('{"files":[],"issues":[{"message":"x"}]}\n{"progress":"90%"}\n');
  const noResultShape = review.parseJsonLoose('{"a":1}\n{"b":2,"c":3,"d":4}\n');
  check(
    "v0.8.1：JSONL 优先取「像评审结果」的那块，而不是最后一个能解析的对象（以前倒着扫，尾部进度对象会顶掉真结果）",
    Array.isArray(resultFirst?.issues) && resultFirst.issues.length === 1 && resultFirst.progress === undefined,
    JSON.stringify(resultFirst),
  );
  check(
    "v0.8.1：JSONL 里没有任何「结果形状」时退回到字段最多的对象（不再是谁在最后就选谁）",
    noResultShape?.d === 4 && noResultShape.a === undefined,
    JSON.stringify(noResultShape),
  );

  const dupScan = review.extractIssuesDetailed({
    issues: [
      { message: "x", file: "a.js", line: 1 },
      { message: "x", file: "a.js", line: 1 },
      null,
      { nope: 1 },
    ],
  });
  check(
    "v0.8.1：rawCount 不含重复条目，不变量是 rawCount === issues.length + dropped（以前重复项把它顶大）",
    dupScan.issues.length === 1 && dupScan.dropped === 2 && dupScan.rawCount === 3 && dupScan.rawCount === dupScan.issues.length + dupScan.dropped,
    JSON.stringify({ issues: dupScan.issues.length, dropped: dupScan.dropped, rawCount: dupScan.rawCount }),
  );

  check(
    "v0.8.1：pathMatches 认相对/绝对/正反斜杠",
    review.pathMatches("lib/review.js", ["review.js"]) === true &&
      review.pathMatches("C:\\repo\\lib\\a.js", ["lib/a.js"]) === true &&
      review.pathMatches("./lib/b.js", ["lib/b.js"]) === true &&
      review.pathMatches("lib/b.js", ["lib/a.js"]) === false &&
      review.pathMatches("", ["lib/a.js"]) === false,
    "相对/绝对/反斜杠/失配四例",
  );

  const bigSpec = review.buildDelegateSpec({
    plan: { cwd: "/repo", scope: "workspace" },
    preview: { repository: "/repo", mode: "workspace", reviewable_count: 2 },
    rules: { groups: [] },
    diff: "x".repeat(30000),
    files: [
      { path: "lib/review.js", status: "modified", insertions: 1, deletions: 1 },
      { path: "lib/client.js", status: "modified", insertions: 2, deletions: 2 },
    ],
    maxBytes: 5000,
  });
  check(
    "v0.8.1：规格按字节截断 diff 后，收尾围栏与「你的任务」仍在（以前整段按字符切，正好切掉任务段）",
    bigSpec.includes("## 你的任务") &&
      bigSpec.includes("已按 maxBytes=5000 截断") &&
      (bigSpec.match(/^```/gm) ?? []).length === 2 &&
      bigSpec.includes("## 变更内容") &&
      Buffer.byteLength(bigSpec, "utf8") <= 5000,
    `bytes=${Buffer.byteLength(bigSpec, "utf8")} 围栏=${(bigSpec.match(/^```/gm) ?? []).length}`,
  );
  check(
    "v0.8.1：按字节（不是字符）算预算，CJK 不会被低估到 1/3",
    Buffer.byteLength(review.truncateBytes("中文中文中文", 7), "utf8") <= 7 &&
      review.truncateBytes("中文", 1) === "" &&
      review.truncateBytes("abc", 2) === "ab",
    `中文7字节=${JSON.stringify(review.truncateBytes("中文中文中文", 7))}`,
  );
  check(
    "v0.8.1：delegate 模式下 paths 参数由插件过滤（`ocr delegate preview` 没有 --path，ocr 给的永远是整个工作区）",
    review.buildDelegateSpec({
      plan: { cwd: "/repo", scope: "workspace" },
      preview: { repository: "/repo", mode: "workspace" },
      rules: { groups: [] },
      diff: "",
      files: [{ path: "lib/review.js", status: "modified", insertions: 1, deletions: 1 }],
      only: ["lib/review.js"],
      maxBytes: 100000,
    }).includes("只看这些路径"),
    "只看这些路径",
  );
  {
    const filtered = review.buildDelegateSpec({
      plan: { cwd: "/repo", scope: "workspace" },
      preview: { repository: "/repo", mode: "workspace" },
      rules: { groups: [] },
      diff: "",
      files: [
        { path: "lib/review.js", status: "modified", insertions: 1, deletions: 1 },
        { path: "lib/client.js", status: "modified", insertions: 2, deletions: 2 },
      ],
      only: ["lib/review.js"],
      maxBytes: 100000,
    });
    const unmatched = review.buildDelegateSpec({
      plan: { cwd: "/repo", scope: "workspace" },
      preview: { repository: "/repo", mode: "workspace" },
      rules: { groups: [] },
      diff: "",
      files: [{ path: "lib/client.js", status: "modified", insertions: 2, deletions: 2 }],
      only: ["lib/nothing.js"],
      maxBytes: 100000,
    });
    check(
      "v0.8.1：只列出 paths 命中的文件；一个都没命中时回落到 ocr 的全量清单并说明",
      filtered.includes("lib/review.js") &&
        !filtered.includes("lib/client.js") &&
        unmatched.includes("一个都没匹配上可审文件") &&
        unmatched.includes("lib/client.js"),
      `命中=${filtered.includes("lib/client.js")} 未命中回落=${unmatched.includes("lib/client.js")}`,
    );
  }
  {
    const reviewSource = readFileSync(new URL("../lib/review.js", import.meta.url), "utf8");
    const indexSource = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
    check(
      "v0.8.1：三份「限深递归遍历 JSON」合并成一个 walkJson（不再各写一份、改一处漂另一处）",
      /function walkJson\(node, keys, onArray, maxDepth = 6\)/.test(reviewSource) &&
        (reviewSource.match(/walkJson\(/g) ?? []).length >= 4 &&
        !/const visit = \(node, depth\) =>/.test(reviewSource),
      `walkJson=${(reviewSource.match(/walkJson\(/g) ?? []).length} 旧 visit=${(reviewSource.match(/const visit = \(node, depth\) =>/g) ?? []).length}`,
    );
    check(
      "v0.8.1：delegate 的路径过滤真的接上了（runDelegate 把 plan.paths 传给 buildDelegateSpec）",
      /only: plan\.paths/.test(indexSource) && !/buildDelegateArgvs\(plan, cfg\)/.test(indexSource),
      `only: plan.paths=${/only: plan\.paths/.test(indexSource)}`,
    );
  }
}


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

/* E3（v0.12.0 批 1）：结论的「可用性行」—— 部分结果 / 完整结果 / 失败三种口径，连同覆盖回执一起渲染。
   这一行是给模型与用户看的「这份结论能用到什么程度」，不再要求读者自己拼 partial + coverage 两个字段。 */
const e3Partial = review.valueToText(
  {
    ok: true,
    engine: "delegate",
    scope: "workspace",
    exitCode: 0,
    durationMs: 900,
    partial: true,
    partialReasons: ["diff 按 hunk 整片截断"],
    coverage: { totalFiles: 3, totalHunks: 12, keptHunks: 7, droppedHunks: 5, slices: 2, truncated: true },
    summary: "规格已生成",
    reviewSessionId: "sess-1",
  },
  {},
);
check(
  "E3：部分结果 → 可用性行说「只能作为部分结论」，并把覆盖回执（收录/丢弃/截断）与 ocr 会话一起渲染",
  e3Partial.includes("可用性：**只能作为部分结论**") &&
    e3Partial.includes("收录 7/12 个 hunk") &&
    e3Partial.includes("丢弃 5 个 hunk") &&
    e3Partial.includes("diff 被截断") &&
    e3Partial.includes("ocr 会话：sess-1"),
  e3Partial.split("\n").find((line) => line.startsWith("可用性：")) ?? "(没有可用性行)",
);
const e3Clean = review.valueToText({ ok: true, engine: "ocr", scope: "commit", exitCode: 0, durationMs: 1000, partial: false, summary: "审查 1 个文件，未发现问题" }, {});
const e3Fail = review.valueToText({ ok: false, engine: "ocr", scope: "workspace", exitCode: 1, durationMs: 300, partial: false, code: "OCR_NOT_FOUND", summary: "找不到 ocr" }, {});
check(
  "E3：完整结果说「可作为本次范围的完整结论」；失败说「本次没有成功，没有结论」",
  e3Clean.includes("可用性：可作为本次范围的完整结论") && e3Fail.includes("可用性：本次没有成功，没有结论"),
  `${e3Clean.split("\n")[1] ?? ""} || ${e3Fail.split("\n")[1] ?? ""}`,
);

/* T1（v0.12.0 批 1）：单飞闸 —— 同一个插件实例同时只跑一次评审。
   runReview 是**同步**取闸的，所以「先发起、不 await，紧接着再发一次」能稳定命中第二次。 */
const t1First = tools.get("ocr_review").execute({ preview: true }, exec);
const t1Second = await tools.get("ocr_review").execute({ preview: true }, exec);
const t1FirstResult = await t1First;
checkEither(
  "T1：并发第二次调用 → OCR_ALREADY_RUNNING（说清谁在跑、跑了多久），不再两条流水线并跑",
  t1FirstResult.ok === true &&
    t1Second.ok === false &&
    t1Second.code === "OCR_ALREADY_RUNNING" &&
    t1Second.summary.includes("已经有一次评审在跑") &&
    t1Second.nextStep.length > 0 &&
    t1Second.engine === "",
  t1FirstResult.ok === false && t1FirstResult.code === "OCR_NOT_FOUND" && t1Second.code === "OCR_ALREADY_RUNNING",
  `${t1Second.code} | ${t1Second.summary}`,
);
const t1Third = await tools.get("ocr_review").execute({ preview: true }, exec);
checkEither(
  "T1：闸门在 finally 里释放 —— 上一次跑完之后，下一次调用照常执行",
  t1Third.ok === true,
  t1Third.code === "OCR_NOT_FOUND",
  `第三次=${t1Third.code || "ok"}`,
);

/* T2（v0.12.0 批 1）：宿主侧兜底超时不能比插件自己的上限紧
   （旧值固定 30 分钟，与 maxTimeoutMinutes 默认 60 分钟不对齐）。 */
const t2Timeout = tools.get("ocr_review").timeoutMs;
check(
  "T2：ocr_review 的宿主侧兜底超时 > 30 分钟（按启动时生效的 maxTimeoutMinutes + 60s 宽限算）",
  typeof t2Timeout === "number" && t2Timeout >= 31 * 60 * 1000,
  `${t2Timeout} ms ≈ ${Math.round(Number(t2Timeout) / 60000)} 分钟`,
);

/* R5（v0.12.0 批 1）：结果码一律走常量表，别在正文里手写字符串。 */
{
  const r5IndexSource = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  const r5Literals = r5IndexSource.match(/"OCR_ALREADY_[A-Z_]+"/g) ?? [];
  check(
    "R5：lib/index.js 里没有手写的结果码字符串（一律走 CODES 常量）",
    r5Literals.length === 0,
    r5Literals.length === 0 ? "没有手写字面量" : `发现 ${r5Literals.join("、")}`,
  );
}

/* R6（v0.12.0 批 1）：覆盖回执只有一份文案（coverageSummary 喂结论文本）。 */
const r6Coverage = { totalFiles: 3, totalHunks: 12, keptHunks: 7, droppedHunks: 5, slices: 2, truncated: true };
check(
  "R6：覆盖回执单一来源（coverageSummary 喂结论文本；空输入返回空串）",
  review.coverageSummary(r6Coverage) === "收录 7/12 个 hunk · 2/3 个文件片 · 丢弃 5 个 hunk · diff 被截断" &&
    review.coverageSummary({}) === "" &&
    review.coverageSummary(null) === "" &&
    e3Partial.includes(`覆盖：${review.coverageSummary(r6Coverage)}`),
  `${review.coverageSummary(r6Coverage)} || 空=${JSON.stringify(review.coverageSummary({}))}`,
);

/* v1-slim：自动评审与 jobs 进度行整体删除后，client.js 里不该再有任何 jobs 调用点。 */
{
  const r3ClientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const r3CodeOnly = r3ClientSource
    .split("\n")
    .filter((line) => {
      const s = line.trim();
      return !s.startsWith("*") && !s.startsWith("/*") && !s.startsWith("//");
    })
    .join("\n");
  check(
    "v1-slim：client.js 不再碰 jobs（无 useJobs / watchRows / kill / input.dock 注册），turnTail 按钮照常注册",
    !/ctx\.inject\(\["jobs"\]/.test(r3CodeOnly) &&
      !/props\.useJobs/.test(r3CodeOnly) &&
      !/watchRows/.test(r3CodeOnly) &&
      !/input\.dock/.test(r3CodeOnly) &&
      /ctx\.inject\(\["configForms", "remote", "remote\.commands"\]/.test(r3ClientSource) &&
      /if \(!props\.sessionId\) return null;/.test(r3ClientSource),
    [
      `jobs inject=${/ctx\.inject\(\["jobs"\]/.test(r3CodeOnly)}`,
      `useJobs=${/props\.useJobs/.test(r3CodeOnly)}`,
      `watchRows=${/watchRows/.test(r3CodeOnly)}`,
      `input.dock=${/input\.dock/.test(r3CodeOnly)}`,
      `按钮守门=${/if \(!props\.sessionId\) return null;/.test(r3ClientSource)}`,
    ].join(" · "),
  );
}


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

/* v1-slim：自动评审整体删除 —— 插件不再挂 tools/result 与 agent/turn-stopping 两个钩子，
   写完文件的回合结束不会自动注入任何东西；按需评审（按钮 / /ocr-review）仍照常工作。 */
check(
  "v1-slim：apply 之后没有 tools/result 与 agent/turn-stopping 监听（自动评审已删除）",
  (listeners.get("tools/result") ?? []).length === 0 && (listeners.get("agent/turn-stopping") ?? []).length === 0,
  `tools/result=${(listeners.get("tools/result") ?? []).length} turn-stopping=${(listeners.get("agent/turn-stopping") ?? []).length}`,
);
const autoAgent = makeAgent();
emit("tools/result", { name: "edit", agent: autoAgent, callId: "c2", arguments: {} }, { isError: false });
emit("agent/turn-stopping", { agent: autoAgent, turn: 7, signal: undefined });
await new Promise((resolve) => setTimeout(resolve, 200));
check(
  "v1-slim：写文件后回合结束不自动注入评审（没有任何自动路径）",
  deliver.followed.length === 0 && deliver.injected.length === 0,
  `followup=${deliver.followed.length} inject=${deliver.injected.length}（期望都是 0）`,
);
check(
  "v1-slim：设置页 schema 不再有自动评审字段（auto* 与 progress 全删）",
  (() => {
    const dict = typeof schema === "function" ? schema({}).dict : null;
    return !dict || (!Object.keys(dict).some((key) => key.startsWith("auto")) && !("progress" in dict));
  })(),
  typeof schema === "function" ? Object.keys(schema({}).dict).join(",") : "无 schema",
);

/* ------------------------------------------------- 设置页：总开关（热更新） */

const listenersBefore = (listeners.get("loader/volatile-update") ?? []).length;
emit("loader/volatile-update", {});
check(
  "loader/volatile-update：设置页改动即时同步按需评审接缝（开关未变则不重挂监听）",
  listenersBefore >= 1 && (listeners.get("loader/volatile-update") ?? []).length === listenersBefore,
  `volatile-update 监听=${(listeners.get("loader/volatile-update") ?? []).length}`,
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
   retrySkips/retrySkipReason/tokens 三个键（10 → 13），v0.6.1 又把「没转发就被拒」拆出
   rejected/lastReject（13 → 15），v0.11.0 加 requestedPort/portShifted（15 → 17）。 */
const bridgeKeys = Object.keys(bridgeStatus.bridge ?? {}).sort().join(",");
check(
  "ocr_status：bridge 对象恰好是 schema 声明的 17 个键（否则宿主调用期拒收）",
  bridgeKeys === "failed,inflight,lastError,lastModel,lastProvider,lastReject,portShifted,rejected,requestedPort,requests,retries,retrySkipReason,retrySkips,tokenMasked,tokens,uptimeMs,url",
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
    "dsh 路由：桥的 stats 计入 ocr_status 的探测请求（那一次故意打错的 token 记进 rejected，不再污染 failed）",
    Number(live.bridge?.requests ?? 0) >= 2 &&
      Number(live.bridge?.failed ?? 0) === 0 &&
      Number(live.bridge?.rejected ?? 0) === 1 &&
      String(live.bridge?.lastReject ?? "").includes("鉴权失败") &&
      String(live.bridge?.lastModel).length > 0,
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

/* --------------- v0.11.0：跟随当前会话 / dsh 不再回落静态端点 / 桥端口 --------------- */

/** v0.11.0：llm.bridgePort 只从 config.json 读（设置页故意不暴露），所以测试要临时换配置文件。 */
async function withTempConfigFile(patch, fn) {
  const dir = mkdtempSync(join(tmpdir(), "ocr-bridge-port-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify(patch), "utf8");
  const before = process.env.DSH_OPEN_CODE_REVIEW_CONFIG;
  process.env.DSH_OPEN_CODE_REVIEW_CONFIG = file;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.DSH_OPEN_CODE_REVIEW_CONFIG;
    else process.env.DSH_OPEN_CODE_REVIEW_CONFIG = before;
    rmSync(dir, { recursive: true, force: true });
  }
}

const netMod = await import("node:net");
/** 占住一个 TCP 端口；拿不到（EADDRINUSE）说明本来就被别人占着，同样算「被占用」。 */
const occupyPort = async (port) => {
  const srv = netMod.createServer();
  try {
    await new Promise((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(port, "127.0.0.1", resolve);
    });
    return srv;
  } catch {
    try {
      srv.close();
    } catch {
      /* 没起来就不用关 */
    }
    return null;
  }
};

/* (1) 跟随「当前会话」：设置页留空时，会话正在用的 provider/model 优先于 DSH 默认模型。 */
const sessionCtx = makeCtx({
  llm: fakeLlmService(() => []),
  agents: { currentInitiator: () => ({ id: "sess-1" }) },
  sessions: {
    get: (id) => (id === "sess-1" ? { requestContext: () => ({ provider: "session-prov", model: "session-model" }) } : undefined),
  },
});
mod.apply(sessionCtx, mkConfig({ llmMode: "dsh", llmProvider: "", llmModel: "" }));
const sessStatus = await tools.get("ocr_status").execute({ checkLlm: false }, exec);
check(
  "v0.11.0：设置页留空时跟随「当前会话」正在用的模型（优先于 DSH 默认模型）",
  String(sessStatus.llmRoute).includes("来自当前会话") &&
    String(sessStatus.llmEndpoint).includes("session-prov/session-model") &&
    !String(sessStatus.llmRoute).includes("DSH 默认模型"),
  `${sessStatus.llmRoute} | ${sessStatus.llmEndpoint}`,
);
check(
  "v0.11.0：跟随当前会话时，子进程拿到的 OCR_LLM_MODEL 就是会话模型",
  sessStatus.llmEnv.includes("OCR_LLM_MODEL=session-model"),
  JSON.stringify(sessStatus.llmEnv),
);
/* (2) 设置页填了就以设置为准（当前会话只补缺）。 */
mod.apply(sessionCtx, mkConfig({ llmMode: "dsh", llmProvider: "settings-prov", llmModel: "settings-model" }));
const settingsWin = await tools.get("ocr_status").execute({ checkLlm: false }, exec);
check(
  "v0.11.0：设置页填了 provider/model 就以设置为准（当前会话不再参与）",
  String(settingsWin.llmRoute).includes("来自插件设置") && String(settingsWin.llmEndpoint).includes("settings-prov/settings-model"),
  `${settingsWin.llmRoute} | ${settingsWin.llmEndpoint}`,
);
for (const entry of sessionCtx.effects) if (typeof entry.dispose === "function") entry.dispose();

/* ---------- v0.12.3：provider 与 model 必须来自同一条路由（真机事故的回归守卫） ----------
   事故现场（2026-10-14 桌面宿主）：设置里只写了模型名 deepseek/deepseek-v4-flash、provider 留空；
   路由行记的是 commandcode（会话级来源给的），而桥是「每个请求」再解析一次 —— 那一刻会话级来源
   刚好拿不到，于是拿 DSH 默认模型的 provider=ark-coding-plan 去配这个模型，6 次转发全失败。
   桥的 stats 留下真因：`pi-ai provider "ark-coding-plan" has no configured model
   "deepseek/deepseek-v4-flash"`，而 ocr 只报一句通用的「check your LLM configuration and API key」。 */
const ACCIDENT_MODEL = "deepseek/deepseek-v4-flash";
/** 目录替身：用来验证「只写了模型名时，去问哪个 provider 声明了它」。 */
function catalogLlm({ providers, models }) {
  const svc = fakeLlmService(() => [{ type: "finish", reason: { kind: "stop" } }]);
  svc.listProviders = async () => providers;
  svc.listModels = async (id) => (models && models[id]) || [];
  return svc;
}

/* (1) 设置里只写模型名 + 会话级只给模型名（事故里的那一刻）+ 默认模型是另一条路由：
       必须按模型目录找到 commandcode，绝不能拼成 ark-coding-plan + deepseek/deepseek-v4-flash。 */
const accidentCtx = makeCtx({
  llm: catalogLlm({
    providers: [{ id: "commandcode", name: "Command Code" }, { id: "ark-coding-plan", name: "Ark" }],
    models: { commandcode: [{ id: ACCIDENT_MODEL, name: ACCIDENT_MODEL }] },
  }),
  agents: { currentInitiator: () => ({ id: "sess-1" }) },
  sessions: {
    get: (id) => (id === "sess-1" ? { requestContext: () => ({ provider: "", model: ACCIDENT_MODEL }) } : undefined),
  },
  agentDefaultModel: { currentSelection: () => ({ provider: "ark-coding-plan", model: "deepseek-v4-flash" }) },
});
mod.apply(accidentCtx, mkConfig({ llmMode: "dsh", llmProvider: "", llmModel: ACCIDENT_MODEL }));
const accStatus = await tools.get("ocr_status").execute({ checkLlm: false }, exec);
check(
  "v0.12.3：设置里只写了模型名 → 按模型目录找它真正的 provider（不再借默认路由的 provider 拼）",
  String(accStatus.llmEndpoint).includes(`commandcode/${ACCIDENT_MODEL}`) &&
    String(accStatus.llmRoute).includes("DSH 模型目录") &&
    !String(accStatus.llmEndpoint).includes("ark-coding-plan"),
  `${accStatus.llmRoute} | ${accStatus.llmEndpoint}`,
);
check(
  "v0.12.3：配对成功时子进程拿到的 OCR_LLM_MODEL 就是被选中的那个模型",
  accStatus.llmEnv.includes(`OCR_LLM_MODEL=${ACCIDENT_MODEL}`),
  JSON.stringify(accStatus.llmEnv),
);
for (const entry of accidentCtx.effects) if (typeof entry.dispose === "function") entry.dispose();

/* (2) 目录里也问不到：明确失败并说清缺哪一半，不许拼出一条假路由。 */
const unmatchCtx = makeCtx({
  llm: catalogLlm({ providers: [{ id: "ark-coding-plan" }], models: { "ark-coding-plan": [] } }),
  agentDefaultModel: null,
});
mod.apply(unmatchCtx, mkConfig({ llmMode: "dsh", llmProvider: "", llmModel: ACCIDENT_MODEL }));
const unmatchStatus = await tools.get("ocr_status").execute({ checkLlm: false }, exec);
check(
  "v0.12.3：只写了模型名又查不到它的 provider → 说清缺哪一半（不拼半条路由）",
  String(unmatchStatus.llmRoute).includes("只写了模型名") &&
    String(unmatchStatus.llmRoute).includes(ACCIDENT_MODEL) &&
    !String(unmatchStatus.llmRoute).includes("ark-coding-plan"),
  `${unmatchStatus.llmRoute} | ${unmatchStatus.llmEndpoint}`,
);
for (const entry of unmatchCtx.effects) if (typeof entry.dispose === "function") entry.dispose();

/* (3) dsh 桥不可用：明确失败，不回落静态端点、不起子进程。 */
const noBridgeCanned = cannedSubprocess([
  { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "lib/a.js", insertions: 1, deletions: 0 }], excluded: [] }) },
  { exitCode: 0, stdout: JSON.stringify({ groups: [{ group_id: "g1", pattern: "**/*.js", rule: "不要把 undefined 当空值" }] }) },
  { exitCode: 0, stdout: "diff --git a/lib/a.js b/lib/a.js\n" },
]);
const noBridgeCtx = makeCtx({ subprocess: noBridgeCanned, llm: undefined, agentDefaultModel: null });
mod.apply(noBridgeCtx, mkConfig({ engine: "ocr", llmMode: "dsh", llmProvider: "", llmModel: "" }));
const bridgeExec = { name: "ocr_review", callId: "no-bridge", arguments: {}, agent: makeAgent(), signal: undefined };
const noBridgeRun = await tools.get("ocr_review").execute({ engine: "ocr" }, bridgeExec);
check(
  "v0.11.0：dsh 桥不可用时明确失败（OCR_LLM_MISSING），不再悄悄回落静态端点",
  noBridgeRun.ok === false &&
    noBridgeRun.code === "OCR_LLM_MISSING" &&
    noBridgeRun.engine === "ocr" &&
    String(noBridgeRun.summary).includes("未执行评审") &&
    !String(noBridgeRun.notes.join(" ")).includes("回落"),
  `${noBridgeRun.code} | ${noBridgeRun.summary} | notes=${noBridgeRun.notes.join(" / ")}`,
);
check(
  "v0.11.0：明确失败时一个子进程都没起（不花时间也不花钱）",
  noBridgeCanned.calls.length === 0,
  `calls=${noBridgeCanned.calls.length}`,
);
check(
  "v0.11.0：失败里给出一条能立刻做的事（含改 llm.mode=endpoint 的逃生门）",
  String(noBridgeRun.nextStep).includes("llm.mode") && String(noBridgeRun.nextStep).includes("endpoint"),
  noBridgeRun.nextStep,
);
const autoNoBridge = await tools.get("ocr_review").execute({ engine: "auto" }, bridgeExec);
check(
  "v1.0：auto 引擎已删除 —— 桥不可用时传 auto 不再降级，回落到默认 ocr 档并明确失败",
  autoNoBridge.ok === false && autoNoBridge.code === "OCR_LLM_MISSING" && autoNoBridge.engine === "ocr",
  `${autoNoBridge.engine} | ${autoNoBridge.code} | ${autoNoBridge.summary}`,
);
for (const entry of noBridgeCtx.effects) if (typeof entry.dispose === "function") entry.dispose();

/* (4) llm.bridgePort：被占用时顺延，并如实报出实际监听地址。 */
{
  let base = 0;
  let held = null;
  for (let cand = 20800; cand < 20900 && !base; cand += 2) {
    const a = await occupyPort(cand);
    if (!a) continue;
    const b = await occupyPort(cand + 1);
    if (b) {
      b.close();
      base = cand;
      held = a;
    } else {
      a.close();
    }
  }
  if (base) {
    const shiftCtx = makeCtx({ llm: fakeLlmService(() => []), agentDefaultModel: null });
    await withTempConfigFile({ llm: { bridgePort: base } }, async () => {
      mod.apply(shiftCtx, mkConfig({ llmMode: "dsh", llmProvider: "p", llmModel: "m" }));
      const st = await tools.get("ocr_status").execute({ checkLlm: false }, exec);
      check(
        "v0.11.0：llm.bridgePort 被读到；首选端口被占则顺延，并标记 requestedPort/portShifted",
        st.bridge?.requestedPort === base && st.bridge?.portShifted === true && String(st.bridge?.url).endsWith(`:${base + 1}/v1`),
        `requestedPort=${st.bridge?.requestedPort} portShifted=${st.bridge?.portShifted} url=${st.bridge?.url}`,
      );
      check(
        "v0.11.0：顺延后 ocr_status 报的是实际监听的地址（地址可核对）",
        String(st.llmEndpoint).includes(`127.0.0.1:${base + 1}`),
        st.llmEndpoint,
      );
      for (const entry of shiftCtx.effects) if (typeof entry.dispose === "function") entry.dispose();
    });
  }
  if (held) held.close();
}

/* (5) 首选端口与其后 9 个都被占用：桥起不来 → 如实报，不假装就绪。 */
{
  const base2 = 21000;
  const holders = [];
  for (let port = base2; port < base2 + 10; port += 1) {
    const srv = await occupyPort(port);
    if (srv) holders.push(srv);
  }
  const deadCtx = makeCtx({ llm: fakeLlmService(() => []), agentDefaultModel: null });
  await withTempConfigFile({ llm: { bridgePort: base2 } }, async () => {
    mod.apply(deadCtx, mkConfig({ llmMode: "dsh", llmProvider: "p", llmModel: "m" }));
    const st = await tools.get("ocr_status").execute({ checkLlm: false }, exec);
    check(
      "v0.11.0：首选端口与其后 9 个都被占用 → 如实报「都被占用」，不假装桥就绪",
      !st.bridge && String(st.llmRoute).includes("都被占用"),
      `bridge=${JSON.stringify(st.bridge)} route=${st.llmRoute}`,
    );
    const deadRun = await tools
      .get("ocr_review")
      .execute({ engine: "ocr" }, { name: "ocr_review", callId: "dead-port", arguments: {}, agent: makeAgent(), signal: undefined });
    check(
      "v0.11.0：端口全被占 → OCR_LLM_MISSING，原因指名端口、下一步给出 llm.bridgePort",
      HAS_OCR
        ? deadRun.ok === false &&
            deadRun.code === "OCR_LLM_MISSING" &&
            String(deadRun.summary).includes("都被占用") &&
            String(deadRun.nextStep).includes("bridgePort")
        : /* 离线档（CI 没装 ocr）：插件在查桥之前先解析 ocr 可执行文件，所以这里必然先报 OCR_NOT_FOUND。
             「端口耗尽」那条路只能在装了 ocr 的机器上验，但离线档也必须断言点东西 —— 断言失败原因确实是
             「找不到 ocr」，免得把「环境缺 ocr」误当成「端口那条路坏了」（CI 2026-10-13 就是这么红的）。 */
          deadRun.ok === false && deadRun.code === "OCR_NOT_FOUND",
      `${deadRun.code} | ${deadRun.summary} | next=${deadRun.nextStep}`,
    );
    for (const entry of deadCtx.effects) if (typeof entry.dispose === "function") entry.dispose();
  });
  for (const srv of holders) srv.close();
}

/* (6) 两条源码级守卫：老文案确实删了；bridgePort 确实没进设置页。 */
{
  const routeIndexSource = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  check(
    "v0.11.0：dsh 落回静态端点那条老文案已从源码删掉（不再有静默换 LLM 路径的路径）",
    !routeIndexSource.includes("这次回落成静态端点"),
    "源码里仍能找到「这次回落成静态端点」",
  );
  const routeClientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  check(
    "v0.11.0：llm.bridgePort 不作为设置页配置项放出来（默认不用改的东西不给用户看）",
    !routeClientSource.includes("bridgePort"),
    `client.js 里出现 bridgePort ${(routeClientSource.match(/bridgePort/g) ?? []).length} 次`,
  );
}

/* (7) 源码级守卫（2026-10-13 真机踩坑）：模型下拉的「定位基准」与「不透明背景」。
   mini-DOM 没有排版引擎，这两条在 client-smoke 里量不出来 —— 它们是样式对象里的事实，
   所以在源码这一层钉住（真机复核用 bsk 的 aria 快照 + 元素几何，见 docs/ROADMAP.md §6）。 */
{
  const pickerSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const sStart = pickerSource.indexOf("const S = {");
  const sEnd = sStart >= 0 ? pickerSource.indexOf("\n    };", sStart) : -1;
  const styleBlock = sStart >= 0 && sEnd > sStart ? pickerSource.slice(sStart, sEnd) : "";
  const comboKeys = (styleBlock.match(/(^|\s)combo:\s*\{/g) ?? []).length;
  check(
    "模型下拉：样式表里 combo 只有一个（重复键会让后一个静默覆盖前一个的 position: relative）",
    comboKeys === 1,
    `S 里找到 ${comboKeys} 个 combo 键`,
  );
  const comboStyle = /(?:^|\s)combo:\s*\{([^}]*)\}/.exec(styleBlock)?.[1] ?? "";
  check(
    "模型下拉：combo 带 position: relative（菜单的定位基准；缺了菜单会改成以设置面板为基准、掉到面板外被 overflow:hidden 裁掉，点开什么也看不见）",
    /position:\s*"relative"/.test(comboStyle),
    `combo = ${comboStyle.trim() || "(没找到)"}`,
  );
  check(
    "模型下拉：菜单是 position:absolute + top:100%（配合上面的定位基准才有意义）",
    /(?:^|\s)menu:\s*\{[^}]*position:\s*"absolute"/.test(styleBlock) && /(?:^|\s)menu:\s*\{[^}]*top:\s*"100%"/.test(styleBlock),
    "S.menu 不是 absolute + top:100%",
  );
  check(
    "批 2：菜单与抬头的底色用 bg-layer-3 令牌（不再沿 DOM 猜祖先底色），且 guessBg 已删干净",
    /(?:^|\s)menu:\s*\{[^}]*background:\s*"var\(--dsw-alias-bg-layer-3, Canvas\)"/.test(styleBlock)
      && /(?:^|\s)menuHead:\s*\{[^}]*background:\s*"var\(--dsw-alias-bg-layer-3, Canvas\)"/.test(styleBlock)
      && !/(?:const|function)\s+guessBg\s*[(=]/.test(pickerSource)
      && !/(?:const|function)\s+isOpaque\s*[(=]/.test(pickerSource),
    "菜单/抬头没走 bg-layer-3 令牌，或还留着猜底色的旧机制",
  );

  /* P0-G「点前看到代价」：按钮副行按档位给不同文案，档位来自**已有**的配置快照（不新增宿主通道），
     认不出档位时只承诺「点下后会先给预估」—— 不编一个没人验证过的金额。 */
  check(
    "批 2：回合尾按钮带副行代价标签（档位取自已有配置快照；认不出档位时不编数字）",
    pickerSource.includes('"data-ocr-tail-cost"') &&
      /if \(key === "delegate"\)/.test(pickerSource) &&
      /if \(key === "ocr"\)/.test(pickerSource) &&
      /return t\("tail\.costUnknown"/.test(pickerSource) &&
      !/\$\s?\d/.test(pickerSource),
    "按钮没有代价副行，或档位分支/兜底文案缺失",
  );

  /* ------------------------------- v0.12.4：UX「必须改」里剩下的 M2/M3/M4/M7/M8/M9/M10 ------------------------------- */
  {
    const m8Source = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");

    /* M8：取消路径与超时路径同一口径（同一句「不因…而退还」）。 */
    check(
      "v0.12.4（M8）：取消路径也说明用量不退（与超时路径同口径）",
      /不因终止而退还/.test(m8Source) && /不因取消而退还/.test(m8Source),
      "取消路径没接上用量说明",
    );

    /* v1.0：入口不再依赖会话级改动清单（api/changes.summary）与副行里的「本回合 N 个文件改动」。
       实测那套判断在真机上会 404 / 被撤销，读不到只能 fail-open，于是入口「有时出现、有时不出现」。 */
    check(
      "v1.0：按钮不再依赖会话级改动清单（无 CHANGES_SUMMARY_ROUTE / TURN_CHANGES_KIND / changeCount / data-ocr-tail-count）",
      !/CHANGES_SUMMARY_ROUTE/.test(pickerSource) &&
        !/TURN_CHANGES_KIND/.test(pickerSource) &&
        !/changeCount/.test(pickerSource) &&
        !/changesFeedReady/.test(pickerSource) &&
        !pickerSource.includes('"data-ocr-tail-count"'),
      "还残留会话级改动清单依赖",
    );

    /* M3：按钮失败文案必须有去处 —— 不许只显示「评审没能启动。」 */
    check(
      "v0.12.4（M3）：按钮失败文案带去处（指向 ocr_status 看原因），不是零信息的一句",
      /"tail\.failed": "[^"]*ocr_status/.test(pickerSource),
      "失败文案没有去处",
    );

    /* M4：首次使用的落点 —— 设置页 basic 区的三步引导。 */
    check(
      "v0.12.4（M4）：设置页有「三步开始用」静态引导",
      pickerSource.includes('"data-ocr-getting-started"') &&
        /gettingStarted\.step1/.test(pickerSource) &&
        /gettingStarted\.step3/.test(pickerSource),
      "设置页没有三步引导",
    );

    /* M9：就绪态只说人话；内部字段（entry id / state / mode / writable）只在异常态出现。 */
    {
      const readyAt = pickerSource.indexOf("status.readyDsh");
      const statusAt = pickerSource.indexOf("const statusLine = () => {");
      const body = statusAt >= 0 ? pickerSource.slice(statusAt, pickerSource.indexOf("\n      };", statusAt)) : "";
      check(
        "v0.12.4（M9）：就绪态只说人话（内部字段 entry/state/mode/writable 只在异常态出现）",
        readyAt > 0 &&
          /snap\.status === "ready" && snap\.writable !== false/.test(body) &&
          body.indexOf('"data-ocr-status-ready"') > 0 &&
          body.indexOf('parts.push(fmt(t("status.entry")') > body.indexOf('"data-ocr-status-ready"'),
        "就绪态仍外露宿主内部字段，或缺少就绪态分支",
      );
    }

    /* M10：高级区三条长 hint 压到一句人话（≤80 字），细节交给 README。 */
    {
      const hintOf = (key) => {
        const at = pickerSource.indexOf(`{ key: "${key}"`);
        if (at < 0) return "";
        const line = pickerSource.slice(at, pickerSource.indexOf("\n", at));
        const m = line.match(/hint:\s*"([^"]*)"/);
        return m ? m[1] : "";
      };
      const tooLong = ["engine"].filter((k) => {
        const h = hintOf(k);
        return h.length === 0 || h.length > 80;
      });
      check(
        "v0.12.4（M10）：高级区长 hint 已压到 ≤80 字（细节移进 README）",
        tooLong.length === 0,
        tooLong.length === 0 ? "engine 的 hint ≤80 字" : `仍过长或取不到：${tooLong.map((k) => `${k}=${hintOf(k).length}字`).join("、")}`,
      );
    }
  }
  /* 批 2（UI 规范）：容器底色只许用 layer-1/2/3 令牌 —— 不许自造 α<0.95 的叠层色当容器底。 */
  {
    const semiTransparent = [...styleBlock.matchAll(/background:\s*"(rgba\([^)]*\)|[^"]*?)"/g)]
      .map((m) => m[1])
      .filter((v) => /^rgba?\(/.test(v) && !/^rgb\(/.test(v) && (() => {
        const parts = v.replace(/^rgba?\(|\)$/g, "").split(",").map((s) => s.trim());
        const a = parts.length === 4 ? Number(parts[3]) : 1;
        return !(Number.isFinite(a) && a >= 0.95);
      })());
    check(
      "批 2：样式表里没有半透明叠层色当容器背景（容器底色只用 layer 令牌）",
      semiTransparent.length === 0,
      semiTransparent.length === 0 ? "没有半透明背景" : `发现 ${semiTransparent.join("、")}`,
    );
  }

  /* 批 2（UI 规范）：样式表自身的纪律 —— 键唯一、间距在 4px 刻度上、圆角与字号收敛。
     覆盖 S / T 两张表（S 是设置页，T 是回合尾部按钮；进度卡随 jobs 一起删了）。 */
  {
    const blockOf = (head) => {
      const start = pickerSource.indexOf(head);
      const end = start >= 0 ? pickerSource.indexOf("\n    };", start) : -1;
      return start >= 0 && end > start ? pickerSource.slice(start, end) : "";
    };
    const stylesAll = [blockOf("const S = {"), blockOf("const T = {")].join("\n");
    check(
      "批 2：两张样式表都取到了（守卫本身不能静默变成空跑）",
      stylesAll.includes("menu:") && stylesAll.includes("btnBusy:") && stylesAll.includes("cost:"),
      `长度=${stylesAll.length}`,
    );

    /* 键唯一必须**逐表**看：S/T 两张表里有同名键（wrap/row/btn…）是正常的，
       只有在同一张表里写两遍才会静默覆盖（combo 事故就是这样来的）。 */
    const dup = [];
    let keyCount = 0;
    for (const head of ["const S = {", "const T = {"]) {
      const keys = [...blockOf(head).matchAll(/^\s{6}([A-Za-z][A-Za-z0-9]*)\s*:/gm)].map((m) => m[1]);
      keyCount += keys.length;
      for (const k of new Set(keys.filter((k, i) => keys.indexOf(k) !== i))) dup.push(`${head.split(" ")[1]}.${k}`);
    }
    check(
      "批 2：同一张样式表里没有重复的样式键（combo 事故：后一个键会静默覆盖前一个）",
      dup.length === 0,
      dup.length === 0 ? `共 ${keyCount} 个键，逐表无重复` : `重复键：${dup.join("、")}`,
    );

    const spacing = [];
    for (const m of stylesAll.matchAll(/(?:padding|margin|gap)(?:Top|Bottom|Left|Right)?:\s*"?([^",}\n]+)"?/g)) {
      for (const n of String(m[1]).matchAll(/(-?\d+(?:\.\d+)?)px/g)) spacing.push(Number(n[1]));
    }
    /* 1/2px 是紧凑控件（按钮、进度卡抬头）的例外，见 UI 规范；其余必须落在 4px 刻度上。 */
    const allowedSpacing = new Set([0, 1, 2, 4, 8, 12, 16, 20, 24, 32]);
    const offScale = [...new Set(spacing.filter((v) => !allowedSpacing.has(v)))];
    check(
      "批 2：间距落在 4px 刻度上（1/2px 仅限紧凑控件）",
      offScale.length === 0,
      offScale.length === 0 ? `检查了 ${spacing.length} 个值` : `不在刻度上：${offScale.join("、")}`,
    );

    const radii = [...stylesAll.matchAll(/borderRadius:\s*"?(\d+)/g)].map((m) => Number(m[1]));
    const badRadii = [...new Set(radii.filter((v) => ![4, 6, 8, 999].includes(v)))];
    check(
      "批 2：圆角只用 4 / 6 / 8 / 999",
      badRadii.length === 0,
      badRadii.length === 0 ? `圆角取值 ${[...new Set(radii)].join(" / ")}` : `越界：${badRadii.join("、")}`,
    );

    const fonts = [...stylesAll.matchAll(/fontSize:\s*"?([\d.]+)/g)].map((m) => Number(m[1]));
    const badFonts = [...new Set(fonts.filter((v) => ![10.5, 11, 12, 13, 15].includes(v)))];
    check(
      "批 2：字号收敛成 5 档（10.5 / 11 / 12 / 13 / 15，去掉 11.5 与 12.5）",
      badFonts.length === 0,
      badFonts.length === 0 ? `字号 ${[...new Set(fonts)].sort((a, b) => a - b).join(" / ")}` : `越界：${badFonts.join("、")}`,
    );

    check(
      "批 2：可访问性 —— 菜单/输入框有 listbox+combobox 角色与 aria-activedescendant",
      /role:\s*"listbox"/.test(pickerSource)
        && /role:\s*"combobox"/.test(pickerSource)
        && /role:\s*"option"/.test(pickerSource)
        && /"aria-activedescendant"/.test(pickerSource),
      "菜单/输入框的角色或 aria 属性缺失",
    );

    check(
      "批 2：焦点环样式表注入（行内样式表达不了 :focus-visible）",
      /function ensureFocusRing\(\)/.test(pickerSource)
        && /ocr-plugin-focus-style/.test(pickerSource)
        && /:focus-visible \{/.test(pickerSource)
        && /\n\s+ensureFocusRing\(\);/.test(pickerSource),
      "没有注入焦点环样式表，或 apply 里没有调用",
    );
  }
}

/* --------------------------- 结果码与 fail-closed（罐头子进程，不依赖真 ocr） --------- */

const codeKeys = Object.keys(review.CODES ?? {});
check(
  "结果码表：13 个稳定码齐全（v1.0 删掉独立评审 agent 的 3 条）、都是 OCR_ 前缀、互不重复",
  codeKeys.length === 13 &&
    new Set(Object.values(review.CODES)).size === 13 &&
    codeKeys.includes("ALREADY_RUNNING") &&
    !codeKeys.some((key) => key.startsWith("REVIEWER_")) &&
    codeKeys.every((key) => String(review.CODES[key]).startsWith("OCR_")),
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
  /* llmMode 用 endpoint（v0.11.0 起 dsh 模式不再回落静态端点）：这批用例考的是 ocr 子进程那条流水线
     —— 罐头子进程根本不看 env，起真桥只会让每个用例都绑一个端口。dsh 路由本身在下面
     「本机 LLM 桥」那几条 + bridge-smoke 里单独覆盖，「桥不可用就明确失败」也有专门用例。 */
  mod.apply(ctx2, mkConfig({ engine: "ocr", llmMode: "endpoint", llmProvider: "commandcode", llmModel: "deepseek/deepseek-v4.1-flash", ...config }));
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

/* v0.11.2（真机 2026-10-13 撞到）：改动全是不可审类型时，ocr 给出 reviewable_count=0 + 空 files/issues，
   而 reviewedFileCount 的回落会把 total_files 当成「审了几个文件」，于是摘要打出「审查 1 个文件，未发现问题」
   —— 一个文件都没审却说没问题，正好是本插件最不该出现的失败方向。 */
const noReviewableCase = cannedHarness([
  {
    exitCode: 0,
    stdout: JSON.stringify({
      total_files: 1,
      reviewable_count: 0,
      excluded_files: ["notes.txt"],
      files: [],
      issues: [],
    }),
  },
]);
const noReviewableRun = await noReviewableCase.call({ engine: "ocr" });
check(
  "v0.11.2：没有可审文件时不许说「未发现问题」（要报 partial + 说清被排除的文件）",
  noReviewableRun.ok === true &&
    noReviewableRun.partial === true &&
    noReviewableRun.summary.includes("没有可审的代码改动") &&
    noReviewableRun.summary.includes("notes.txt") &&
    !noReviewableRun.summary.includes("未发现问题") &&
    noReviewableRun.notes.some((n) => n.includes("换 scope")),
  `ok=${noReviewableRun.ok} partial=${noReviewableRun.partial} summary=${noReviewableRun.summary}`,
);

/* M6 同族（v0.12.1 · 真机 2026-10-14 边界 5）：delegate 档撞上「规格里没有可审文件」时同样是
   「成功（exit=0）」，很容易被读成「评审通过、没问题」——但一个文件都没审。结论必须说清没有结论。 */
const delegateEmptyCase = cannedHarness([
  { exitCode: 0, stdout: JSON.stringify({ files: [], excluded: ["notes.txt"] }) },
  { exitCode: 0, stdout: "" },
]);
const delegateEmptyRun = await delegateEmptyCase.call({ engine: "delegate" });
check(
  "v0.12.1：delegate 档可审文件为空时标 partial 并明说「没有做出任何结论」（别被读成「没问题」）",
  delegateEmptyRun.ok === true &&
    delegateEmptyRun.partial === true &&
    /^⚠️ 部分结果/.test(String(delegateEmptyRun.summary)) &&
    /没有做出任何结论/.test(delegateEmptyRun.summary) &&
    (delegateEmptyRun.notes ?? []).some((n) => /没有做出任何结论/.test(n)),
  `ok=${delegateEmptyRun.ok} partial=${delegateEmptyRun.partial} summary=${String(delegateEmptyRun.summary).slice(0, 120)}`,
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
    listText.indexOf("- 7 [中]") < listText.indexOf("- 12-14 [高]") &&
    listText.includes("- 12-14 [高] 空指针风险（null-check）") &&
    listText.includes("高 1 · 中 1 · 低 1 · 未分级 0"),
  listText.split("\n").slice(-5).join(" / "),
);
check(
  "批 2：结论的附录行固定存在（有材料就列出材料，没有就明写「无附加输出」）",
  review.valueToText({ ok: true, engine: "delegate", scope: "workspace", exitCode: 0, durationMs: 10 }, {}).includes("附录：无附加输出") &&
    review.valueToText({ ok: false, engine: "ocr", scope: "workspace", exitCode: 1, durationMs: 10, code: "OCR_RUN_FAILED", stderr: "boom" }, {}).includes("附录：stderr（见下）"),
  review.valueToText({ ok: true, engine: "delegate", scope: "workspace", exitCode: 0, durationMs: 10 }, {}).split("\n").slice(-2).join(" / "),
);
const layerText = review.valueToText(
  {
    ok: true,
    engine: "ocr",
    scope: "workspace",
    exitCode: 0,
    durationMs: 10,
    reviewableFiles: [
      { path: "lib/a.js", status: "modified", insertions: 3, deletions: 1 },
      { path: "lib/b.js", status: "modified", insertions: 4, deletions: 2 },
    ],
    excludedFiles: ["notes.txt"],
    coverage: { totalFiles: 2, totalHunks: 9, keptHunks: 9, droppedHunks: 0, slices: 2, truncated: false },
  },
  {},
);
const layerFail = review.valueToText(
  {
    ok: false,
    engine: "ocr",
    scope: "workspace",
    exitCode: 1,
    durationMs: 10,
    code: "OCR_RUN_FAILED",
    nextStep: "先 ocr llm test",
    stderr: "boom",
  },
  {},
);
check(
  "批 2：结论的「规模」层与「下一步」层固定存在（规模给总数+增删；成功也有一句下一步，失败仍用宿主给的 nextStep）",
  layerText.includes("规模：可审 2 个文件（+7 -3） · 排除 1 个 · 改动 9 个 hunk") &&
    layerText.includes("\n下一步：") &&
    layerFail.includes("\n下一步：先 ocr llm test") &&
    layerText.indexOf("规模：") < layerText.indexOf("下一步："),
  layerText.split("\n").filter((l) => l.startsWith("规模：") || l.startsWith("下一步：")).join(" / "),
);
/* 交互规格 §5.2 第 1 层 + §9.3 判定线：结论行必须是结果文本的第 1 行（机读头行不能占第 1 行）。
   判定线原文：出现「结论行不是结果文本的第 1 行」即视为未达标。 */
{
  const firstLine = (text) => String(text).split("\n")[0];
  const cleanText = review.valueToText(
    { ok: true, engine: "ocr", scope: "workspace", exitCode: 0, durationMs: 9000, reviewableFiles: [{ path: "a.js", insertions: 3, deletions: 1 }], coverage: { totalHunks: 4, keptHunks: 4, totalFiles: 1, slices: 1, droppedHunks: 0 }, summary: "没问题。" },
    {},
  );
  const issuesText = review.valueToText(
    { ok: true, engine: "ocr", scope: "workspace", exitCode: 0, durationMs: 9000, issues: [{ file: "a.js", line: 3, severity: "major", message: "x" }] },
    {},
  );
  const delegateText = review.valueToText({ ok: true, engine: "delegate", scope: "workspace", exitCode: 0, durationMs: 300, reviewableFiles: [{ path: "a.js", insertions: 1, deletions: 0 }] }, {});
  const failText = review.valueToText({ ok: false, engine: "ocr", scope: "workspace", exitCode: 1, durationMs: 10, code: "OCR_RUN_FAILED", nextStep: "先 ocr llm test", stderr: "boom" }, {});
  /* v0.12.6：干跑（preview）不调 LLM、也没审任何东西 —— 它绝不能落到「✅ 未发现问题」。
     plan.preview 时 lib/index.js 的 emptyReview / nothingReviewable 两支都不生效（都带 !plan.preview），
     所以 ok=true + 0 条问题 + 0 个文件会一路滑到 clean 分支（v0.12.5 的委派模式自查抓到的）。 */
  const previewText = review.valueToText(
    { ok: true, preview: true, engine: "ocr", scope: "workspace", exitCode: 0, durationMs: 400, reviewableFiles: [], issues: [], excludedFiles: ["notes.txt"] },
    {},
  );
  const issuesFirst = firstLine(issuesText);
  const cleanFirst = firstLine(cleanText);
  const delegateFirst = firstLine(delegateText);
  const failFirst = firstLine(failText);
  const previewFirst = firstLine(previewText);
  check(
    "交互规格 M5/§5.2-1：结论行永远是结果文本第 1 行（机读头行降级到第 2 层；失败给「码 + 一句话」；delegate 不许说「未发现问题」）",
    cleanFirst.startsWith("✅ 未发现问题 · 已审查 1 个文件") &&
      issuesFirst.startsWith("⚠️ 发现 1 条问题（涉及 1 个文件）") &&
      delegateFirst.startsWith("📋 已生成审查规格") &&
      failFirst.startsWith("❌ 评审没有完成：OCR_RUN_FAILED（") &&
      cleanText.indexOf("阿里 OpenCodeReview") > 0 &&
      cleanText.split("\n")[1].startsWith("可用性：") &&
      cleanText.indexOf("阿里 OpenCodeReview") > cleanText.indexOf("规模：") &&
      cleanText.indexOf("可审文件 1 个：") > cleanText.indexOf("下一步："),
    [cleanFirst, issuesFirst, delegateFirst, failFirst].map((l) => l.slice(0, 28)).join(" | "),
  );
  check(
    "v0.12.6：干跑（preview）不说「未发现问题」—— 第 1 行是「📋 干跑」，可用性行写「没有结论」",
    previewFirst.startsWith("📋 干跑：只列出了将审查的") &&
      !previewText.includes("未发现问题") &&
      previewText.split("\n")[1].startsWith("可用性：只是干跑（preview）"),
    [previewFirst, previewText.split("\n")[1], `含未发现问题=${previewText.includes("未发现问题")}`].join(" | "),
  );
}
check(
  "批 2：严重程度按 高/中/低 展示，认不出来的一律「未分级」（未知档不当低）",
  review.severityLabel("critical").label === "高" &&
    review.severityLabel("MAJOR").label === "高" &&
    review.severityLabel("moderate").label === "中" &&
    review.severityLabel("P2").label === "中" &&
    review.severityLabel("nit").label === "低" &&
    review.severityLabel("建议").label === "低" &&
    review.severityLabel("unheard-of").label === "未分级" &&
    review.severityLabel("").label === "未分级" &&
    review.severityLabel(7).label === "未分级",
  ["critical", "moderate", "nit", "unheard-of", ""].map((s) => `${JSON.stringify(s)}→${review.severityLabel(s).label}`).join(" · "),
);
check(
  "issuesToLines（工具结果内联）：同样逐条列出问题（文件 → 行 [severity] 问题）",
  review.issuesToLines(listRun.issues, { max: 12 }).lines.includes("lib/a.js") &&
    review.issuesToLines(listRun.issues, { max: 12 }).lines.includes("- 12-14 [高] 空指针风险（null-check）") &&
    review.issuesToLines(listRun.issues, { max: 12 }).lines.includes("lib/b.js"),
  review.issuesToLines(listRun.issues, { max: 12 }).lines.slice(-4).join(" / "),
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

/* 跑前成本预估（v0.10.0）：engine=ocr 先跑一次 `ocr delegate preview` 拿本次可审文件数，再跑真正的评审。 */
const estimateCase = cannedHarness([
  {
    exitCode: 0,
    stdout: JSON.stringify({
      files: [
        { path: "lib/a.js", insertions: 3, deletions: 1 },
        { path: "lib/b.js", insertions: 1, deletions: 0 },
        { path: "lib/c.js", insertions: 2, deletions: 2 },
      ],
      excluded: ["x.md", "y.md"],
    }),
  },
  { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "lib/a.js", insertions: 3, deletions: 1 }], issues: [] }) },
]);
const estimateRun = await estimateCase.call({ engine: "ocr" });
const estimateNotes = (estimateRun.notes ?? []).join("\n");
check(
  "v0.10.0：engine=ocr 跑前先拿一次 delegate preview 做规模预估（评审本身照旧一次 review）",
  estimateCase.canned.calls.length === 2 &&
    estimateCase.canned.calls[0]?.spec.argv.includes("delegate") &&
    estimateCase.canned.calls[1]?.spec.argv.includes("review") &&
    estimateRun.ok === true &&
    /实测可审 3 个文件/.test(estimateNotes) &&
    /约 9~30 分钟/.test(estimateNotes),
  `${estimateCase.canned.calls.map((call) => call.spec.argv[1] ?? "").join(",")} | ${estimateNotes.replace(/\n/g, " ").slice(0, 140)}`,
);
const estimateFailCase = cannedHarness([
  { exitCode: 1, stdout: "", stderr: "ocr delegate preview 失败" },
  { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "lib/a.js", insertions: 1, deletions: 0 }], issues: [] }) },
]);
const estimateFailRun = await estimateFailCase.call({ engine: "ocr" });
const estimateFailNotes = (estimateFailRun.notes ?? []).join("\n");
check(
  "v0.10.0：预估拿不到时只是少那半句，评审照跑（不因预估失败而失败、也不编数字）",
  estimateFailRun.ok === true && !/实测可审/.test(estimateFailNotes) && /成本提示：engine=ocr/.test(estimateFailNotes),
  `${estimateFailRun.code} ok=${estimateFailRun.ok} | ${estimateFailNotes.replace(/\n/g, " ").slice(0, 140)}`,
);
const estimatePathCase = cannedHarness([
  {
    exitCode: 0,
    stdout: JSON.stringify({
      files: [
        { path: "lib/a.js", insertions: 3, deletions: 1 },
        { path: "lib/b.js", insertions: 1, deletions: 0 },
      ],
    }),
  },
  { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "lib/a.js", insertions: 3, deletions: 1 }], issues: [] }) },
]);
const estimatePathRun = await estimatePathCase.call({ engine: "ocr", paths: ["lib/a.js"] });
const estimatePathNotes = [estimatePathRun.summary, ...(estimatePathRun.notes ?? [])].join("\n");
check(
  "E1：workspace 档给 paths（ocr 引擎）→ OCR_INVALID_ARGS，不再静默忽略、也不再报一个比实际更小的预估",
  estimatePathRun.ok === false &&
    estimatePathRun.code === "OCR_INVALID_ARGS" &&
    estimatePathNotes.includes("不接受 paths"),
  `${estimatePathRun.code} | ${estimatePathNotes.replace(/\n/g, " ").slice(0, 140)}`,
);

/* ocr 档体验（v0.11.0 · W4）：预估前置、预计剩余、超时下限告警、partial 置顶、会话 id、停止/超时说明「保住了什么」。 */
{
  const m = review.estimateMinutes({ reviewable: 4 });
  check(
    "v0.11.0：estimateMinutes 与 estimateText 同口径（3~10 分钟/文件），拿不到文件数就 null",
    m?.files === 4 && m?.lo === 12 && m?.hi === 40 && review.estimateMinutes({}) === null && review.estimateMinutes({ reviewable: 0 }) === null,
    JSON.stringify(m),
  );
  check(
    "v0.11.0：spendNotice 给开跑那一行（无预估 / preview 时为空串）",
    review.spendNotice({}, { reviewable: 2 }) === "本次约 2 个文件 → 按真机历史约 6~20 分钟" &&
      review.spendNotice({}, null) === "" &&
      review.spendNotice({ preview: true }, { reviewable: 2 }) === "",
    review.spendNotice({}, { reviewable: 2 }),
  );
  check(
    "v0.11.0：remainingText 三段话术（未到下限 / 过下限 / 过上限），无预估时闭嘴",
    /预计还需 6 分钟起/.test(review.remainingText(0, { reviewable: 2 })) &&
      /已过预估下限 6 分钟/.test(review.remainingText(10 * 60000, { reviewable: 2 })) &&
      /* v0.12.5（交互规格 §7.1 / 附录 A）：越过下限时不只是让秒数跳 —— 同一行里要给动作。 */
      /停止后换 delegate/.test(review.remainingText(10 * 60000, { reviewable: 2 })) &&
      /已过预估上限 20 分钟/.test(review.remainingText(25 * 60000, { reviewable: 2 })) &&
      review.remainingText(60000, null) === "",
    review.remainingText(10 * 60000, { reviewable: 2 }),
  );
  check(
    "v0.11.0：timeoutWarning 只在下限越界时给（上限越界不拦人）",
    /小于预估下限 6 分钟/.test(review.timeoutWarning({}, { reviewable: 2 }, 3)) &&
      review.timeoutWarning({}, { reviewable: 2 }, 6) === "" &&
      review.timeoutWarning({}, { reviewable: 2 }, 30) === "" &&
      review.timeoutWarning({ preview: true }, { reviewable: 2 }, 3) === "",
    review.timeoutWarning({}, { reviewable: 2 }, 3).slice(0, 60),
  );
  check(
    "v0.11.0：心跳带预估时多一句「还要等多久」（老签名不动）",
    review.heartbeatLine(60000, null, 15, { reviewable: 2 }).includes("预计还需 5 分钟起") &&
      !review.heartbeatLine(60000, null, 15).includes("预计还需") &&
      review.heartbeatLine(95000).includes("还没有任何输出"),
    review.heartbeatLine(60000, null, 15, { reviewable: 2 }),
  );
  check(
    "v0.11.0：extractSessionId 只认 ocr 的字段名，拿不到就空串（不猜）",
    review.extractSessionId({ session_id: "abc" }) === "abc" &&
      review.extractSessionId({ sessionId: "def" }) === "def" &&
      review.extractSessionId({ nope: "x" }) === "" &&
      review.extractSessionId(null) === "",
    review.extractSessionId({ session_id: "abc" }),
  );

  /* 开跑前告警：预估下限 > 超时 → 结果 notes 里留一条（v1-slim 起没有 job 进度行可看了）。 */
  const phaseCase = cannedHarness(
    [
      { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "lib/a.js", insertions: 3, deletions: 1 }], excluded: [] }) },
      {
        exitCode: 0,
        stdout: JSON.stringify({ session_id: "s-123", files: [{ path: "lib/a.js", insertions: 3, deletions: 1 }], issues: [] }),
      },
    ],
    { timeoutMinutes: 1 },
  );
  const phaseRun = await phaseCase.call({ engine: "ocr" });
  const phaseNotes = (phaseRun.notes ?? []).join("\n");
  check(
    "v0.11.0：开跑前告警留在结果 notes 里（超时 1 分钟 < 预估下限 3 分钟 → 告警 + 缩小范围建议）",
    phaseRun.ok === true &&
      /超时 1 分钟小于预估下限 3 分钟/.test(phaseNotes) &&
      /缩小范围/.test(phaseNotes),
    `notes=${phaseNotes.replace(/\n/g, " ").slice(0, 100)}`,
  );
  check(
    "v0.11.0：结果带 ocr 会话 id —— 摘要在前，note 给出 session show/export/viewer 三步",
    phaseRun.reviewSessionId === "s-123" &&
      /ocr 会话：s-123/.test(phaseRun.summary) &&
      /ocr session show s-123/.test(phaseNotes) &&
      /ocr session export s-123/.test(phaseNotes) &&
      /ocr viewer/.test(phaseNotes),
    `${phaseRun.reviewSessionId} | ${String(phaseRun.summary).slice(0, 90)}`,
  );
  check(
    "v0.11.0：拿不到 session_id 时不编（summary 不提会话，note 也不出现 session show）",
    !/ocr 会话/.test(estimateRun.summary ?? "") && !/ocr session show/.test(estimateNotes),
    String(estimateRun.summary ?? "").slice(0, 80),
  );

  /* partial 置顶：ocr 侧摘要第一句就是「部分结果」，而不是先说「审查了 N 个文件」。 */
  const partialCase = cannedHarness([
    { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "lib/a.js", insertions: 1, deletions: 0 }], excluded: [] }) },
    {
      exitCode: 0,
      stdout: JSON.stringify({
        partial: true,
        files: [{ path: "lib/a.js", insertions: 1, deletions: 0 }],
        issues: [],
      }),
    },
  ]);
  const partialRun = await partialCase.call({ engine: "ocr" });
  check(
    "v0.11.0：ocr 报部分结果时「⚠️ 部分结果」是摘要第一个词（不许先说审了几个文件）",
    partialRun.partial === true && /^⚠️ 部分结果/.test(String(partialRun.summary ?? "")) && /不能当作/.test(String(partialRun.summary ?? "")),
    String(partialRun.summary ?? "").slice(0, 110),
  );

  /* 停止 / 超时：说清「保住了什么」（= 没有结论，只有已发生的用量）。
     超时那条在罐头子进程里没法真触发（timeoutMs = timeoutMinutes*60000 + 60000，最短也要分钟级），
     所以用「跑到一半取消」走 ABORTED 真路径 + 一条源码级守卫盯 TIMEOUT 的文案。 */
  const w4AbortCase = cannedHarness([
    { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "a.js", insertions: 1, deletions: 0 }] }) },
    { exitCode: 0, stdout: JSON.stringify({ files: [], issues: [] }), manual: true },
  ]);
  const w4Ctl = new AbortController();
  const w4AbortRun = tools
    .get("ocr_review")
    .execute({ engine: "ocr" }, { ...w4AbortCase.exec, signal: w4Ctl.signal });
  const w4Review = () => w4AbortCase.canned.calls.find((call) => call.spec.argv.includes("review"));
  for (let i = 0; i < 200 && !w4Review(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  w4Ctl.abort();
  const w4AbortValue = await w4AbortRun;
  const w4AbortNotes = (w4AbortValue.notes ?? []).join("\n");
  check(
    "v0.11.0：取消的说明里写清「已跑过的不留结论」与「缩小范围/换 delegate 更快」",
    w4AbortValue.code === "OCR_ABORTED" &&
      /被切断/.test(w4AbortNotes) &&
      /不留下结论/.test(w4AbortNotes) &&
      /缩小范围/.test(w4AbortNotes),
    `${w4AbortValue.code} | ${w4AbortNotes.replace(/\n/g, " ").slice(0, 140)}`,
  );
  const w4IndexSource = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  check(
    "v0.11.0：超时文案说清「没有结论」与「已发生的用量不退还」（源码级守卫，罐头里跑不到真超时）",
    /被终止，没有结论/.test(w4IndexSource) && /这部分不因终止而退还/.test(w4IndexSource) && /一次性 JSON/.test(w4IndexSource),
    "lib/index.js 里找不到超时/取消的「保住了什么」文案",
  );
}

/* 覆盖回执与部分结果（v0.10.0 · W3）：规格按片交付，预算不够就整片丢弃并报数；部分结果不许当「未发现问题」。 */
{
  const threeHunks = [
    "diff --git a/lib/a.js b/lib/a.js",
    "index 111..222 100644",
    "--- a/lib/a.js",
    "+++ b/lib/a.js",
    "@@ -1,2 +1,2 @@",
    "-old1",
    "+new1",
    "@@ -10,2 +10,2 @@",
    "-old2",
    "+new2",
    "@@ -20,2 +20,2 @@",
    "-old3",
    "+new3",
    "",
  ].join("\n");
  const blocks = review.splitDiffSlices(threeHunks);
  check(
    "v0.10.0 W3：diff 能按「文件块 → hunk」切开（按片交付的片头靠它）",
    blocks.length === 1 && blocks[0].path === "lib/a.js" && blocks[0].hunks.length === 3,
    `blocks=${blocks.length} path=${blocks[0]?.path} hunks=${blocks[0]?.hunks.length}`,
  );
  const headBytes = Buffer.byteLength(blocks[0].head, "utf8");
  const hunk0Bytes = Buffer.byteLength(blocks[0].hunks[0], "utf8");
  const oneHunk = review.planDiffSlices(threeHunks, headBytes + hunk0Bytes + 5, 0);
  check(
    "v0.10.0 W3：预算只够 1 个 hunk 时整片丢弃其余（绝不切在 hunk 中间）",
    oneHunk.truncated === true &&
      oneHunk.keptHunks === 1 &&
      oneHunk.droppedHunks === 2 &&
      oneHunk.slices.length === 1 &&
      oneHunk.slices[0].hunkFrom === 1 &&
      oneHunk.slices[0].hunkTo === 1 &&
      oneHunk.slices[0].hunkTotal === 3,
    `kept=${oneHunk.keptHunks}/${oneHunk.totalHunks} dropped=${oneHunk.droppedHunks} ${oneHunk.slices[0]?.hunkFrom}-${oneHunk.slices[0]?.hunkTo}/${oneHunk.slices[0]?.hunkTotal}`,
  );
  const cut = review.truncateDiffByHunk(threeHunks, 400 + oneHunk.usedBytes + 5);
  check(
    "v0.10.0 W3：gitDiff 的截断也是 hunk 级 —— 只留整片、报出收录/丢弃数、不出现半截 hunk",
    cut.truncated === true &&
      cut.keptHunks === 1 &&
      cut.droppedHunks === 2 &&
      cut.text.includes("+new1") &&
      !cut.text.includes("-old2") &&
      !cut.text.includes("+new3") &&
      /收录 1\/3 个 hunk/.test(cut.text) &&
      cut.text.includes("只整片丢弃"),
    `kept=${cut.keptHunks}/${cut.totalHunks} dropped=${cut.droppedHunks} bytes=${Buffer.byteLength(cut.text, "utf8")}`,
  );
  const specOptions = {
    plan: { cwd: "/repo", scope: "workspace" },
    preview: { repository: "/repo", mode: "workspace", reviewable_count: 1 },
    rules: { groups: [{ group_id: "g1", pattern: "**/*.js", rule: "不要把 undefined 当空值" }] },
    diff: threeHunks,
    files: [{ path: "lib/a.js", status: "modified", insertions: 3, deletions: 3 }],
  };
  const fullSpec = review.buildDelegateSpecDetailed({ ...specOptions, maxBytes: 100000 });
  check(
    "v0.10.0 W3：规格按片交付 —— 片头写明文件/本文件 hunk 区间/字节数，且要求逐片回执",
    /\[片 1\/1 · lib\/a\.js · 本文件 hunk 1-3\/3 · \d+B\]/.test(fullSpec.text) &&
      fullSpec.text.includes("## 覆盖回执（硬规则，必须逐片回填）") &&
      fullSpec.text.includes("片 i/n → 未读到") &&
      fullSpec.text.includes("不得输出「未发现问题」") &&
      fullSpec.coverage?.totalHunks === 3 &&
      fullSpec.coverage?.keptHunks === 3 &&
      fullSpec.coverage?.truncated === false,
    `coverage=${JSON.stringify(fullSpec.coverage)}`,
  );
  const fortyHunks = Array.from({ length: 40 }, (_, i) => `@@ -${i * 5},1 +${i * 5},1 @@\n-old${i}\n+new${i}`).join("\n");
  const skeletonBytes = Buffer.byteLength(review.buildDelegateSpecDetailed({ ...specOptions, diff: "", maxBytes: 100000 }).text, "utf8");
  const tightSpec = review.buildDelegateSpecDetailed({
    ...specOptions,
    diff: `diff --git a/lib/a.js b/lib/a.js\n${fortyHunks}\n`,
    maxBytes: skeletonBytes + 200,
  });
  check(
    "v0.10.0 W3：预算装不下时整片丢弃、coverage 记数，任务段与回执段必须活着（截断不许吃掉骨架）",
    tightSpec.coverage?.truncated === true &&
      tightSpec.coverage?.partial === true &&
      tightSpec.coverage?.droppedFiles === 1 &&
      /收录 \d+\/40 个 hunk/.test(tightSpec.text) &&
      tightSpec.text.includes("## 你的任务") &&
      tightSpec.text.includes("## 覆盖回执"),
    `coverage=${JSON.stringify(tightSpec.coverage)}`,
  );
  const partialSeen = review.detectPartial({ files: [{ path: "a.js", status: "failed", error: "budget" }] });
  check(
    "v0.10.0 W3：只有 ocr 明说「部分失败」时才标 partial（纯函数，不猜）",
    review.detectPartial({ files: [], issues: [] }).partial === false &&
      review.detectPartial({ partial: true }).partial === true &&
      partialSeen.partial === true &&
      /报告失败/.test(partialSeen.reasons.join("；")),
    JSON.stringify(partialSeen),
  );
  /* 真机字段（2026-10-12 验收实收）：status / manifest.terminal_state / manifest.coverage。
     验收发现：只认顶层 partial/budget_exceeded 那几个键的话，真机跑出「选中 8 项、只完成 5 项」时
     一个信号都命不中 → 会照样输出「未发现问题」，正好踩中我们自己立的规矩。 */
  const realClean = {
    status: "complete",
    summary: { files_reviewed: 1, comments: 0 },
    manifest: {
      terminal_state: "complete",
      coverage: { selected: [{ path: "a.js" }], completed: [{ path: "a.js" }], reused: [], failed: [], waived: [] },
    },
  };
  const realGap = {
    status: "complete",
    manifest: { terminal_state: "complete", coverage: { selected: [{}, {}], completed: [{}], reused: [], failed: [], waived: [] } },
  };
  const realFailed = {
    status: "complete",
    manifest: { terminal_state: "complete", coverage: { selected: [{}, {}], completed: [{}], reused: [], failed: [{}], waived: [] } },
  };
  const realTerminal = { status: "complete", manifest: { terminal_state: "interrupted", coverage: { selected: [], completed: [], reused: [], failed: [], waived: [] } } };
  const gapSeen = review.detectPartial(realGap);
  check(
    "v0.10.0 W3：认 ocr 真机的 manifest.coverage 与 terminal_state（选中 > 完成+复用 就标 partial）",
    review.detectPartial(realClean).partial === false &&
      gapSeen.partial === true &&
      /覆盖不足：选中 2 项、完成 1 项/.test(gapSeen.reasons.join("；")) &&
      review.detectPartial(realFailed).partial === true &&
      /coverage\.failed 1 项/.test(review.detectPartial(realFailed).reasons.join("；")) &&
      review.detectPartial(realTerminal).partial === true &&
      /terminal_state=interrupted/.test(review.detectPartial(realTerminal).reasons.join("；")) &&
      review.detectPartial({ status: "interrupted" }).partial === true,
    JSON.stringify({ clean: review.detectPartial(realClean), gap: gapSeen.reasons }),
  );
}
{
  /* 让 diff 远超 includeDiffMaxBytes（默认 120000）：gitDiff 先按 hunk 截断、规格预算再丢尾部若干片。
     这样不依赖「把配置注入进去」也能确定性地走到 partial。 */
  const hugeHunks = Array.from({ length: 6000 }, (_, i) => `@@ -${i * 5},1 +${i * 5},1 @@\n-old${i}\n+new${i}`).join("\n");
  const delegateRuns = (diffText) => [
    { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "lib/a.js", insertions: 40, deletions: 40 }], excluded: [] }) },
    { exitCode: 0, stdout: JSON.stringify({ groups: [{ group_id: "g1", pattern: "**/*.js", rule: "不要把 undefined 当空值" }] }) },
    { exitCode: 0, stdout: diffText },
  ];
  const delegatePartialCase = cannedHarness(delegateRuns(`diff --git a/lib/a.js b/lib/a.js\n${hugeHunks}\n`));
  const delegatePartialRun = await delegatePartialCase.call({ engine: "delegate" });
  check(
    "v0.10.0 W3：delegate 的 diff 被截断时结果标 partial，摘要与 notes 都点名「未覆盖的片不得当 clean」",
    delegatePartialRun.ok === true &&
      delegatePartialRun.partial === true &&
      delegatePartialRun.coverage?.truncated === true &&
      delegatePartialRun.coverage?.droppedHunks > 0 &&
      /部分结果/.test(String(delegatePartialRun.summary)) &&
      (delegatePartialRun.notes ?? []).some((n) => /未回填的片按未覆盖处理/.test(n)),
    `partial=${delegatePartialRun.partial} coverage=${JSON.stringify(delegatePartialRun.coverage)} | ${String(delegatePartialRun.summary).slice(0, 160)}`,
  );
}
const partialOcrCase = cannedHarness([
  { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "lib/a.js", insertions: 1, deletions: 0 }], issues: [], partial: true }) },
]);
const partialOcrRun = await partialOcrCase.call({ engine: "ocr" });
check(
  "v0.10.0 W3：ocr 报部分结果时摘要不许写「未发现问题」（部分结果 ≠ 干净）",
  partialOcrRun.ok === true &&
    partialOcrRun.partial === true &&
    /部分结果/.test(String(partialOcrRun.summary)) &&
    /不能当作/.test(String(partialOcrRun.summary)) &&
    !/未发现问题（返回的 JSON 带问题清单字段且为空）/.test(String(partialOcrRun.summary)),
  `${partialOcrRun.code} partial=${partialOcrRun.partial} | ${String(partialOcrRun.summary).slice(0, 140)}`,
);
check(
  "v0.10.0 W3：插件绝不传 --max-tokens-budget（预算不足必须显式暴露，不靠 ocr 静默截半）",
  !/--max-tokens-budget/.test(readFileSync(new URL("../lib/review.js", import.meta.url), "utf8")),
  "review.js 里没有 --max-tokens-budget",
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
const midCase = cannedHarness([
  /* 第一次 spawn 是跑前规模预估（秒级、立刻结束），第二次才是真正的评审。 */
  { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "a.js", insertions: 1, deletions: 0 }] }) },
  { exitCode: 0, stdout: JSON.stringify({ files: [], issues: [] }), manual: true },
]);
const midCtl = new AbortController();
const midRun = midCase.call
  ? tools.get("ocr_review").execute({ engine: "ocr" }, { ...midCase.exec, signal: midCtl.signal })
  : null;
const midReview = () => midCase.canned.calls.find((call) => call.spec.argv.includes("review"));
for (let i = 0; i < 200 && !midReview(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
midCtl.abort();
const midValue = await midRun;
check(
  "取消：跑到一半被中断 → 子进程被 terminate，结果报 OCR_ABORTED",
  midValue.ok === false && midValue.code === "OCR_ABORTED" && midReview()?.terminated === true,
  `${midValue.code} terminated=${midReview()?.terminated} spawn=${midCase.canned.calls.map((call) => call.spec.argv[1] ?? "").join(",")} | ${midValue.summary}`,
);

/* dispose：abort 在飞评审 + 等它收尾（不留孤儿进程，也不丢半截结果）。 */
const disposeCase = cannedHarness([
  { exitCode: 0, stdout: JSON.stringify({ files: [{ path: "a.js", insertions: 1, deletions: 0 }] }) },
  { exitCode: 0, stdout: JSON.stringify({ files: [], issues: [] }), delayMs: 300 },
]);
const inflight = disposeCase.call({ engine: "ocr" });
/* 等真正的评审 spawn（第一次 spawn 是跑前预估）。 */
await until(() => disposeCase.canned.calls.some((call) => call.spec.argv.includes("review")));
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
const disposeReview = disposeCase.canned.calls.find((call) => call.spec.argv.includes("review"));
check(
  "生命周期：dispose 会 abort 在飞的子进程（terminate 被调用）",
  disposeReview?.terminated === true,
  `terminated=${disposeReview?.terminated} spawn=${disposeCase.canned.calls.map((call) => call.spec.argv[1] ?? "").join(",")}`,
);
check(
  "生命周期：被 dispose 掐掉的评审标记为 OCR_ABORTED（不会当成功结果投递）",
  disposeValue.ok === false && disposeValue.code === "OCR_ABORTED",
  `${disposeValue.code} | ${disposeValue.summary}`,
);

/** 轮询等一个条件成立（等 spawn 真的发生之类）。 */
async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  return predicate();
}

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

/* P2：手写 config 里的 "false" / false 这类写法过去会被当成「启用」。 */
const hrCfgWeird = cfgMod.loadConfig({ enabled: "false", timeoutMinutes: "9" });
check(
  "配置（P2 回归）：字符串/布尔写法被归一（enabled:'false' 不再当启用，'9' 认成 9）",
  hrCfgWeird.enabled === false && hrCfgWeird.timeoutMinutes === 9,
  JSON.stringify({ enabled: hrCfgWeird.enabled, timeoutMinutes: hrCfgWeird.timeoutMinutes }),
);
const hrCfgTrue = cfgMod.loadConfig({ enabled: "true" });
check(
  "配置（P2 回归）：'true' 这类写法认得出来",
  hrCfgTrue.enabled === true,
  JSON.stringify({ enabled: hrCfgTrue.enabled }),
);

/* v0.5.0 步骤 3：默认按需评审（回合尾部按钮 + runtime skill）。 */
check(
  "配置（v0.5.0 步骤 3）：出厂 onDemand=true",
  cfgMod.DEFAULTS.onDemand === true,
  `onDemand=${cfgMod.DEFAULTS.onDemand}`,
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
    "配置（v0.5.0 步骤 3）：设置页 schema 的 onDemand 默认值引用 DEFAULTS（不写死）",
    schema?.dict?.onDemand?.meta?.default === cfgMod.DEFAULTS.onDemand,
    JSON.stringify({ onDemand: schema?.dict?.onDemand?.meta?.default }),
  );
} else {
  check(
    "配置（v0.5.0 步骤 3）：没有 schema 时 onDemand 默认值仍由 DEFAULTS 单点决定（CI 路径：onDemand=true）",
    cfgMod.DEFAULTS.onDemand === true && cfgMod.loadConfig({}).onDemand === cfgMod.DEFAULTS.onDemand,
    JSON.stringify({ onDemand: cfgMod.loadConfig({}).onDemand }),
  );
}

/* v0.3.5：真机 `ocr scan` 评审 lib/config.js 报出来的 6 条，这里守住其中可断言的部分。 */
const schemaDefault = (name) => schema?.dict?.[name]?.meta?.default;
if (HAS_SCHEMA) {
  check(
    "配置（v0.3.5 回归）：设置页默认值直接引用 DEFAULTS（不再两处硬编码），timeoutMinutes 上界也是",
    schemaDefault("timeoutMinutes") === cfgMod.DEFAULTS.timeoutMinutes &&
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
    ["onDemand", cfgMod.DEFAULTS.onDemand],
    ["timeoutMinutes", cfgMod.DEFAULTS.timeoutMinutes],
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
      cfgMod.loadConfig({}).verbose === cfgMod.DEFAULTS.verbose,
    JSON.stringify({ engine: cfgMod.loadConfig({}).engine, verbose: cfgMod.loadConfig({}).verbose }),
  );
}

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
    cfgMod.loadConfig({ maxIssuesInText: "25" }).maxIssuesInText === 25 &&
    cfgMod.loadConfig({ timeoutMinutes: "" }).timeoutMinutes === cfgMod.DEFAULTS.timeoutMinutes,
  JSON.stringify({
    str: cfgMod.loadConfig({ timeoutMinutes: "20" }).timeoutMinutes,
    maxIssues: cfgMod.loadConfig({ maxIssuesInText: "25" }).maxIssuesInText,
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
  "配置（v0.3.6 回归）：run 的硬超时与 ocr --timeout 同源（plan.timeoutMs = 分钟 + 60s 宽限）",
  hrSameSrcPlan.timeoutMinutes === 120 &&
    hrSameSrcPlan.timeoutMs === 121 * 60000 &&
    cfgMod.timeoutMsOf(hrSameSrcCfg, hrSameSrcPlan.timeoutMinutes) === hrSameSrcPlan.timeoutMs - 60000,
  `plan.timeoutMs=${hrSameSrcPlan.timeoutMs} base=${cfgMod.timeoutMsOf(hrSameSrcCfg, hrSameSrcPlan.timeoutMinutes)}`,
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

/* v0.12.0（后端架构师自审 D1）：模板是给新用户**直接复制**的，所以它写了值的键必须与出厂默认一致 ——
   `config.example.json` 曾经写 `"engine": "auto"`（而 DEFAULTS.engine 是 `"ocr"`），复制粘贴即悄悄回到
   v0.10.0 之前的行为。这里只比一份显式清单（模板有权省略键、也有权写示例值，但绝不能与默认相反）。 */
const exampleCfg = JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8"));
const exampleDefaultPairs = [
  ["enabled", cfgMod.DEFAULTS.enabled],
  ["engine", cfgMod.DEFAULTS.engine],
  ["onDemand", cfgMod.DEFAULTS.onDemand],
  ["audience", cfgMod.DEFAULTS.audience],
  ["timeoutMinutes", cfgMod.DEFAULTS.timeoutMinutes],
  ["maxTimeoutMinutes", cfgMod.DEFAULTS.maxTimeoutMinutes],
  ["llm.mode", cfgMod.DEFAULTS.llm.mode],
];
const exampleDrift = exampleDefaultPairs
  .filter(([key]) => {
    const got = key.includes(".") ? exampleCfg[key.split(".")[0]]?.[key.split(".")[1]] : exampleCfg[key];
    const want = key.includes(".") ? cfgMod.DEFAULTS[key.split(".")[0]]?.[key.split(".")[1]] : cfgMod.DEFAULTS[key];
    return got !== undefined && JSON.stringify(got) !== JSON.stringify(want);
  })
  .map(([key]) => {
    const got = key.includes(".") ? exampleCfg[key.split(".")[0]]?.[key.split(".")[1]] : exampleCfg[key];
    const want = key.includes(".") ? cfgMod.DEFAULTS[key.split(".")[0]]?.[key.split(".")[1]] : cfgMod.DEFAULTS[key];
    return `${key}=${JSON.stringify(got)}≠${JSON.stringify(want)}`;
  });
check(
  "v0.12.0：config.example.json 里写明了值的键必须与出厂默认一致（模板被复制即生效）",
  exampleDrift.length === 0,
  exampleDrift.length === 0 ? `比了 ${exampleDefaultPairs.length} 个键，全部一致` : exampleDrift.join(" · "),
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
  const beforeBack = process.env.DSH_OPEN_CODE_REVIEW_CONFIG;
  /* 这一段要断言的正是「env **没设**时」的回落，所以临时撤掉它本身（文件层的隔离见文件顶部）。 */
  delete process.env.DSH_OPEN_CODE_REVIEW_CONFIG;
  const back = cfgMod.resolveConfigFile();
  if (beforeBack === undefined) delete process.env.DSH_OPEN_CODE_REVIEW_CONFIG;
  else process.env.DSH_OPEN_CODE_REVIEW_CONFIG = beforeBack;
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
    { llm: { model: "from-file", protocol: "OpenAI " }, env: { A: "1" } },
    { llm: { mode: "Endpoint" } },
  );
  check(
    "v0.5.0 步骤 5：mergeLayers 先深合并再归一（file 的 llm/env 与 patch 的键都在，坏类型被收敛）",
    merged.llm.model === "from-file" &&
      merged.llm.mode === "endpoint" &&
      merged.llm.protocol === "openai" &&
      merged.env.A === "1" &&
    JSON.stringify({ llm: merged.llm, env: merged.env }),
  );
  const guarded = cfgMod.mergeLayers({ llm: ["x"] }, { env: "nope" });
  check(
    "v0.5.0 步骤 5：嵌套块传数组/字符串时整块回落默认（不会展开成数字键对象污染配置）",
    guarded.llm.mode === "dsh" &&
      Object.keys(guarded.llm).every((key) => !/^\d+$/.test(key)) &&
      JSON.stringify(guarded.env) === "{}",
    JSON.stringify({ llm: guarded.llm, env: guarded.env }),
  );
  const clamped = cfgMod.normalizeConfig({
    engine: "OCR",
    audience: "nope",
    timeoutMinutes: 0,
    maxTimeoutMinutes: 99999,
    maxIssuesInText: 999999,
    includeDiffMaxBytes: -1,
    llm: { mode: "Endpoint", protocol: "Anthropic " },
  });
  check(
    "v0.5.0 步骤 5：越界值 — 大于上界夹住，小于下界回落到默认（负数不是「要更小」而是写错）",
    clamped.maxIssuesInText === 2000 &&
      clamped.includeDiffMaxBytes === cfgMod.DEFAULTS.includeDiffMaxBytes &&
      clamped.timeoutMinutes === 15 &&
      clamped.maxTimeoutMinutes === 1440,
    JSON.stringify({
      maxIssuesInText: clamped.maxIssuesInText,
      includeDiffMaxBytes: clamped.includeDiffMaxBytes,
      timeoutMinutes: clamped.timeoutMinutes,
      maxTimeoutMinutes: clamped.maxTimeoutMinutes,
    }),
  );
  check(
    "v0.5.0 步骤 5：枚举非法值回落默认、合法值去空白小写（engine/audience/llm.mode/llm.protocol）",
    clamped.engine === "ocr" &&
      clamped.audience === "agent" &&
      clamped.llm.mode === "endpoint" &&
      clamped.llm.protocol === "anthropic" &&
    JSON.stringify({ engine: clamped.engine, audience: clamped.audience, llm: clamped.llm }),
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
    "v0.6.1：bridge schema 声明了 rejected / lastReject 并进 required（「没转发就被拒」与 failed 分开计数）",
    bridgeDecl.includes("\"rejected\"") &&
      bridgeDecl.includes("\"lastReject\"") &&
      (statusSchema?.properties?.bridge?.oneOf?.[0]?.required ?? []).includes("rejected") &&
      (statusSchema?.properties?.bridge?.oneOf?.[0]?.required ?? []).includes("lastReject"),
    JSON.stringify(statusSchema?.properties?.bridge?.oneOf?.[0]?.required ?? null),
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
}

/* v0.6.0 事故回归（源码级）：0.5.7~0.5.9 的全局 guard 是「放行返回 "" 被宿主当成拒绝
   理由 ⇒ 所有工具变成 Error: 」的直接来源。防线是**压根不注册**它，所以这里直接检查
   源码里不再有 tools.guard 调用（比行为断言更难绕过：无论配置是什么都不该出现）。 */
{
  const indexSource = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  /* 注释里提到这次事故是允许的（甚至是希望的文档），所以先把注释剥掉再看调用点。 */
  const indexCode = indexSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  check(
    "v0.6.0 事故回归：lib/index.js 的代码里不再出现全局 ctx.tools.guard（全局单调 guard 不许回来）",
    !/tools\s*\.\s*guard\s*\(/.test(indexCode) && !/\bguards?\s*\.\s*append\s*\(/.test(indexCode),
    `matches=${(indexCode.match(/tools\s*\.\s*guard\s*\(/g) ?? []).length}（注释里提到 ${(indexSource.match(/tools\s*\.\s*guard/g) ?? []).length} 次）`,
  );
}

/* v1-slim：设置页 / 文件层改动靠 loader/volatile-update 一条钩子同步（自动评审删掉后
   不再需要配置指纹钩子，也不许残留 tools/result 与 agent/turn-stopping 监听）。 */
{
  const syncListeners = new Map();
  const syncCase = makeCtx({ listeners: syncListeners });
  mod.apply(syncCase, mkConfig({ onDemand: true }));
  const volatileHooks = (syncListeners.get("loader/volatile-update") ?? []).length;
  const resultHooks = (syncListeners.get("tools/result") ?? []).length;
  const stoppingHooks = (syncListeners.get("agent/turn-stopping") ?? []).length;
  check(
    "v1-slim：apply 只挂 loader/volatile-update 一条钩子（自动评审的 tools/result 与 agent/turn-stopping 不再挂）",
    volatileHooks >= 1 && resultHooks === 0 && stoppingHooks === 0,
    `volatile=${volatileHooks} tools/result=${resultHooks} agent/turn-stopping=${stoppingHooks}`,
  );

  const stampA = cfgMod.loadConfig({}).__configStamp;
  const stampB = cfgMod.loadConfig({ timeoutMinutes: 9 }).__configStamp;
  check(
    "v0.5.8：loadConfig 带文件层指纹 __configStamp（含生效路径；设置页 patch 不影响它，只有文件层变了才变）",
    typeof stampA === "string" && stampA.length > 0 && stampA.includes(String(cfgMod.loadConfig({}).__configPath)) && stampA === stampB,
    `${String(stampA).slice(0, 90)} / 相等=${stampA === stampB}`,
  );
  /* 轻量指纹（只 stat）必须与完整读取的指纹逐字相等，否则「配置文件变没变」的判定会永远失效 ——
     这条断言就是防两处实现漂移的。 */
  const cheapStamp = cfgMod.configFileStamp();
  check(
    "v0.5.8：configFileStamp()（只 stat 的轻量指纹）与 loadConfig().__configStamp 完全一致",
    typeof cheapStamp === "string" && cheapStamp !== "" && cheapStamp === stampA,
    `cheap=${String(cheapStamp).slice(0, 60)} full=${String(stampA).slice(0, 60)} 相等=${cheapStamp === stampA}`,
  );
}

/* v0.5.8 三层优先级修（真机决定性实验的回归）：Host 把 schema 实例化后，用户没动过的字段
   也带着 schema 默认值（true / 3 / "off" / 15 …），旧实现只跳过「空值」⇒ 布尔/数字/枚举
   的默认值恒被当成设置页覆盖项，把 config.json（第二层）整个遮住。真机上表现为
   config.json 写 timeoutMinutes:7 → 运行时仍按 15（schema 默认值把它遮住了）。
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
      "v0.5.8：设置页真改过的字段仍然覆盖文件层（timeoutMinutes=20 不是默认值，必须留下）",
      cfgMod.schemaOverrides(mkConfig({ timeoutMinutes: 20 }))?.timeoutMinutes === 20,
      `overrides=${JSON.stringify(cfgMod.schemaOverrides(mkConfig({ timeoutMinutes: 20 })))}`,
    );
    /* 带 BOM 写：记事本 / PowerShell 另存为 UTF-8 会加 BOM，旧实现直接 parse 失败、
       整份配置被当坏文件回落到出厂默认（用户以为配置生效了）。 */
    writeFileSync(tmpConfig, `\uFEFF${JSON.stringify({ timeoutMinutes: 7, verbose: true })}`, "utf8");
    process.env.DSH_OPEN_CODE_REVIEW_CONFIG = tmpConfig;
    const merged = cfgMod.loadConfig(cfgMod.schemaOverrides(mkConfig({})));
    check(
      "v0.5.8：config.json 的 timeoutMinutes=7 / verbose=true 真的生效（设置页没改过这两项，不再被 schema 默认值遮住）",
      merged.timeoutMinutes === 7 && merged.verbose === true && !merged.__configError,
      `timeoutMinutes=${merged.timeoutMinutes} verbose=${merged.verbose} error=${String(merged.__configError)}`,
    );
    check(
      "v0.5.8：配置文件带 UTF-8 BOM（记事本/PowerShell 另存）不再被当成坏文件",
      cfgMod.loadConfig({}).timeoutMinutes === 7 && !cfgMod.loadConfig({}).__configError,
      `timeoutMinutes=${cfgMod.loadConfig({}).timeoutMinutes} error=${String(cfgMod.loadConfig({}).__configError)}`,
    );
    const withSetting = cfgMod.loadConfig(cfgMod.schemaOverrides(mkConfig({ timeoutMinutes: 20 })));
    check(
      "v0.5.8：设置页真改过的项仍然优先（timeoutMinutes=20 压过文件层的 7），同一份文件的其它键照常生效",
      withSetting.timeoutMinutes === 20 && withSetting.verbose === true,
      `timeoutMinutes=${withSetting.timeoutMinutes} verbose=${withSetting.verbose}`,
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
  const norm = cfgMod.normalizeConfig({ ...cfgMod.DEFAULTS, llm: llmInput });
  check(
    "v0.5.8：normalizeConfig 不就地改调用方传入的嵌套块（llmInput 保持原样），但结果照常收敛",
    llmInput.protocol === " OpenAI " &&
      norm.llm !== llmInput &&
      norm.llm.protocol === "openai",
    `输入 protocol=${JSON.stringify(llmInput.protocol)} 结果 protocol=${norm.llm.protocol} 同一引用=${norm.llm === llmInput}`,
  );

  const effortTrim = cfgMod.normalizeConfig({ ...cfgMod.DEFAULTS, llm: { ...cfgMod.DEFAULTS.llm, effort: "  HIGH  " } }).llm.effort;
  const effortBogus = cfgMod.normalizeConfig({ ...cfgMod.DEFAULTS, llm: { ...cfgMod.DEFAULTS.llm, effort: 42 } }).llm.effort;
  const effortLong = cfgMod.normalizeConfig({ ...cfgMod.DEFAULTS, llm: { ...cfgMod.DEFAULTS.llm, effort: "x".repeat(80) } }).llm.effort;
  check(
    "v0.11.1：llm.effort 只 trim + 截断 64（不做白名单：合法 id 由模型自己声明，非法值交给 DSH 拒绝）",
    cfgMod.DEFAULTS.llm.effort === "" && effortTrim === "HIGH" && effortBogus === "" && effortLong.length === 64,
    `默认=${JSON.stringify(cfgMod.DEFAULTS.llm.effort)} trim=${JSON.stringify(effortTrim)} 数字=${JSON.stringify(effortBogus)} 长度=${effortLong.length}`,
  );

  const llmBefore = JSON.stringify(cfgMod.DEFAULTS.llm);
  const shallow = cfgMod.normalizeConfig({ ...cfgMod.DEFAULTS }); // 浅拷贝 DEFAULTS：嵌套块与 DEFAULTS 同一个引用
  check(
    "v0.5.8：浅拷贝 DEFAULTS 进去也不会把出厂默认的嵌套块就地写掉（normalizeConfig 换了新对象）",
    JSON.stringify(cfgMod.DEFAULTS.llm) === llmBefore && shallow.llm !== cfgMod.DEFAULTS.llm,
    `llm 未变=${JSON.stringify(cfgMod.DEFAULTS.llm) === llmBefore} 新对象=${shallow.llm !== cfgMod.DEFAULTS.llm}`,
  );

  const engineCases = [
    ["OCR", "ocr"],
    [" Delegate ", "delegate"],
    /* v1.0：auto 不再是合法档位 —— 与其它非法值一样回落默认（ocr）。 */
    ["auto", cfgMod.DEFAULTS.engine],
    ["nope", cfgMod.DEFAULTS.engine],
  ];
  const engineGot = engineCases.map(([input]) => cfgMod.normalizeConfig({ ...cfgMod.DEFAULTS, engine: input }).engine);
  check(
    "配置：engine 收敛（去空白小写；auto 已不再是合法档位）",
    engineCases.every(([, want], i) => engineGot[i] === want),
    engineCases.map(([input], i) => `${JSON.stringify(input)}→${engineGot[i]}`).join(" · "),
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

  /* 宿主的加载校验（dsh-skill/lib/index.js:480-489 validateDefinition）要求 name/description/source/
     provider/content 全是字符串；而 register() 只补 invocation 与 provider，**不补 source**（同文件
     :193-215）。缺它时注册成功、ocr_status 报 registered=true，模型一读却是红的：
     `加载技能 Error: loaded skill "ocr-on-demand-review" source must be a string`（2026-10-13 真机复现）。
     这里按宿主的校验面钉住插件自己必须给的那几个字段。 */
  check(
    "v0.11.2：skill 定义满足宿主加载校验（source 必须自己给——register() 只补 invocation/provider）",
    def?.source === "runtime" &&
      typeof def?.name === "string" &&
      typeof def?.description === "string" &&
      typeof def?.content === "string" &&
      def.content.length > 0,
    `source=${JSON.stringify(def?.source)} name=${typeof def?.name} description=${typeof def?.description} content=${typeof def?.content}`,
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

/* v0.7.0：爆炸半径预算（lib/hooks.js）。0.5.7~0.5.9 的教训是「钩子写错语义 / 挂错事件 /
   注册本身抛错，都可能把整个工具面拖下水」，所以从这一版起挂钩子只有一条路：armHook()
   —— 白名单 + try/catch + 记账，任何异常只是少一个功能，绝不冒泡到宿主。 */
{
  const hooksMod = await import(new URL("../lib/hooks.js", import.meta.url));
  hooksMod.resetHookStats();
  const hookCalls = [];
  const hookCtx = {
    on(event, handler) {
      hookCalls.push({ event, handler });
      return () => {};
    },
  };
  const unwatch = hooksMod.armHook(hookCtx, "loader/volatile-update", () => {});
  check(
    "v0.7.0：白名单内的事件挂得上，并返回可调用的卸载函数",
    hookCalls.length === 1 && hookCalls[0].event === "loader/volatile-update" && typeof unwatch === "function",
    `calls=${hookCalls.length}`,
  );
  const blockedOff = hooksMod.armHook(hookCtx, "tools/guard", () => {});
  check(
    "v0.7.0：白名单外的事件一律拒绝注册（挂错事件 = 静默失效或越权）",
    hookCalls.length === 1 && typeof blockedOff === "function" && hooksMod.hookStats().blocked.includes("tools/guard"),
    JSON.stringify(hooksMod.hookStats().blocked),
  );
  const throwingCtx = {
    on() {
      throw new Error("宿主拒绝了这次注册");
    },
  };
  let hookThrew = false;
  let throwingOff = null;
  try {
    throwingOff = hooksMod.armHook(throwingCtx, "tools/result", () => {});
  } catch {
    hookThrew = true;
  }
  check(
    "v0.7.0：注册抛错不冒泡（只是少一个功能），并记进 errors",
    hookThrew === false && typeof throwingOff === "function" && hooksMod.hookStats().errors.some((line) => line.includes("宿主拒绝了这次注册")),
    JSON.stringify(hooksMod.hookStats().errors),
  );
  const noOnOff = hooksMod.armHook({}, "tools/result", () => {});
  check(
    "v0.7.0：宿主没有 ctx.on 时也不抛，并记一笔（不谎报已挂）",
    typeof noOnOff === "function" && hooksMod.hookStats().errors.some((line) => line.includes("没有 ctx.on")),
    JSON.stringify(hooksMod.hookStats().errors),
  );

  /* v0.7.1：以下五条来自「拿 v0.7.0 的新模块去问 ocr」那一轮评审的发现。 */
  const whitelistReadonly = (() => {
    const before = hooksMod.HOOK_WHITELIST.length;
    let mutationThrew = false;
    try {
      hooksMod.HOOK_WHITELIST.push("tools/guard");
    } catch {
      mutationThrew = true;
    }
    return {
      frozen: Object.isFrozen(hooksMod.HOOK_WHITELIST),
      unchanged: hooksMod.HOOK_WHITELIST.length === before,
      mutationThrew,
      guardRejected: hooksMod.isWhitelistedHook("tools/guard") === false,
      resultAllowed: hooksMod.isWhitelistedHook("tools/result") === true,
    };
  })();
  check(
    "v0.7.1：白名单集合保持私有（导出的是冻结副本 + isWhitelistedHook 判定），导入方改不动",
    whitelistReadonly.frozen &&
      whitelistReadonly.unchanged &&
      whitelistReadonly.guardRejected &&
      whitelistReadonly.resultAllowed,
    JSON.stringify(whitelistReadonly),
  );

  hooksMod.resetHookStats();
  let hostOffCalls = 0;
  const reclaimCtx = {
    on() {
      return () => {
        hostOffCalls += 1;
      };
    },
  };
  const reclaimOff = hooksMod.armHook(reclaimCtx, "tools/result", () => {});
  const armedCounts = { ...hooksMod.hookStats().counts };
  reclaimOff();
  const afterOff = hooksMod.hookStats();
  reclaimOff(); // 第二次必须是空操作（卸载函数幂等）
  check(
    "v0.7.1：卸载函数回收自己那条账（不再虚高）、只调一次宿主 off、重复调用安全",
    armedCounts["tools/result"] === 1 &&
      afterOff.counts["tools/result"] === undefined &&
      !afterOff.registered.includes("tools/result") &&
      hostOffCalls === 1,
    JSON.stringify({ armedCounts, afterOff: afterOff.counts, hostOffCalls }),
  );

  hooksMod.resetHookStats();
  const notFunctionOff = hooksMod.armHook({ on: () => () => {} }, "tools/result", "不是函数");
  check(
    "v0.7.1：handler 不是函数时拒绝注册并记一笔（不谎报、不抛）",
    typeof notFunctionOff === "function" &&
      hooksMod.hookStats().errors.some((line) => line.includes("不是函数")) &&
      !hooksMod.hookStats().registered.includes("tools/result"),
    JSON.stringify(hooksMod.hookStats()),
  );

  const throwingNameOff = hooksMod.armHook(
    { on: () => () => {} },
    { toString() { throw new Error("事件名炸了"); } },
    () => {},
  );
  check(
    "v0.7.1：事件名 toString 抛错也不冒泡（String() 本身也在保护范围里），按拒绝处理",
    typeof throwingNameOff === "function" &&
      hooksMod.hookStats().blocked.some((line) => line.includes("无法解析")),
    JSON.stringify(hooksMod.hookStats().blocked),
  );

  hooksMod.resetHookStats();
  const hookLogs = [];
  hooksMod.setHookLogger((text) => hookLogs.push(String(text)));
  hooksMod.armHook({}, "tools/result", () => {});
  hooksMod.setHookLogger(null);
  check(
    "v0.7.1：挂载失败会进日志（用户不问也能知道少挂了一个钩子）",
    hookLogs.some((line) => line.includes("没有 ctx.on")),
    JSON.stringify(hookLogs),
  );

  hooksMod.resetHookStats();
  for (let i = 0; i < 60; i += 1) hooksMod.armHook({ on: () => () => {} }, "tools/guard", () => {});
  for (let i = 0; i < 60; i += 1) hooksMod.armHook({}, "tools/result", () => {});
  const cappedStats = hooksMod.hookStats();
  check(
    "v0.7.1：诊断账目有上限（blocked/errors 各不超过 50 条），不会长成第二个内存问题",
    cappedStats.blocked.length <= 50 && cappedStats.errors.length <= 50 && cappedStats.blocked.length > 0,
    `blocked=${cappedStats.blocked.length} errors=${cappedStats.errors.length}`,
  );
  hooksMod.resetHookStats();

  /* 源码级：lib/index.js 里所有宿主事件注册都必须经过 armHook（出现裸的 ctx.on( 就是回归）。 */
  const hookIndexSource = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  const hookIndexCode = hookIndexSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const bareOn = hookIndexCode.match(/(?<![\w.$])ctx\s*\.\s*on\s*\(/g) ?? [];
  const armCalls = hookIndexCode.match(/armHook\s*\(/g) ?? [];
  check(
    "v0.7.0：lib/index.js 里没有裸的 ctx.on( —— 事件钩子一律走 armHook 白名单",
    bareOn.length === 0 && armCalls.length >= 1,
    `ctx.on=${bareOn.length} armHook=${armCalls.length}`,
  );
}

/* v0.7.0：ocr_status 要能回答「你到底挂了哪些钩子、有没有挂失败」—— 事故当天最缺的就是这个。 */
{
  const hookStatusCtx = makeCtx({ listeners: new Map() });
  mod.apply(hookStatusCtx, mkConfig({}));
  const hookStatus = await tools.get("ocr_status").execute({ checkLlm: false }, exec);
  const hookSchema = tools.get("ocr_status")?.output?.schema?.properties?.hooks ?? {};
  check(
    "v0.7.0：ocr_status 报出事件钩子账目（registered/counts/errors/blocked 四件套，且能看到真实挂上的钩子）",
    Array.isArray(hookStatus.hooks?.registered) &&
      hookStatus.hooks.registered.includes("loader/volatile-update") &&
      typeof hookStatus.hooks.counts === "object" &&
      Number.isFinite(hookStatus.hooks.counts?.["loader/volatile-update"]) &&
      Array.isArray(hookStatus.hooks.errors) &&
      Array.isArray(hookStatus.hooks.blocked),
    JSON.stringify(hookStatus.hooks).slice(0, 240),
  );
  check(
    "v0.7.0：ocr_status 的 schema 声明了 hooks 并进 required",
    hookSchema.type === "object" &&
      (hookSchema.required ?? []).join(",") === "registered,counts,errors,blocked" &&
      (tools.get("ocr_status")?.output?.schema?.required ?? []).includes("hooks"),
    JSON.stringify(hookSchema).slice(0, 200),
  );
}

/* v0.9.0：按入口记账（D2）。CPO 评估的 P1-1 判定（按钮 0 点击 ⇒ 默认入口的价值假设不成立）
   需要一个可核对的数，而不是体感。这里用「必然失败的参数」驱动便宜路径
   （commit 不给 hash ⇒ OCR_INVALID_ARGS），所以断言与这台机器装没装 ocr 无关。 */
{
  mod.resetReviewEntryStats();
  const entryCtx = makeCtx({ listeners: new Map() });
  mod.apply(entryCtx, mkConfig({}));

  const noHash = { scope: "commit" };
  const toolOut = await tools.get("ocr_review").execute(noHash, {});
  const afterTool = mod.reviewEntryStats();
  check(
    "v0.9.0：模型工具那条路记在 tool 桶（started/ok/failed 与失败码都留痕）",
    toolOut.ok === false &&
      toolOut.code === "OCR_INVALID_ARGS" &&
      afterTool.byEntry.tool.started === 1 &&
      afterTool.byEntry.tool.failed === 1 &&
      afterTool.byEntry.tool.ok === 0 &&
      afterTool.byEntry.tool.lastCode === "OCR_INVALID_ARGS" &&
      afterTool.byEntry.command.started === 0 &&
      afterTool.byEntry.button.started === 0,
    JSON.stringify(afterTool.byEntry),
  );

  /* 命令与按钮本身不执行评审（它们只是往会话里注入一条指令），所以入口只能在**工具调用**上认领：
     命令处理器留一个待认领的入口，模型随后那次 ocr_review 把它领走。 */
  const entryAgent = {
    sent: [],
    followup(message) {
      this.sent.push(String(message?.content?.[0]?.text ?? ""));
    },
  };
  const commandDef = commands.get("ocr-review");
  commandDef.handler({ agent: entryAgent, rawInput: "" });
  await tools.get("ocr_review").execute(noHash, { agent: entryAgent });
  const afterCommand = mod.reviewEntryStats();
  check(
    "v0.9.0：手输 /ocr-review 后紧跟的那次 ocr_review 记在 command 桶（不糊进 tool）",
    afterCommand.byEntry.command.started === 1 &&
      afterCommand.byEntry.command.failed === 1 &&
      afterCommand.byEntry.command.lastCode === "OCR_INVALID_ARGS" &&
      afterCommand.byEntry.tool.started === 1,
    JSON.stringify(afterCommand.byEntry),
  );

  commandDef.handler({ agent: entryAgent, rawInput: "  重点看并发 --entry=button " });
  await tools.get("ocr_review").execute(noHash, { agent: entryAgent });
  const afterButton = mod.reviewEntryStats();
  const buttonText = String(entryAgent.sent.at(-1) ?? "");
  check(
    "v0.9.0：回合尾部按钮（--entry=button 标记）记在 button 桶，且标记不进模型提示词",
    afterButton.byEntry.button.started === 1 &&
      !buttonText.includes("--entry=button") &&
      buttonText.includes("重点看并发"),
    JSON.stringify({ byEntry: afterButton.byEntry, markerLeaked: buttonText.includes("--entry=button") }),
  );

  const entryStatus = await tools.get("ocr_status").execute({ checkLlm: false }, exec);
  const entryStatusText = String(
    tools.get("ocr_status")?.output?.render?.({ checkLlm: false }, entryStatus)?.[0]?.text ?? "",
  );
  const entrySchema = tools.get("ocr_status")?.output?.schema ?? {};
  const byEntrySchema = entrySchema.properties?.stats?.properties?.byEntry ?? {};
  check(
    "v0.9.0：ocr_status 报出按入口记账，状态文本里按钮 0 次会被点名（P1-1 要看的就是它）",
    entryStatus.stats?.byEntry?.button?.started === 1 &&
      entryStatus.stats.byEntry.tool.started === 1 &&
      Number.isFinite(entryStatus.stats.since) &&
      entryStatusText.includes("按入口记账（v0.9.0") &&
      entryStatusText.includes("button 1 次"),
    JSON.stringify({ stats: entryStatus.stats, line: entryStatusText.split("\n").find((l) => l.includes("按入口记账")) }),
  );
  check(
    "v0.9.0：stats 进 ocr_status 的 schema（since + 三个入口，各自五个计数）",
    (entrySchema.properties?.stats?.required ?? []).join(",") === "since,byEntry" &&
      (byEntrySchema.required ?? []).join(",") === "tool,command,button" &&
      (entrySchema.required ?? []).includes("stats") &&
      (byEntrySchema.properties?.tool?.required ?? []).join(",") === "started,ok,failed,lastAt,lastCode",
    JSON.stringify({ byEntryRequired: byEntrySchema.required, rootHasStats: (entrySchema.required ?? []).includes("stats") }),
  );

  /* 没有 skill 桶是**有意的**：模型自发调用与按 skill 说明调用在工具层是同一次调用。
     这条断言防的是「以后有人为了报表好看造一个猜出来的桶」；v1-slim 起 auto 桶随自动评审一起删了。 */
  check(
    "v0.9.0：只有三个可核对的口径（没有猜出来的 skill / auto 桶）",
    Object.keys(entryStatus.stats.byEntry).join(",") === "tool,command,button",
    Object.keys(entryStatus.stats.byEntry).join(","),
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
