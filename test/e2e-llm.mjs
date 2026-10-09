/**
 * 端到端验证：新代码 + 真实凭据 + 真实 ocr 二进制 + 真实 LLM（CommandCode 的 DeepSeek v4.1）。
 * 密钥从 DSH 凭据库读取，绝不打印。
 *
 * 用法：node test/e2e-llm.mjs [被测仓库路径] [status-only]
 *   status-only = 只跑 ocr_status（免费），跳过会花钱的真实评审
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

const REPO = process.argv[2] ?? process.cwd();
const STATUS_ONLY = process.argv.slice(2).includes("status-only");
const CRED = process.env.DSH_CREDENTIALS ?? join(homedir(), ".dsh", ".credentials.yaml");

function readCredential(name) {
  if (!existsSync(CRED)) return "";
  const text = readFileSync(CRED, "utf8");
  const flat = text.split(/\r?\n/).find((line) => line.trim().startsWith(`${name}:`));
  if (!flat) return "";
  return flat.slice(flat.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "");
}

const key = readCredential("COMMANDCODE_API_KEY");
console.log(`凭据 COMMANDCODE_API_KEY：${key ? `已读取（${key.length} 字符，前缀 ${key.slice(0, 2)}）` : "未找到"}`);
if (!key) process.exit(1);

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

function spawnReal(spec) {
  const [exe, ...argv] = spec.argv;
  const child = spawn(exe, argv, { cwd: spec.cwd, env: spec.env ?? process.env, windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
  child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
  try {
    child.stdin.end();
  } catch {
    /* 无 stdin */
  }
  const done = new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ exitCode: code, signal }));
    child.on("error", () => resolve({ exitCode: null, signal: null }));
  });
  const reader = (get) => ({ readFrom: () => ({ text: get(), nextOffset: 0, lossy: false }) });
  return {
    collected: { stdout: reader(() => stdout), stderr: reader(() => stderr) },
    done,
    terminate: () => child.kill(),
    waitForExit: () => done.then(() => true),
  };
}

const tools = new Map();
const listeners = new Map();
const ctx = {
  subprocess: {
    async resolveExecutable(cmd) {
      const found = which(cmd);
      if (!found) throw new Error(`not found on PATH: ${cmd}`);
      return found;
    },
    spawn: spawnReal,
  },
  credentials: {
    async resolve(ref) {
      const value = ref === "COMMANDCODE_API_KEY" ? key : "";
      return value ? { value, source: "DSH 凭据库（测试脚本读取）" } : undefined;
    },
  },
  logger: { info: (m) => console.log(`  · ${m}`), warn: (m) => console.log(`  warn: ${m}`), debug: () => {} },
  on(name, handler) {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(handler);
    return () => {};
  },
  tools: {
    register(definition) {
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
  },
  commands: { register: () => () => {} },
};

const mod = await import(new URL("../lib/index.js", import.meta.url));
const refs = mod.Config({ llmApiKeyRef: "COMMANDCODE_API_KEY" });
mod.apply(ctx, refs);

const agent = { status: "idle", session: { header: { cwd: REPO } } };
const exec = { name: "ocr_review", callId: "e2e", arguments: {}, agent, signal: undefined };

console.log("\n--- ocr_status（真实连通性测试）---");
const status = await tools.get("ocr_status").execute({ checkLlm: true }, exec);
const llmEnv = Array.isArray(status.llmEnv) ? status.llmEnv : [];
console.log(`endpoint=${status.llmEndpoint}`);
console.log(`已注入的环境变量：${llmEnv.length > 0 ? llmEnv.join(" | ") : "(无)"}（TOKEN 打码）`);
console.log(`credentialRef=${status.credentialRef}  source=${status.credentialSource}`);
console.log(`llm test：${status.llmTest}`);

if (STATUS_ONLY) {
  console.log("\n(status-only：跳过真实评审)");
  process.exit(status.ok && /可用/.test(String(status.llmTest)) ? 0 : 1);
}

console.log("\n--- ocr_review（真实 LLM 评审，engine=ocr）---");
const t0 = Date.now();
const review = await tools.get("ocr_review").execute({ engine: "ocr" }, exec);
console.log(`ok=${review.ok} engine=${review.engine} exit=${review.exitCode} 耗时=${review.durationMs}ms（脚本计时 ${Date.now() - t0}ms）`);
console.log(`summary=${review.summary}`);
console.log(`issues=${review.issues.length}${review.issues.map((i) => `\n  - [${i.severity}] ${i.file}:${i.line} ${String(i.message).slice(0, 160)}`).join("")}`);
console.log(`notes=${review.notes.join(" / ")}`);
if (review.rawJson) console.log(`rawJson=${String(review.rawJson).slice(0, 700)}`);
if (review.configHint) console.log(`configHint=${review.configHint}`);

process.exit(review.ok && review.engine === "ocr" ? 0 : 1);
