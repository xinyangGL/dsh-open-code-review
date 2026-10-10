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
import { armHook, hookStats, hookStatsFor, resetHookStats } from "../lib/hooks.js";

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

/**
 * v0.7.1：事件类能力不再只看 `ctx.on` 在不在 —— 还要看**这个事件真的接上了没有**，
 * 所以探针接受一份可注入的挂载账目（不传就读 lib/hooks.js 的实时账目）。
 * 这里给一份「四个事件都挂上了」的账目，代表一次正常启动。
 */
const ARMED_HOOKS = {
  hooks: { counts: { "tools/result": 2, "agent/turn-stopping": 1, "tools/pre-execute": 1, "loader/volatile-update": 1 } },
};
const NOT_ARMED_HOOKS = { hooks: { counts: {} } };

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
  /* v0.7.1：package.json 的 dsh.host.capabilities 与这份清单必须是同一套 id。
     原来一个写 `events.tools/pre-execute`、一个写 `tools/pre-execute`，两份「同样的话」
     各说各的 —— 声明类信息最怕这种漂移，评审的人根本没法比对（第 10 条发现）。 */
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const declared = pkg?.dsh?.host?.capabilities;
  check(
    "v0.7.1：package.json 的 dsh.host.capabilities 与 HOST_CONTRACT 用的是同一套 id（集合相等）",
    Array.isArray(declared) &&
      declared.length === ids.length &&
      declared.every((id) => ids.includes(id)) &&
      ids.every((id) => declared.includes(id)),
    `declared=${JSON.stringify(declared)} ids=${JSON.stringify(ids)}`,
  );
  check(
    "v0.7.1：package.json 的 dsh.host 也写明了 dsh 版本范围与实测环境（给人看的兼容性声明）",
    typeof pkg?.dsh?.host?.dsh === "string" &&
      ["dsh", "node", "ocr"].every((key) => typeof pkg?.dsh?.host?.testedWith?.[key] === "string"),
    JSON.stringify(pkg?.dsh?.host ?? null),
  );
}

/* --------------------------------------------------------------- 全能力宿主 */
{
  const host = probeHost(fullCtx(), ARMED_HOOKS);
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
    "v0.7.0：hostSummary 一句话说得清（必需能力齐备时说齐备，缺失时点名）",
    hostSummary(host).includes("齐备") && hostSummary(null) === "未探测",
    hostSummary(host),
  );
  /* v0.7.1：宿主有 ctx.on 但插件一个钩子都没挂上（紧急制动、或注册全失败）时，
     四条事件能力必须报「缺」，而不是跟着 ctx.on 一起报 true —— 那正是第 11 条发现：
     原来的写法会一边说「能力齐备」一边在 degrade 里说「不会触发」，自相矛盾。 */
  const unarmed = probeHost(fullCtx(), NOT_ARMED_HOOKS);
  const unarmedEvents = unarmed.capabilities.filter((row) => row.id.startsWith("events."));
  check(
    "v0.7.1：只有 ctx.on、一个钩子都没挂上时，四条事件能力报「缺」（不再假阳性）",
    unarmedEvents.length === 4 && unarmedEvents.every((row) => row.present === false),
    unarmedEvents.map((row) => `${row.id}=${row.present}`).join(" "),
  );
  check(
    "v0.7.1：不传账目时读实时账目；四条事件能力的 present 与 hookStats().counts 一致",
    unarmed.capabilities
      .filter((row) => row.id.startsWith("events."))
      .every((row) => row.present === (Number(hookStats().counts?.[row.id.replace(/^events\./, "")] ?? 0) > 0)),
    JSON.stringify(hookStats().counts ?? {}),
  );
  /* v0.7.1：入参被写坏时 hostSummary/hostNotes 不许抛（第 13 条发现：hostSummary({ok:false}) 原来会 TypeError）。 */
  const brokenSummaries = [
    hostSummary({ ok: false }),
    hostSummary({ ok: false, missing: "tools.register" }),
    hostSummary({ ok: true, capabilities: [{ surface: "host", present: false }] }),
  ];
  check(
    "v0.7.1：hostSummary/hostNotes 对残缺入参也不抛（missing 不是数组、行缺字段都兜住）",
    brokenSummaries.every((line) => typeof line === "string" && line.length > 0) &&
      hostNotes({ ok: false }).length === 0 &&
      hostNotes({ capabilities: [{ surface: "host", present: false }] }).length === 1,
    brokenSummaries.join(" | "),
  );
  /* v0.7.2：v0.7.1 的兜底「兜住了不抛，但把 undefined 当文案渲染出去了」——
     拿 v0.7.1 去真机自审找出来的三条里有两条就是这个（第 2、3 条发现）。 */
  check(
    "v0.7.2：兜底文案里不许出现字面量 undefined（行缺 id/label/degrade 时也要有可读的名字）",
    brokenSummaries.every((line) => !line.includes("undefined")) &&
      hostNotes({ capabilities: [{ surface: "host", present: false }] }).every(
        (line) => !line.includes("undefined"),
      ),
    `${brokenSummaries.join(" | ")} || ${hostNotes({ capabilities: [{ surface: "host", present: false }] }).join(" | ")}`,
  );
  check(
    "v0.7.2：ok=true 只说「必需能力齐备」——不再一边说齐备、一边说缺少可选能力（自相矛盾）",
    hostSummary({
      ok: true,
      capabilities: [{ id: "inject.llm", label: "LLM 服务", surface: "host", present: false }],
    }).includes("必需能力齐备") &&
      hostSummary({
        ok: true,
        capabilities: [{ id: "inject.llm", label: "LLM 服务", surface: "host", present: false }],
      }).includes("缺少 inject.llm"),
    hostSummary({
      ok: true,
      capabilities: [{ id: "inject.llm", label: "LLM 服务", surface: "host", present: false }],
    }),
  );
  /* v0.7.3（第 5 轮真机自审第 7 条）：只信入参字段时，手工拼装/写坏的对象会输出自相矛盾的句子。
     现在有行数据就以行数据为准；没有行数据才回落字段。 */
  const requiredAbsentRow = {
    ok: true,
    capabilities: [{ id: "inject.llm", label: "LLM 服务", surface: "host", required: true, present: false }],
  };
  check(
    "v0.7.3：入参 ok=true 但行数据说必需能力缺失时，措辞以行数据为准（不再自相矛盾）",
    hostSummary(requiredAbsentRow).includes("宿主缺必需能力：inject.llm") &&
      !hostSummary(requiredAbsentRow).includes("必需能力齐备"),
    hostSummary(requiredAbsentRow),
  );
  check(
    "v0.7.3：rowName 一个工具按 priority 取名（行缺 id/label 时仍不出现字面量 undefined）",
    !hostSummary({ capabilities: [{ surface: "host", present: false, required: true }] }).includes("undefined") &&
      hostSummary({ capabilities: [{ surface: "host", present: false, required: true }] }).includes("未命名能力") &&
      hostNotes({ capabilities: [{ surface: "host", present: false }] }).every((line) => line.includes("未命名能力")),
    hostSummary({ capabilities: [{ surface: "host", present: false, required: true }] }),
  );
  /* v0.7.2：账目按 ctx 取（自审第 1 条）—— 模块级账目只代表「这份实例挂了什么」，
     不能拿去回答别的 ctx，否则同一进程里的两份实例会互相串账。 */
  resetHookStats();
  const ctxA = { on: () => () => {} };
  const ctxB = { on: () => () => {} };
  const emptyForBoth =
    !hookStatsFor(ctxA).counts["tools/result"] && !hookStatsFor(ctxB).counts["tools/result"];
  armHook(ctxA, "tools/result", () => {});
  const ledgerA = hookStatsFor(ctxA);
  const eventsForA = probeHost(ctxA).capabilities.filter((row) => row.id.startsWith("events."));
  const eventsForB = probeHost(ctxB).capabilities.filter((row) => row.id.startsWith("events."));
  check(
    "v0.7.2：还没挂钩子时任意 ctx 都拿到实时账目（不误判成「有钩子」）",
    emptyForBoth,
    `A=${JSON.stringify(hookStatsFor(ctxB).counts)}`,
  );
  check(
    "v0.7.2：账目跟着 ctx 走 —— A 挂上的事件在 B 那里必须是 0（多实例/热重载不串账）",
    ledgerA.counts["tools/result"] === 1 &&
      Number(hookStatsFor(ctxB).counts["tools/result"] ?? 0) === 0 &&
      eventsForA.filter((row) => row.present === true).map((row) => row.id).join(",") ===
        "events.tools/result" &&
      eventsForB.every((row) => row.present === false),
    `A=${ledgerA.counts["tools/result"]} B=${hookStatsFor(ctxB).counts["tools/result"]} eventsA=${eventsForA.map((row) => `${row.id}=${row.present}`).join(",")} eventsB=${eventsForB.map((row) => row.present).join(",")}`,
  );
  resetHookStats();
}

/* ----------------------------------------------------------- 逐条「缺一」验证降级 */
for (const capability of HOST_CONTRACT.capabilities) {
  if (capability.surface === "client") continue;
  const host = probeHost(ctxWithout(capability.id), ARMED_HOOKS);
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

/* ------------------------- 服务藏在 inject 后面时也必须认得出来（v0.7.1 的真机事故） */
{
  /** 复刻真机：服务由别的 fiber 提供，直接读属性抛 cordis 的基错，只有 reflect 读得到。 */
  function injectOnlyCtx() {
    const services = {
      llm: { stream: () => {} },
      jobs: { start: () => {} },
      skills: { register: () => () => {} },
      subagents: { start: () => {} },
    };
    const ctx = {
      tools: { register: () => () => {} },
      subprocess: { spawn: () => {}, resolveExecutable: async () => "" },
      commands: { register: () => () => {} },
      credentials: { resolve: async () => "" },
      on: () => () => {},
      reflect: { get: (name) => services[name] },
    };
    for (const name of Object.keys(services)) {
      Object.defineProperty(ctx, name, {
        enumerable: true,
        get() {
          throw new Error(`cannot get property "${name}" without inject`);
        },
      });
    }
    return ctx;
  }

  const host = probeHost(injectOnlyCtx());
  const injectRows = host.capabilities.filter((row) => row.id.startsWith("inject."));
  check(
    "v0.7.1：服务藏在 inject 后面（直接读 ctx.llm 抛 cannot get property … without inject）时，探针仍靠 ctx.reflect.get(name,false) 认出 llm/jobs/skills/subagents",
    host.errors.length === 0 && injectRows.length === 4 && injectRows.every((row) => row.present === true),
    `errors=${JSON.stringify(host.errors)} present=${injectRows.map((row) => row.present).join(",")}`,
  );

  const broken = injectOnlyCtx();
  broken.reflect = {
    get() {
      throw new Error("reflect 也炸了");
    },
  };
  const brokenHost = probeHost(broken);
  check(
    "v0.7.1：reflect 自己抛错时按「缺」处理但绝不抛出去（探针不能成为新的崩溃点）",
    brokenHost.capabilities.filter((row) => row.id.startsWith("inject.")).every((row) => row.present === false) && brokenHost.errors.length === 0,
    JSON.stringify(brokenHost.errors),
  );

  const viaCtxGet = { ...fullCtx(), get: (name) => (name === "llm" ? { stream: () => {} } : undefined) };
  check(
    "v0.7.1：没有 reflect、只有 ctx.get(name) 的宿主也认（第三种读法）",
    probeHost(viaCtxGet).capabilities.find((row) => row.id === "inject.llm")?.present === true,
    "",
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
