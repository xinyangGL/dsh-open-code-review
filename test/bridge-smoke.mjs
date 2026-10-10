/**
 * 本地 LLM 桥的离线冒烟测试：不起 DSH，用假的 llm.stream 驱动真实的 HTTP 服务，
 * 并用真实的 HTTP 请求验证 OpenAI 兼容契约（路径、鉴权、请求体键、工具往返）。
 *
 * 用法：node test/bridge-smoke.mjs
 */
import {
  BRIDGE_COMPLETIONS_PATH,
  CLOSE_GRACE_MS,
  MAX_BODY_BYTES,
  SELF_ABORT_MESSAGES,
  SELF_ABORT_RE,
  accumulateUsage,
  bearerTokenOf,
  bridgeFailureNote,
  classifyUpstreamFailure,
  createAccumulator,
  describeTokens,
  isRetryableUpstreamFailure,
  openAiStreamFrames,
  startLlmBridge,
  textOfOpenAiContent,
  toDshMessages,
  toDshTools,
  toOpenAiCompletion,
  toOpenAiError,
  toOpenAiUsage,
} from "../lib/bridge.js";

const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
  if (!ok) failures += 1;
}

/** ocr 会在 OCR_LLM_URL（= bridge.url，已含 /v1）后面拼这一段：从常量派生，避免测试写死路径。 */
const COMPLETIONS_SUFFIX = BRIDGE_COMPLETIONS_PATH.replace(/^\/v1/, "");

function text(value) {
  return JSON.stringify(value);
}

/** 轮询等待（等桥内部的 abort / inflight 变化）。 */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

/* ------------------------------------------------------- 纯函数：请求翻译 */

{
  check("契约常量：桥挂在 /v1/chat/completions（ocr 会在 OCR_LLM_URL 后面拼它）", BRIDGE_COMPLETIONS_PATH === "/v1/chat/completions", BRIDGE_COMPLETIONS_PATH);
  check("textOfOpenAiContent：字符串原样", textOfOpenAiContent("hi") === "hi");
  check(
    "textOfOpenAiContent：parts 拼接、图片降级成占位",
    textOfOpenAiContent([{ type: "text", text: "a" }, { type: "image_url", image_url: { url: "x" } }, "b"]) === "a[图片已忽略：ocr 走的是纯文本审查]b",
  );
  check("textOfOpenAiContent：null 得空串", textOfOpenAiContent(null) === "");

  const tools = toDshTools([
    { type: "function", function: { name: "ocr_selftest", description: "d", parameters: { type: "object", properties: {}, required: [] } } },
    { type: "function", function: { description: "没有名字，应被丢掉" } },
    { name: "plain", description: "已经是 DSH 形状", parameters: { type: "object" } },
  ]);
  check("toDshTools：OpenAI 形状解包成 DSH 的 {name,description,parameters}", tools?.length === 2 && tools[0].name === "ocr_selftest" && tools[0].function === undefined, text(tools));
  check("toDshTools：空数组得 undefined", toDshTools([]) === undefined && toDshTools(undefined) === undefined);

  const translated = toDshMessages([
    { role: "system", content: "系统一" },
    { role: "system", content: "系统二" },
    { role: "user", content: [{ type: "text", text: "用户" }] },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_probe", type: "function", function: { name: "ocr_selftest", arguments: "{\"note\":\"x\"}" } }],
    },
    { role: "tool", tool_call_id: "call_probe", content: "ocr_selftest ok" },
  ], { provider: "commandcode", model: "deepseek/deepseek-v4.1-flash" });
  check("toDshMessages：system 折成 options.system 并用空行连接", translated.system === "系统一\n\n系统二", text(translated.system));
  check("toDshMessages：user 变文本块", translated.messages[0].role === "user" && translated.messages[0].content[0].text === "用户");
  check(
    "toDshMessages：assistant 的 tool_calls 变 DSH 的 tool-call 块（arguments 是 JSON 文本）",
    translated.messages[1].content[0].type === "tool-call" && translated.messages[1].content[0].name === "ocr_selftest" && translated.messages[1].content[0].arguments === "{\"note\":\"x\"}" && translated.messages[1].content[0].id === "call_probe",
    text(translated.messages[1]),
  );
  {
    // 真机教训：assistant 消息缺 source 时，宿主 forAdapter() 会抛
    // Cannot read properties of undefined (reading 'replayState')，整轮工具往返全失败。
    const source = translated.messages[1].source;
    check(
      "toDshMessages：assistant 自带 model source（宿主 forAdapter 的硬要求）",
      source?.kind === "model" && source.provider === "commandcode" && source.model === "deepseek/deepseek-v4.1-flash" && source.replayState === undefined,
      text(source),
    );
    const fallbackSource = toDshMessages([{ role: "assistant", content: "hi" }]).messages[0].source;
    check(
      "toDshMessages：没给路由时也不缺 source（宁可为空串，也不能 undefined —— 宿主把 null 也当缺）",
      fallbackSource !== null && typeof fallbackSource === "object",
      text(fallbackSource),
    );
    check(
      "toDshMessages：role=tool 变 DSH 的 tool 消息（带 toolCallId + source.kind=tool）",
      translated.messages[2].source?.kind === "tool" && translated.messages[2].source.callId === "call_probe",
      text(translated.messages[2].source),
    );
  }
  check(
    "toDshMessages：role=tool 变 DSH 的 tool 消息（带 toolCallId）",
    translated.messages[2].role === "tool" && translated.messages[2].toolCallId === "call_probe" && translated.messages[2].content[0].text === "ocr_selftest ok",
    text(translated.messages[2]),
  );
  let badMessages = "";
  try {
    toDshMessages("不是数组");
  } catch (error) {
    badMessages = error.message;
  }
  check("toDshMessages：非数组报 400", badMessages.includes("messages 必须是数组"), badMessages);
}

/* --------------------------------------------------- 纯函数：响应与流累积 */

{
  const acc = createAccumulator();
  acc.push({ type: "block-start", index: 0, blockType: "text" });
  acc.push({ type: "reasoning-delta", index: 0, text: "想一想" });
  acc.push({ type: "text-delta", index: 0, text: "po" });
  acc.push({ type: "text-delta", index: 0, text: "ng" });
  acc.push({ type: "usage", usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } });
  acc.push({ type: "finish", reason: { kind: "stop" } });
  check("累积器：文本 delta 拼接", acc.state.text === "pong", acc.state.text);
  check("累积器：reasoning 单独记，不混进正文", acc.state.reasoning === "想一想" && acc.openAiMessage().content === "pong");
  check("累积器：stop 的 finish_reason 是 stop", acc.finishReason() === "stop" && acc.failure() === null);
  const completion = toOpenAiCompletion({ id: "chatcmpl-x", model: "m", created: 1, accumulator: acc });
  check(
    "toOpenAiCompletion：OpenAI 响应骨架",
    completion.object === "chat.completion" && completion.choices[0].message.role === "assistant" && completion.choices[0].message.content === "pong" && completion.choices[0].finish_reason === "stop",
    text(completion),
  );
  check("toOpenAiCompletion：usage 归一成 prompt_tokens/completion_tokens/total_tokens", completion.usage.prompt_tokens === 7 && completion.usage.completion_tokens === 3 && completion.usage.total_tokens === 10, text(completion.usage));
  const frames = openAiStreamFrames({ id: "chatcmpl-x", model: "m", created: 1, accumulator: acc });
  check("openAiStreamFrames：内容帧 + 终止帧 + usage 帧", frames.length === 3 && frames[0].choices[0].delta.content === "pong" && frames[1].choices[0].finish_reason === "stop" && frames[2].usage.total_tokens === 10, text(frames));

  const toolAcc = createAccumulator();
  toolAcc.push({ type: "tool-call-delta", index: 0, id: "call_probe", name: "ocr_selftest", argumentsDelta: "{\"note\":" });
  toolAcc.push({ type: "tool-call-delta", index: 0, argumentsDelta: "\"x\"}" });
  toolAcc.push({ type: "finish", reason: { kind: "stop" } });
  const toolMessage = toolAcc.openAiMessage();
  check(
    "累积器：工具调用拼成 OpenAI 的 tool_calls（arguments 是字符串）",
    toolMessage.content === null && toolMessage.tool_calls[0].id === "call_probe" && toolMessage.tool_calls[0].function.name === "ocr_selftest" && toolMessage.tool_calls[0].function.arguments === "{\"note\":\"x\"}",
    text(toolMessage),
  );
  check("累积器：有工具调用时 finish_reason 是 tool_calls", toolAcc.finishReason() === "tool_calls", toolAcc.finishReason());
  const toolFrames = openAiStreamFrames({ id: "chatcmpl-x", model: "m", created: 1, accumulator: toolAcc });
  check("openAiStreamFrames：工具帧先给 name 再给 arguments，最后 finish_reason=tool_calls", toolFrames[0].choices[0].delta.tool_calls[0].function.name === "ocr_selftest" && toolFrames[1].choices[0].delta.tool_calls[0].function.arguments === "{\"note\":\"x\"}" && toolFrames[2].choices[0].finish_reason === "tool_calls", text(toolFrames));

  const errAcc = createAccumulator();
  errAcc.push({ type: "finish", reason: { kind: "error", failure: { code: "UPSTREAM", message: "上游 500" } } });
  const errFailure = errAcc.failure();
  check("累积器：error 终结块被识别成失败（含 code/message）", errFailure?.code === "UPSTREAM" && errFailure?.message === "上游 500", text(errFailure));
  const abortAcc = createAccumulator();
  abortAcc.push({ type: "finish", reason: { kind: "aborted" } });
  check("累积器：aborted 也当失败，且给出兜底文案", abortAcc.failure()?.code === "aborted" && abortAcc.failure().message.length > 0, text(abortAcc.failure()));
  const maxAcc = createAccumulator();
  maxAcc.push({ type: "text-delta", index: 0, text: "x" });
  maxAcc.push({ type: "finish", reason: { kind: "max-tokens" } });
  check("累积器：max-tokens → length", maxAcc.finishReason() === "length");

  check("toOpenAiUsage：认 DSH 与 OpenAI 两套字段名", toOpenAiUsage({ inputTokens: 2, outputTokens: 4 }).prompt_tokens === 2 && toOpenAiUsage({ inputTokens: 2, outputTokens: 4 }).total_tokens === 6, text(toOpenAiUsage({ inputTokens: 2, outputTokens: 4 })));
  check("toOpenAiUsage：没有可用字段时返回 undefined", toOpenAiUsage({}) === undefined && toOpenAiUsage(null) === undefined);
  /* v0.6.1（OCR 自审发现）：`state.chunks` 只自增、没有任何读取方，删掉以免让人以为有「chunk 数」这层统计。 */
  check("累积器（v0.6.1）：不再保留没有读取方的 state.chunks 死字段", !("chunks" in acc.state) && !("chunks" in toolAcc.state), Object.keys(acc.state).join(","));
  check("bearerTokenOf：大小写与多余空格都认", bearerTokenOf("Bearer  abc ") === "abc" && bearerTokenOf("bearer xyz") === "xyz" && bearerTokenOf("Basic zzz") === "");
  check("toOpenAiError：OpenAI 错误体骨架", toOpenAiError("boom", "code_x", "authentication_error").error.code === "code_x" && toOpenAiError("boom").error.type === "invalid_request_error");
}

/* ------------------------------------------------------------ 真 HTTP 服务 */

/** 假的 DSH llm.stream：按脚本吐 chunk，并记录收到的 options。 */
function fakeStream(script) {
  const calls = [];
  const stream = async function* stream(options) {
    calls.push(options);
    const chunks = typeof script === "function" ? script(options, calls.length) : script;
    for (const chunk of chunks) {
      if (chunk && chunk.__throw) throw new Error(chunk.__throw);
      yield chunk;
    }
  };
  return { stream, calls };
}

/**
 * 宿主的真行为（dsh-llm/lib/index.js 的 forAdapter，以及 pi-ai/deepseek 适配器的
 * toPiAssistant）：assistant 消息没有 source 时，真机会抛
 * `Cannot read properties of undefined (reading 'replayState')`；role=tool 的
 * toolCallId 对不上时，deepseek 适配器抛 INVALID_REQUEST（tool result has no
 * matching call）—— 假 ctx / 假 llm 服务完全拦不住这一类「宿主契约」错误，
 * 所以在这里逐字复刻那两条读取路径。
 * @returns 问题描述列表（空数组＝合规）。
 */
function hostAssistantSourceProblems(calls) {
  const problems = [];
  for (const options of calls) {
    for (const message of options.messages) {
      if (message.role === "tool") {
        if (typeof message.toolCallId !== "string" || message.toolCallId.length === 0) {
          problems.push("role=tool 缺 toolCallId（适配器会抛 INVALID_REQUEST：tool result has no matching call）");
          continue;
        }
        if (message.source?.kind !== "tool" || message.source.callId !== message.toolCallId) {
          problems.push("role=tool 的 source 与 toolCallId 不一致：" + text(message.source));
        }
        continue;
      }
      if (message.role !== "assistant") continue;
      const source = message.source; // forAdapter: const source = message.source;
      if (source === undefined || source === null) {
        problems.push("assistant 消息缺 source（宿主会抛 Cannot read properties of undefined (reading 'replayState')）");
        continue;
      }
      if (source.kind !== "model") problems.push("source.kind=" + String(source.kind));
      if (typeof source.provider !== "string" || source.provider.length === 0) problems.push("source.provider 为空");
      if (typeof source.model !== "string" || source.model.length === 0) problems.push("source.model 为空");
      if (source.provider !== options.provider || source.model !== options.model) {
        problems.push("source 路由(" + source.provider + "/" + source.model + ")≠本次转发路由(" + options.provider + "/" + options.model + ")");
      }
    }
  }
  return problems;
}

async function post(base, token, body, headers = {}) {
  // base 已经是 http://127.0.0.1:<port>/v1，ocr 自己会拼 /chat/completions。
  const response = await fetch(base + COMPLETIONS_SUFFIX, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: "Bearer " + token }), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const raw = await response.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  return { status: response.status, json, raw, contentType: response.headers.get("content-type") ?? "" };
}

const seen = [];
const logger = { info() {}, warn(m) { seen.push("warn:" + m); }, debug(m) { seen.push("debug:" + m); }, error(m) { seen.push("error:" + m); } };

const happy = fakeStream([{ type: "text-delta", index: 0, text: "pong" }, { type: "finish", reason: { kind: "stop" } }]);
const happyBridge = await startLlmBridge({ stream: happy.stream, target: () => ({ provider: "commandcode", model: "deepseek/deepseek-v4.1-flash" }), logger });

check("桥：url 只绑定 127.0.0.1 且以 /v1 结尾", /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(happyBridge.url), happyBridge.url);
check("桥：token 是随机长串", happyBridge.token.length >= 32 && happyBridge.url.includes(String(happyBridge.port)), "token 长度=" + happyBridge.token.length);

const unauth = await post(happyBridge.url, null, { model: "m", messages: [{ role: "user", content: "hi" }] });
check("桥：缺 Authorization 头 → 401", unauth.status === 401 && unauth.json.error.code === "unauthorized", unauth.status + " " + unauth.raw.slice(0, 120));
const wrongToken = await post(happyBridge.url, "deadbeef", { model: "m", messages: [{ role: "user", content: "hi" }] });
check("桥：token 不对 → 401", wrongToken.status === 401, String(wrongToken.status));
const wrongPath = await fetch("http://127.0.0.1:" + happyBridge.port + "/v1/models", { headers: { authorization: "Bearer " + happyBridge.token } });
check("桥：只提供 /v1/chat/completions，其它路径 → 404", wrongPath.status === 404, String(wrongPath.status));
const getCall = await fetch(happyBridge.url + COMPLETIONS_SUFFIX, { headers: { authorization: "Bearer " + happyBridge.token } });
check("桥：非 POST → 404", getCall.status === 404, String(getCall.status));

const ok = await post(happyBridge.url, happyBridge.token, {
  model: "deepseek/deepseek-v4.1-flash",
  messages: [{ role: "system", content: "你是审查员" }, { role: "user", content: "看一下" }],
  max_completion_tokens: 4096,
  temperature: 0,
});
check(
  "桥：非流式成功返回 OpenAI chat.completion",
  ok.status === 200 && ok.json.choices[0].message.content === "pong" && ok.json.choices[0].finish_reason === "stop" && ok.json.model === "deepseek/deepseek-v4.1-flash",
  ok.status + " " + ok.raw.slice(0, 160),
);
const seenOptions = happy.calls.at(-1);
check("桥：provider/model 取自插件设置（不看请求体里的 model）", seenOptions.provider === "commandcode" && seenOptions.model === "deepseek/deepseek-v4.1-flash", text({ provider: seenOptions.provider, model: seenOptions.model }));
check("桥：system 走 options.system，user 走 messages", seenOptions.system === "你是审查员" && seenOptions.messages.length === 1 && seenOptions.messages[0].role === "user", text({ system: seenOptions.system, roles: seenOptions.messages.map((m) => m.role) }));
check("桥：max_completion_tokens → maxTokens，temperature 透传", seenOptions.maxTokens === 4096 && seenOptions.temperature === 0, text({ maxTokens: seenOptions.maxTokens, temperature: seenOptions.temperature }));
check("桥：signal 是 AbortSignal（关桥时能掐断上游）", seenOptions.signal instanceof AbortSignal, String(seenOptions.signal));

const badJson = await post(happyBridge.url, happyBridge.token, "{不是 JSON");
check("桥：请求体不是 JSON → 400", badJson.status === 400 && badJson.json.error.code === "invalid_json", String(badJson.status));
const emptyMessages = await post(happyBridge.url, happyBridge.token, { model: "m", messages: [{ role: "system", content: "只有系统提示" }] });
check("桥：messages 里没有可翻译内容 → 400", emptyMessages.status === 400 && emptyMessages.json.error.code === "empty_messages", emptyMessages.raw.slice(0, 120));
/* v0.6.1（OCR 自审发现）：以前这些「没转发出去」的请求也记进 failed，于是诊断里出现
   「已转发 0 次 · 失败 1 次」，而且一次 401 会盖掉真正的上游失败。现在分开计数。 */
check(
  "桥（v0.6.1）：「到达桥但没转发出去」的请求记进 rejected，不污染 failed（不出现「已转发 0 次 · 失败 1 次」）",
  happyBridge.stats.rejected === 4 && happyBridge.stats.failed === 0 && happyBridge.describe().rejected === 4 && String(happyBridge.stats.lastReject).includes("empty_messages"),
  text({ rejected: happyBridge.stats.rejected, failed: happyBridge.stats.failed, lastReject: happyBridge.stats.lastReject }),
);
check(
  "桥（v0.6.1）：bridgeFailureNote 会点出「未转发即被拒」与其最近原因（否则用户只看到 ocr 的通用提示）",
  (() => {
    const note = bridgeFailureNote(happyBridge.describe());
    return typeof note === "string" && note.includes("未转发即被拒 4 次") && note.includes("最近被拒");
  })(),
  String(bridgeFailureNote(happyBridge.describe())),
);

const toolScript = fakeStream([
  { type: "tool-call-delta", index: 0, id: "call_probe", name: "ocr_selftest", argumentsDelta: "{\"note\":" },
  { type: "tool-call-delta", index: 0, argumentsDelta: "\"x\"}" },
  { type: "finish", reason: { kind: "stop" } },
]);
const toolBridge = await startLlmBridge({ stream: toolScript.stream, target: () => ({ provider: "p", model: "m" }), logger });
const first = await post(toolBridge.url, toolBridge.token, {
  model: "m",
  messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
  tools: [{ type: "function", function: { name: "ocr_selftest", description: "d", parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } } }],
});
check(
  "桥：工具调用往返（第 1 跳返回 tool_calls + finish_reason=tool_calls）",
  first.status === 200 && first.json.choices[0].message.tool_calls?.[0].function.name === "ocr_selftest" && first.json.choices[0].finish_reason === "tool_calls",
  first.raw.slice(0, 200),
);
check("桥：tools 被翻译成 DSH 形状（{name,description,parameters}）", toolScript.calls.at(-1).tools?.[0].name === "ocr_selftest" && toolScript.calls.at(-1).tools[0].function === undefined, text(toolScript.calls.at(-1).tools));

const second = await post(toolBridge.url, toolBridge.token, {
  model: "m",
  messages: [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
    { role: "assistant", content: null, tool_calls: first.json.choices[0].message.tool_calls },
    { role: "tool", tool_call_id: "call_probe", content: "ocr_selftest ok" },
  ],
});
const secondOptions = toolScript.calls.at(-1);
check("桥：第 2 跳把 assistant.tool_calls + role=tool 翻回 DSH 消息", second.status === 200 && secondOptions.messages[1].content[0].type === "tool-call" && secondOptions.messages[2].role === "tool" && secondOptions.messages[2].toolCallId === "call_probe", text(secondOptions.messages.map((m) => ({ role: m.role, types: m.content.map((b) => b.type) }))));
{
  // 这一节钉的是真机事故（v0.3.2）：工具往返第 2 跳的 assistant 历史缺 source，
  // 宿主 forAdapter() 一读 message.source.replayState 就 TypeError → ocr 报
  // 「all 4 file review(s) failed」，而桥自己只看到 stats.failed。
  const problems = hostAssistantSourceProblems([...happy.calls, ...toolScript.calls]);
  check("桥：发出去的每条 assistant 消息都带 model source（宿主 forAdapter 契约）", problems.length === 0, problems.join("；"));
  check(
    "桥：source 路由＝本次转发的 provider/model",
    secondOptions.messages[1].source.provider === "p" && secondOptions.messages[1].source.model === "m",
    text(secondOptions.messages[1].source),
  );
  check(
    "桥：tool 消息带 source.kind=tool + callId（与 createToolResultMessage 同形）",
    secondOptions.messages[2].source?.kind === "tool" && secondOptions.messages[2].source.callId === "call_probe",
    text(secondOptions.messages[2].source),
  );
  const probe = hostAssistantSourceProblems([{ provider: "p", model: "m", messages: [{ role: "assistant", content: [] }] }]);
  check("桥：宿主契约探针本身有效（缺 source 会被抓出来）", probe.length === 1 && probe[0].includes("replayState"), probe.join("；"));
}
{
  // A4：有些客户端不给 role=tool 带 tool_call_id；过去桥写出 toolCallId=""，
  // 宿主适配器配对失败 → INVALID_REQUEST（DeepSeek Messages tool result has no
  // matching call），第 2 跳直接失败。现在按前一条 assistant 的调用补齐。
  const unpaired = await post(toolBridge.url, toolBridge.token, {
    model: "m",
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      { role: "assistant", content: null, tool_calls: first.json.choices[0].message.tool_calls },
      { role: "tool", content: "没有 tool_call_id 的工具结果" },
    ],
  });
  const unpairedOptions = toolScript.calls.at(-1);
  check(
    "桥：role=tool 缺 tool_call_id 时按前一条 assistant 的调用补齐（否则宿主配对失败）",
    unpaired.status === 200 && unpairedOptions.messages[2].toolCallId === "call_probe" && unpairedOptions.messages[2].source?.callId === "call_probe",
    text({ status: unpaired.status, toolCallId: unpairedOptions.messages[2]?.toolCallId, source: unpairedOptions.messages[2]?.source }),
  );
  const toolProbe = hostAssistantSourceProblems([{ provider: "p", model: "m", messages: [{ role: "tool", content: [], source: { kind: "tool", callId: "" } }] }]);
  check("桥：宿主契约探针覆盖 role=tool（缺 callId 会被抓出来）", toolProbe.length === 1 && toolProbe[0].includes("INVALID_REQUEST"), toolProbe.join("；"));
  const allProblems = hostAssistantSourceProblems([...happy.calls, ...toolScript.calls]);
  check("桥：所有发出去的消息（含工具往返）都过宿主契约探针", allProblems.length === 0, allProblems.join("；"));
}

/* 超大 body：过去先 req.destroy() 再回 413，客户端拿到的是 ECONNRESET（status 0），
   413 永远送不到。 */
const bigBridge = await startLlmBridge({ stream: happy.stream, target: () => ({ provider: "p", model: "m" }), logger });
let big = null;
let bigError = "";
try {
  big = await post(bigBridge.url, bigBridge.token, '{"model":"m","messages":[{"role":"user","content":"' + "x".repeat(MAX_BODY_BYTES + 4096) + '"}]}');
} catch (error) {
  bigError = String(error);
}
check(
  "桥：超过体积上限 → 客户端真的收到 413 body_too_large（不再是 ECONNRESET）",
  big !== null && big.status === 413 && big.json.error.code === "body_too_large",
  big ? big.status + " " + big.raw.slice(0, 120) : "请求失败：" + bigError,
);
await bigBridge.close();

/* 客户端断开（ocr 被取消/超时/进程退出）：上游 llm.stream 必须收到 abort，
   否则这次调用会继续烧配额（过去只有上游超时或关桥才会 abort）。 */
const hangCalls = [];
const hangBridge = await startLlmBridge({
  stream: async function* stream(options) {
    hangCalls.push(options);
    yield { type: "text-delta", index: 0, text: "开始" };
    await new Promise((resolve) => {
      if (options.signal?.aborted) return resolve();
      options.signal?.addEventListener("abort", resolve, { once: true });
      return undefined;
    });
    yield { type: "finish", reason: { kind: "stop" } };
  },
  target: () => ({ provider: "p", model: "m" }),
  logger,
});
const hangAc = new AbortController();
const hangPending = fetch(hangBridge.url + COMPLETIONS_SUFFIX, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer " + hangBridge.token },
  body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "u" }] }),
  signal: hangAc.signal,
}).catch(() => null);
await waitFor(() => hangCalls.length > 0);
hangAc.abort();
await waitFor(() => hangCalls[0]?.signal?.aborted === true);
check(
  "桥：客户端断开 → 上游 signal 被 abort（取消评审不再继续烧配额）",
  hangCalls.length === 1 && hangCalls[0].signal.aborted === true,
  "aborted=" + String(hangCalls[0]?.signal?.aborted),
);
await waitFor(() => hangBridge.describe().inflight === 0);
check("桥：客户端断开后 inflight 归零", hangBridge.describe().inflight === 0, text(hangBridge.describe()));
await hangPending;

/* v0.5.5（自审发现）：上游可能「不理 signal、照常把流跑完」（复用同一条流、或实现里没看 signal）。
   这时桥绝不能把结果写回已经销毁的 socket —— res.write 会同步抛 ERR_STREAM_DESTROYED，而
   res.on("error") 只吞 'error' 事件，盖不住同步异常（未处理异常足以杀掉宿主进程）；也不该把自己
   掐断的这次调用记成「上游失败」。 */
const stubbornCalls = [];
const stubbornBridge = await startLlmBridge({
  stream: async function* stream(options) {
    stubbornCalls.push(options);
    yield { type: "text-delta", text: "late" };
    await new Promise((resolve) => setTimeout(resolve, 150));
    yield { type: "finish", reason: { kind: "stop" } };
  },
  target: () => ({ provider: "p", model: "m" }),
  logger,
});
const stubbornAc = new AbortController();
const stubbornPending = fetch(stubbornBridge.url + COMPLETIONS_SUFFIX, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer " + stubbornBridge.token },
  body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "u" }] }),
  signal: stubbornAc.signal,
}).catch(() => null);
await waitFor(() => stubbornCalls.length > 0);
stubbornAc.abort();
await waitFor(() => stubbornCalls[0]?.signal?.aborted === true);
await waitFor(() => stubbornBridge.describe().inflight === 0, 5000);
check(
  "桥（v0.5.5）：上游忽略 abort 照常跑完 → 不写已销毁的 socket（不然是未处理异常）、也不误记成上游失败",
  stubbornBridge.describe().failed === 0 &&
    stubbornBridge.describe().retries === 0 &&
    stubbornBridge.describe().inflight === 0 &&
    stubbornCalls.length === 1,
  text(stubbornBridge.describe()),
);
await stubbornPending;
await stubbornBridge.close();

/* 关桥：客户端挂着连接（keep-alive）时也要在宽限期内返回，不能挂死插件卸载。 */
const keepAlive = fetch(hangBridge.url + COMPLETIONS_SUFFIX, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer " + hangBridge.token },
  body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "u" }] }),
}).catch(() => null);
await waitFor(() => hangCalls.length >= 2);
const closeStart = Date.now();
await hangBridge.close();
const closeMs = Date.now() - closeStart;
check(
  "桥：close() 在客户端挂着连接时也能在宽限期内返回（不挂死卸载）",
  closeMs < CLOSE_GRACE_MS * 3,
  "耗时 " + closeMs + "ms（宽限 " + CLOSE_GRACE_MS + "ms）",
);
await keepAlive;

const failing = fakeStream([{ type: "finish", reason: { kind: "error", failure: { code: "MODEL_NOT_FOUND", message: "Model not supported" } } }]);
const failBridge = await startLlmBridge({ stream: failing.stream, target: () => ({ provider: "p", model: "m" }), logger });
const failed = await post(failBridge.url, failBridge.token, { model: "m", messages: [{ role: "user", content: "u" }] });
check("桥：上游 error 终结块 → 502 + OpenAI 错误体", failed.status === 502 && failed.json.error.code === "MODEL_NOT_FOUND" && failed.json.error.message === "Model not supported", failed.status + " " + failed.raw.slice(0, 160));
check("桥：上游失败计数进 stats", failBridge.stats.failed === 1 && failBridge.stats.lastError === "Model not supported", text(failBridge.describe()));

const throwing = fakeStream([{ __throw: "适配器炸了" }]);
const throwBridge = await startLlmBridge({ stream: throwing.stream, target: () => ({ provider: "p", model: "m" }), logger });
const thrown = await post(throwBridge.url, throwBridge.token, { model: "m", messages: [{ role: "user", content: "u" }] });
check(
  "桥（v0.5.4）：stream 抛异常 → 归一成上游 failure（502 + OpenAI 错误体），不再让异常穿透到外层 catch",
  thrown.status === 502 && thrown.json.error.message.includes("适配器炸了") && thrown.json.error.code === "upstream_error",
  thrown.status + " " + thrown.raw.slice(0, 160),
);
check(
  "桥（v0.5.4）：抛出的异常也走既有判定（不可重试的错误记 retrySkip，不谎报重试）",
  throwBridge.stats.failed === 1 && throwBridge.stats.retries === 0 && throwBridge.stats.retrySkips === 1 && String(throwBridge.stats.retrySkipReason).length > 0,
  text(throwBridge.describe()),
);

/* v0.6.1（OCR 自审发现）：retrySkipReason 只写不重置 —— 下一次请求若是「重试过仍失败」
   （不写这条原因），同一次诊断里会打印上一条的原因。现在每次转发前清掉。 */
const clearScript = fakeStream((options, call) =>
  call === 1
    ? [{ type: "finish", reason: { kind: "error", failure: { code: "MODEL_NOT_FOUND", message: "Model not supported" } } }]
    : [{ type: "text-delta", index: 0, text: "recovered" }, { type: "finish", reason: { kind: "stop" } }],
);
const clearBridge = await startLlmBridge({ stream: clearScript.stream, target: () => ({ provider: "p", model: "m" }), logger });
const clearFirst = await post(clearBridge.url, clearBridge.token, { model: "m", messages: [{ role: "user", content: "u" }] });
const skippedReason = String(clearBridge.stats.retrySkipReason);
const clearSecond = await post(clearBridge.url, clearBridge.token, { model: "m", messages: [{ role: "user", content: "u" }] });
check(
  "桥（v0.6.1）：上一次请求留下的 retrySkipReason 不会带到下一次（否则诊断里出现错配的原因）",
  clearFirst.status === 502 && skippedReason.length > 0 && clearSecond.status === 200 &&
    clearBridge.stats.retrySkips === 1 && clearBridge.stats.retrySkipReason === "" &&
    !String(bridgeFailureNote(clearBridge.describe())).includes("未重试原因"),
  text({ skippedReason, after: clearBridge.stats.retrySkipReason, note: bridgeFailureNote(clearBridge.describe()) }),
);

/* 抛出的是「明确值得重试」的网络错误时，以前永远不会重试（异常直接穿透整个循环）——这条钉住修复。 */
const flakyThrow = fakeStream((options, call) =>
  call === 1
    ? [{ __throw: "socket hang up" }]
    : [
        { type: "text-delta", text: "recovered" },
        { type: "finish", reason: { kind: "stop" } },
      ],
);
const flakyBridge = await startLlmBridge({ stream: flakyThrow.stream, target: () => ({ provider: "p", model: "m" }), logger });
const recovered = await post(flakyBridge.url, flakyBridge.token, { model: "m", messages: [{ role: "user", content: "u" }] });
check(
  "桥（v0.5.4）：抛出的瞬时网络错误 → 自动重试一次并成功（RETRYABLE_UPSTREAM_RE 终于对抛出的异常也生效）",
  recovered.status === 200 &&
    recovered.json.choices[0].message.content === "recovered" &&
    flakyBridge.stats.retries === 1 &&
    flakyBridge.stats.failed === 0,
  recovered.status + " " + JSON.stringify(recovered.json).slice(0, 160) + " " + text(flakyBridge.describe()),
);

/* 上游「流正常结束但既没有 finish 事件、也没有内容」= 典型的截断；以前会当成空成功交给 ocr。 */
const truncated = fakeStream([]);
const truncBridge = await startLlmBridge({ stream: truncated.stream, target: () => ({ provider: "p", model: "m" }), logger });
const truncRes = await post(truncBridge.url, truncBridge.token, { model: "m", messages: [{ role: "user", content: "u" }] });
check(
  "桥（v0.5.4）：没有 finish 事件也没有内容的流 → 判成 upstream_truncated 失败（不再静默当空成功），并重试过一次",
  truncRes.status === 502 &&
    truncRes.json.error.code === "upstream_truncated" &&
    truncRes.json.error.message.includes("stream ended before a terminal") &&
    truncBridge.stats.failed === 1 &&
    truncBridge.stats.retries === 1,
  truncRes.status + " " + truncRes.raw.slice(0, 200) + " " + text(truncBridge.describe()),
);

/* v0.5.6（第三轮自审发现）：`truncated()` 以前要求「既没有 finish、也没有任何正文」才算截断，
   于是「先吐出半截正文、再断流」（`stream ended before a terminal response event` 的另一半情形）
   会被当成成功 —— ocr 拿到半截内容还以为评审跑完了。半截正文同样是截断。 */
const half = fakeStream([{ type: "text-delta", text: "半句 " }]);
const halfBridge = await startLlmBridge({ stream: half.stream, target: () => ({ provider: "p", model: "m" }), logger });
const halfRes = await post(halfBridge.url, halfBridge.token, { model: "m", messages: [{ role: "user", content: "u" }] });
check(
  "桥（v0.5.6）：先吐出半截正文再断流也算截断（不再当成功），并说明半截内容不算完成",
  halfRes.status === 502 &&
    halfRes.json.error.code === "upstream_truncated" &&
    halfRes.json.error.message.includes("已经收到的半截内容不算完成") &&
    halfBridge.stats.failed === 1 &&
    halfBridge.stats.retries === 1,
  halfRes.status + " " + halfRes.raw.slice(0, 200) + " " + text(halfBridge.describe()),
);
await halfBridge.close();

/* v0.5.6（第三轮自审发现）：桥自己的超时以前与「客户端断开」混成一个判定 → 客户端还在等却什么都不写、
   stats.failed 也不计（统计上看不出发生过什么）。现在超时必须给客户端一个交代，并且如实记进统计。 */
const slowCalls = [];
const slowBridge = await startLlmBridge({
  timeoutMs: 150,
  stream: async function* stream(options) {
    slowCalls.push(options);
    yield { type: "text-delta", text: "开始" };
    await new Promise((resolve) => {
      if (options.signal?.aborted) return resolve();
      options.signal?.addEventListener("abort", resolve, { once: true });
      return undefined;
    });
  },
  target: () => ({ provider: "p", model: "m" }),
  logger,
});
const slowRes = await post(slowBridge.url, slowBridge.token, { model: "m", messages: [{ role: "user", content: "u" }] });
check(
  "桥（v0.5.6）：桥自己的上游超时（客户端还连着）→ 502 upstream_timeout，不再静默不回应",
  slowRes.status === 502 && slowRes.json.error.code === "upstream_timeout" && slowRes.json.error.message === SELF_ABORT_MESSAGES.timeout,
  slowRes.status + " " + slowRes.raw.slice(0, 200),
);
check(
  "桥（v0.5.6）：我们自己掐断的中止也计失败、并记下不重试的原因（桥超时不再「统计上看不出发生过什么」）",
  slowBridge.stats.failed === 1 &&
    slowBridge.stats.retries === 0 &&
    slowBridge.stats.retrySkips === 1 &&
    slowBridge.stats.retrySkipReason.includes("超时"),
  text(slowBridge.describe()),
);
check(
  "桥（v0.5.6）：桥超时会真的 abort 上游（不继续烧配额）",
  slowCalls.length === 1 && slowCalls[0].signal.aborted === true,
  "calls=" + slowCalls.length + " aborted=" + String(slowCalls[0]?.signal?.aborted),
);
await slowBridge.close();

/* v0.5.6（第三轮自审发现）：合法 JSON 但形状不对的请求体（null / 数组 / 数字）以前能过 JSON.parse，
   然后 `body.messages` 直接把桥打崩（`JSON.parse("null")` → TypeError: Cannot read properties of null）。 */
const nullBody = await post(happyBridge.url, happyBridge.token, null);
check(
  "桥（v0.5.6）：请求体是 null → 400 invalid_body（以前必崩 TypeError）",
  nullBody.status === 400 && nullBody.json.error.code === "invalid_body",
  nullBody.status + " " + nullBody.raw.slice(0, 160),
);
const arrayBody = await post(happyBridge.url, happyBridge.token, []);
check(
  "桥（v0.5.6）：请求体是数组 → 400 invalid_body",
  arrayBody.status === 400 && arrayBody.json.error.code === "invalid_body",
  arrayBody.status + " " + arrayBody.raw.slice(0, 160),
);

const noRoute = await startLlmBridge({ stream: happy.stream, target: () => ({ provider: "", model: "" }), logger });
const unrouted = await post(noRoute.url, noRoute.token, { model: "m", messages: [{ role: "user", content: "u" }] });
check("桥：DSH 侧没配 provider/model → 500 且提示去设置里选", unrouted.status === 500 && unrouted.json.error.code === "missing_route" && unrouted.json.error.message.includes("provider"), unrouted.raw.slice(0, 200));

const streamBridge = await startLlmBridge({ stream: happy.stream, target: () => ({ provider: "p", model: "m" }), logger });
const streamed = await post(streamBridge.url, streamBridge.token, { model: "m", stream: true, messages: [{ role: "user", content: "u" }] });
check(
  "桥：stream:true 走 SSE（data: 帧 + [DONE]）",
  streamed.status === 200 && streamed.contentType.includes("text/event-stream") && streamed.raw.includes("\"content\":\"pong\"") && streamed.raw.trimEnd().endsWith("[DONE]"),
  streamed.raw.slice(0, 200),
);

const describe = happyBridge.describe();
check("桥：describe() 报请求数/最近路由，且不吐明文 token", describe.requests >= 1 && describe.lastProvider === "commandcode" && describe.tokenMasked !== happyBridge.token && describe.tokenMasked.includes("…"), text(describe));
check(
  "桥（v0.5.4）：describe().tokens 恒六键（输入/输出/合计/缓存命中/缓存写入/partial），宿主 schema 与界面文案都靠它",
  describe.tokens &&
    Object.keys(describe.tokens).sort().join(",") ===
      "cache_read_tokens,cache_write_tokens,completion_tokens,partial,prompt_tokens,total_tokens" &&
    Number.isFinite(describe.tokens.partial),
  text(describe.tokens),
);
check("桥：logger.warn 收到过鉴权/协议类噪音（说明有可观测性）", seen.some((line) => line.startsWith("warn:") || line.startsWith("debug:")), text(seen.slice(0, 3)));

/* 上游瞬时故障自动重试。
   真机事故（v0.3.7 的由来）：DSH 默认模型切成 ark-coding-plan/glm-5.3-flash 后，上游偶尔用
   `OpenAI Responses stream ended before a terminal response event` 把流截断；ocr 把这一次失败
   当成整份文件的扫描失败（`all 1 file scan(s) failed`），10 分钟白跑，还打印误导人的
   「check your LLM configuration and API key」。桥是「先把上游流攒完、再一次性写给客户端」，
   失败时客户端一个字节都没收到，所以可以安全重试一次。 */
const retryScript = fakeStream((options, attempt) =>
  attempt === 1
    ? [
        { type: "text-delta", index: 0, text: "半句" },
        { type: "finish", reason: { kind: "error", failure: { code: "UPSTREAM", message: "OpenAI Responses stream ended before a terminal response event" } } },
      ]
    : [
        { type: "text-delta", index: 0, text: "pong" },
        { type: "finish", reason: { kind: "stop" } },
      ],
);
const retryBridge = await startLlmBridge({ stream: retryScript.stream, target: () => ({ provider: "ark-coding-plan", model: "glm-5.3-flash" }), logger });
const retried = await post(retryBridge.url, retryBridge.token, { model: "m", messages: [{ role: "user", content: "u" }] });
check(
  "桥：上游流被截断 → 自动重试一次并成功（客户端拿到完整结果，不再整份扫描失败）",
  retried.status === 200 && retried.json.choices[0].message.content === "pong" && retryScript.calls.length === 2,
  retried.status + " " + retried.raw.slice(0, 160) + " calls=" + retryScript.calls.length,
);
check(
  "桥：重试只记在 retries，不算 failed（失败账目保持真实）",
  retryBridge.stats.retries === 1 && retryBridge.stats.failed === 0 && retryBridge.describe().retries === 1,
  text(retryBridge.describe()),
);

const noRetryScript = fakeStream(() => [{ type: "finish", reason: { kind: "error", failure: { code: "MODEL_NOT_FOUND", message: "Model not supported" } } }]);
const noRetryBridge = await startLlmBridge({ stream: noRetryScript.stream, target: () => ({ provider: "p", model: "m" }), logger });
const noRetried = await post(noRetryBridge.url, noRetryBridge.token, { model: "m", messages: [{ role: "user", content: "u" }] });
check(
  "桥：非瞬时错误（Model not supported）不重试——重试救不回配置错，只会放大延迟与配额",
  noRetried.status === 502 && noRetryBridge.stats.retries === 0 && noRetryScript.calls.length === 1 && noRetryBridge.stats.failed === 1,
  text({ calls: noRetryScript.calls.length, ...noRetryBridge.describe() }),
);

const retryStreamScript = fakeStream((options, attempt) =>
  attempt === 1
    ? [
        { type: "text-delta", index: 0, text: "半句" },
        { type: "finish", reason: { kind: "error", failure: { code: "UPSTREAM", message: "socket hang up" } } },
      ]
    : [
        { type: "text-delta", index: 0, text: "pong" },
        { type: "finish", reason: { kind: "stop" } },
      ],
);
const retryStreamBridge = await startLlmBridge({ stream: retryStreamScript.stream, target: () => ({ provider: "p", model: "m" }), logger });
const retriedStream = await post(retryStreamBridge.url, retryStreamBridge.token, { model: "m", stream: true, messages: [{ role: "user", content: "u" }] });
check(
  "桥：SSE 路径重试后只写一遍内容（第一次尝试的半句不残留、不重复）",
  retriedStream.status === 200 &&
    (retriedStream.raw.match(/"content":"pong"/g) ?? []).length === 1 &&
    !retriedStream.raw.includes("半句") &&
    retryStreamBridge.stats.retries === 1,
  retriedStream.raw.slice(0, 200),
);

check(
  "桥：isRetryableUpstreamFailure 只认上游瞬时故障，不认我方 abort",
  isRetryableUpstreamFailure({ kind: "error", code: "UPSTREAM", message: "OpenAI Responses stream ended before a terminal response event" }) === true &&
    isRetryableUpstreamFailure({ kind: "error", code: "x", message: "rate limit exceeded (429)" }) === true &&
    isRetryableUpstreamFailure({ kind: "error", code: "x", message: "fetch failed" }) === true &&
    isRetryableUpstreamFailure({ kind: "aborted", code: "aborted", message: "客户端断开，桥已取消上游调用" }) === false &&
    isRetryableUpstreamFailure({ kind: "error", code: "x", message: "桥的上游调用超时" }) === false &&
    isRetryableUpstreamFailure({ kind: "error", code: "MODEL_NOT_FOUND", message: "Model not supported" }) === false &&
    isRetryableUpstreamFailure(null) === false,
);
{
  const note = bridgeFailureNote({ requests: 21, failed: 2, retries: 1, lastError: "OpenAI Responses stream ended before a terminal response event", lastModel: "glm-5.3-flash" });
  check(
    "桥：bridgeFailureNote 把桥侧真因写成人话（含失败数/重试数/最近模型，且点明 ocr 的通用提示未必是密钥问题）",
    bridgeFailureNote(null) === null &&
      bridgeFailureNote({ requests: 3, failed: 0 }) === null &&
      typeof note === "string" &&
      note.includes("失败 2 次") &&
      note.includes("上游重试 1 次") &&
      note.includes("glm-5.3-flash") &&
      note.includes("stream ended before a terminal response event") &&
      note.includes("未必是密钥问题"),
    String(note),
  );
}

await happyBridge.close();
let closed = false;
try {
  await post(happyBridge.url, happyBridge.token, { model: "m", messages: [{ role: "user", content: "u" }] });
} catch {
  closed = true;
}
check("桥：close() 之后端口关掉、请求失败", closed === true);

for (const bridge of [toolBridge, failBridge, throwBridge, noRoute, streamBridge, retryBridge, noRetryBridge, retryStreamBridge, flakyBridge, truncBridge, clearBridge]) await bridge.close();

/* M1（v0.4.0）：重试闸门的三分支 + token 累计 + 「没重试」的原因。
   真机踩过的坑：v0.3.7 把 kind==="aborted" 摆在判定最前面，于是上游标成 aborted 的
   「流被截断」被当成「我方主动中止」，自动重试一次都没发生（真机三次长评审 retries 恒为 0），
   用户只能看到 ocr 那句通用的「check your LLM configuration and API key」。 */
{
  const self = classifyUpstreamFailure({ kind: "aborted", code: "aborted", message: "客户端断开，桥已取消上游调用" });
  const truncated = classifyUpstreamFailure({
    kind: "aborted",
    code: "aborted",
    message: "OpenAI Responses stream ended before a terminal response event",
  });
  const rateLimited = classifyUpstreamFailure({ kind: "error", code: "x", message: "上游 429 rate limit exceeded" });
  const unknown = classifyUpstreamFailure({ kind: "aborted", code: "aborted", message: "莫名其妙地结束了" });
  /* v0.5.5（自审发现）：三条「我方主动中止」的文案由 SELF_ABORT_MESSAGES 生成正则，不再是两处各写一遍。
     谁改了 abort 文案却忘了正则，这里立刻红 —— 否则「我方中止」会被误判成可重试的上游故障。 */
  const selfAbortMessages = Object.values(SELF_ABORT_MESSAGES);
  check(
    "桥（v0.5.5）：SELF_ABORT_MESSAGES 三条文案都被 SELF_ABORT_RE 认出来（文案与判定不再各写一份）",
    selfAbortMessages.length === 3 &&
      selfAbortMessages.every((message) => SELF_ABORT_RE.test(message) && classifyUpstreamFailure({ kind: "error", code: "x", message }).retryable === false),
    selfAbortMessages.join(" / "),
  );
  check(
    "桥（M1）：classifyUpstreamFailure 三分支 —— 我方中止不重试 / 瞬时故障重试 / aborted 但文本不认识也不重试并给原因",
    self.retryable === false &&
      self.reason.includes("我方主动中止") &&
      truncated.retryable === true &&
      rateLimited.retryable === true &&
      unknown.retryable === false &&
      unknown.reason.includes("不在已知的瞬时故障列表") &&
      classifyUpstreamFailure(null).retryable === false,
    JSON.stringify({ self, truncated, unknown }),
  );
}
{
  const totals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  accumulateUsage(totals, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  // 字符串 / 负数 / NaN / Infinity / undefined / null 一律不认（宁可少算，也不能把总数弄成 NaN）。
  accumulateUsage(totals, { prompt_tokens: "5", completion_tokens: -2, total_tokens: -5 });
  accumulateUsage(totals, { prompt_tokens: Number.NaN, completion_tokens: Number.POSITIVE_INFINITY, total_tokens: undefined });
  accumulateUsage(totals, null);
  const fromScratch = accumulateUsage(undefined, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  check(
    "桥（M1）：accumulateUsage 只累加正有限数（字符串/负数/NaN/Infinity 都不污染总数，缺字段按 0）",
    totals.prompt_tokens === 7 &&
      totals.completion_tokens === 3 &&
      totals.total_tokens === 10 &&
      fromScratch.total_tokens === 3,
    JSON.stringify(totals),
  );
}
/* v0.5.0 步骤 5：token 口径 —— 上游只报 total 的次数单独计数（真机「累计 415736（输入 40882 / 输出 52550）」的缺口来源）。 */
{
  const totals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, partial: 0 };
  accumulateUsage(totals, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  accumulateUsage(totals, { total_tokens: 100 });
  accumulateUsage(totals, { prompt_tokens: 2, total_tokens: 5 });
  accumulateUsage(totals, { completion_tokens: 4, total_tokens: 6 });
  check(
    "桥（v0.5.0）：只有 total 的上游调用记进 partial（输入/输出缺一项也算），三字段各自累加不缺位",
    totals.partial === 3 &&
      totals.prompt_tokens === 9 &&
      totals.completion_tokens === 7 &&
      totals.total_tokens === 121,
    JSON.stringify(totals),
  );
  const fromScratch = accumulateUsage(undefined, { total_tokens: 42 });
  check(
    "桥（v0.5.0）：accumulateUsage 从零开始时也把 partial 初始化出来（describe() 的 tokens 恒六键）",
    fromScratch.partial === 1 && fromScratch.total_tokens === 42 && fromScratch.prompt_tokens === 0,
    JSON.stringify(fromScratch),
  );
}
/* v0.5.4：token 口径的真凶 —— DSH/pi-ai 的 inputTokens 不含缓存命中/写入。
   真机事故：桥报「累计 tokens 452422（输入 41305 / 输出 73581）」，41305+73581=114886 ≠ 452422，
   而 partial=0（不是「上游只报 total」）。差值 337536 就是缓存命中的输入 —— ocr 每次重发整份
   审查规格，命中率很高。修法：toOpenAiUsage 带出 cache_read_tokens/cache_write_tokens，
   累加与文案同步，界面显示成「输入 X（其中缓存命中 Y · 缓存写入 Z）/ 输出 W / 合计 T」。 */
{
  const mapped = toOpenAiUsage({
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 500,
    cacheReadTokens: 360,
    cacheWriteTokens: 20,
  });
  check(
    "桥（v0.5.4）：toOpenAiUsage 带出缓存命中/写入（DSH 的 inputTokens 已扣掉缓存，只取输入输出会看着像 bug）",
    mapped.prompt_tokens === 100 &&
      mapped.completion_tokens === 20 &&
      mapped.total_tokens === 500 &&
      mapped.cache_read_tokens === 360 &&
      mapped.cache_write_tokens === 20 &&
      mapped.prompt_tokens_details.cached_tokens === 360,
    text(mapped),
  );
  check(
    "桥（v0.5.4）：上游只报 OpenAI 风格字段名时也认（cache_read_tokens / prompt_tokens_details.cached_tokens / cachedTokens）",
    toOpenAiUsage({ prompt_tokens: 5, completion_tokens: 1, cache_read_tokens: 7 }).cache_read_tokens === 7 &&
      toOpenAiUsage({ input_tokens: 5, output_tokens: 1, cachedTokens: 9 }).cache_read_tokens === 9 &&
      toOpenAiUsage({ inputTokens: 5, outputTokens: 1 }).cache_read_tokens === undefined,
    JSON.stringify([
      toOpenAiUsage({ prompt_tokens: 5, completion_tokens: 1, cache_read_tokens: 7 }),
      toOpenAiUsage({ input_tokens: 5, output_tokens: 1, cachedTokens: 9 }),
    ]),
  );
  check(
    "桥（v0.5.4）：上游没给 total 时，补出来的合计含缓存（漏掉缓存会低估，且显示成「合计 < 输入+输出」）",
    toOpenAiUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 360, cacheWriteTokens: 20 }).total_tokens === 500 &&
      toOpenAiUsage({ inputTokens: 100, outputTokens: 20 }).total_tokens === 120,
    JSON.stringify([
      toOpenAiUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 360, cacheWriteTokens: 20 }),
      toOpenAiUsage({ inputTokens: 100, outputTokens: 20 }),
    ]),
  );
  const totals = accumulateUsage(undefined, {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 500,
    cache_read_tokens: 360,
    cache_write_tokens: 20,
  });
  accumulateUsage(totals, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  check(
    "桥（v0.5.4）：缓存字段也逐次累加，缺失按 0（不让 NaN/负数污染）",
    totals.prompt_tokens === 101 &&
      totals.completion_tokens === 22 &&
      totals.total_tokens === 503 &&
      totals.cache_read_tokens === 360 &&
      totals.cache_write_tokens === 20,
    JSON.stringify(totals),
  );
  const justTotal = accumulateUsage(undefined, { total_tokens: 42 });
  check(
    "桥（v0.5.4）：只报 total 时缓存字段为 0（partial 记一次），describeTokens 说明「未分类」而不是编造归属",
    justTotal.cache_read_tokens === 0 &&
      justTotal.partial === 1 &&
      describeTokens(justTotal) ===
        "累计 tokens 42（输入 0 / 输出 0） · 另有 42 tokens 未分类（上游只按总数上报） · 其中 1 次上游只报了总数",
    describeTokens(justTotal),
  );
  check(
    "桥（v0.5.4）：describeTokens 把「合计 = 输入 + 输出 + 缓存」说清楚（真机 452422 那组数字）",
    describeTokens({
      prompt_tokens: 41305,
      completion_tokens: 73581,
      total_tokens: 452422,
      cache_read_tokens: 337536,
      cache_write_tokens: 0,
      partial: 0,
    }) === "累计 tokens 452422（输入 41305（其中缓存命中 337536） / 输出 73581）",
    describeTokens({ prompt_tokens: 41305, completion_tokens: 73581, total_tokens: 452422, cache_read_tokens: 337536 }),
  );
  check(
    "桥（v0.5.4）：describeTokens 没有数字时返回空串（endpoint 路由没有桥数据，界面不显示半句）",
    describeTokens(undefined) === "" && describeTokens({ total_tokens: 0, prompt_tokens: 0 }) === "",
  );
}
{
  const skipped = bridgeFailureNote({
    requests: 5,
    failed: 2,
    retries: 0,
    retrySkips: 2,
    retrySkipReason: "客户端已断开或桥已超时",
    lastError: "OpenAI Responses stream ended before a terminal response event",
  });
  check(
    "桥（M1）：bridgeFailureNote 在「该重试却没重试」时给出次数与原因（否则用户只看到 ocr 的通用提示）",
    typeof skipped === "string" && skipped.includes("未自动重试 2 次") && skipped.includes("客户端已断开或桥已超时"),
    String(skipped),
  );
}

/* ------------------------------------------------------------------ 汇总 */

console.log("\n=== 结果 ===");
for (const line of results) console.log(line);
console.log("\n" + (failures === 0 ? "全部通过" : failures + " 项失败") + "（共 " + results.length + " 项）");
process.exit(failures === 0 ? 0 : 1);
