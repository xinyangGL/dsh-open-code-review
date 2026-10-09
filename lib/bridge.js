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
/** 我方主动掐断上游（客户端断开/桥超时/桥关闭）——这不是上游的错，重试没有意义。 */
const SELF_ABORT_RE = /客户端断开|桥的上游调用超时|桥已关闭/;
/** 判为「上游瞬时故障、值得重试一次」的错误文本。 */
const RETRYABLE_UPSTREAM_RE =
  /stream ended before a terminal|ended before a terminal|premature close|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|fetch failed|terminated|rate ?limit|429|50[234]|overloaded|service unavailable|temporarily unavailable/i;

/**
 * 这次上游失败是否值得重试：只有「上游自己出的瞬时故障」才算，我方主动 abort 不算。
 * @param {{kind?: string, code?: string, message?: string}|null} failure
 * @returns {boolean}
 */
export function isRetryableUpstreamFailure(failure) {
  if (!failure || typeof failure.message !== "string" || failure.message.length === 0) return false;
  if (failure.kind === "aborted") return false;
  if (SELF_ABORT_RE.test(failure.message)) return false;
  return RETRYABLE_UPSTREAM_RE.test(failure.message);
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
  if (!stats || !Number.isFinite(stats.failed) || stats.failed <= 0) return null;
  const parts = [`本机桥：已转发 ${Number(stats.requests) || 0} 次`, `失败 ${stats.failed} 次`];
  if (Number(stats.retries) > 0) parts.push(`上游重试 ${stats.retries} 次`);
  const model = stats.lastModel ? `（模型 ${stats.lastModel}）` : "";
  const last = stats.lastError ? ` · 最近错误：${stats.lastError}${model}` : "";
  return `${parts.join(" · ")}${last} —— ocr 打印的「check your LLM configuration and API key」是它的通用提示，未必是密钥问题。`;
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

/** 把 DSH 的 usage 归一成 OpenAI 的 usage 字段（字段名不保证，尽量两套都认）。 */
export function toOpenAiUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const pick = (...names) => {
    for (const name of names) if (typeof usage[name] === "number") return usage[name];
    return undefined;
  };
  const prompt = pick("promptTokens", "inputTokens", "prompt_tokens", "input_tokens");
  const completion = pick("completionTokens", "outputTokens", "completion_tokens", "output_tokens");
  const total = pick("totalTokens", "total_tokens") ?? ((prompt ?? 0) + (completion ?? 0) || undefined);
  const out = {};
  if (prompt !== undefined) out.prompt_tokens = prompt;
  if (completion !== undefined) out.completion_tokens = completion;
  if (total !== undefined) out.total_tokens = total;
  return Object.keys(out).length > 0 ? out : undefined;
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
    chunks: 0,
  };
  return {
    state,
    push(chunk) {
      if (!chunk || typeof chunk !== "object") return;
      state.chunks += 1;
      switch (chunk.type) {
        case "text-delta":
          if (typeof chunk.text === "string") state.text += chunk.text;
          break;
        case "reasoning-delta":
          if (typeof chunk.text === "string") state.reasoning += chunk.text;
          break;
        case "tool-call-delta": {
          const index = typeof chunk.index === "number" ? chunk.index : state.toolCalls.length;
          let slot = state.toolCalls.find((entry) => entry.index === index);
          if (!slot) {
            slot = { index, id: "", name: "", arguments: "" };
            state.toolCalls.push(slot);
            state.toolCalls.sort((a, b) => a.index - b.index);
          }
          if (typeof chunk.id === "string" && chunk.id.length > 0) slot.id = chunk.id;
          if (typeof chunk.name === "string" && chunk.name.length > 0) slot.name = chunk.name;
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
    openAiMessage(model) {
      const toolCalls = state.toolCalls.filter((entry) => entry.name.length > 0);
      const message = { role: "assistant", content: state.text.length > 0 ? state.text : toolCalls.length > 0 ? null : "" };
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls.map((entry, index) => ({
          id: entry.id || "call_" + index,
          type: "function",
          function: { name: entry.name, arguments: entry.arguments.length > 0 ? entry.arguments : "{}" },
        }));
      }
      return message;
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
  if (accumulator.openAiMessage().tool_calls) {
    const calls = accumulator.openAiMessage().tool_calls;
    calls.forEach((call, index) => {
      frames.push(chunk({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } }] }));
      frames.push(chunk({ tool_calls: [{ index, function: { arguments: call.function.arguments } }] }));
    });
    frames.push(chunk({}, "tool_calls"));
  } else {
    if (state.text.length > 0) frames.push(chunk({ content: state.text }));
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
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
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
  const stats = { requests: 0, failed: 0, retries: 0, lastError: null, lastModel: null, lastProvider: null, startedAt: now() };

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
      stats.failed += 1;
      stats.lastError = "鉴权失败：Authorization 头里的 token 与桥的 token 不一致";
      sendJson(res, 401, toOpenAiError("鉴权失败", "unauthorized", "authentication_error"));
      return;
    }
    const raw = await readBody(req, MAX_BODY_BYTES);
    let body;
    try {
      body = JSON.parse(raw);
    } catch (error) {
      sendJson(res, 400, toOpenAiError("请求体不是合法 JSON：" + (error instanceof Error ? error.message : String(error)), "invalid_json"));
      return;
    }
    const routing = target() ?? {};
    const provider = typeof routing.provider === "string" ? routing.provider : "";
    const model = typeof routing.model === "string" ? routing.model : "";
    // 先取路由再翻译：assistant 消息的 source 要写本次转发的 provider/model。
    const { system, messages } = toDshMessages(body.messages, { provider, model });
    if (messages.length === 0) {
      sendJson(res, 400, toOpenAiError("messages 里没有任何可翻译的内容", "empty_messages"));
      return;
    }
    if (provider.length === 0 || model.length === 0) {
      stats.failed += 1;
      stats.lastError = "DSH 侧没有配好 provider/model，桥无法转发";
      sendJson(res, 500, toOpenAiError("插件设置里还没有选定 DSH 的 provider 与模型名，桥无法转发", "missing_route"));
      return;
    }
    stats.requests += 1;
    stats.lastProvider = provider;
    stats.lastModel = model;
    const controller = new AbortController();
    const entry = { controller, done: false };
    inflight.add(entry);
    // 客户端断开（ocr 被取消/超时/进程退出）时立刻掐掉上游：否则这次 llm.stream 会继续烧配额。
    const onClientGone = () => {
      if (entry.done) return;
      try {
        controller.abort(new Error("客户端断开，桥已取消上游调用"));
      } catch {
        /* 忽略 */
      }
    };
    res.on("close", onClientGone);
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error("桥的上游调用超时")), timeoutMs) : null;
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
      for (let attempt = 1; ; attempt += 1) {
        accumulator = createAccumulator();
        for await (const chunk of await stream(dshOptions)) {
          accumulator.push(chunk);
        }
        failure = accumulator.failure();
        if (!failure || attempt >= MAX_UPSTREAM_ATTEMPTS) break;
        if (controller.signal.aborted || !isRetryableUpstreamFailure(failure)) break;
        stats.retries += 1;
        logger.warn?.(`本地 LLM 桥：上游失败（${failure.message}），重试第 ${attempt} 次`);
      }
      if (failure) {
        stats.failed += 1;
        stats.lastError = failure.message;
        if (!res.headersSent) {
          sendJson(res, 502, toOpenAiError(failure.message, failure.code, "upstream_error"));
          return;
        }
        res.write("data: " + JSON.stringify(toOpenAiError(failure.message, failure.code, "upstream_error")) + "\n\n");
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (wantsStream) {
        for (const frame of openAiStreamFrames({ id, model: body.model || model, created, accumulator })) {
          res.write("data: " + JSON.stringify(frame) + "\n\n");
        }
        res.write("data: [DONE]\n\n");
        res.end();
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
        retries: stats.retries,
        lastError: stats.lastError,
        lastProvider: stats.lastProvider,
        lastModel: stats.lastModel,
        inflight: inflight.size,
        uptimeMs: now() - stats.startedAt,
      };
    },
    async close() {
      for (const entry of inflight) {
        try {
          entry.controller.abort(new Error("桥已关闭"));
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
