/**
 * dsh-open-code-review —— 把阿里 OpenCodeReview（ocr）接进 DeepSeek Harness。
 *
 * 三条入口：
 *  1) 工具 ocr_review / ocr_status：模型可主动调用（也可由用户让模型调用）；
 *  2) 命令 /ocr-review：用户在输入框直接拉起评审；
 *  3) 自动：本回合有文件写入且回合即将结束时，自动跑一次评审并把结果注入/开新回合。
 *
 * 引擎两种模式：
 *  - ocr：跑 OCR 自己的"确定性工程 × LLM Agent"流水线（需要 provider/model/key）；
 *  - delegate：不调 LLM，用 `ocr delegate preview|rule` 拿到 OCR 解析出的规则+文件，拼成审查规格交给当前模型。
 *  engine=auto 时先试 ocr，遇到“未配置 LLM 端点”自动降级 delegate。
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
  PLUGIN_DIR,
  SCHEMA_AVAILABLE,
  Config as ConfigSchema,
  loadConfig,
  schemaOverrides,
} from "./config.js";
import { buildEnv, gitDiff, resolveOcr, runCommand } from "./ocr-cli.js";
import {
  buildDelegateArgvs,
  buildDelegateSpec,
  buildOcrArgv,
  configHintText,
  extractFiles,
  extractIssues,
  looksLikeMissingLlm,
  normalizeTarget,
  num,
  parseJsonLoose,
  valueToText,
} from "./review.js";

export const name = "dsh-open-code-review";
export const inject = ["tools", "commands", "subprocess", "credentials"];
/** 插件配置 schema：Host 把 meta.volatile 节点投影成设置页表单（缺 schemastery 时为 undefined）。 */
export const Config = ConfigSchema;
/** schemastery 是否可用（false = 没有设置页，其余功能照旧）。 */
export { SCHEMA_AVAILABLE };

const RAW_JSON_LIMIT = 100000;
const MAX_ISSUES = 200;
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
  };
}

function excludedNames(parsed) {
  const list = Array.isArray(parsed?.excluded_files) ? parsed.excluded_files : [];
  return list
    .map((item) => (typeof item === "string" ? item : typeof item?.path === "string" ? item.path : ""))
    .filter(Boolean);
}

/* ------------------------------------------------------------------ 引擎：ocr */

async function runOcrOnce(ctx, { cfg, plan, env, ocrPath, signal }) {
  const out = mkResult(plan);
  const { argv, label } = buildOcrArgv(plan, cfg);
  out.command = label;
  const run = await runCommand(ctx, {
    exe: ocrPath,
    argv,
    cwd: plan.cwd,
    env,
    signal,
    timeoutMs: plan.timeoutMs,
  });
  const parsed = parseJsonLoose(run.stdout);
  const files = extractFiles(parsed);
  const issues = plan.preview ? [] : extractIssues(parsed);
  const combined = `${run.stdout}\n${run.stderr}`;
  out.llmMissing = looksLikeMissingLlm(combined);
  out.ok = run.exitCode === 0 && (plan.preview || parsed !== null || run.stdout.trim() === "");
  out.exitCode = typeof run.exitCode === "number" ? run.exitCode : -1;
  out.durationMs = run.durationMs;
  out.timedOut = run.timedOut;
  out.reviewableFiles = files;
  out.excludedFiles = excludedNames(parsed);
  out.issues = issues.slice(0, MAX_ISSUES);
  out.rawJson = run.stdout ? run.stdout.slice(0, RAW_JSON_LIMIT) : "";
  out.stderr = run.stderr ? run.stderr.slice(0, 4000) : "";
  out.lostOutput = Boolean(run.lostOutput);
  out.spillPath = run.spillPath ?? "";
  if (run.error) out.notes.push(`子进程异常：${run.error}`);
  if (run.timedOut) out.notes.push(`超过 ${plan.timeoutMinutes} 分钟被终止。`);
  if (parsed === null && run.exitCode === 0 && !plan.preview) {
    out.notes.push("ocr 退出码为 0 但输出不是可解析的 JSON，已把原始输出放在 rawJson。");
  }
  if (run.exitCode === 0 && parsed !== null && !plan.preview && issues.length === 0) {
    out.notes.push("JSON 中没有识别到问题数组；请以 rawJson 为准复核。");
  }

  if (/not a git repository/i.test(combined)) {
    out.ok = false;
    out.summary = `不是 git 仓库，无法计算改动范围：${plan.cwd}`;
    out.configHint = "把 repo 指向一个 git 仓库，或改在 git 仓库目录下的会话里调用；ocr 依赖 git 判断改动范围。";
  } else if (plan.preview) {
    out.summary = `preview：将审查 ${files.length} 个文件（排除 ${num(parsed?.excluded_count, 0)} 个，+${num(parsed?.total_insertions, 0)} -${num(parsed?.total_deletions, 0)}）；未调用 LLM。`;
  } else if (out.ok) {
    out.summary = issues.length
      ? `OCR 评审完成：${files.length} 个文件，发现 ${issues.length} 条问题。`
      : `OCR 评审完成：${files.length} 个文件，未发现结构化问题。`;
  } else if (out.llmMissing) {
    out.summary = "OCR 未配置 LLM 端点，评审没有执行。";
    out.configHint = configHintText();
  } else if (run.timedOut) {
    out.summary = `OCR 评审超时（>${plan.timeoutMinutes} 分钟）被终止。`;
  } else {
    out.summary = `OCR 评审失败（exit=${out.exitCode}）。`;
  }
  return out;
}

/* -------------------------------------------------------------- 引擎：delegate */

async function runDelegate(ctx, { cfg, plan, env, ocrPath, signal, notes = [] }) {
  const out = mkResult(plan);
  out.engine = "delegate";
  const { previewArgv, ruleArgv, label } = buildDelegateArgvs(plan, cfg);
  out.command = label;

  const previewRun = await runCommand(ctx, {
    exe: ocrPath,
    argv: previewArgv,
    cwd: plan.cwd,
    env,
    signal,
    timeoutMs: 180000,
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
    if (/not a git repository/i.test(out.stderr)) {
      out.summary = `不是 git 仓库，无法计算改动范围：${plan.cwd}`;
      out.configHint = "把 repo 指向一个 git 仓库，或改在 git 仓库目录下的会话里调用；ocr 依赖 git 判断改动范围。";
    } else {
      out.summary = `delegate preview 失败（exit=${out.exitCode}）；无法获得可审文件清单。`;
    }
    return out;
  }

  const targetFiles = plan.paths.length > 0 ? plan.paths : files.map((f) => f.path);
  let rulesParsed = null;
  if (targetFiles.length > 0) {
    const ruleRun = await runCommand(ctx, {
      exe: ocrPath,
      argv: ruleArgv(targetFiles),
      cwd: plan.cwd,
      env,
      signal,
      timeoutMs: 180000,
    });
    out.durationMs += ruleRun.durationMs;
    rulesParsed = parseJsonLoose(ruleRun.stdout);
    if (ruleRun.exitCode !== 0 || rulesParsed === null) {
      notes.push("delegate rule 未返回可解析 JSON，规格里将缺少规则正文（可用 ocr delegate rule 手动获取）。");
    }
  } else {
    notes.push("没有可审文件，规格里只有空清单。");
  }

  let diff = "";
  if (plan.includeDiff && plan.scope !== "scan") {
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
  return out;
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
 * 决定这次 ocr 子进程走哪条 LLM 路由：
 *  - dsh：ocr → 本机桥（127.0.0.1 随机端口 + 随机 token）→ ctx.llm.stream；
 *  - endpoint：ocr → llm.baseUrl 静态端点，密钥按 llm.apiKeyRef 解析（老行为）。
 * dsh 模式但桥没就绪或没选模型时回落 endpoint，并在 note 里说明原因（不静默）。
 */
async function resolveLlmRoute(ctx, cfg, signal) {
  const mode = String(cfg?.llm?.mode ?? "dsh") === "endpoint" ? "endpoint" : "dsh";
  const model = String(cfg?.llm?.model ?? "").trim();
  if (mode === "dsh" && activeBridge && model) {
    const provider = String(cfg?.llm?.provider ?? "").trim() || "(未选)";
    return {
      mode,
      env: buildEnv(cfg, { bridge: activeBridge }),
      source: `DSH 本机桥 ${activeBridge.url}（provider=${provider} · model=${model}）`,
      key: "",
      ready: true,
      note: "",
      bridgeUrl: activeBridge.url,
    };
  }
  const llmKey = await resolveLlmKey(ctx, cfg, signal);
  let note = "";
  if (mode === "dsh") {
    note = !model
      ? "路由模式是 dsh，但设置页里还没选模型名"
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
  };
}

/** engine=auto 时是否该因为"LLM 没配好"降级 delegate：dsh 模式有桥就不降级。 */
function canDegradeLlm(route) {
  return route.mode === "endpoint" && !route.key;
}

/* ------------------------------------------------------------------ 工具实现 */

async function runReview(ctx, args, exec, cfgNow) {
  const cfg = cfgNow();
  if (cfg.enabled === false) {
    const off = mkResult(null);
    off.summary =
      "插件已在设置里关闭（enabled=false），未执行评审。请到「DSH 设置 → 插件 → dsh-open-code-review」打开开关，或把 config.json 的 enabled 改成 true。";
    off.notes.push("ocr_status 不受总开关影响，仍可用于诊断。");
    return off;
  }
  const plan = normalizeTarget(args, cfg, cwdOf(exec?.agent));
  if (plan.error) {
    const bad = mkResult(plan);
    bad.summary = plan.error;
    bad.notes.push("参数不完整，未执行任何命令。");
    return bad;
  }

  const route = await resolveLlmRoute(ctx, cfg, exec?.signal);
  const env = route.env;
  let ocrPath = "";
  try {
    ocrPath = (await resolveOcr(ctx, cfg, exec?.signal)).path;
  } catch (err) {
    const failed = mkResult(plan);
    failed.summary = `无法定位 ocr 可执行文件：${msgOf(err)}`;
    failed.notes.push(`请在设置页（设置 → 插件 → dsh-open-code-review）或 ${CONFIG_PATH} 里设置 ocrPath。`);
    return failed;
  }

  try {
    if (plan.engine === "delegate") {
      return await runDelegate(ctx, { cfg, plan, env, ocrPath, signal: exec?.signal });
    }
    const result = await runOcrOnce(ctx, { cfg, plan, env, ocrPath, signal: exec?.signal });
    if (plan.engine === "auto" && !result.ok && result.llmMissing && !plan.preview && canDegradeLlm(route)) {
      const notes = [
        `OCR 的 LLM 端点未配置：自动降级为 delegate，由当前模型按 OCR 规则审查。`,
        `可执行文件：${ocrPath}`,
        `LLM 路由：${route.source}${route.note ? `（${route.note}）` : ""}`,
        `LLM 端点：${cfg.llm.baseUrl || "(未设置)"} · ${cfg.llm.protocol || "?"} · ${cfg.llm.model || "(未设置)"}`,
      ];
      const delegated = await runDelegate(ctx, { cfg, plan, env, ocrPath, signal: exec?.signal, notes });
      delegated.notes = [...notes, ...delegated.notes];
      delegated.configHint = configHintText();
      return delegated;
    }
    result.notes.unshift(`可执行文件：${ocrPath}`, `LLM 路由：${route.source}${route.note ? `（${route.note}）` : ""}`);
    return result;
  } catch (err) {
    const failed = mkResult(plan);
    failed.summary = `执行失败：${msgOf(err)}`;
    return failed;
  }
}

async function runStatus(ctx, args, exec, cfgNow) {
  const cfg = cfgNow();
  const out = {
    ok: false,
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
    credentialRef: "",
    credentialSource: "",
    ocrHomeConfig: "",
    llmEnv: [],
    llmTest: "",
    notes: [],
  };
  const route = await resolveLlmRoute(ctx, cfg, exec?.signal);
  const env = route.env;
  out.llmMode = String(cfg.llm.mode ?? "dsh");
  out.llmRoute = `${route.source}${route.note ? `（${route.note}）` : ""}`;
  out.llmEndpoint =
    route.mode === "dsh"
      ? `本机桥 ${route.bridgeUrl} · openai · ${cfg.llm.model || "(未设置)"}`
      : `${cfg.llm.baseUrl || "(未设置)"} · ${cfg.llm.protocol || "?"} · ${cfg.llm.model || "(未设置)"}`;
  out.credentialRef = route.mode === "dsh" ? "(dsh 模式不需要：密钥由 DSH 的 provider 配置提供)" : String(cfg.llm.apiKeyRef || "") || "(未设置)";
  out.credentialSource = route.mode === "dsh" ? "由 DSH 提供（密钥不进 ocr 子进程）" : `${route.key ? "已解析" : "未解析"}（${route.source}）`;
  try {
    out.executable = (await resolveOcr(ctx, cfg, exec?.signal)).path;
    out.ok = true;
  } catch (err) {
    out.notes.push(`定位 ocr 失败：${msgOf(err)}`);
    return out;
  }
  const cwd = cwdOf(exec?.agent);
  const versionRun = await runCommand(ctx, {
    exe: out.executable,
    argv: ["--version", "--color", "never"],
    cwd,
    env,
    signal: exec?.signal,
    timeoutMs: 30000,
    stdoutMaxBytes: 65536,
    stderrMaxBytes: 65536,
  });
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
    const test = await runCommand(ctx, {
      exe: out.executable,
      argv: ["llm", "test", "--color", "never"],
      cwd,
      env,
      signal: exec?.signal,
      timeoutMs: 120000,
      stdoutMaxBytes: 65536,
      stderrMaxBytes: 65536,
    });
    const text = (test.stdout || test.stderr || "").trim().replace(/\s+/g, " ").slice(0, 600);
    out.llmTest = test.exitCode === 0 ? `可用：${text}` : `不可用（exit=${test.exitCode}）：${text}`;
  }

  out.bridge = activeBridge ? activeBridge.describe() : null;
  if (out.llmMode !== "endpoint" && !activeBridge) {
    out.notes.push(
      `dsh 路由要用的本机 LLM 桥没有就绪：${bridgeError || "宿主没有可用的 llm 服务，或桥还在启动"}；本次已回落成静态端点。`,
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
    `OpenCodeReview 接入状态：${v.ok ? "可执行文件已就绪" : "未就绪"}`,
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
    engine: { type: "string", description: "实际使用的引擎：ocr 或 delegate。" },
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
  },
  required: ["ok", "engine", "scope", "summary"],
  additionalProperties: false,
};

const STATUS_TOOL_OUTPUT = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
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
      type: ["object", "null"],
      description: "本机 LLM 桥的实时状态（dsh 模式）；桥没起来时为 null。",
      properties: {
        url: { type: "string" },
        tokenMasked: { type: "string" },
        requests: { type: "number" },
        failed: { type: "number" },
        lastError: { type: ["string", "null"] },
        lastProvider: { type: ["string", "null"] },
        lastModel: { type: ["string", "null"] },
        inflight: { type: "number" },
        uptimeMs: { type: "number" },
      },
      required: ["url", "requests", "failed"],
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
      state = { dirty: false, running: false, runs: 0, notified: false, lastRunAt: 0, lastSignature: "" };
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
      if (cfgNow().verbose) ctx.logger?.warn?.(`[open-code-review] 交付自动评审结果失败：${msgOf(err)}`);
      return false;
    }
  };

  const runAutoReview = async (agent, state, cfg, reason) => {
    state.running = true;
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
        timeoutMs: 120000,
      });
      const previewParsed = parseJsonLoose(previewRun.stdout);
      const files = extractFiles(previewParsed);
      if (files.length < num(cfg.autoMinReviewableFiles, 1)) {
        state.dirty = false;
        return;
      }
      const signature = files.map((f) => `${f.path}:${f.insertions}:${f.deletions}`).join("|");
      if (signature !== "" && signature === state.lastSignature) {
        state.dirty = false;
        return;
      }
      state.lastSignature = signature;

      const engineWanted = String(cfg.autoEngine || "").trim() || String(cfg.engine || "auto");
      const plan = normalizeTarget(
        { scope: autoScope, engine: engineWanted, includeDiff: cfg.autoIncludeDiff !== false },
        cfg,
        cwd,
      );
      let value;
      if (plan.engine === "delegate") {
        value = await runDelegate(ctx, { cfg, plan, env, ocrPath, exec: { agent } });
      } else {
        value = await runOcrOnce(ctx, { cfg, plan, env, ocrPath, exec: { agent } });
        if (!value.ok && value.llmMissing && canDegradeLlm(route)) {
          const notes = [
            "OCR 的 LLM 端点未配置：自动降级为 delegate，由当前模型按 OCR 规则审查。",
            `LLM 路由：${route.source}${route.note ? `（${route.note}）` : ""}`,
            `LLM 端点：${cfg.llm.baseUrl || "(未设置)"} · ${cfg.llm.protocol || "?"} · ${cfg.llm.model || "(未设置)"}`,
          ];
          value = await runDelegate(ctx, { cfg, plan, env, ocrPath, exec: { agent }, notes });
          value.notes = [...notes, ...value.notes];
          value.configHint = configHintText();
        }
      }

      state.runs += 1;
      state.lastRunAt = Date.now();
      state.dirty = false;
      const header = `【自动代码评审 · 阿里 OpenCodeReview】触发点：回合即将结束（${reason}）；本会话自动评审 ${state.runs}/${num(cfg.autoMaxPerSession, 3)} 次。若不需要自动评审：在 DSH「设置 → 插件 → dsh-open-code-review」里把「自动评审」设为 off（或改 ${CONFIG_PATH} 的 auto）。`;
      deliver(agent, `${header}\n\n${valueToText(value, cfg)}`, String(cfg.auto ?? "adaptive"));
    } catch (err) {
      state.dirty = false;
      if (!state.notified) {
        state.notified = true;
        deliver(agent, `【自动代码评审 · 阿里 OpenCodeReview】执行失败：${msgOf(err)}`, "adaptive");
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
    void runAutoReview(agent, state, cfg, "agent/turn-stopping");
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
      "用阿里 OpenCodeReview（ocr）做代码评审。默认审查当前仓库未提交的工作区改动；也支持分支区间、单个提交、整文件扫描。engine=ocr 走 OCR 自己的「确定性工程 × LLM」流水线（需要已配置 provider/model/key）；engine=delegate 不需要 key：插件用 ocr delegate 拿到按内容分组的审查规则+可审文件（并附上 unified diff），由你按规则自行审查。engine=auto（默认）先试 ocr，未配置 LLM 时自动降级 delegate。建议：改动完成后、提交前调用一次。",
    parameters: REVIEW_TOOL_PARAMS,
    output: {
      schema: REVIEW_TOOL_OUTPUT,
      render(_args, value) {
        return [{ type: "text", text: valueToText(value, cfgNow()) }];
      },
    },
    timeoutMs: 30 * 60 * 1000,
    execute: (args, exec) => runReview(ctx, args, exec, cfgNow),
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
    execute: (args, exec) => runStatus(ctx, args, exec, cfgNow),
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
        "3. 逐条判断评审结果：真实缺陷就修复，误报或规则不适用要说明理由，最后给出结论与改动摘要。",
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
          const cfg = cfgNow();
          return { provider: String(cfg.llm?.provider ?? ""), model: String(cfg.llm?.model ?? "") };
        },
        logger: ctx.logger,
        timeoutMs: Math.max(1, Number(cfgNow().timeoutMinutes) || 15) * 60 * 1000,
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

  syncAutoReviewer("apply");

  // 设置页改动的热通道：Loader 把新值写进 volatile 引用后广播，这里据此启停自动评审。
  ctx.on("loader/volatile-update", () => syncAutoReviewer("settings"));
}
