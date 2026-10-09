/**
 * dsh-open-code-review 的配置层。
 *
 * 三个来源，后者覆盖前者：
 *  1) 本文件里的 DEFAULTS —— 出厂默认（默认值已指向本机实测可用的 CommandCode v4.1 端点）；
 *  2) <插件目录>/config.json —— 可选文件层，按 mtime+size 热读，改完下次调用即生效。
 *     用于设置页未覆盖的键：extraArgs、env、llm.apiKey（字面密钥）、autoEngine、maxTimeoutMinutes 等；
 *  3) 插件设置页 —— 本模块导出的 schemastery `Config`。DSH 会把 schema 里标了 `.volatile()`
 *     的节点投影成 profile 条目的设置表单（Host 侧通用配置表单），编辑后写进 profile 的
 *     patch YAML 并广播 `loader/volatile-update`，所以改完立即生效、无需重启。
 *
 * 读取方式：apply(ctx, config) 收到的 config 里，标了 volatile 的字段是"引用"（有 .get()），
 * 必须用 schemaOverrides(config) 取活值；loadConfig() 再把三层合并成一份普通对象。
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 插件根目录（package.json 所在目录）。 */
export const PLUGIN_DIR = dirname(HERE);
/** 可选配置文件路径：<插件目录>/config.json */
export const CONFIG_PATH = join(PLUGIN_DIR, "config.json");

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

  /** 自动评审：off=关闭；adaptive=模型仍在跑就 inject，空闲就 followup；inject=只注入上下文；followup=直接开新回合。 */
  auto: "adaptive",
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

  /** delegate 模式一次性带出的 diff 上限（字符数）。 */
  includeDiffMaxBytes: 120000,
  /** 文本渲染时最多列出的问题条数（完整数据仍在 rawJson / issues）。 */
  maxIssuesInText: 40,
  /** 打印调试日志。 */
  verbose: false,
};

const cache = { mtimeMs: -1, size: -1, file: {}, error: null, present: false };

function readFileConfig() {
  let st = null;
  try {
    st = statSync(CONFIG_PATH);
  } catch {
    st = null;
  }
  if (!st) {
    cache.mtimeMs = -1;
    cache.size = -1;
    cache.file = {};
    cache.error = null;
    cache.present = false;
    return;
  }
  if (st.mtimeMs === cache.mtimeMs && st.size === cache.size) return;
  cache.mtimeMs = st.mtimeMs;
  cache.size = st.size;
  cache.present = true;
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config.json 顶层必须是 JSON 对象");
    }
    cache.file = parsed;
    cache.error = null;
  } catch (err) {
    cache.file = {};
    cache.error = err instanceof Error ? err.message : String(err);
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
  autoScope: "autoScope",
  autoSkipSubagents: "autoSkipSubagents",
  autoMaxPerSession: "autoMaxPerSession",
  autoMinReviewableFiles: "autoMinReviewableFiles",
  autoMinIntervalMs: "autoMinIntervalMs",
  autoIncludeDiff: "autoIncludeDiff",
  timeoutMinutes: "timeoutMinutes",
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

/**
 * 把 apply(ctx, config) 收到的（含 volatile 引用的）配置解成普通覆盖对象。
 * 空串视为"未设置"，会回落到 config.json / 出厂默认。
 */
export function schemaOverrides(config) {
  if (!config || typeof config !== "object") return null;
  const out = { llm: {}, reviewer: {} };
  let any = false;
  for (const [schemaKey, target] of Object.entries(SCHEMA_KEY_MAP)) {
    const value = readRef(config[schemaKey]);
    if (!isMeaningful(value)) continue;
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

/** 读取生效配置（出厂默认 + config.json + 设置页，深层合并 env / llm / reviewer）。 */
export function loadConfig(overrides = null) {
  readFileConfig();
  const file = cache.file && typeof cache.file === "object" ? cache.file : {};
  const patch = overrides && typeof overrides === "object" ? overrides : {};
  const merged = { ...DEFAULTS, ...file, ...patch };
  merged.env = {
    ...(DEFAULTS.env ?? {}),
    ...(file.env && typeof file.env === "object" && !Array.isArray(file.env) ? file.env : {}),
  };
  merged.llm = {
    ...DEFAULTS.llm,
    ...(file.llm && typeof file.llm === "object" && !Array.isArray(file.llm) ? file.llm : {}),
    ...(patch.llm && typeof patch.llm === "object" ? patch.llm : {}),
  };
  merged.reviewer = {
    ...DEFAULTS.reviewer,
    ...(file.reviewer && typeof file.reviewer === "object" && !Array.isArray(file.reviewer) ? file.reviewer : {}),
    ...(patch.reviewer && typeof patch.reviewer === "object" ? patch.reviewer : {}),
  };
  merged.ocrCandidates = Array.isArray(file.ocrCandidates)
    ? file.ocrCandidates.filter((v) => typeof v === "string" && v.trim() !== "")
    : [];
  merged.extraArgs = Array.isArray(file.extraArgs)
    ? file.extraArgs.filter((v) => typeof v === "string")
    : [];
  merged.__configPath = CONFIG_PATH;
  merged.__pluginDir = PLUGIN_DIR;
  merged.__configPresent = cache.present;
  merged.__configError = cache.error;
  merged.__settingsApplied = Boolean(overrides);
  return merged;
}

/* ----------------------------------------------------------- 设置页（schema） */

let z = null;
try {
  const mod = await import("@deepseek-ai/schemastery");
  z = mod?.default ?? mod ?? null;
} catch {
  /* 没有 schemastery 也能跑：只是没有设置页（工具/命令/自动评审照旧） */
}

/** schemastery 是否可用（不可用时 Host 侧看不到本插件的设置表单）。 */
export const SCHEMA_AVAILABLE = Boolean(z && typeof z.object === "function");

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
        .default("adaptive")
        .description("自动评审（回合结束、且有文件写入时）：adaptive=模型在跑就注入、空闲就开新回合；inject/followup=只走其中一种；off=关闭。"),
    ),
    autoScope: mark(
      z.union(["workspace", "range", "commit", "scan"]).default("workspace").description("自动评审的范围（workspace=未提交改动）。"),
    ),
    autoMaxPerSession: mark(z.number().min(0).max(50).default(3).description("每个会话最多自动评审几次（防改—评—改死循环）。")),
    autoMinReviewableFiles: mark(z.number().min(1).max(50).default(1).description("可审文件数低于该值时跳过自动评审。")),
    autoMinIntervalMs: mark(z.number().min(0).max(3600000).default(60000).description("两次自动评审之间的最小间隔（毫秒）。")),
    autoSkipSubagents: mark(z.boolean().default(true).description("跳过子代理会话的自动评审。")),
    autoIncludeDiff: mark(z.boolean().default(true).description("自动评审降级到 delegate 时，是否把 unified diff 一并放进规格。")),
    timeoutMinutes: mark(z.number().min(1).max(60).default(15).description("单次评审超时（分钟），传给 ocr --timeout。")),
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
export const Config = SCHEMA_AVAILABLE ? buildSchema(z) : undefined;
