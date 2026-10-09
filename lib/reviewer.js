/**
 * 独立评审 agent —— 让「评审」由第二个 agent 执行，而不是写代码的那个 agent 自审。
 *
 * 为什么需要它：engine=ocr 是外部 CLI 流水线、engine=delegate 是当前 agent 拿着规则自审，
 * 两者都在「同一个上下文」里；人审代码的价值恰恰在于独立的第二双眼睛。
 *
 * 一轮的形状（插件负责编排，本模块只做单一职责）：
 *   编码 agent 改完 → 回合结束 → 插件拿 ocr 规格（规则 + 文件清单 + diff）
 *   → ctx.subagents.start(provider, { prompt: 规格, outputSchema: FINDINGS_SCHEMA, toolFilter: 只读, persona })
 *   → result.structured（结构化 findings） → 插件把 findings 注入编码 agent 要求逐条修复/说明
 *   → 编码 agent 改完 → 下一轮带着上一轮 findings 复审 → 直到 clean 或到轮次上限。
 *
 * 关键约束：
 *  - 评审 agent 只有只读工具（read / grep / glob），禁止代改代码 —— 两个 agent 抢写文件是灾难；
 *  - 结构化结果是硬前提，所以每轮都用一次性 start()（只有它支持 outputSchema）；
 *  - 拿不到结果一律 fail-closed：绝不把「没有结果」当成「没发现问题」。
 *
 * 这一层不依赖 cordis：subagents 运行时由调用方注入（可选服务，缺了就回落静态引擎）。
 */
import { randomUUID } from "node:crypto";
import { CODES } from "./review.js";

/** 评审 agent 专属的结果码（与 OCR_* 同一命名空间，便于机器分支）。 */
export const REVIEWER_CODES = Object.freeze({
  UNAVAILABLE: "OCR_REVIEWER_UNAVAILABLE",
  FAILED: "OCR_REVIEWER_FAILED",
  UNCERTAIN: "OCR_REVIEWER_UNCERTAIN",
});

/** 严重程度（越靠前越严重；未知值统一归 minor）。 */
export const REVIEWER_SEVERITIES = Object.freeze(["blocker", "major", "minor", "nit"]);
/** 评审结论。uncertain = agent 自己说「信息不足，无法确认」，不算通过。 */
export const REVIEWER_VERDICTS = Object.freeze(["clean", "issues", "uncertain"]);
/** 评审 agent 允许使用的工具：只读三件套。 */
export const REVIEWER_TOOL_ALLOW = Object.freeze(["read", "grep", "glob"]);
/** 默认轮次上限（每轮 = 一次新的子 agent 会话）。 */
export const DEFAULT_REVIEWER_ROUNDS = 3;
/** 单次评审最多接受的 findings 条数（防跑飞）。 */
export const MAX_FINDINGS = 200;

const SEVERITY_RANK = { blocker: 0, major: 1, minor: 2, nit: 3 };

/** 内置评审人格（config.json 的 reviewer.persona 可整段覆盖）。 */
export const DEFAULT_REVIEWER_PERSONA = [
  "你是一名严格的代码评审者，与写这段代码的人互不共享上下文：他写、你审。",
  "你的职责是找出真实缺陷（正确性、边界、并发、资源释放、错误处理、安全、契约破坏），而不是复述代码或夸奖实现。",
  "纪律：所有结论都要有证据（引用你读到的真实代码行）；不确定就说不确定；没有问题就说没有问题。",
  "你只读代码，绝不修改仓库里的任何文件 —— 发现问题只报告，由编码 agent 自己修。",
].join("\n");

/** 评审 agent 必须按这个 schema 返回结果（SubagentStartRequest.outputSchema）。 */
export const FINDINGS_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: {
      type: "string",
      enum: [...REVIEWER_VERDICTS],
      description: "clean=未发现问题；issues=有问题需要修；uncertain=信息不足无法确认（不算通过）。",
    },
    summary: { type: "string", description: "一句话结论（中文），包含你审了哪些文件、依据什么。" },
    findings: {
      type: "array",
      description: "问题清单；verdict=clean 时必须是空数组。",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "severity", "message"],
        properties: {
          file: { type: "string", description: "仓库内相对路径。" },
          line: { type: "number", description: "行号（拿不到就给 0）。" },
          severity: { type: "string", enum: [...REVIEWER_SEVERITIES] },
          message: { type: "string", description: "问题是什么、为什么是问题（不要只说「建议优化」）。" },
          evidence: { type: "string", description: "证据：贴出关键代码或说明推理链。" },
          suggestion: { type: "string", description: "修复方向（可选）。" },
          stillOpen: { type: "boolean", description: "第 2 轮起：这条上一轮就报过、现在仍未解决。" },
        },
      },
    },
  },
});

function msgOf(err) {
  return err instanceof Error ? err.message : String(err);
}

function num(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** 可用的 provider 名（拿不到就空数组；诊断文案里列给用户看）。 */
export function listProviders(subagents) {
  try {
    const list = typeof subagents?.list === "function" ? subagents.list() : null;
    return Array.isArray(list) ? list.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------ 提示词 */

/**
 * 拼评审 agent 的提示词：身份 + 硬约束 + 范围 + ocr 规格 + 上一轮 findings + 输出约定。
 * 第 2 轮起会把上一轮的 findings 与「以代码为准」的要求写进去 —— 这就是「往返」的全部记忆。
 */
export function buildReviewerPrompt({
  plan = {},
  spec = "",
  round = 1,
  rounds = DEFAULT_REVIEWER_ROUNDS,
  openFindings = [],
  maxBytes = 0,
  cwd = "",
} = {}) {
  const total = Math.max(1, num(rounds, DEFAULT_REVIEWER_ROUNDS));
  const current = Math.min(Math.max(1, num(round, 1)), total);
  const files = Array.isArray(plan?.reviewableFiles) ? plan.reviewableFiles : [];
  const open = Array.isArray(openFindings) ? openFindings : [];
  const lines = [];

  lines.push("你是这次代码评审的独立评审 agent（第 " + current + "/" + total + " 轮）。");
  lines.push("");
  lines.push("硬约束（必须遵守）：");
  lines.push("1. 你只有只读工具（read / grep / glob）：禁止修改仓库里的任何文件，发现问题只报告，不代改；");
  lines.push("2. 每条结论都要能定位到「文件:行」并给出证据（引用你真实读到的代码），不要凭猜测报问题；");
  lines.push("3. 只审下面规格里给出的范围与规则，规格里已排除的文件不要审；");
  lines.push("4. 信息不足就不要下结论：verdict=uncertain 并在 summary 里说明还缺什么，不要假装通过；");
  lines.push("5. 没有问题就 verdict=clean 且 findings=[]；不要为了凑数报问题，也不要因为上一轮报过就默认它还在。");
  lines.push("");
  lines.push("评审范围：");
  lines.push("- 仓库：" + String(plan?.cwd || cwd || "(未知)"));
  lines.push("- 模式：" + String(plan?.scope || "workspace") + "（engine=agent）");
  const shown = files.slice(0, 40).map((f) => f.path).join(", ");
  lines.push("- 可审文件 " + files.length + " 个：" + shown + (files.length > 40 ? " …等共 " + files.length + " 个" : ""));
  const excluded = Array.isArray(plan?.excludedFiles) ? plan.excludedFiles : [];
  if (excluded.length > 0) lines.push("- 已排除（不要审）：" + excluded.slice(0, 20).join(", "));

  if (current > 1 && open.length > 0) {
    lines.push("");
    lines.push("上一轮（第 " + (current - 1) + " 轮）你报了 " + open.length + " 条，编码 agent 说已经处理。请以现在的代码为准逐条核对：");
    for (const item of open) {
      const where = String(item.file || "?") + (item.line ? ":" + item.line : "");
      lines.push("- " + where + (item.severity ? " [" + item.severity + "]" : "") + " " + item.message);
    }
    lines.push("解决了就不要出现在 findings 里；仍存在就带 stillOpen=true 重新报；不同意它的处理方式就把理由写进 evidence，也算 stillOpen=true。");
    lines.push("它这一轮的改动见下面的规格（diff）—— 不要只相信它的说法。");
  } else if (current > 1) {
    lines.push("");
    lines.push("这是第 " + current + " 轮复审：上一轮没有问题结论，请重新审一遍当前代码。");
  }

  lines.push("");
  lines.push("## 审查规格（来自阿里 OpenCodeReview：按内容分组的规则 + 文件清单 + unified diff）");
  lines.push("");
  let body = typeof spec === "string" ? spec.trim() : "";
  if (maxBytes > 0 && body.length > maxBytes) {
    body = body.slice(0, maxBytes) + "\n…（规格已截断：如需完整 diff 请用 git diff 自己看）";
  }
  lines.push(body || "(规格为空：请用 git diff / read 自己确认改动范围)");

  lines.push("");
  lines.push("## 输出");
  lines.push("按本次会话约定的 JSON schema 返回：{ verdict, summary, findings:[{ file, line, severity, message, evidence?, suggestion?, stillOpen? }] }。");
  lines.push("verdict 与 findings 必须自洽：有 findings 就必须是 issues（或 uncertain），clean 时 findings 为空。");
  return lines.join("\n");
}

/* ------------------------------------------------------------ 结果解析（fail-closed） */

/**
 * 校验子 agent 的结构化结果。任何形状不对都返回 ok=false —— 宁可说「无法确认」，
 * 也绝不把没有结果的评审当成「没发现问题」。
 */
export function parseFindings(structured) {
  const empty = { verdict: "", summary: "", findings: [], notes: [] };
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
    return { ...empty, ok: false, error: "子 agent 没有返回结构化结果（structured 缺失或不是对象）" };
  }
  const rawVerdict = str(structured.verdict).toLowerCase();
  if (!REVIEWER_VERDICTS.includes(rawVerdict)) {
    return { ...empty, ok: false, error: "结构化结果的 verdict 不合法：" + JSON.stringify(structured.verdict ?? null) };
  }
  if (structured.findings !== undefined && structured.findings !== null && !Array.isArray(structured.findings)) {
    return { ...empty, ok: false, error: "结构化结果的 findings 不是数组" };
  }
  const raw = Array.isArray(structured.findings) ? structured.findings : [];
  const findings = [];
  const notes = [];
  let dropped = 0;
  for (const item of raw.slice(0, MAX_FINDINGS)) {
    if (!item || typeof item !== "object") {
      dropped += 1;
      continue;
    }
    const file = str(item.file);
    const message = str(item.message);
    if (!file || !message) {
      dropped += 1;
      continue;
    }
    const rawSeverity = str(item.severity).toLowerCase();
    const severity = REVIEWER_SEVERITIES.includes(rawSeverity) ? rawSeverity : "minor";
    if (rawSeverity && severity !== rawSeverity) notes.push("严重程度 " + JSON.stringify(item.severity) + " 不认识，按 minor 处理。");
    const parsedLine = Number.isFinite(item.line) ? Math.trunc(item.line) : Number.parseInt(str(item.line), 10);
    findings.push({
      file,
      line: Number.isFinite(parsedLine) ? Math.max(0, parsedLine) : 0,
      severity,
      message: message.slice(0, 2000),
      evidence: str(item.evidence).slice(0, 2000),
      suggestion: str(item.suggestion).slice(0, 1000),
      stillOpen: item.stillOpen === true,
    });
  }
  if (dropped > 0) notes.push("有 " + dropped + " 条 findings 缺少 file/message，已丢弃（agent 输出不合格）。");
  if (raw.length > MAX_FINDINGS) notes.push("findings 超过上限 " + MAX_FINDINGS + " 条，多余的已丢弃。");

  let verdict = rawVerdict;
  if (verdict === "clean" && findings.length > 0) {
    verdict = "issues";
    notes.push("结果自相矛盾（verdict=clean 却给了 findings），已按 issues 处理。");
  } else if (verdict === "issues" && findings.length === 0) {
    verdict = "uncertain";
    notes.push("结果自相矛盾（verdict=issues 却没有 findings 清单），已按 uncertain 处理（不算通过）。");
  }
  return { ok: true, error: "", verdict, summary: str(structured.summary).slice(0, 2000), findings, notes };
}

/** findings → 与 ocr 结果同形的 issues（lib/review.js 的渲染与输出 schema 直接复用）。 */
export function toIssues(findings) {
  const list = Array.isArray(findings) ? findings.slice() : [];
  list.sort((a, b) => {
    const sa = SEVERITY_RANK[a?.severity] ?? 9;
    const sb = SEVERITY_RANK[b?.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    const fa = String(a?.file ?? "");
    const fb = String(b?.file ?? "");
    if (fa !== fb) return fa < fb ? -1 : 1;
    return num(a?.line, 0) - num(b?.line, 0);
  });
  return list.map((item) => ({
    file: String(item?.file ?? ""),
    line: num(item?.line, 0),
    severity: String(item?.severity ?? ""),
    message: String(item?.message ?? "").slice(0, 2000),
  }));
}

/** 把 findings 渲染成交付给编码 agent 的清单行。 */
export function formatFindings(findings, max = 40) {
  const list = Array.isArray(findings) ? findings : [];
  const limit = Math.max(1, num(max, 40));
  const lines = list.slice(0, limit).map((item) => {
    const where = String(item.file || "?") + (item.line ? ":" + item.line : "");
    const mark = item.stillOpen ? "（上一轮就报过）" : "";
    const fix = item.suggestion ? " → " + item.suggestion : "";
    return "- " + where + (item.severity ? " [" + item.severity + "]" : "") + " " + item.message + mark + fix;
  });
  if (list.length > limit) lines.push("…其余 " + (list.length - limit) + " 条见结果数据。");
  return lines.join("\n");
}

/* ------------------------------------------------------------ 评审线程 */

/** 改动签名：同一签名不重复开轮（沿用原来的 path:+/- 拼接）。 */
export function signatureOf(files) {
  return (Array.isArray(files) ? files : [])
    .map((f) => String(f?.path ?? "") + ":" + num(f?.insertions, 0) + ":" + num(f?.deletions, 0))
    .join("|");
}

export function newThread({ rounds = DEFAULT_REVIEWER_ROUNDS, signature = "", files = [], now = Date.now() } = {}) {
  return {
    id: randomUUID(),
    round: 1,
    rounds: Math.max(1, num(rounds, DEFAULT_REVIEWER_ROUNDS)),
    signature,
    files: (Array.isArray(files) ? files : []).map((f) => String(f?.path ?? "")).filter(Boolean),
    open: [],
    failures: 0,
    startedAt: now,
    lastAt: now,
  };
}

/** 线程闲置太久（默认取 timeoutMinutes）就算过期，避免永远挂着一张「进行中的评审」。 */
export function threadExpired(thread, now = Date.now(), idleMs = 0) {
  if (!thread) return false;
  if (!idleMs || idleMs <= 0) return false;
  return now - num(thread.lastAt, now) > idleMs;
}

/** 线程的「第 N/M 轮」标签。 */
export function roundLabel(thread) {
  const round = num(thread?.round, 1);
  const rounds = Math.max(1, num(thread?.rounds, DEFAULT_REVIEWER_ROUNDS));
  return "第 " + round + "/" + rounds + " 轮";
}

/* ------------------------------------------------------------ 子 agent 调用 */

function withTimeout(promise, timeoutMs, onTimeout) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        if (onTimeout) onTimeout();
      } catch {
        /* 中断失败也要把超时抛出去 */
      }
      const err = new Error("子 agent 超过 " + Math.round(timeoutMs / 60000) + " 分钟未结束，已中断");
      err.__reviewerTimeout = true;
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 起一个评审子 agent 并等它给出结构化结果。
 * 返回 { ok, code, stopReason, verdict, summary, findings, structured, diagnostic, runId, durationMs, notes }。
 * 无论成功失败都会 dispose 那次 run（run.id 就是子会话 id）。
 */
export async function runReviewerAgent({
  subagents = null,
  provider = "spawn",
  persona = "",
  model = "",
  label = "ocr-reviewer",
  prompt = "",
  parent = null,
  signal = undefined,
  timeoutMs = 0,
} = {}) {
  const started = Date.now();
  const notes = [];
  const done = (extra) => ({
    ok: false,
    code: "",
    stopReason: "",
    verdict: "",
    summary: "",
    findings: [],
    structured: undefined,
    diagnostic: "",
    runId: "",
    durationMs: Date.now() - started,
    notes,
    ...extra,
  });

  if (!subagents || typeof subagents.start !== "function") {
    return done({ code: REVIEWER_CODES.UNAVAILABLE, diagnostic: "宿主没有 subagents 服务（profile 未装子代理插件）" });
  }
  const name = str(provider) || "spawn";
  let providerObj = null;
  try {
    providerObj = typeof subagents.getProvider === "function" ? subagents.getProvider(name) : null;
  } catch {
    providerObj = null;
  }
  if (!providerObj) {
    const available = listProviders(subagents);
    return done({
      code: REVIEWER_CODES.UNAVAILABLE,
      diagnostic: "没有名为 " + name + " 的子 agent provider" + (available.length > 0 ? "（可用：" + available.join(", ") + "）" : "（当前一个都没注册）"),
    });
  }
  if (!parent) {
    return done({ code: REVIEWER_CODES.UNAVAILABLE, diagnostic: "拿不到父 agent（工具/命令/回合事件里没有 agent），无法起子 agent" });
  }

  const routeProvider = str(providerObj?.agentRouteDefaults?.provider);
  let run = null;
  try {
    run = await subagents.start(name, {
      label,
      prompt: [{ type: "text", text: String(prompt ?? "") }],
      parent,
      signal,
      outputSchema: FINDINGS_SCHEMA,
      persona: str(persona) || DEFAULT_REVIEWER_PERSONA,
      toolFilter: { allow: [...REVIEWER_TOOL_ALLOW] },
      agentOptions: str(model) ? { ...(routeProvider ? { provider: routeProvider } : {}), model: str(model) } : undefined,
    });
  } catch (err) {
    return done({ code: REVIEWER_CODES.UNAVAILABLE, diagnostic: "起子 agent 失败：" + msgOf(err) });
  }
  if (!run || !run.result) {
    try {
      if (run && typeof run.dispose === "function") await run.dispose();
    } catch {
      /* 忽略 */
    }
    return done({ code: REVIEWER_CODES.UNAVAILABLE, diagnostic: "subagents.start 没有返回可用的 run（缺少 result）" });
  }

  const runId = String(run.id ?? "");
  try {
    const result = await withTimeout(Promise.resolve(run.result), timeoutMs, () => {
      try {
        if (subagents.interrupt) subagents.interrupt(run.id, { kind: "ancestor", agent: parent });
      } catch {
        /* 中断失败也要让超时继续 */
      }
    });
    const stopReason = str(result?.stopReason) || "error";
    const diagnostic = str(result?.diagnostic);
    if (stopReason !== "completed") {
      if (stopReason === "aborted" && signal?.aborted) {
        return done({ code: CODES.ABORTED, stopReason, runId, diagnostic, notes: ["子 agent 被取消（工具调用中断或插件卸载）。"] });
      }
      return done({
        code: REVIEWER_CODES.FAILED,
        stopReason,
        runId,
        diagnostic,
        notes: ["子 agent 结束理由不是 completed（" + stopReason + "）" + (diagnostic ? "：" + diagnostic : "")],
      });
    }
    const parsed = parseFindings(result?.structured);
    if (!parsed.ok) {
      return done({
        code: REVIEWER_CODES.FAILED,
        stopReason,
        runId,
        diagnostic,
        structured: result?.structured,
        notes: [...parsed.notes, parsed.error + "（fail-closed：不当作通过）"],
      });
    }
    return done({
      ok: true,
      stopReason,
      runId,
      diagnostic,
      structured: result?.structured,
      verdict: parsed.verdict,
      summary: parsed.summary,
      findings: parsed.findings,
      notes: parsed.notes,
    });
  } catch (err) {
    if (err && err.__reviewerTimeout) {
      return done({ code: CODES.TIMEOUT, runId, notes: [msgOf(err)] });
    }
    return done({ code: REVIEWER_CODES.FAILED, runId, notes: ["等待子 agent 失败：" + msgOf(err)] });
  } finally {
    try {
      if (typeof run.dispose === "function") await run.dispose();
    } catch {
      /* dispose 失败不影响评审结果 */
    }
  }
}
