/**
 * dsh-open-code-review 的配置层。
 *
 * 三个来源，后者覆盖前者：
 *  1) 本文件里的 DEFAULTS —— 出厂默认（默认值已指向本机实测可用的 CommandCode v4.1 端点）；
 *  2) 配置文件 —— 按 mtime+size 热读，改完下次调用即生效。路径解析顺序（第一个存在的胜出）：
 *     `env DSH_OPEN_CODE_REVIEW_CONFIG` → `<DSH_HOME>/dsh-open-code-review.json`（推荐，git 安装后升级不覆盖）
 *     → `<插件目录>/config.json`（兼容老用法）。
 *     用于设置页未覆盖的键：extraArgs、env、llm.apiKey（字面密钥）、autoEngine、maxTimeoutMinutes 等；
 *  3) 插件设置页 —— 本模块导出的 schemastery `Config`。DSH 会把 schema 里标了 `.volatile()`
 *     的节点投影成 profile 条目的设置表单（Host 侧通用配置表单），编辑后写进 profile 的
 *     patch YAML 并广播 `loader/volatile-update`，所以改完立即生效、无需重启。
 *     （真机核实：写入落在 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 的 `config:` 块里，
 *     是宿主持久层，不是会话内存。）
 *
 * 读取方式：apply(ctx, config) 收到的 config 里，标了 volatile 的字段是"引用"（有 .get()），
 * 必须用 schemaOverrides(config) 取活值；loadConfig() 再把三层合并成一份普通对象。
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 插件根目录（package.json 所在目录）。 */
export const PLUGIN_DIR = dirname(HERE);
/**
 * 插件目录里的配置文件。
 * 兼容老用法，但**不推荐**：从 GitHub 装（git 安装）时它落在 node_modules 里，
 * 升级会被覆盖，而且它在包的 `files` 名单里（跟着包一起分发）。
 * 推荐把覆盖项写进 `externalConfigPath()`。
 */
export const CONFIG_PATH = join(PLUGIN_DIR, "config.json");

/** DSH 家目录：优先 DSH_HOME 环境变量，其次 ~/.dsh。 */
export function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME.trim() : "";
  return fromEnv !== "" ? fromEnv : join(homedir(), ".dsh");
}

/**
 * `DSH_HOME` 下的推荐配置文件位置（**不含** env 覆盖）：回落用的 home 候选只能是这一个，
 * 否则 env 指向一个不存在的文件时，「home」也会跟着指向那个不存在的路径，回落直接跳到插件目录。
 */
export function homeConfigPath() {
  return join(dshHome(), "dsh-open-code-review.json");
}

/**
 * 当前推荐的覆盖文件位置：env 指定优先，否则 homeConfigPath()。
 * 用途是「告诉用户该往哪儿写」（ocr_status 的 notes / installHint），
 * **回落解析不要用它** —— 那一层要用 homeConfigPath()。
 */
export function externalConfigPath() {
  const fromEnv = envConfigPath();
  return fromEnv !== "" ? fromEnv : homeConfigPath();
}

/** 本机实测可用的默认 LLM 端点（CommandCode 的 OpenAI 兼容路由 + DeepSeek v4.1）。 */
export const DEFAULT_LLM_BASE_URL = "https://api.commandcode.ai/provider/v1";
export const DEFAULT_LLM_PROTOCOL = "openai";
/**
 * dsh 路由的默认模型名：留空 = 跟随 DSH 的默认模型（agentDefaultModel.currentSelection()）——
 * 与官方插件同一来源，所以设置页可以什么都不填，模型跟着 DSH 的设置走。
 */
export const DEFAULT_LLM_MODEL = "";
/** 默认从 DSH 凭据库里解析的引用名（设置页里是"凭据引用"选择器）。 */
export const DEFAULT_LLM_KEY_REF = "COMMANDCODE_API_KEY";
/**
 * 默认 LLM 路由模式：
 *  - dsh = ocr 走插件的本机 LLM 桥（只监听 127.0.0.1 的随机端口），模型 / provider / 密钥 /
 *    账号轮换 / 配额全由 DSH 决定，插件配置里不再需要地址与密钥；
 *  - endpoint = 老行为：直连下面的 baseUrl，密钥按 apiKeyRef 解析。
 */
export const DEFAULT_LLM_MODE = "dsh";
/** dsh 模式下转发到的 DSH provider id（设置页选模型时写入；留空桥会拒绝转发）。 */
export const DEFAULT_LLM_PROVIDER = "";
/** 独立评审 agent 默认关闭（老行为：评审走 ocr/delegate）。 */
export const DEFAULT_REVIEWER_AGENT = "off";
/** 起子 agent 用的 provider 名（DSH 内置的是 spawn）。 */
export const DEFAULT_REVIEWER_PROVIDER = "spawn";
/** 一次「评审 → 修复 → 复审」往返最多几轮。 */
export const DEFAULT_REVIEWER_ROUNDS = 3;
/* 两者都留空时，桥的转发目标 = DSH 默认模型（provider + model 都从 DSH 读）。 */

export const DEFAULTS = {
  /** 总开关：关闭后不再注册 ocr_review / ocr_status / /ocr-review，也不做自动评审。 */
  enabled: true,

  /** ocr 可执行文件绝对路径；留空 = 自动探测（真实 exe 优先，其次 ocr shim）。 */
  ocrPath: "",
  /** 额外候选路径，按顺序在 ocrPath 之后尝试。 */
  ocrCandidates: [],

  /** 默认引擎：auto=先跑 OCR 的 LLM 流水线，LLM 未配置时自动降级 delegate；ocr=只跑流水线；delegate=只产出审查规格。 */
  engine: "auto",
  /** 自动评审用的引擎；留空表示跟随 engine。 */
  autoEngine: "",
  /** ocr --audience：agent(仅摘要) | human。 */
  audience: "agent",
  /** 单次评审超时（分钟），传给 ocr --timeout；同时作为插件侧硬超时。 */
  timeoutMinutes: 15,
  /** timeoutMinutes 的上限保护。 */
  maxTimeoutMinutes: 60,
  /** 追加给 ocr 的原始参数。 */
  extraArgs: [],
  /** 追加/覆盖 ocr 子进程环境变量，例如 {"OCR_LLM_TOKEN":"sk-xxx"}。值为空串/null 表示删除该变量。 */
  env: {},
  /**
   * LLM 路由。mode=dsh 时 ocr 子进程只会拿到本机桥的 URL 与随机 token（模型与密钥都不落插件配置）；
   * mode=endpoint 时才看 baseUrl/protocol/apiKeyRef（设置页可覆盖），apiKey 是"字面密钥"
   * （设置页不写它，因为密钥走凭据 seam），留空则用 apiKeyRef 解析。
   */
  llm: {
    mode: DEFAULT_LLM_MODE,
    provider: DEFAULT_LLM_PROVIDER,
    baseUrl: DEFAULT_LLM_BASE_URL,
    protocol: DEFAULT_LLM_PROTOCOL,
    model: DEFAULT_LLM_MODEL,
    apiKeyRef: DEFAULT_LLM_KEY_REF,
    apiKey: "",
  },

  /**
   * 独立评审 agent（opt-in）：agent=off 时评审走 ocr/delegate（老行为）；
   * agent=spawn 时每轮起一个只读子 agent（自己的会话/人格/模型）出结构化 findings，
   * 由插件回传编码 agent 逐条修复/说明，再带上一轮 findings 复审。
   * provider/model 留空 = 默认；persona 留空 = lib/reviewer.js 的内置人格。
   */
  reviewer: {
    agent: DEFAULT_REVIEWER_AGENT,
    provider: DEFAULT_REVIEWER_PROVIDER,
    model: "",
    rounds: DEFAULT_REVIEWER_ROUNDS,
    persona: "",
  },

  /**
   * 自动评审（v0.5.0 起默认 off）：off=不自动跑，改成按需（回合尾部按钮 + 按需 skill）；
   * adaptive=模型仍在跑就 inject，空闲就 followup；inject=只注入上下文；followup=直接开新回合。
   */
  auto: "off",
  /**
   * 按需评审（v0.5.0 起的默认工作方式）：在每条已完成回合的尾部提供「启动代码审核」按钮，
   * 并把 runtime skill `ocr-on-demand-review` 注册给模型 —— 用户说「验证/评审」或模型自己
   * 判断一批改动需要验证时，才调用 ocr_review。关掉它只剩模型工具与 /ocr-review 命令（零自动触发）。
   */
  onDemand: true,
  /** 自动评审的范围。 */
  autoScope: "workspace",
  /** 自动评审跳过子代理会话（subagent / delegationDepth>0）。 */
  autoSkipSubagents: true,
  /** 每个会话最多自动评审多少次（防止改—评—改死循环）。 */
  autoMaxPerSession: 3,
  /** 可审文件数低于该值时跳过自动评审。 */
  autoMinReviewableFiles: 1,
  /** 两次自动评审之间的最小间隔（毫秒）。 */
  autoMinIntervalMs: 60000,
  /** 自动委派评审时是否带上 unified diff。 */
  autoIncludeDiff: true,
  /**
   * 评审先于测试（opt-in，v0.5.7 起）：off=不管；remind=允许测试跑，但测试结果到了以后
   * 提醒模型自己去补一次评审（插件不替你跑）；gate=挡住测试命令，把「先跑 ocr_review 再跑测试」
   * 的拒绝理由交回给模型（评审工具本身不受影响）。
   * 机制：优先用宿主认可的同步闸门 `ctx.tools.guard()`，没有这个 API 的老宿主回落到
   * `tools/pre-execute` waterfall（返回 `{kind:"deny",reason}`）——`ocr_status.preTest.mechanism`
   * 会显示实际走的是哪条。
   * 判定依据是「本次改动是否已被一次成功的 ocr_review 覆盖」：任何写工具成功后立即作废，
   * 失败或 `preview` 的评审不算数。
   */
  preTest: "off",

  /** delegate 模式一次性带出的 diff 上限（字符数）。 */
  includeDiffMaxBytes: 120000,
  /** 文本渲染时最多列出的问题条数（完整数据仍在 rawJson / issues）。 */
  maxIssuesInText: 40,
  /** 评审进度：把每次评审登记成 background job（Jobs 面板的实时进度/输出 + 会话内进度行）。 */
  progress: true,
  /** 打印调试日志。 */
  verbose: false,
};

const cache = {
  path: "",
  source: "none",
  mtimeMs: -1,
  ctimeMs: -1,
  size: -1,
  file: {},
  error: null,
  present: false,
  envPath: "",
  envMissing: false,
};

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * env 指定的配置文件路径（`DSH_OPEN_CODE_REVIEW_CONFIG`）；没设置或空白时返回 ""。
 * 解析只留这一份：`externalConfigPath()` 与 `resolveConfigFile()` 共用（OCR 真机扫描发现重复实现）。
 */
export function envConfigPath() {
  return typeof process.env.DSH_OPEN_CODE_REVIEW_CONFIG === "string" ? process.env.DSH_OPEN_CODE_REVIEW_CONFIG.trim() : "";
}

/** 配置来源的一句话说明（statusText / notes / 工具备注共用同一套说法）。 */
export function configSourceText(source) {
  if (source === "env") return "DSH_OPEN_CODE_REVIEW_CONFIG 指定的文件";
  if (source === "home") return "推荐位置（<DSH_HOME>/dsh-open-code-review.json）";
  if (source === "plugin") return "插件目录里的 config.json";
  return "没有配置文件（用出厂默认 + 设置页）";
}

/**
 * 解析配置文件路径：env 指定 > `<DSH_HOME>/dsh-open-code-review.json` > `<插件目录>/config.json`。
 * 第一个**存在**的胜出（不做多层叠加，避免「改了这个、生效的却是另一个」）。
 * env 指到一个不存在的路径**不再终止解析**（老行为：用户以为配置生效了，其实一路退回出厂默认，
 * 而且连警告都没有）—— 现在继续回落 home → plugin，并把 envMissing 报出去。
 * @returns {{path: string, source: "env"|"home"|"plugin"|"none", present: boolean, envPath: string, envMissing: boolean}}
 */
export function resolveConfigFile() {
  const fromEnv = envConfigPath();
  if (fromEnv !== "" && isFile(fromEnv)) {
    return { path: fromEnv, source: "env", present: true, envPath: fromEnv, envMissing: false };
  }
  const envMissing = fromEnv !== "";
  const home = homeConfigPath();
  if (isFile(home)) return { path: home, source: "home", present: true, envPath: fromEnv, envMissing };
  if (isFile(CONFIG_PATH)) return { path: CONFIG_PATH, source: "plugin", present: true, envPath: fromEnv, envMissing };
  // 都不存在：把推荐位置报出去（ocr_status 会照实说明「当前按出厂默认 + 设置页运行」）。
  return { path: home, source: "none", present: false, envPath: fromEnv, envMissing };
}

function readFileConfig() {
  const resolved = resolveConfigFile();
  if (resolved.path !== cache.path) {
    // 换了文件（改了 env、或外部文件刚出现/刚删掉）：缓存全部作废，重新读。
    cache.path = resolved.path;
    cache.source = resolved.source;
    cache.mtimeMs = -1;
    cache.ctimeMs = -1;
    cache.size = -1;
    cache.file = {};
    cache.error = null;
    cache.present = false;
  }
  cache.envPath = resolved.envPath;
  cache.envMissing = resolved.envMissing;
  let st = null;
  try {
    st = statSync(resolved.path);
  } catch {
    st = null;
  }
  if (!st) {
    cache.mtimeMs = -1;
    cache.ctimeMs = -1;
    cache.size = -1;
    cache.file = {};
    cache.error = null;
    cache.present = false;
    cache.source = resolved.source;
    return;
  }
  /* 缓存键 = mtime + size + ctime：只比 mtime/size 的话，「内容变了但大小没变、mtime 又被保持住」
     （脚本覆盖写 + 保持时间戳）不会重读（OCR 真机扫描发现）。 */
  const ctimeMs = typeof st.ctimeMs === "number" ? st.ctimeMs : -1;
  if (st.mtimeMs === cache.mtimeMs && st.size === cache.size && ctimeMs === cache.ctimeMs) {
    /* 内容没变：但「同一个文件经由不同来源被选中」是会变的（例如 DSH_OPEN_CODE_REVIEW_CONFIG
       正好指向 home 路径，之后又删掉了这个环境变量）—— 来源标记必须在短路前刷新，
       否则 __configSource / __configSourceHint 会一直报旧来源（OCR 扫描发现）。 */
    cache.source = resolved.source;
    cache.present = true;
    return;
  }
  cache.mtimeMs = st.mtimeMs;
  cache.ctimeMs = ctimeMs;
  cache.size = st.size;
  cache.present = true;
  cache.source = resolved.source;
  try {
    // 记事本 / PowerShell 另存为 UTF-8 时会带 BOM，JSON.parse 见到 \uFEFF 直接报
    // "Unexpected token" ⇒ 用户会以为配置生效了、其实整份文件被当成坏文件回落到出厂默认。
    const text = readFileSync(resolved.path, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("配置文件顶层必须是 JSON 对象");
    }
    cache.file = parsed;
    cache.error = null;
  } catch (err) {
    cache.file = {};
    cache.error = err instanceof Error ? err.message : String(err);
    // 这里只在 mtime/size/ctime 变化时才走到（上面的短路），所以等于「每次文件变化喊一次」。
    // 必须喊：静默回落到出厂默认，用户会以为自己的阈值/超时/环境变量已经生效。
    console.warn(`[dsh-open-code-review] ${resolved.path} 解析失败，本次按出厂默认运行：${cache.error}`);
  }
}

/** volatile 字段是"引用"（有 .get()），取出活值。 */
function readRef(value) {
  if (value && typeof value === "object" && typeof value.get === "function") {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

function isMeaningful(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

/** schema 字段名 → 生效配置里的目标路径（点号表示嵌套）。 */
const SCHEMA_KEY_MAP = {
  enabled: "enabled",
  engine: "engine",
  audience: "audience",
  autoReview: "auto",
  onDemand: "onDemand",
  autoScope: "autoScope",
  autoSkipSubagents: "autoSkipSubagents",
  autoMaxPerSession: "autoMaxPerSession",
  autoMinReviewableFiles: "autoMinReviewableFiles",
  autoMinIntervalMs: "autoMinIntervalMs",
  autoIncludeDiff: "autoIncludeDiff",
  preTest: "preTest",
  timeoutMinutes: "timeoutMinutes",
  progress: "progress",
  verbose: "verbose",
  ocrPath: "ocrPath",
  llmMode: "llm.mode",
  llmProvider: "llm.provider",
  llmBaseUrl: "llm.baseUrl",
  llmProtocol: "llm.protocol",
  llmModel: "llm.model",
  llmApiKeyRef: "llm.apiKeyRef",
  reviewerAgent: "reviewer.agent",
  reviewerProvider: "reviewer.provider",
  reviewerModel: "reviewer.model",
  reviewerRounds: "reviewer.rounds",
  reviewerPersona: "reviewer.persona",
};

/** 按点号路径取出厂默认值（"llm.mode" → DEFAULTS.llm.mode）。 */
function defaultAt(target) {
  let node = DEFAULTS;
  for (const part of target.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = node[part];
  }
  return node;
}

/**
 * 把 apply(ctx, config) 收到的（含 volatile 引用的）配置解成普通覆盖对象。
 * 空串视为"未设置"，会回落到 config.json / 出厂默认。
 *
 * v0.5.8：**取值恰好等于出厂默认的字段也不算覆盖**。
 * 原因：Host 把 schema 实例化后，没被用户改过的字段照样带着 schema 默认值（"true" /
 * 3 / "off" / 15 …），而布尔、数字、枚举的默认值本身就是"有意义"的值 ⇒ 这些字段会
 * 恒被当成设置页的覆盖项，把 config.json（第二层）整个遮住 —— 真机上表现为
 * 「config.json 写 preTest:"gate" / timeoutMinutes:7 完全不起作用」。
 * 代价（已知并写进文档）：用户若在设置页把某项显式改成出厂默认，而 config.json 里
 * 写了别的值，则以 config.json 为准 —— 因为这两件事在 schema 实例上无法区分。
 */
export function schemaOverrides(config) {
  if (!config || typeof config !== "object") return null;
  const out = { llm: {}, reviewer: {} };
  let any = false;
  for (const [schemaKey, target] of Object.entries(SCHEMA_KEY_MAP)) {
    const value = readRef(config[schemaKey]);
    if (!isMeaningful(value)) continue;
    if (value === defaultAt(target)) continue;
    any = true;
    const dot = target.indexOf(".");
    if (dot > 0) {
      const head = target.slice(0, dot);
      if (!out[head] || typeof out[head] !== "object") out[head] = {};
      out[head][target.slice(dot + 1)] = value;
    } else {
      out[target] = value;
    }
  }
  if (!any) return null;
  return out;
}

/** 布尔风格取值：配置文件是手写的，接受 true/false 与 "true"/"false"/"on"/"off"/"yes"/"no"/1/0。 */
function boolLike(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["true", "on", "yes", "1"].includes(v)) return true;
    if (["false", "off", "no", "0"].includes(v)) return false;
  }
  return fallback;
}

/**
 * 数值 / 数字字符串 → number，其它一律 NaN。
 * 手写 config.json 里 `"timeoutMinutes": "20"` 很常见，宽容度与上面的 boolLike 对齐
 * （空串与纯空白不算数字，避免 `Number("")===0` 把空值悄悄变成 0）。
 */
function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return Number.NaN;
}

/** 非负数值（毫秒/次数类）：非法或负数回落默认（-1 会让「最小间隔」判断恒成立）。 */
function countLike(value, fallback) {
  const n = toFiniteNumber(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/** 超时分钟数的硬上界（24h）：ocr 与插件侧都用它夹一层，避免「配了 999 分钟」。 */
export const MAX_TIMEOUT_MINUTES = 24 * 60;

/**
 * endpoint 模式的端点展示文本：地址仍等于出厂那个第三方默认值时点名提醒。
 * 场景：用户换了供应商、只改了 `apiKeyRef`，`baseUrl` 还是出厂值 → 新凭据会被发到旧地址。
 * 纯函数，便于 `test/smoke.mjs` 直接断言（不进子进程、不碰网络）。
 */
export function endpointDisplay(baseUrl) {
  const url = String(baseUrl ?? "").trim();
  if (!url) return "(未设置)";
  if (url === DEFAULTS.llm.baseUrl) {
    return `${url}（出厂默认地址，换供应商时记得同步改 llm.baseUrl，否则凭据会发到旧地址）`;
  }
  return url;
}

/**
 * 单次评审的插件侧硬超时（毫秒）。**与 `ocr --timeout` 同源**：
 * 显式给的分钟（工具参数 / 计划）优先，其次生效配置，最后被 maxTimeoutMinutes 夹住。
 * 使用点（Jobs 的 timeoutMs、评审 agent 的空闲上限、桥的上游超时）都走这里，
 * 否则会出现「ocr 收到 --timeout 60，插件却等 999 分钟才杀进程」这种错配。
 */
export function timeoutMsOf(config, minutes = null) {
  const max = Math.min(MAX_TIMEOUT_MINUTES, Math.max(1, countLike(config?.maxTimeoutMinutes, DEFAULTS.maxTimeoutMinutes)));
  const explicit = toFiniteNumber(minutes);
  const base = Number.isFinite(explicit) && explicit >= 1 ? explicit : countLike(config?.timeoutMinutes, DEFAULTS.timeoutMinutes);
  return Math.max(1, Math.min(base, max)) * 60000;
}

const AUTO_MODES = ["off", "adaptive", "inject", "followup"];
const ENGINE_MODES = ["auto", "ocr", "delegate"];
const AUDIENCE_MODES = ["agent", "human"];
const SCOPE_MODES = ["workspace", "range", "commit", "scan"];
const LLM_MODES = ["dsh", "endpoint"];
const PROTOCOL_MODES = ["openai", "anthropic"];
const REVIEWER_MODES = ["off", "spawn"];
const PRETEST_MODES = ["off", "remind", "gate"];

/** 只认真对象（数组 / null / 标量都当空对象）：三层配置的嵌套块共用。
 *  返回**浅拷贝**：normalizeConfig 会就地写 mode/protocol/agent 等字段，直接返回入参引用
 *  会把调用方的对象（包括 DEFAULTS 里的嵌套块）一起改掉（OCR 扫描发现）。 */
function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

/** 枚举取值：字符串（去空白、小写）命中白名单才用，否则回落默认。 */
function oneOf(value, allowed, fallback) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return allowed.includes(v) ? v : fallback;
}

/**
 * 区间取值（config.json 也能绕过设置页的 min/max，所以这里再夹一层）。
 * - 非数字 / **小于下界** → 回落默认：负数和小到没有意义的值（`autoMinIntervalMs: -1`、
 *   `timeoutMinutes: 0`）是写错，不是「要更小」，回落默认比夹成 0（= 无冷却、无超时）安全；
 * - 大于上界 → 夹到上界（`autoMaxPerSession: 99999` 这类明显想「尽量多」的值，夹住比回落更贴近意图）。
 * 下界为 0 的键上显式 `0` 仍然合法（例如 `autoMaxPerSession: 0` = 本会话不自动评审）。
 *
 * 命名带 `Range` 是为了与 `lib/review.js` 里的 `numIn(value, fallback, lo, hi)` 区分开 ——
 * 两个模块各有各的实现，但**参数顺序相反**，同名极易在重构时把参数传串（OCR 自审发现）。
 */
function numInRange(value, min, max, fallback) {
  const n = toFiniteNumber(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(max, n);
}

/** 字符串取值：非字符串回落默认，字符串去首尾空白。 */
function strOf(value, fallback) {
  return typeof value === "string" ? value.trim() : fallback;
}

/** 字符串数组（ocrCandidates/extraArgs 共用）：按「上一层优先」取第一个真数组，过滤空串。 */
function stringList(...sources) {
  for (const source of sources) {
    if (Array.isArray(source)) return source.filter((v) => typeof v === "string" && v.trim() !== "");
  }
  return [];
}

/**
 * 把合并后的配置收敛成插件真正能用的形状。
 * 设置页与手写 config.json 都可能给错类型，而使用点是 `cfg.enabled === false`、
 * `String(cfg.auto) === "off"` 这类严格判断：字符串 "false" 会让插件「看起来关了其实还开着」。
 *
 * 数值一律夹进设置页 schema 的同一组上下界（否则 config.json 能绕过 min/max，例如
 * `autoMaxPerSession: 99999`、`autoMinReviewableFiles: 0`）；枚举非法值回落默认。
 * **嵌套块（env/llm/reviewer）也在这里收敛** —— 必须先深合并再收敛，否则合并进来的
 * `reviewer:{"rounds":"3"}`、`llm:{"protocol":"OpenAI "}`、`llm:{"mode":"Endpoint"}` 会原样漏过去
 * （OCR 真机扫描发现：老实现先归一、后深合并）。
 */
export function normalizeConfig(merged) {
  const out = { ...merged };
  out.enabled = boolLike(out.enabled, DEFAULTS.enabled);
  out.verbose = boolLike(out.verbose, DEFAULTS.verbose);
  out.progress = boolLike(out.progress, DEFAULTS.progress);
  out.autoSkipSubagents = boolLike(out.autoSkipSubagents, DEFAULTS.autoSkipSubagents);
  out.autoIncludeDiff = boolLike(out.autoIncludeDiff, DEFAULTS.autoIncludeDiff);
  out.onDemand = boolLike(out.onDemand, DEFAULTS.onDemand);
  const auto = out.auto;
  /* `auto` 是四档枚举，但 config.json 里写成开关（true/"on"/1）也很常见：
     先按 boolLike 的宽容度认成 adaptive/off，再落回枚举白名单。 */
  const autoBool = typeof auto === "string" || typeof auto === "number" ? boolLike(auto, null) : null;
  if (auto === false || autoBool === false) out.auto = "off";
  else if (auto === true || autoBool === true) out.auto = "adaptive";
  else out.auto = oneOf(auto, AUTO_MODES, DEFAULTS.auto);
  out.engine = oneOf(out.engine, ENGINE_MODES, DEFAULTS.engine);
  out.audience = oneOf(out.audience, AUDIENCE_MODES, DEFAULTS.audience);
  out.autoScope = oneOf(out.autoScope, SCOPE_MODES, DEFAULTS.autoScope);
  out.preTest = oneOf(out.preTest, PRETEST_MODES, DEFAULTS.preTest);
  out.autoMaxPerSession = numInRange(out.autoMaxPerSession, 0, 50, DEFAULTS.autoMaxPerSession);
  out.autoMinReviewableFiles = numInRange(out.autoMinReviewableFiles, 1, 50, DEFAULTS.autoMinReviewableFiles);
  out.autoMinIntervalMs = numInRange(out.autoMinIntervalMs, 0, 3600000, DEFAULTS.autoMinIntervalMs);
  // 注意这里是 countLike，不要再加 `|| DEFAULTS.x`：那会把「显式配 0」（不带 diff / 不列问题）
  // 当成未设置，与同组其它计数项（0 合法）行为不一致。
  out.includeDiffMaxBytes = countLike(out.includeDiffMaxBytes, DEFAULTS.includeDiffMaxBytes);
  out.maxIssuesInText = countLike(out.maxIssuesInText, DEFAULTS.maxIssuesInText);
  // 超时：maxTimeoutMinutes 是 timeoutMinutes 的上限保护，必须在这里收敛 —— lib/index.js 有几处
  // 直接拿生效配置当插件侧硬超时（Jobs 的 timeoutMs / 评审 agent / 桥的上游超时），不收敛就会
  // 出现「ocr 收到 --timeout 60、插件 999 分钟才杀进程」的错配（OCR 真机扫描发现）。
  out.maxTimeoutMinutes = numInRange(out.maxTimeoutMinutes, 1, MAX_TIMEOUT_MINUTES, DEFAULTS.maxTimeoutMinutes);
  out.timeoutMinutes = numInRange(out.timeoutMinutes, 1, out.maxTimeoutMinutes, DEFAULTS.timeoutMinutes);
  out.ocrPath = strOf(out.ocrPath, DEFAULTS.ocrPath);
  out.env = plain(out.env);
  out.llm = plain(out.llm);
  out.llm.mode = oneOf(out.llm.mode, LLM_MODES, DEFAULTS.llm.mode);
  out.llm.protocol = oneOf(out.llm.protocol, PROTOCOL_MODES, DEFAULTS.llm.protocol);
  for (const key of ["provider", "baseUrl", "model", "apiKeyRef", "apiKey"]) {
    out.llm[key] = strOf(out.llm[key], DEFAULTS.llm[key]);
  }
  out.reviewer = plain(out.reviewer);
  out.reviewer.agent = oneOf(out.reviewer.agent, REVIEWER_MODES, DEFAULTS.reviewer.agent);
  out.reviewer.provider = strOf(out.reviewer.provider, DEFAULTS.reviewer.provider);
  out.reviewer.model = strOf(out.reviewer.model, DEFAULTS.reviewer.model);
  out.reviewer.persona = strOf(out.reviewer.persona, DEFAULTS.reviewer.persona);
  out.reviewer.rounds = numInRange(out.reviewer.rounds, 1, 10, DEFAULTS.reviewer.rounds);
  return out;
}

/**
 * 合并三层配置（出厂默认 < config.json < 设置页）：**先深合并、再归一**。
 * 深层键（env/llm/reviewer）按层叠加，patch 侧也带 `Array.isArray` 守卫（传数组不再是
 * 「展开成数字键对象」把配置污染掉）；`extraArgs`/`ocrCandidates` 取**上一层第一个真数组**
 * （`[]` 与 undefined 无法区分，所以空数组 = 显式清空，把下层的整段盖掉）。
 * 注意：`extraArgs`/`ocrCandidates`/`env` 不在设置页 schema（`SCHEMA_KEY_MAP`）里，
 * 生产路径上 patch 侧只会拿到 llm/reviewer/开关类字段，这三个键实际来自 config.json 或直调本函数。
 * 导出的目的是让 `test/smoke.mjs` 直接断言分层规则（loadConfig 只是它 + 目录/来源标记）。
 */
export function mergeLayers(file = {}, patch = {}) {
  const f = plain(file);
  const p = plain(patch);
  const merged = { ...DEFAULTS, ...f, ...p };
  merged.env = { ...(DEFAULTS.env ?? {}), ...plain(f.env), ...plain(p.env) };
  merged.llm = { ...DEFAULTS.llm, ...plain(f.llm), ...plain(p.llm) };
  merged.reviewer = { ...DEFAULTS.reviewer, ...plain(f.reviewer), ...plain(p.reviewer) };
  merged.ocrCandidates = stringList(p.ocrCandidates, f.ocrCandidates);
  merged.extraArgs = stringList(p.extraArgs, f.extraArgs);
  return normalizeConfig(merged);
}

/**
 * 文件层实际提供了值的键（点号路径，例如 `llm.baseUrl`、`env`、`timeoutMinutes`）。
 * 用途：设置页只能看见「用户有没有在表单里改过」，看不见文件层 —— `ocr_status.fileValues`
 * 把文件层的真相报出来，两边一对就知道某个值到底从哪来。
 */
export function fileValuePaths(file) {
  const out = [];
  if (!file || typeof file !== "object" || Array.isArray(file)) return out;
  for (const [key, value] of Object.entries(file)) {
    if (key.startsWith("_")) continue; // _readme / _comment 之类纯注释
    const def = DEFAULTS[key];
    const nested =
      def && typeof def === "object" && !Array.isArray(def) && value && typeof value === "object" && !Array.isArray(value);
    if (nested) {
      for (const sub of Object.keys(value)) out.push(`${key}.${sub}`);
    } else {
      out.push(key);
    }
  }
  return out.sort();
}

/** 读取生效配置（出厂默认 + 配置文件 + 设置页），并带上来源标记（__ 开头的键不参与合并）。 */
export function loadConfig(overrides = null) {
  readFileConfig();
  const file = cache.file && typeof cache.file === "object" ? cache.file : {};
  const patch = overrides && typeof overrides === "object" ? overrides : {};
  const merged = mergeLayers(file, patch);
  merged.__configPath = cache.path || CONFIG_PATH;
  merged.__configSource = cache.source;
  merged.__configSourceHint = cache.envMissing
    ? `DSH_OPEN_CODE_REVIEW_CONFIG 指向的 ${cache.envPath} 不存在，已回落到${configSourceText(cache.source)}`
    : configSourceText(cache.source);
  merged.__envConfigPath = cache.envPath || "";
  merged.__envConfigMissing = Boolean(cache.envMissing);
  merged.__fileKeys = fileValuePaths(file);
  /* 与 `PLUGIN_DIR` 同值；插件半侧直接 import 那个常量，这里保留是为了让诊断输出
     （ocr_status 的 pluginDir / 任何读 cfg 的地方）拿到同一份信息。 */
  merged.__pluginDir = PLUGIN_DIR;
  merged.__configPresent = cache.present;
  merged.__configError = cache.error;
  // 文件层「变没变」的指纹：值级热读（cfgNow() 每次重算）不需要它，但
  // 「装/卸监听器」的决定（auto / onDemand / preTest）必须在文件层改动后重新评估，
  // 调用方拿这个指纹去重，避免每次都重挂一遍监听器。
  merged.__configStamp = stampKey(cache);
  return merged;
}

/**
 * 指纹的唯一实现（loadConfig 与下面的 configFileStamp 共用，避免两处漂移）。
 * 形状变了要连带改 `configFileStamp`。
 */
function stampKey(entry) {
  return [
    entry.source,
    entry.path || CONFIG_PATH,
    entry.mtimeMs,
    entry.ctimeMs,
    entry.size,
    entry.error ? "error" : "",
    entry.envMissing ? "env-missing" : "",
  ].join("|");
}

/**
 * 轻量指纹：只做「定位 + stat」，不解析 JSON、不合并三层。
 * 给每条 `tools/result` 这类高频判断用 —— 先比对指纹，真的变了才去 loadConfig()。
 * 内容没变时必须与 `loadConfig({}).__configStamp` 完全相等（错误/回落标记沿用上一次读取的结果），
 * 否则调用方的去重会永远失效。测试里有一条断言专门钉这个相等关系。
 */
export function configFileStamp() {
  try {
    const resolved = resolveConfigFile();
    if (!resolved.present) {
      return stampKey({
        source: resolved.source,
        path: resolved.path || CONFIG_PATH,
        mtimeMs: -1,
        ctimeMs: -1,
        size: -1,
        error: false,
        envMissing: resolved.envMissing,
      });
    }
    const st = statSync(resolved.path);
    const ctimeMs = typeof st.ctimeMs === "number" ? st.ctimeMs : -1;
    const unchanged = cache.path === resolved.path && cache.mtimeMs === st.mtimeMs && cache.size === st.size && cache.ctimeMs === ctimeMs;
    return stampKey({
      source: resolved.source,
      path: resolved.path,
      mtimeMs: st.mtimeMs,
      ctimeMs,
      size: st.size,
      // 文件没变就沿用上一次读取留下的解析错误标记，保证与 __configStamp 相等
      error: unchanged ? cache.error : null,
      envMissing: resolved.envMissing,
    });
  } catch {
    return "";
  }
}

/* ----------------------------------------------------------- 设置页（schema） */

let z = null;
try {
  const mod = await import("@deepseek-ai/schemastery");
  z = mod?.default ?? mod ?? null;
} catch {
  /* 没有 schemastery 也能跑：只是没有设置页（工具/命令/自动评审照旧） */
}

/* buildSchema 在模块顶层求值：只要 schemastery 的版本缺了 .volatile() / .role() 之类的 API，
   就会抛异常并把整个插件的 import 一起带崩 —— 与「没有 schemastery 也能跑」的设计意图不符
   （OCR 扫描发现）。所以先建 schema，建不出来就当天没有设置页（config.json 照常可用）。 */
let builtSchema = null;
let schemaError = "";
if (z && typeof z.object === "function") {
  try {
    builtSchema = buildSchema(z);
  } catch (err) {
    builtSchema = null;
    schemaError = err instanceof Error ? err.message : String(err);
    console.warn(`[dsh-open-code-review] 生成设置页 schema 失败，本次按「没有设置页」运行（config.json 照常可用）：${schemaError}`);
  }
}

/** schemastery 是否可用（不可用时 Host 侧看不到本插件的设置表单）。 */
export const SCHEMA_AVAILABLE = Boolean(builtSchema);

/**
 * schema 生成失败的原因（空串 = 没失败）。
 * `SCHEMA_AVAILABLE` 为 false 有两种完全不同的原因：**没装 schemastery**（正常，只用 config.json）
 * 与**装了但生成失败**（多半是版本不兼容，值得报给插件作者）。状态文本必须分得清
 * （OCR 自审发现：只报布尔会把后者说成「缺少 @deepseek-ai/schemastery」，误导用户去装一个已经装了的包）。
 */
export const SCHEMA_ERROR = schemaError;

function buildSchema(z) {
  const mark = (field) => field.volatile();
  return z.object({
    enabled: mark(
      z
        .boolean()
        .default(true)
        .description("总开关：关闭后停掉自动评审，且 ocr_review 与 /ocr-review 会拒绝执行（ocr_status 仍可用于诊断）。"),
    ),
    engine: mark(
      z
        .union(["auto", "ocr", "delegate"])
        .default("auto")
        .description("默认引擎：auto=先跑 OCR 流水线、没配 LLM 时自动降级 delegate；ocr=只跑 OCR 流水线；delegate=不调 LLM，只产出规则+diff 规格。"),
    ),
    audience: mark(z.union(["agent", "human"]).default("agent").description("ocr --audience：agent=只给摘要，human=带进度输出。")),
    autoReview: mark(
      z
        .union(["adaptive", "inject", "followup", "off"])
        .default(DEFAULTS.auto)
        .description(
          "自动评审（回合结束、且有文件写入时才可能触发）：off=关闭（v0.5.0 起默认，改成按需——回合尾部按钮 + 按需 skill）；adaptive=模型在跑就注入、空闲就开新回合；inject/followup=只走其中一种。",
        ),
    ),
    onDemand: mark(
      z
        .boolean()
        .default(DEFAULTS.onDemand)
        .description(
          "按需评审（默认开）：每条已完成回合的尾部显示「启动代码审核」按钮，并注册 runtime skill `ocr-on-demand-review`，让模型在用户要求验证/评审时才调 ocr_review。关掉后只剩模型工具与 /ocr-review 命令。",
        ),
    ),
    autoScope: mark(
      z.union(["workspace", "range", "commit", "scan"]).default("workspace").description("自动评审的范围（workspace=未提交改动）。"),
    ),
    autoMaxPerSession: mark(z.number().min(0).max(50).default(DEFAULTS.autoMaxPerSession).description("每个会话最多自动评审几次（防改—评—改死循环）。")),
    autoMinReviewableFiles: mark(z.number().min(1).max(50).default(DEFAULTS.autoMinReviewableFiles).description("可审文件数低于该值时跳过自动评审。")),
    autoMinIntervalMs: mark(z.number().min(0).max(3600000).default(DEFAULTS.autoMinIntervalMs).description("两次自动评审之间的最小间隔（毫秒）。")),
    autoSkipSubagents: mark(z.boolean().default(DEFAULTS.autoSkipSubagents).description("跳过子代理会话的自动评审。")),
    autoIncludeDiff: mark(z.boolean().default(DEFAULTS.autoIncludeDiff).description("自动评审降级到 delegate 时，是否把 unified diff 一并放进规格。")),
    preTest: mark(
      z
        .union(["off", "remind", "gate"])
        .default(DEFAULTS.preTest)
        .description(
          "评审先于测试：off=不管；remind=允许测试跑，测试结果到了以后发一条提醒让模型自己去补评审（插件不替你跑评审）；gate=在工具调用前挡住测试命令，把「先跑 ocr_review」的拒绝理由交回给模型（ocr_review 自身不受影响）。判定依据是本次改动有没有被一次成功的 ocr_review 覆盖，写文件成功后立即作废（失败或 preview 的评审不算数）。",
        ),
    ),
    timeoutMinutes: mark(z.number().min(1).max(DEFAULTS.maxTimeoutMinutes).default(DEFAULTS.timeoutMinutes).description("单次评审超时（分钟），传给 ocr --timeout；上限由 maxTimeoutMinutes（第 1 层）决定（本表的上限固定为出厂值，要更大的值请直接写 config.json）。")),
    progress: mark(z.boolean().default(true).description("评审进度：把每次评审登记成后台任务，在 Jobs 面板与会话里显示实时进度与输出（关掉后评审照跑，只是不可见）。")),
    llmMode: mark(
      z
        .union(["dsh", "endpoint"])
        .default(DEFAULT_LLM_MODE)
        .description(
          "LLM 路由：dsh=ocr 走插件的本机桥（127.0.0.1）→ DSH 的 ctx.llm.stream，模型/provider/密钥/配额全由 DSH 决定；endpoint=直连下面的静态端点（老行为）。",
        ),
    ),
    llmProvider: mark(
      z
        .string()
        .default(DEFAULT_LLM_PROVIDER)
        .description("dsh 模式下要转发到的 DSH provider id（在设置页选模型时自动写入，例如 commandcode）；留空 = 跟随 DSH 默认模型的 provider。"),
    ),
    llmBaseUrl: mark(
      z
        .string()
        .default(DEFAULT_LLM_BASE_URL)
        .description("LLM 端点。默认 CommandCode 的 OpenAI 兼容路由（实测可用）；Anthropic 协议端点形如 https://api.deepseek.com/anthropic。"),
    ),
    llmProtocol: mark(
      z.union(["openai", "anthropic"]).default(DEFAULT_LLM_PROTOCOL).description("端点协议，映射到 OCR_LLM_PROTOCOL。CommandCode 的 DeepSeek v4.1 只能用 openai。"),
    ),
    llmModel: mark(
      z
        .string()
        .default(DEFAULT_LLM_MODEL)
        .description("模型名，映射到 OCR_LLM_MODEL（例如 deepseek/deepseek-v4.1-flash）；留空 = 跟随 DSH 默认模型。"),
    ),
    llmApiKeyRef: mark(
      z
        .string()
        .role("credential-ref")
        .default(DEFAULT_LLM_KEY_REF)
        .description("API Key 的凭据引用（从 DSH 凭据库/环境变量解析），映射到 OCR_LLM_TOKEN；留空则回落到 config.json 的 llm.apiKey。"),
    ),
    reviewerAgent: mark(
      z
        .union(["off", "spawn"])
        .default(DEFAULT_REVIEWER_AGENT)
        .description("独立评审 agent：off=不启用（评审走 ocr/delegate）；spawn=每次评审起一个只读子 agent（独立上下文/人格），产出结构化 findings 后由插件回传编码 agent 往返修复。"),
    ),
    reviewerProvider: mark(
      z.string().default(DEFAULT_REVIEWER_PROVIDER).description("起评审子 agent 用的 provider 名（DSH 内置的 spawn）；名字不存在时回落静态引擎并记诊断。"),
    ),
    reviewerModel: mark(
      z.string().default("").description("评审子 agent 用的模型（provider 下的模型名）；留空 = 跟随 DSH 默认模型。"),
    ),
    reviewerRounds: mark(
      z.number().min(1).max(10).default(DEFAULT_REVIEWER_ROUNDS).description("一次往返最多几轮（每轮 = 一个新子 agent 会话）；到上限后交付当前结论。"),
    ),
    reviewerPersona: mark(
      z.string().default("").description("评审子 agent 的人格/评审纪律；留空 = 插件内置人格。"),
    ),
    ocrPath: mark(z.string().default("").description("ocr 可执行文件绝对路径；留空 = 自动探测（Volta 安装的真实 exe 优先）。")),
    verbose: mark(z.boolean().default(false).description("在 DSH 日志里打印调试信息。")),
  });
}

/** 导出给 Host 的插件配置 schema；Host 把 volatile 节点投影成设置表单。 */
export const Config = builtSchema ?? undefined;
