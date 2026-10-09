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
  bearerTokenOf,
  createAccumulator,
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

function log(message) {
  console.log("      · " + message);
}

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
    check(
      "toDshMessages：没给路由时也不缺 source（宁可为空串，也不能 undefined）",
      typeof toDshMessages([{ role: "assistant", content: "hi" }]).messages[0].source === "object",
      text(toDshMessages([{ role: "assistant", content: "hi" }]).messages[0]),
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
  const response = await fetch(base + "/chat/completions", {
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
const getCall = await fetch(happyBridge.url + "/chat/completions", { headers: { authorization: "Bearer " + happyBridge.token } });
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
const hangPending = fetch(hangBridge.url + "/chat/completions", {
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

/* 关桥：客户端挂着连接（keep-alive）时也要在宽限期内返回，不能挂死插件卸载。 */
const keepAlive = fetch(hangBridge.url + "/chat/completions", {
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
check("桥：stream 抛异常 → 500 而不是让 http 挂住", thrown.status === 500 && thrown.json.error.message.includes("适配器炸了"), thrown.status + " " + thrown.raw.slice(0, 160));

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
check("桥：logger.warn 收到过鉴权/协议类噪音（说明有可观测性）", seen.some((line) => line.startsWith("warn:") || line.startsWith("debug:")), text(seen.slice(0, 3)));

await happyBridge.close();
let closed = false;
try {
  await post(happyBridge.url, happyBridge.token, { model: "m", messages: [{ role: "user", content: "u" }] });
} catch {
  closed = true;
}
check("桥：close() 之后端口关掉、请求失败", closed === true);

for (const bridge of [toolBridge, failBridge, throwBridge, noRoute, streamBridge]) await bridge.close();

/* ------------------------------------------------------------------ 汇总 */

console.log("\n=== 结果 ===");
for (const line of results) console.log(line);
console.log("\n" + (failures === 0 ? "全部通过" : failures + " 项失败") + "（共 " + results.length + " 项）");
process.exit(failures === 0 ? 0 : 1);
