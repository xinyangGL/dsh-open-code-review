/**
 * 宿主契约探针的离线测试 —— v0.7.0（对应 CPO 的 M2）。
 *
 * 目的：证明「宿主少哪一块能力，插件自己知道、并且说得清会退化成什么样」。
 * 0.5.7~0.5.9 那次事故的本质是我们对宿主语义的理解错了，而当时没有任何地方
 * 能把「我们挂了哪些面」列出来 —— 这组断言既是探针的功能测试，也是清单的防漂移门：
 * lib/index.js 里出现的每个注册点 id 都必须登记在 HOST_CONTRACT 里。
 *
 * 用法：node test/host-contract.mjs
 */
import { readFileSync } from "node:fs";
import { HOST_CONTRACT, hostNotes, hostSummary, probeHost } from "../lib/host-contract.js";

const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
  if (!ok) failures += 1;
}

/** 一个「什么都有」的宿主上下文（鸭子类型，和 lib/index.js 里的判定保持一致）。 */
function fullCtx() {
  return {
    tools: { register: () => () => {} },
    subprocess: { spawn: () => {}, resolveExecutable: async () => "" },
    commands: { register: () => () => {} },
    credentials: { resolve: async () => "" },
    on: () => () => {},
    llm: { stream: () => {} },
    jobs: { start: () => {} },
    skills: { register: () => () => {} },
    subagents: { start: () => {} },
  };
}

const clone = (ctx) => JSON.parse(JSON.stringify({})) ?? ctx; // 占位：下面用手工裁剪

/** 从「什么都有」的宿主里精确删掉一条能力（按清单里的 id 反推该删哪个键）。 */
function ctxWithout(id) {
  const ctx = fullCtx();
  const drop = {
    "tools.register": () => delete ctx.tools.register,
    "subprocess.spawn": () => delete ctx.subprocess.spawn,
    "subprocess.resolveExecutable": () => delete ctx.subprocess.resolveExecutable,
    "commands.register": () => delete ctx.commands.register,
    "credentials.resolve": () => delete ctx.credentials.resolve,
    "events.tools/result": () => delete ctx.on,
    "events.agent/turn-stopping": () => delete ctx.on,
    "events.tools/pre-execute": () => delete ctx.on,
    "events.loader/volatile-update": () => delete ctx.on,
    "inject.llm": () => delete ctx.llm.stream,
    "inject.jobs": () => delete ctx.jobs.start,
    "inject.skills": () => delete ctx.skills.register,
    "inject.subagents": () => delete ctx.subagents.start,
    "client.slots": () => {},
  }[id];
  if (!drop) throw new Error(`测试没覆盖这个能力 id：${id}`);
  drop();
  return ctx;
}

/* ----------------------------------------------------------- 清单自身的完整性 */
{
  const ids = HOST_CONTRACT.capabilities.map((row) => row.id);
  check(
    "v0.7.0：清单齐备（id 唯一、都有 label/surface/required/detect/degrade、surface 只有 host/client）",
    HOST_CONTRACT.capabilities.length >= 13 &&
      new Set(ids).size === ids.length &&
      HOST_CONTRACT.capabilities.every(
        (row) =>
          typeof row.id === "string" &&
          row.id.length > 0 &&
          typeof row.label === "string" &&
          (row.surface === "host" || row.surface === "client") &&
          typeof row.required === "boolean" &&
          typeof row.detect === "function" &&
          typeof row.degrade === "string" &&
          row.degrade.length > 0,
      ),
    `count=${HOST_CONTRACT.capabilities.length} ids=${ids.join(",")}`,
  );
  check(
    "v0.7.0：必需能力只有「工具注册」与「子进程执行」两条 —— 其余缺失都有降级路径",
    HOST_CONTRACT.capabilities.filter((row) => row.required).map((row) => row.id).join(",") === "tools.register,subprocess.spawn",
    HOST_CONTRACT.capabilities.filter((row) => row.required).map((row) => row.id).join(","),
  );
  check(
    "v0.7.0：清单里写明了实测环境（host / node / ocr 三项），不靠 README 口头承诺",
    ["host", "node", "ocr"].every((key) => typeof HOST_CONTRACT.verifiedWith?.[key] === "string" && HOST_CONTRACT.verifiedWith[key].length > 0),
    JSON.stringify(HOST_CONTRACT.verifiedWith),
  );
}

/* --------------------------------------------------------------- 全能力宿主 */
{
  const host = probeHost(fullCtx());
  const hostRows = host.capabilities.filter((row) => row.surface === "host");
  check(
    "v0.7.0：能力齐备的宿主 → ok=true、missing 为空、每项 host 能力 present=true、client 槽位 present=null",
    host.ok === true &&
      host.missing.length === 0 &&
      host.errors.length === 0 &&
      hostRows.length >= 13 &&
      hostRows.every((row) => row.present === true) &&
      host.capabilities.filter((row) => row.surface === "client").every((row) => row.present === null),
    `ok=${host.ok} hostRows=${hostRows.length}`,
  );
  check(
    "v0.7.0：probeHost 的每一行都能自解释（id/label/surface/required/present/degrade 六件套）",
    host.capabilities.every(
      (row) =>
        typeof row.id === "string" &&
        typeof row.label === "string" &&
        (row.surface === "host" || row.surface === "client") &&
        typeof row.required === "boolean" &&
        (typeof row.present === "boolean" || row.present === null) &&
        typeof row.degrade === "string",
    ),
    JSON.stringify(host.capabilities[0]),
  );
  check(
    "v0.7.0：hostSummary 一句话说得清（齐备时说齐备，缺失时点名）",
    hostSummary(host).includes("齐备") && hostSummary(null) === "未探测",
    hostSummary(host),
  );
}

/* ----------------------------------------------------------- 逐条「缺一」验证降级 */
for (const capability of HOST_CONTRACT.capabilities) {
  if (capability.surface === "client") continue;
  const host = probeHost(ctxWithout(capability.id));
  const row = host.capabilities.find((item) => item.id === capability.id);
  const expectedOk = capability.required !== true;
  check(
    `v0.7.0：去掉「${capability.id}」→ present=false${capability.required ? " 且 ok=false（必需）" : " 但 ok 仍 true（有降级）"}，备注说明退化`,
    row?.present === false &&
      host.ok === expectedOk &&
      (capability.required ? host.missing.includes(capability.id) : !host.missing.includes(capability.id)) &&
      hostNotes(host).some((line) => line.includes(capability.label)),
    `ok=${host.ok} missing=${host.missing.join(",")} notes=${hostNotes(host).length}`,
  );
}

/* ------------------------------------------------------- 探针本身永不把插件带崩 */
{
  const weird = [
    null,
    undefined,
    {},
    { tools: null, subprocess: null, on: null },
    { tools: { register: 1 }, subprocess: { spawn: "nope" }, on: "no" },
  ];
  let threw = "";
  let allFalse = true;
  for (const ctx of weird) {
    try {
      const host = probeHost(ctx);
      if (host.ok !== false) allFalse = false;
      if (!Array.isArray(host.capabilities) || host.capabilities.length !== HOST_CONTRACT.capabilities.length) allFalse = false;
    } catch (err) {
      threw = `${err?.message ?? err}`;
    }
  }
  check(
    "v0.7.0：ctx 为空/被写坏成各种类型时探针不抛错，且 ok=false、每项都判成缺",
    threw === "" && allFalse === true,
    `threw="${threw}" allFalse=${allFalse}`,
  );
  const poisoning = {};
  Object.defineProperty(poisoning, "tools", {
    get() {
      throw new Error("宿主服务访问器炸了");
    },
  });
  const poisonedHost = probeHost(poisoning);
  check(
    "v0.7.0：服务访问器本身抛错时也按「缺这个能力」处理，并记进 errors（探针不能成为新的崩溃点）",
    poisonedHost.ok === false && poisonedHost.errors.some((line) => line.includes("宿主服务访问器炸了")),
    JSON.stringify(poisonedHost.errors),
  );
}

/* --------------------------------------- 源码级防漂移：新扩展点必须登记进清单 */
{
  const source = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const registered = new Set(
    (code.match(/ctx\.tools\.register\(|ctx\.commands\.register\(|ctx\.inject\(\[[^\]]*\]/g) ?? []).map((hit) =>
      hit.replace(/^ctx\./, "").replace(/\(\[?/, "(").replace(/\s/g, ""),
    ),
  );
  /* v0.7.0 起 apply 里的可选服务注入统一走 safeInject(...) 包装（缺服务/注入抛错都不许拖垮
     apply），所以这里必须同时认 safeInject( 与 ctx.inject( —— 否则包装一上线，
     这份「用到的扩展点」清单就会静默少掉四项，防漂移断言形同虚设。 */
  const injectRe = /\b(?:ctx\.inject|safeInject)\(\[([^\]]*)\]/g;
  const injectServices = (code.match(injectRe) ?? []).flatMap((hit) =>
    hit
      .replace(/^.*?\(\[/, "")
      .split(",")
      .map((piece) => piece.replace(/["'\]]/g, "").trim())
      .filter(Boolean)
      .map((name) => `inject.${name}`),
  );
  const events = new Set((code.match(/armHook\(\s*ctx\s*,\s*"([^"]+)"/g) ?? []).map((hit) => `events.${hit.replace(/.*"([^"]+)".*/, "$1")}`));
  const declared = new Set(HOST_CONTRACT.capabilities.map((row) => row.id));
  const used = [
    ...(code.includes("ctx.tools.register(") ? ["tools.register"] : []),
    ...(code.includes("ctx.commands.register(") ? ["commands.register"] : []),
    ...injectServices,
    ...events,
  ];
  const unregistered = used.filter((id) => !declared.has(id));
  check(
    "v0.7.0：lib/index.js 里用到的每个扩展点都在 HOST_CONTRACT 里登记（新增挂载点不登记 = 测试红）",
    unregistered.length === 0 && used.length >= 9,
    `used=${used.join(",")} unregistered=${unregistered.join(",")}`,
  );
  check(
    "v0.7.0：事件类扩展点全部来自白名单（tools/result、tools/pre-execute、agent/turn-stopping、loader/volatile-update）",
    [...events].every((id) => declared.has(id)) && events.size >= 3,
    [...events].join(","),
  );
  void registered;
}

/* ------------------------------------------------------------------ 汇总 */
console.log("\n=== 结果 ===");
for (const line of results) console.log(line);
console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}（共 ${results.length} 项）`);
process.exit(failures === 0 ? 0 : 1);
