/**
 * 本地 LLM 桥：把一个只监听 127.0.0.1 的 OpenAI 兼容端点翻译成 DSH 自己的
 * ctx.llm.stream。
 *
 * 为什么需要它：ocr 是独立 CLI 子进程，只认 OCR_LLM_URL / OCR_LLM_PROTOCOL /
 * OCR_LLM_MODEL / OCR_LLM_TOKEN 四个环境变量（见 lib/ocr-cli.js 的 buildEnv），
 * 它进不了 cordis，拿不到 DSH 的 provider 目录、凭据库、模型目录和账号轮换。
 * 于是插件在本机起一个小 HTTP 服务，把 ocr 的 /chat/completions 请求原样翻译成
 * DSH 的 llm.stream 调用，模型与密钥都由 DSH 决定。
 *
 * 实测契约（用本地假服务器 + 真 ocr 验证过，见 test/bridge-smoke.mjs）：
 *   - 请求：POST <OCR_LLM_URL>/chat/completions
 *   - 鉴权：Authorization: Bearer <OCR_LLM_TOKEN>
 *   - 请求体键：messages / model / max_completion_tokens / tools（OpenAI function 形状）
 *   - ocr 默认非流式（不带 stream 键），但服务端同时支持 stream:true 的 SSE
 *   - 工具往返：第 2 次请求的 messages 里会有 {role:"assistant", tool_calls:[…]} 与
 *     {role:"tool", content:"…"}
 *
 * 本模块不依赖 cordis：llm 流由调用方以 stream(options) 传进来，便于单测。
 */

import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";

/** 桥对外暴露的 base（ocr 会在它后面拼 /chat/completions）。 */
export const BRIDGE_PATH_PREFIX = "/v1";
/** 只接受挂在这个路径下的 OpenAI 兼容调用。 */
export const BRIDGE_COMPLETIONS_PATH = "/v1/chat/completions";
/** 请求体上限：diff 会很大，但不能大到把宿主内存吃光。 */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** 单次上游调用的兜底超时，ocr 自己也有超时，这里只防挂死。 */
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
/** 默认监听地址：只给本机，永不对外。 */
export const BIND_HOST = "127.0.0.1";
/** close() 的宽限期：到点还有连接挂着就强拆，绝不卡住插件卸载。 */
export const CLOSE_GRACE_MS = 2000;
/**
 * 单次请求最多尝试几次上游调用（1 次重试）。
 *
 * 为什么可以重试：桥是「先把上游流跑完、再一次性写给客户端」的（见 handle 里的
 * accumulator + openAiStreamFrames），失败时客户端一个字节都还没收到，所以重试不会
 * 产生重复内容。真机事故：DSH 默认模型切成 ark-coding-plan/glm-5.3-flash 后，上游偶尔
 * 用 `OpenAI Responses stream ended before a terminal response event` 截断，ocr 把这一次
 * 失败当成整个文件的扫描失败（`all 1 file scan(s) failed`），10 分钟白跑；重试一次即可救回。
 */
export const MAX_UPSTREAM_ATTEMPTS = 2;
/**
 * 我方主动掐断上游时的文案 —— `SELF_ABORT_RE` **由这三个常量生成**，不再是两处各写一遍。
 *
 * 真机教训（v0.5.5 自审发现）：以前正则里写「客户端断开」、abort 处写「客户端断开，桥已取消上游调用」，
 * 只靠子串巧合命中；谁改一下 abort 的文案（例如「客户端已断开」），`classifyUpstreamFailure` 就会把
 * 「我方主动中止」误判成可重试的上游瞬时故障 —— 而重试会在客户端早已断开的情况下继续烧配额。
 */
export const SELF_ABORT_MESSAGES = {
  clientGone: "客户端断开，桥已取消上游调用",
  timeout: "桥的上游调用超时",
  closed: "桥已关闭",
};
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 我方主动掐断上游（客户端断开/桥超时/桥关闭）——这不是上游的错，重试没有意义。 */
export const SELF_ABORT_RE = new RegExp(Object.values(SELF_ABORT_MESSAGES).map(escapeRegExp).join("|"));
/**
 * `abortedBy()` 的结果 → `stats.retrySkipReason` 的文案。以前是嵌套三元，且把
 * `abortedBy()` 返回的 `"unknown"`（外部用别的 reason 掐的）也写成「桥已关闭」——
 * 诊断信息指向错误的原因（v0.6.1 真机自审发现）。
 */
export const ABORT_SKIP_REASONS = {
  timeout: "桥的上游调用超时（我们自己掐的，不重试）",
  client: "客户端已断开",
  closed: "桥已关闭",
  unknown: "上游被中止，但原因不是桥超时/桥关闭/客户端断开（不重试）",
};
/** 判为「上游瞬时故障、值得重试一次」的错误文本。 */
const RETRYABLE_UPSTREAM_RE =
  /stream ended before a terminal|ended before a terminal|premature close|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|fetch failed|terminated|rate ?limit|429|50[234]|overloaded|service unavailable|temporarily unavailable/i;

/**
 * 判定一次上游失败：能不能重试，以及**不能重试时为什么**。
 *
 * 判定顺序很关键（v0.3.7 的顺序有 bug）：先看「是不是我方自己掐的」，再看「错误文本是否
 * 命中已知的瞬时故障」，最后才用 `kind` 兜底。v0.3.7 把 `kind === "aborted"` 放在最前面，
 * 于是上游把「流被截断」标成 aborted 时会被直接否决 —— 真机证据：三次长评审全部
 * `OpenAI Responses stream ended before a terminal response event` 失败，而 `stats.retries`
 * 一直是 0，重试从未触发。我方自己的中止（客户端断开 / 桥超时 / 桥关闭）都有独占文案，
 * 所以用文案区分是安全的。
 * @param {{kind?: string, code?: string, message?: string}|null} failure
 * @returns {{retryable: boolean, reason: string}}
 */
export function classifyUpstreamFailure(failure) {
  if (!failure || typeof failure.message !== "string" || failure.message.length === 0) {
    return { retryable: false, reason: "上游没给出可判定的错误文本" };
  }
  if (SELF_ABORT_RE.test(failure.message)) {
    return { retryable: false, reason: "我方主动中止（客户端断开/桥超时/桥关闭），重试没有意义" };
  }
  if (RETRYABLE_UPSTREAM_RE.test(failure.message)) return { retryable: true, reason: "上游瞬时故障" };
  const kind = failure.kind ? `kind=${failure.kind}` : "kind 未知";
  if (failure.kind === "aborted") {
    return { retryable: false, reason: `上游把这次失败标成 aborted，且错误文本不在已知的瞬时故障列表里（${kind}）` };
  }
  return { retryable: false, reason: `错误文本不在已知的瞬时故障列表里（${kind}）` };
}

/**
 * 这次上游失败是否值得重试（classifyUpstreamFailure 的薄封装）。
 * @param {{kind?: string, code?: string, message?: string}|null} failure
 * @returns {boolean}
 */
export function isRetryableUpstreamFailure(failure) {
  return classifyUpstreamFailure(failure).retryable;
}

/**
 * 评审失败时给用户看的一行「桥侧真因」。
 *
 * 真机事故：上游流被截断导致 `all 1 file scan(s) failed`，而 ocr 只会打印
 * 「check your LLM configuration and API key」，把人引到密钥上；这一行把桥记录的
 * 请求数/失败数/最近错误/最近模型贴出来，才能一眼看出是上游流异常。
 * @param {object|null} stats 桥的 describe()（或 null：没起桥/engine 不走 dsh）
 * @returns {string|null} 没有失败过就返回 null，不打扰用户
 */
export function bridgeFailureNote(stats) {
  const failed = Number.isFinite(stats?.failed) ? stats.failed : 0;
  const rejected = Number.isFinite(stats?.rejected) ? stats.rejected : 0;
  if (!stats || (failed <= 0 && rejected <= 0)) return null;
  const parts = [`本机桥：已转发 ${Number(stats.requests) || 0} 次`, `失败 ${failed} 次`];
  if (rejected > 0) parts.push(`未转发即被拒 ${rejected} 次`);
  if (Number(stats.retries) > 0) parts.push(`上游重试 ${stats.retries} 次`);
  // 「重试为 0」本身就是要看的诊断：说明这次失败被判定成不可重试，把原因一起贴出来。
  if (Number(stats.retrySkips) > 0) parts.push(`未自动重试 ${stats.retrySkips} 次`);
  const model = stats.lastModel ? `（模型 ${stats.lastModel}）` : "";
  const last = stats.lastError ? ` · 最近错误：${stats.lastError}${model}` : "";
  const why = stats.retrySkipReason ? ` · 未重试原因：${stats.retrySkipReason}` : "";
  const reject = stats.lastReject ? ` · 最近被拒：${stats.lastReject}` : "";
  return `${parts.join(" · ")}${last}${why}${reject} —— ocr 打印的「check your LLM configuration and API key」是它的通用提示，未必是密钥问题。`;
}

/** 一次失败的 OpenAI 兼容错误。 */
export class BridgeError extends Error {
  constructor(message, status = 502, code = "bridge_error") {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
  }
}

const noopLogger = { info() {}, warn() {}, debug() {}, error() {} };

/** 把 OpenAI 的 content（字符串或 parts 数组）压成纯文本。 */
export function textOfOpenAiContent(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") parts.push(part);
    else if (part && typeof part === "object") {
      if (typeof part.text === "string") parts.push(part.text);
      else if (part.type === "image_url") parts.push("[图片已忽略：ocr 走的是纯文本审查]");
    }
  }
  return parts.join("");
}

/**
 * 把 DSH 的 usage 归一成 OpenAI 的 usage 字段（字段名不保证，尽量两套都认）。
 *
 * 口径说明（v0.5.4 修的坑）：DSH/pi-ai 给的 `inputTokens` 是**已扣掉缓存**的非缓存输入 ——
 * pi-ai `openai-completions.js` 里 `input = Math.max(0, promptTokens - cacheRead - cacheWrite)`，
 * 而 `totalTokens = input + output + cacheRead + cacheWrite`。所以只 pick 输入/输出时会出现
 * 「合计 ≠ 输入 + 输出」的假象（真机看到 452422 vs 41305+73581=114886，差值就是缓存命中的输入）。
 * 这里把两个缓存字段一并带出来，上层就能显示成「输入 X（其中缓存命中 Y · 缓存写入 Z）/ 输出 W / 合计 T」。
 */
export function toOpenAiUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const pick = (...names) => {
    for (const name of names) if (typeof usage[name] === "number") return usage[name];
    return undefined;
  };
  const prompt = pick("promptTokens", "inputTokens", "prompt_tokens", "input_tokens");
  const completion = pick("completionTokens", "outputTokens", "completion_tokens", "output_tokens");
  const cacheRead = pick("cacheReadTokens", "cache_read_tokens", "cachedTokens", "prompt_cache_hit_tokens");
  const cacheWrite = pick("cacheWriteTokens", "cache_write_tokens");
  /* 没有 total 时自己补一个：pi-ai 的口径是 input + output + cacheRead + cacheWrite，漏掉缓存会低估合计。 */
  const total = pick("totalTokens", "total_tokens") ?? ((prompt ?? 0) + (completion ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) || undefined);
  const out = {};
  if (prompt !== undefined) out.prompt_tokens = prompt;
  if (completion !== undefined) out.completion_tokens = completion;
  if (total !== undefined) out.total_tokens = total;
  if (cacheRead !== undefined) {
    out.cache_read_tokens = cacheRead;
    /* OpenAI 风格的标准写法：ocr 侧或其他 OpenAI 兼容客户端按这个字段读缓存命中。 */
    out.prompt_tokens_details = { cached_tokens: cacheRead };
  }
  if (cacheWrite !== undefined) out.cache_write_tokens = cacheWrite;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 把一次**成功**调用的 usage 累加进桥的 token 统计（自动评审的成本可见性）。
 *
 * `toOpenAiUsage` 返回的可能是部分字段（上游只报其中两个，甚至只报 total），缺失的按 0 计；
 * 非法值（NaN/负数/字符串）一律忽略，绝不让统计把总数弄成 NaN。
 * 这种「输入/输出没报全」的次数记在 `totals.partial` 里：真机出现过
 * 「累计 tokens 415736（输入 40882 / 输出 52550）」这种自相矛盾的显示 —— 415736 ≠ 93432，
 * 原因是部分上游调用只给 total。界面文案用它说明缺口，而不是伪造数字。
 * v0.5.4 起同时累加 `cache_read_tokens` / `cache_write_tokens`：DSH 的 inputTokens 不含缓存命中，
 * 少了这两个字段就会得出「合计 > 输入 + 输出」的假矛盾。
 * @param {{prompt_tokens?: number, completion_tokens?: number, total_tokens?: number, cache_read_tokens?: number, cache_write_tokens?: number, partial?: number}} totals 就地累加
 * @param {object|undefined} usage 单次调用的 usage
 * @returns {typeof totals}
 */
export function accumulateUsage(totals, usage) {
  const out =
    totals && typeof totals === "object"
      ? totals
      : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, partial: 0 };
  out.partial = typeof out.partial === "number" && Number.isFinite(out.partial) && out.partial > 0 ? out.partial : 0;
  const provided = (key) => {
    const value = usage && typeof usage === "object" ? usage[key] : undefined;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  const total = provided("total_tokens");
  if (total !== undefined && (provided("prompt_tokens") === undefined || provided("completion_tokens") === undefined)) {
    out.partial += 1;
  }
  for (const key of [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
  ]) {
    out[key] = typeof out[key] === "number" && Number.isFinite(out[key]) ? out[key] : 0;
    const value = provided(key);
    if (value !== undefined && value > 0) out[key] += value;
  }
  return out;
}

/**
 * 把累加的 token 统计渲染成一句人话（状态行与 job 日志共用，避免两处口径漂移）。
 *
 * 形如 `累计 tokens 452422（输入 41305（其中缓存命中 337536） / 输出 73581）`；
 * 若 `total` 比「输入 + 输出 + 缓存」还大，补一句「另有 N tokens 未分类」—— 只说事实，不编造归属。
 * @param {{prompt_tokens?: number, completion_tokens?: number, total_tokens?: number, cache_read_tokens?: number, cache_write_tokens?: number, partial?: number}} tokens
 * @returns {string} 空串表示没有任何可展示的数字
 */
export function describeTokens(tokens) {
  const num = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
  const prompt = num(tokens?.prompt_tokens);
  const completion = num(tokens?.completion_tokens);
  const total = num(tokens?.total_tokens);
  const cacheRead = num(tokens?.cache_read_tokens);
  const cacheWrite = num(tokens?.cache_write_tokens);
  const partial = num(tokens?.partial);
  if (total <= 0 && prompt <= 0 && completion <= 0) return "";
  const cacheBits = [];
  if (cacheRead > 0) cacheBits.push(`缓存命中 ${cacheRead}`);
  if (cacheWrite > 0) cacheBits.push(`缓存写入 ${cacheWrite}`);
  const input = `输入 ${prompt}${cacheBits.length > 0 ? `（其中${cacheBits.join(" · ")}）` : ""}`;
  const unaccounted = total - (prompt + completion + cacheRead + cacheWrite);
  const tail = [];
  if (unaccounted > 0) tail.push(`另有 ${unaccounted} tokens 未分类（上游只按总数上报）`);
  if (partial > 0) tail.push(`其中 ${partial} 次上游只报了总数`);
  return `累计 tokens ${total}（${input} / 输出 ${completion}）${tail.length > 0 ? ` · ${tail.join(" · ")}` : ""}`;
}

/** OpenAI 请求里的 tools → DSH 的 llm.stream options.tools（{name,description,parameters}）。 */
export function toDshTools(tools, logger = noopLogger) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const fn = tool.type === "function" && tool.function ? tool.function : tool;
    if (typeof fn.name !== "string" || fn.name.length === 0) continue;
    const entry = { name: fn.name, description: typeof fn.description === "string" ? fn.description : "" };
    if (fn.parameters && typeof fn.parameters === "object") entry.parameters = fn.parameters;
    out.push(entry);
  }
  if (out.length === 0) return undefined;
  if (tools.length !== out.length) logger.debug?.("桥：有 " + (tools.length - out.length) + " 个工具因形状不认识被跳过");
  return out;
}

/**
 * OpenAI 的 messages → DSH 的 { system, messages }。
 * system 走 options.system（DSH 里 options.system 优先），其余按角色翻译。
 *
 * assistant 消息**必须**带 `source: { kind: "model", provider, model }`：宿主的 llm 运行时
 * 会在 forAdapter()（dsh-llm/lib/index.js）里读 `message.source.replayState`、pi-ai/deepseek
 * 适配器读 `message.source.provider/model`，缺 source 会直接 `Cannot read properties of
 * undefined (reading 'replayState')` —— 表现就是「第 2 次请求（带 assistant 历史）全失败」。
 * 这里用的是无 replayState 的 provider-neutral 形态，宿主会按 foreignAssistant() 处理。
 *
 * @param messages - OpenAI 的 messages 数组。
 * @param route - { provider, model }：本次要转发到的 DSH 路由，写进 assistant 的 source。
 */
export function toDshMessages(messages, route = null) {
  if (!Array.isArray(messages)) throw new BridgeError("messages 必须是数组", 400, "invalid_messages");
  const provider = route && typeof route.provider === "string" ? route.provider : "";
  const model = route && typeof route.model === "string" ? route.model : "";
  const system = [];
  const out = [];
  // 上游适配器会做 tool_call ↔ tool result 的配对校验（dsh-llm-deepseek/lib/index.js:1682-1693
  // 的 pending.delete(result.tool_use_id)：配不上就 INVALID_REQUEST「tool result has no matching call」）。
  // 客户端偶尔漏发 tool_call_id，这里按顺序补上前面 assistant 里还没被认领的 call id。
  const pendingCallIds = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = message.role;
    if (role === "system" || role === "developer") {
      const text = textOfOpenAiContent(message.content);
      if (text.length > 0) system.push(text);
      continue;
    }
    if (role === "user") {
      const text = textOfOpenAiContent(message.content);
      if (text.length > 0) out.push({ role: "user", content: [{ type: "text", text }] });
      continue;
    }
    if (role === "assistant") {
      const blocks = [];
      const text = textOfOpenAiContent(message.content);
      if (text.length > 0) blocks.push({ type: "text", text });
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const call of calls) {
        const fn = call && call.function ? call.function : call;
        if (!fn || typeof fn.name !== "string") continue;
        const id = typeof call.id === "string" && call.id.length > 0 ? call.id : "call-" + randomUUID();
        pendingCallIds.push(id);
        blocks.push({
          type: "tool-call",
          id,
          name: fn.name,
          arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        });
      }
      if (blocks.length > 0) out.push({ role: "assistant", content: blocks, source: { kind: "model", provider, model } });
      continue;
    }
    if (role === "tool") {
      const text = textOfOpenAiContent(message.content);
      let toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
      if (toolCallId.length === 0) {
        toolCallId = pendingCallIds.shift() ?? "";
      } else {
        const at = pendingCallIds.indexOf(toolCallId);
        if (at >= 0) pendingCallIds.splice(at, 1);
      }
      // 宿主建 tool 消息时同样带 source（createToolResultMessage），这里恒带上（空 id 也是 ""）。
      out.push({
        role: "tool",
        toolCallId,
        content: [{ type: "text", text }],
        isError: message.is_error === true,
        source: { kind: "tool", callId: toolCallId },
      });
      continue;
    }
    // 认不出的角色直接丢掉：ocr 只会发上面四种。
  }
  return { system: system.length > 0 ? system.join("\n\n") : undefined, messages: out };
}

/** 累积 DSH 的 chunk 流：文本、工具调用、终态、用量。 */
export function createAccumulator() {
  const state = {
    text: "",
    reasoning: "",
    toolCalls: [],
    finish: null,
    usage: undefined,
  };
  return {
    state,
    push(chunk) {
      if (!chunk || typeof chunk !== "object") return;
      switch (chunk.type) {
        case "text-delta":
          if (typeof chunk.text === "string") state.text += chunk.text;
          break;
        case "reasoning-delta":
          if (typeof chunk.text === "string") state.reasoning += chunk.text;
          break;
        case "tool-call-delta": {
          const incomingName = typeof chunk.name === "string" ? chunk.name : "";
          const hasIndex = typeof chunk.index === "number";
          let slot = null;
          if (hasIndex) {
            slot = state.toolCalls.find((entry) => entry.index === chunk.index) ?? null;
          } else {
            /* 上游不发 index 时，这个 delta 属于「最近一次工具调用」。旧实现拿
               `state.toolCalls.length` 当兜底 index，而它每建一个 slot 就 +1 ⇒ 同一次调用的
               连续两个无 index 的 delta 会各自新建 slot，name 和 arguments 被拆到两个 slot 上，
               `openAiMessage()` 只能拼出半截（v0.6.1 真机自审发现）。
               例外：这个 delta 在起一个新名字，而最近那个 slot 已经有名字 ⇒ 确实是新的调用。 */
            const last = state.toolCalls.length > 0 ? state.toolCalls[state.toolCalls.length - 1] : null;
            slot = last && !(incomingName.length > 0 && last.name.length > 0) ? last : null;
          }
          if (!slot) {
            const index = hasIndex
              ? chunk.index
              : state.toolCalls.length > 0
                ? state.toolCalls[state.toolCalls.length - 1].index + 1
                : 0;
            slot = { index, id: "", name: "", arguments: "" };
            state.toolCalls.push(slot);
            state.toolCalls.sort((a, b) => a.index - b.index);
          }
          if (typeof chunk.id === "string" && chunk.id.length > 0) slot.id = chunk.id;
          if (incomingName.length > 0) slot.name = incomingName;
          if (typeof chunk.argumentsDelta === "string") slot.arguments += chunk.argumentsDelta;
          break;
        }
        case "usage":
          state.usage = chunk.usage ?? state.usage;
          break;
        case "finish":
          state.finish = chunk.reason ?? { kind: "stop" };
          break;
        default:
          break;
      }
    },
    openAiMessage() {
      const toolCalls = state.toolCalls.filter((entry) => entry.name.length > 0);
      const message = { role: "assistant" };
      /* 显式分支（原来的嵌套三元读起来容易看反）：有工具调用时 content 必须是 null
         ——「有调用没正文」和「空回复」是两回事。 */
      if (state.text.length > 0) message.content = state.text;
      else if (toolCalls.length > 0) message.content = null;
      else message.content = "";
      /* 思考过程单独带出去（DeepSeek/DSH 的约定字段）。以前只累积不消费，等于把
         「模型把预算全烧在思考、正文为空」这种失败（真机见过 finish_reason=length +
         reasoningTokens=16384）唯一的线索丢掉（v0.6.1 真机自审发现）。 */
      if (state.reasoning.length > 0) message.reasoning_content = state.reasoning;
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls.map((entry, index) => ({
          id: entry.id || "call_" + index,
          type: "function",
          function: { name: entry.name, arguments: entry.arguments.length > 0 ? entry.arguments : "{}" },
        }));
      }
      return message;
    },
    /**
     * 流跑完了，却没有 finish 事件 —— 这次调用没有终态，就是「流被截断」。
     *
     * 契约依据（v0.5.6 自审时去核了适配器源码 `dsh-llm-pi-ai` 的 `toStreamChunks`）：正常结束时
     * 它一定先发 `usage` 再发 `finish`；上游出错也走 in-band `error` 事件 → 同样以 `finish` 收尾；
     * 真在流中间断掉它自己会抛 `LlmError("pi-ai event stream ended without done/error", "STREAM_CLOSED")`。
     * 所以「没有 finish」只可能意味着流被截断、或被我们（客户端断开/桥超时）掐断。
     *
     * v0.5.4 的判定是「没有 finish **且** 没有任何正文/工具调用」，于是「先吐出部分正文、再断流」
     * （`stream ended before a terminal response event` 的另一半情形）会被当成成功，ocr 拿到半截
     * 内容还以为评审跑完了。半截正文同样是截断，所以现在只看终态。
     */
    truncated() {
      return !state.finish;
    },
    finishReason() {
      const kind = state.finish && typeof state.finish.kind === "string" ? state.finish.kind : "stop";
      if (kind === "max-tokens") return "length";
      if (kind === "stop") return this.openAiMessage().tool_calls ? "tool_calls" : "stop";
      return kind;
    },
    failure() {
      const kind = state.finish && state.finish.kind;
      if (kind !== "error" && kind !== "aborted") return null;
      const failure = state.finish.failure ?? {};
      const code = typeof failure.code === "string" ? failure.code : kind === "aborted" ? "aborted" : "upstream_error";
      const message = typeof failure.message === "string" && failure.message.length > 0 ? failure.message : "DSH 的模型调用没有完成（" + kind + "）";
      return { kind, code, message };
    },
  };
}

/** 把累积结果装配成 OpenAI 的 chat.completion 响应体。 */
export function toOpenAiCompletion({ id, model, created, accumulator }) {
  const { state } = accumulator;
  const message = accumulator.openAiMessage();
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: accumulator.finishReason() }],
    usage: toOpenAiUsage(state.usage) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** 非流式请求的 SSE 帧（ocr 用不到，但保持协议完整）。 */
export function openAiStreamFrames({ id, model, created, accumulator }) {
  const { state } = accumulator;
  const frames = [];
  const chunk = (delta, finishReason = null) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  /* 正文先发：模型可能同时给正文和工具调用，非流式路径会把正文放进 message.content，
     流式路径以前只要检测到 tool_calls 就把它整段丢掉（v0.5.4 修）。
     思考过程同样带出去（与非流式路径的 message.reasoning_content 同源）。 */
  if (state.reasoning.length > 0) frames.push(chunk({ reasoning_content: state.reasoning }));
  if (state.text.length > 0) frames.push(chunk({ content: state.text }));
  if (accumulator.openAiMessage().tool_calls) {
    const calls = accumulator.openAiMessage().tool_calls;
    calls.forEach((call, index) => {
      frames.push(chunk({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } }] }));
      frames.push(chunk({ tool_calls: [{ index, function: { arguments: call.function.arguments } }] }));
    });
    frames.push(chunk({}, "tool_calls"));
  } else {
    frames.push(chunk({}, accumulator.finishReason()));
  }
  const usage = toOpenAiUsage(state.usage);
  if (usage) frames.push({ id, object: "chat.completion.chunk", created, model, choices: [], usage });
  return frames;
}

/** OpenAI 风格的错误体。 */
export function toOpenAiError(message, code = "bridge_error", type = "invalid_request_error") {
  return { error: { message, type, code } };
}

/** 从请求头里取 Bearer token。 */
export function bearerTokenOf(header) {
  if (typeof header !== "string") return "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

/**
 * 读完请求体。三件事都必须做对，否则会挂住或吞掉响应：
 * - 超限：先停读、返回 413（由调用方写出响应），**不要**在这里 destroy——先 destroy 会把 413 吞掉，
 *   客户端只看到 ECONNRESET。
 * - 客户端中途断开：立刻 reject，别让这个 Promise 永远悬着（每个悬着的请求都会钉住一个 32MB 上限的缓冲）。
 * - 正常结束：resolve 文本。
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        req.pause();
        /* 已经收进缓冲的部分要立刻放掉：外层 catch 会在写完 413 之后才 req.destroy()，
           在那之前这些 Buffer 一直被这个 pending Promise 持有（自审发现：注释担心过
           「悬着的请求钉住缓冲」，这里正是同一类问题的小窗口）。 */
        chunks.length = 0;
        finish(reject, new BridgeError("请求体超过 " + limit + " 字节上限", 413, "body_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(resolve, Buffer.concat(chunks).toString("utf8")));
    req.on("error", (error) => finish(reject, error));
    req.on("aborted", () => finish(reject, new BridgeError("客户端在发送请求体时断开了连接", 400, "client_aborted")));
    req.on("close", () => {
      if (!req.complete) finish(reject, new BridgeError("客户端在发送请求体时断开了连接", 400, "client_aborted"));
    });
  });
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  /* 客户端可能在读 body 的过程中就断开了：这时 writeHead/end 会同步抛（EPIPE /
     ERR_STREAM_DESTROYED），绝不能让异常冒到 createServer 的回调之外（未处理异常会杀进程）。 */
  try {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
    res.end(text);
  } catch {
    /* 连接已断，忽略 */
  }
}

/**
 * 起一个只对本机开放的 OpenAI 兼容桥。
 *
 * @param options.stream - (dshOptions) => AsyncIterable<chunk>，通常是 ctx.llm.stream
 * @param options.target - () => { provider, model }，每次请求现取（设置改了立刻生效）
 * @param options.logger - 可选，cordis logger
 * @param options.timeoutMs - 单次上游调用兜底超时
 * @param options.now - 可选，测试注入时钟
 * @returns 桥句柄：{ url, token, port, close(), describe() }
 */
export async function startLlmBridge(options) {
  const { stream, target } = options ?? {};
  if (typeof stream !== "function") throw new Error("startLlmBridge 需要 stream(options)");
  if (typeof target !== "function") throw new Error("startLlmBridge 需要 target()");
  const logger = options.logger ?? noopLogger;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const token = randomBytes(24).toString("hex");
  const inflight = new Set();
  const stats = {
    requests: 0,
    failed: 0,
    rejected: 0,
    retries: 0,
    retrySkips: 0,
    retrySkipReason: "",
    tokens: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, partial: 0 },
    lastError: null,
    lastReject: null,
    lastModel: null,
    lastProvider: null,
    startedAt: now(),
  };

  /* 「到达桥但根本没转发出去」的请求单独计数（自审发现）：以前它们直接记进 failed，
     于是 diagnostics 里会出现「已转发 0 次 · 失败 1 次」这种自相矛盾的数字，而且一次 401
     或未配路由会把真正的上游失败盖掉。failed 只留给「转发出去但失败」的上游调用。
     只统计「本想跑补全、被桥拒掉」的那几种：鉴权失败 / 请求体不合法 / 空 messages / 路由缺失。 */
  const rejectRequest = (code, message) => {
    stats.rejected += 1;
    stats.lastReject = `${message}（${code}）`;
  };

  const server = createServer((req, res) => {
    // 客户端断开后往 res 写会抛（EPIPE / ERR_STREAM_DESTROYED）：这里吞掉，绝不让它冒到
    // 请求回调之外——那会变成未处理异常，在 Node 里足以杀掉整个进程。
    res.on("error", () => {});
    void handle(req, res).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof BridgeError ? error.status : 500;
      const code = error instanceof BridgeError ? error.code : "bridge_failure";
      if (!(error instanceof BridgeError) || status >= 500) logger.warn?.("桥处理请求失败：" + message);
      let wrote = false;
      try {
        if (!res.headersSent && !res.writableEnded) {
          sendJson(res, status, toOpenAiError(message, code));
          wrote = true;
        } else {
          res.end();
        }
      } catch {
        /* 连接已断，忽略 */
      }
      // 请求体超限/客户端半途断开：错误响应交出去之后才拆连接，否则 413 会被 ECONNRESET 吞掉。
      if (code === "body_too_large" || code === "client_aborted") {
        const drop = () => {
          try {
            req.destroy();
          } catch {
            /* 忽略 */
          }
        };
        if (wrote && !res.writableFinished) res.once("finish", drop);
        else drop();
      }
    });
  });

  async function handle(req, res) {
    const url = req.url ?? "";
    const path = url.split("?")[0];
    if (req.method !== "POST" || path !== BRIDGE_COMPLETIONS_PATH) {
      sendJson(res, 404, toOpenAiError("桥只提供 " + BRIDGE_COMPLETIONS_PATH, "not_found", "invalid_request_error"));
      return;
    }
    if (bearerTokenOf(req.headers.authorization) !== token) {
      rejectRequest("unauthorized", "鉴权失败：Authorization 头里的 token 与桥的 token 不一致");
      stats.lastError = "鉴权失败：Authorization 头里的 token 与桥的 token 不一致";
      sendJson(res, 401, toOpenAiError("鉴权失败", "unauthorized", "authentication_error"));
      return;
    }
    const raw = await readBody(req, MAX_BODY_BYTES);
    let body;
    try {
      body = JSON.parse(raw);
    } catch (error) {
      rejectRequest("invalid_json", "请求体不是合法 JSON");
      sendJson(res, 400, toOpenAiError("请求体不是合法 JSON：" + (error instanceof Error ? error.message : String(error)), "invalid_json"));
      return;
    }
    /* 合法 JSON 不等于可用请求体：`null` / `123` / `[]` 都能通过 JSON.parse，然后 `body.messages`
       直接把桥打崩（v0.5.6 自审发现：`JSON.parse("null")` → TypeError: Cannot read properties of
       null）。这里先立一道形状闸门；`messages` 不是数组单独拦（v0.6.1 真机自审发现：以前直接交给
       `toDshMessages` 抛错，既漏记 stats.rejected，又让下面的 empty_messages 分支永远走不到）；
       「是数组但没有可翻译内容」仍然交给 empty_messages。 */
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      rejectRequest("invalid_body", "请求体必须是一个 JSON 对象");
      sendJson(res, 400, toOpenAiError("请求体必须是一个 JSON 对象（形如 {\"messages\":[…] }）", "invalid_body", "invalid_request_error"));
      return;
    }
    if (!Array.isArray(body.messages)) {
      rejectRequest("invalid_messages", "messages 必须是数组");
      sendJson(res, 400, toOpenAiError("messages 必须是数组（形如 [{\"role\":\"user\",\"content\":\"…\"}]）", "invalid_messages", "invalid_request_error"));
      return;
    }
    const routing = target() ?? {};
    const provider = typeof routing.provider === "string" ? routing.provider : "";
    const model = typeof routing.model === "string" ? routing.model : "";
    // 先取路由再翻译：assistant 消息的 source 要写本次转发的 provider/model。
    const { system, messages } = toDshMessages(body.messages, { provider, model });
    if (messages.length === 0) {
      rejectRequest("empty_messages", "messages 里没有任何可翻译的内容");
      sendJson(res, 400, toOpenAiError("messages 里没有任何可翻译的内容", "empty_messages"));
      return;
    }
    if (provider.length === 0 || model.length === 0) {
      rejectRequest("missing_route", "DSH 侧没有配好 provider/model，桥无法转发");
      stats.lastError = "DSH 侧没有配好 provider/model，桥无法转发";
      sendJson(res, 500, toOpenAiError("插件设置里还没有选定 DSH 的 provider 与模型名，桥无法转发", "missing_route"));
      return;
    }
    stats.requests += 1;
    /* 上一次请求留下的「未重试原因」不能跟着带到这一次：否则后一次是「重试过仍失败」
       （不写这条原因）却会打印上一条的原因，同一行里出现错配诊断（自审发现）。 */
    stats.retrySkipReason = "";
    stats.lastProvider = provider;
    stats.lastModel = model;
    const controller = new AbortController();
    const entry = { controller, done: false };
    inflight.add(entry);
    // 客户端断开（ocr 被取消/超时/进程退出）时立刻掐掉上游：否则这次 llm.stream 会继续烧配额。
    const onClientGone = () => {
      if (entry.done) return;
      try {
        controller.abort(new Error(SELF_ABORT_MESSAGES.clientGone));
      } catch {
        /* 忽略 */
      }
    };
    res.on("close", onClientGone);
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error(SELF_ABORT_MESSAGES.timeout)), timeoutMs) : null;
    /**
     * 这次上游被谁掐断的？空串 = 没被掐断。
     *
     * v0.5.5 的自审修复把所有写入都挡在 `clientGone()` 后面，而那个判定把三件事混成了一件事：
     * ①客户端真断开 ②桥自己的超时 ③桥被 close。后果是：桥超时而客户端还连着时，这里会
     * 「不写响应、也不计失败」直接返回 —— ocr 只能干等它自己的 `--timeout`，`stats.failed`
     * 也看不出发生过什么（v0.5.6 自审发现）。现在按 abort 原因分开判。
     */
    const abortedBy = () => {
      const reason = controller.signal.reason;
      const text = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
      if (text === SELF_ABORT_MESSAGES.clientGone) return "client";
      if (text === SELF_ABORT_MESSAGES.timeout) return "timeout";
      if (text === SELF_ABORT_MESSAGES.closed) return "closed";
      return controller.signal.aborted === true ? "unknown" : "";
    };
    /** socket 侧真的写不动了（writableEnded / destroyed）—— 与「我们主动 abort 上游」无关。 */
    const socketDead = () => res.writableEnded === true || res.destroyed === true;
    /** 客户端真的走了：socket 已销毁，或断开事件掐掉了上游。这种情况结果没人要。 */
    const clientReallyGone = () => socketDead() || abortedBy() === "client";
    const writeRaw = (text) => {
      if (socketDead()) return false;
      try {
        res.write(text);
        return true;
      } catch (error) {
        logger.warn?.("本地 LLM 桥：写响应失败（客户端多半已断开）：" + (error instanceof Error ? error.message : String(error)));
        return false;
      }
    };
    const endRaw = () => {
      if (socketDead()) return;
      try {
        res.end();
      } catch {
        /* 连接已断，忽略 */
      }
    };
    const id = "chatcmpl-" + randomBytes(12).toString("hex");
    const created = Math.floor(now() / 1000);
    try {
      const dshOptions = { provider, model, messages, signal: controller.signal };
      if (system !== undefined) dshOptions.system = system;
      const tools = toDshTools(body.tools, logger);
      if (tools) dshOptions.tools = tools;
      const maxTokens = Number(body.max_completion_tokens ?? body.max_tokens);
      if (Number.isFinite(maxTokens) && maxTokens > 0) dshOptions.maxTokens = maxTokens;
      if (typeof body.temperature === "number") dshOptions.temperature = body.temperature;

      let accumulator = createAccumulator();
      const wantsStream = body.stream === true;
      if (wantsStream) {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
      }
      /* 上游流先跑完再写客户端，所以这里可以安全重试；只重试上游自己的瞬时故障。 */
      let failure = null;
      let retrySkip = "";
      let attempts = 0;
      for (let attempt = 1; ; attempt += 1) {
        attempts = attempt;
        accumulator = createAccumulator();
        try {
          for await (const chunk of await stream(dshOptions)) {
            accumulator.push(chunk);
          }
        } catch (error) {
          /* 上游也可能以「抛出」的形式失败（fetch failed / socket hang up / 提前关闭）：以前这种异常
             会直接穿透整个重试循环，于是 RETRYABLE_UPSTREAM_RE 里明确列出的网络错误**永远不重试**，
             headers 已发时客户端还只拿到半截 SSE（既没有 error 帧也没有 [DONE]）。这里归一成同一种
             failure，交给下面的既有判定与重试。 */
          const message = error instanceof Error ? error.message : String(error);
          accumulator.state.finish = { kind: "error", failure: { code: "upstream_error", message } };
        }
        failure = accumulator.failure();
        if (!failure && accumulator.truncated()) {
          /* 没有终态：分清「上游自己断了」和「我们自己掐的」，两种都失败，但结果码与文案要诚实。 */
          const aborted = abortedBy();
          if (aborted === "timeout" || aborted === "closed") {
            failure = {
              kind: "error",
              code: aborted === "timeout" ? "upstream_timeout" : "bridge_closed",
              message: SELF_ABORT_MESSAGES[aborted],
            };
          } else {
            failure = {
              kind: "error",
              code: "upstream_truncated",
              message:
                "OpenAI Responses stream ended before a terminal response event（上游没有发出 finish 事件；" +
                (accumulator.state.text.length > 0 || accumulator.openAiMessage().tool_calls
                  ? "已经收到的半截内容不算完成）"
                  : "也没有任何内容）"),
            };
          }
        }
        if (!failure || attempt >= MAX_UPSTREAM_ATTEMPTS) break;
        if (controller.signal.aborted) {
          const why = abortedBy();
          retrySkip = ABORT_SKIP_REASONS[why] ?? `上游被中止（原因不明：${why || "空"}，不重试）`;
          break;
        }
        const verdict = classifyUpstreamFailure(failure);
        if (!verdict.retryable) {
          retrySkip = verdict.reason;
          break;
        }
        stats.retries += 1;
        logger.warn?.(`本地 LLM 桥：上游失败（${failure.message}），重试第 ${attempt} 次`);
      }
      /* 客户端真的走了：结果没人要，既不该写回一个销毁的 socket，也不该记成「上游失败」
         （那是我们自己掐的）。注意桥自己的超时/close 不在这里 —— 那种情况客户端还在等，
         必须给它一个交代（失败分支会写 502 或 SSE error 帧，并计入 stats.failed）。 */
      if (clientReallyGone()) {
        logger.warn?.("本地 LLM 桥：客户端已断开，丢弃这次上游结果（不写响应，也不计失败）");
        return;
      }
      if (failure) {
        stats.failed += 1;
        stats.lastError = failure.message;
        // 只有「该重试却没试」才记跳过：已经重试过的失败不再计，retries 已经说明发生过什么。
        if (retrySkip && attempts < MAX_UPSTREAM_ATTEMPTS) {
          stats.retrySkips += 1;
          stats.retrySkipReason = retrySkip;
          logger.warn?.(`本地 LLM 桥：这次失败不重试（${retrySkip}）：${failure.message}`);
        }
        if (!res.headersSent) {
          sendJson(res, 502, toOpenAiError(failure.message, failure.code, "upstream_error"));
          return;
        }
        if (!writeRaw("data: " + JSON.stringify(toOpenAiError(failure.message, failure.code, "upstream_error")) + "\n\n")) return;
        writeRaw("data: [DONE]\n\n");
        endRaw();
        return;
      }
      // 成功的上游调用：把 usage 累加进桥的统计（自动评审的成本可见性）。
      const usage = toOpenAiUsage(accumulator.state.usage);
      if (usage) {
        accumulateUsage(stats.tokens, usage);
      }
      if (wantsStream) {
        for (const frame of openAiStreamFrames({ id, model: body.model || model, created, accumulator })) {
          if (!writeRaw("data: " + JSON.stringify(frame) + "\n\n")) return;
        }
        writeRaw("data: [DONE]\n\n");
        endRaw();
        return;
      }
      sendJson(res, 200, toOpenAiCompletion({ id, model: body.model || model, created, accumulator }));
    } finally {
      entry.done = true;
      res.off?.("close", onClientGone);
      inflight.delete(entry);
      if (timer) clearTimeout(timer);
    }
  }

  await new Promise((resolve, reject) => {
    const onListenError = (error) => reject(error);
    server.once("error", onListenError);
    server.listen(0, BIND_HOST, () => {
      server.removeListener("error", onListenError);
      // 监听成功之后必须常驻一个 error 监听：否则迟到的 'error'（如 EMFILE）会变成未处理异常杀进程。
      server.on("error", (error) => {
        logger.warn?.("本地 LLM 桥出错：" + (error instanceof Error ? error.message : String(error)));
      });
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = "http://" + BIND_HOST + ":" + port + BRIDGE_PATH_PREFIX;

  return {
    url: base,
    token,
    port,
    stats,
    describe() {
      return {
        url: base,
        tokenMasked: token.slice(0, 6) + "…" + token.slice(-4),
        requests: stats.requests,
        failed: stats.failed,
        rejected: stats.rejected,
        retries: stats.retries,
        retrySkips: stats.retrySkips,
        retrySkipReason: stats.retrySkipReason,
        tokens: { ...stats.tokens },
        lastError: stats.lastError,
        lastReject: stats.lastReject,
        lastProvider: stats.lastProvider,
        lastModel: stats.lastModel,
        inflight: inflight.size,
        uptimeMs: now() - stats.startedAt,
      };
    },
    async close() {
      for (const entry of inflight) {
        try {
          entry.controller.abort(new Error(SELF_ABORT_MESSAGES.closed));
        } catch {
          /* 忽略 */
        }
      }
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const timer = setTimeout(() => {
          // 还有连接挂着（keep-alive 或客户端不发完 body）：强拆，不卡插件卸载。
          try {
            server.closeAllConnections?.();
          } catch {
            /* 忽略 */
          }
          finish();
        }, CLOSE_GRACE_MS);
        timer.unref?.();
        server.close(() => {
          clearTimeout(timer);
          finish();
        });
      });
    },
  };
}
