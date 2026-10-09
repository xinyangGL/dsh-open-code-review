/**
 * ocr（阿里 OpenCodeReview）子进程封装：
 *  - 可执行文件探测（Volta 安装的 57MB 原生 exe 优先，避开 Windows 的 .cmd shim）
 *  - 通过 ctx.subprocess 受管执行（父进程终止会连带清理），非消费式读取 stdout/stderr
 *  - 可选的 git diff 采集（delegate 模式一次性把改动交给模型）
 */
import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const STDOUT_MAX_BYTES = 24 * 1024 * 1024;
const STDERR_MAX_BYTES = 512 * 1024;
const SPAWN_GRACE_MS = 5000;

function msgOf(err) {
  return err instanceof Error ? err.message : String(err);
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 从 Volta / npm 全局的常见位置推导 ocr 候选路径（不保证存在）。 */
function discoveredCandidates() {
  const out = [];
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const base = join(local, "Volta", "tools", "image", "node");
    try {
      for (const ver of readdirSync(base)) {
        const root = join(base, ver, "node_modules", "@alibaba-group", "open-code-review");
        out.push(join(root, "node_modules", "@alibaba-group", "ocr-win32-x64", "bin", "opencodereview.exe"));
        out.push(join(base, ver, "ocr.cmd"));
      }
    } catch {
      /* 目录不存在则忽略 */
    }
  }
  const appData = process.env.APPDATA;
  if (appData) {
    const npmRoot = join(appData, "npm");
    out.push(join(npmRoot, "node_modules", "@alibaba-group", "open-code-review", "node_modules", "@alibaba-group", "ocr-win32-x64", "bin", "opencodereview.exe"));
    out.push(join(npmRoot, "ocr.cmd"));
  }
  return out.filter((p) => p && !p.includes("\\undefined\\") && !p.includes("\\null\\"));
}

/**
 * 子进程环境变量：继承进程环境 → 叠加 llm 映射（设置页/config.json，显式配置优先于继承来的环境变量）
 * → 最后应用 config.env 的原始覆盖（值为空串/null 表示删除该变量）。
 *
 * 传入 opts.bridge（本机 LLM 桥句柄）时写的是桥的地址与随机 token：
 *   OCR_LLM_URL=http://127.0.0.1:<port>/v1（ocr 自己会拼 /chat/completions）、
 *   OCR_LLM_PROTOCOL=openai、OCR_LLM_TOKEN=<桥 token> —— DSH 的密钥压根不进子进程。
 *
 * @param config 生效配置（loadConfig() 的返回值）
 * @param opts.apiKey 静态端点模式下的密钥（来自 DSH 凭据或 config.json 的 llm.apiKey）
 * @param opts.bridge 本机 LLM 桥句柄（{url, token}）
 */
export function buildEnv(config, opts = {}) {
  const env = { ...process.env };
  const llm = config?.llm && typeof config.llm === "object" ? config.llm : {};
  const bridge = opts.bridge && typeof opts.bridge === "object" ? opts.bridge : null;
  const useBridge = Boolean(bridge && bridge.url && bridge.token);
  const key = useBridge ? String(bridge.token) : String(opts.apiKey ?? llm.apiKey ?? "").trim();
  if (useBridge) {
    env.OCR_LLM_URL = String(bridge.url);
    env.OCR_LLM_PROTOCOL = "openai";
  } else {
    if (llm.baseUrl) env.OCR_LLM_URL = String(llm.baseUrl);
    if (llm.protocol) env.OCR_LLM_PROTOCOL = String(llm.protocol);
  }
  if (key) env.OCR_LLM_TOKEN = key;
  if (llm.model) env.OCR_LLM_MODEL = String(llm.model);
  const extra = config?.env && typeof config.env === "object" ? config.env : {};
  for (const [key2, value] of Object.entries(extra)) {
    if (value === null || value === undefined || value === "") delete env[key2];
    else env[key2] = String(value);
  }
  return env;
}

let cachedExecutable = "";

/** 定位 ocr 可执行文件；返回 {path, tried}。找不到时抛错（err.code = "OCR_NOT_FOUND"）。 */
export async function resolveOcr(ctx, config, signal) {
  const env = buildEnv(config);
  const tried = [];
  if (cachedExecutable && isFile(cachedExecutable)) return { path: cachedExecutable, tried };

  const explicit = [
    typeof config?.ocrPath === "string" ? config.ocrPath.trim() : "",
    ...(Array.isArray(config?.ocrCandidates) ? config.ocrCandidates : []),
    (process.env.OCR_EXECUTABLE ?? "").trim(),
    (process.env.OPENCODEREVIEW_BIN ?? "").trim(),
    ...discoveredCandidates(),
  ].filter((v) => typeof v === "string" && v !== "");

  for (const candidate of explicit) {
    if (isAbsolute(candidate)) {
      if (isFile(candidate)) {
        cachedExecutable = candidate;
        return { path: candidate, tried };
      }
      tried.push(candidate);
      continue;
    }
    try {
      const resolved = await ctx.subprocess.resolveExecutable(candidate, env, signal);
      cachedExecutable = resolved;
      return { path: resolved, tried };
    } catch (err) {
      tried.push(`${candidate} → ${msgOf(err)}`);
    }
  }

  for (const bare of ["opencodereview", "opencodereview.exe"]) {
    try {
      const resolved = await ctx.subprocess.resolveExecutable(bare, env, signal);
      cachedExecutable = resolved;
      return { path: resolved, tried };
    } catch (err) {
      tried.push(`${bare} → ${msgOf(err)}`);
    }
  }

  const err = new Error(
    `找不到 ocr 可执行文件。请在 config.json 里设置 ocrPath，或在 PATH 上提供 opencodereview。\n已尝试：\n- ${tried.join("\n- ")}`,
  );
  err.code = "OCR_NOT_FOUND";
  throw err;
}

function readCollected(reader) {
  if (!reader || typeof reader.readFrom !== "function") {
    return { text: "", lossy: false, spillPath: "" };
  }
  try {
    const read = reader.readFrom(0) ?? {};
    return {
      text: typeof read.text === "string" ? read.text : "",
      lossy: Boolean(read.lossy),
      spillPath: typeof read.spillPath === "string" ? read.spillPath : "",
    };
  } catch (err) {
    return { text: "", lossy: true, spillPath: "", error: msgOf(err) };
  }
}

/**
 * 跑一个受管子进程。
 * @returns {Promise<{exitCode:number|null, signal:string|null, stdout:string, stderr:string, lostOutput:boolean, spillPath:string, timedOut:boolean, durationMs:number, error:string}>}
 */
export async function runCommand(ctx, options) {
  const {
    exe,
    argv,
    cwd,
    env,
    signal,
    timeoutMs = 0,
    stdoutMaxBytes = STDOUT_MAX_BYTES,
    stderrMaxBytes = STDERR_MAX_BYTES,
  } = options;
  const startedAt = Date.now();
  const spec = {
    argv: [exe, ...argv],
    cwd,
    stdio: {
      stdin: "ignore",
      stdout: { maxBytes: stdoutMaxBytes, spill: { maxBytes: 8 * 1024 * 1024 } },
      stderr: { maxBytes: stderrMaxBytes, spill: { maxBytes: 2 * 1024 * 1024 } },
    },
    graceMs: SPAWN_GRACE_MS,
  };
  if (signal) spec.signal = signal;
  if (env) spec.env = env;

  const handle = ctx.subprocess.spawn(spec);
  let timedOut = false;
  let timer = null;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        handle.terminate();
      } catch {
        /* 已退出 */
      }
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  let outcome = null;
  let error = "";
  try {
    outcome = await handle.done;
  } catch (err) {
    error = msgOf(err);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const out = readCollected(handle.collected?.stdout);
  const errOut = readCollected(handle.collected?.stderr);
  return {
    exitCode: typeof outcome?.exitCode === "number" ? outcome.exitCode : null,
    signal: outcome?.signal ?? null,
    stdout: out.text,
    stderr: errOut.text,
    lostOutput: out.lossy || errOut.lossy,
    spillPath: out.spillPath || errOut.spillPath || "",
    timedOut,
    durationMs: Date.now() - startedAt,
    error,
  };
}

/** 采集 git diff（失败不抛错，返回 ok=false + note）。 */
export async function gitDiff(ctx, options) {
  const { cwd, refArgs, files, env, signal, timeoutMs = 90000, maxBytes = 120000 } = options;
  let gitExe = "";
  try {
    gitExe = await ctx.subprocess.resolveExecutable("git", env, signal);
  } catch (err) {
    return { ok: false, text: "", note: `找不到 git：${msgOf(err)}` };
  }
  const argv = ["--no-pager", "diff", "--no-color", "-U8", ...(refArgs ?? [])];
  if (Array.isArray(files) && files.length > 0) argv.push("--", ...files);
  const run = await runCommand(ctx, {
    exe: gitExe,
    argv,
    cwd,
    env,
    signal,
    timeoutMs,
    stdoutMaxBytes: Math.max(maxBytes * 2, 262144),
    stderrMaxBytes: 65536,
  });
  let text = run.stdout ?? "";
  if (text.length > maxBytes) text = `${text.slice(0, maxBytes)}\n…（diff 已截断，原始长度 ${run.stdout.length} 字符）`;
  const ok = run.exitCode === 0;
  return {
    ok,
    text,
    note: ok ? "" : (run.stderr || `git diff 退出码 ${run.exitCode}`).trim().slice(0, 400),
  };
}
