/**
 * 浏览器半侧（lib/client.js）的离线冒烟测试。
 *
 * 不依赖真实 DSH，也不依赖 React（本机没有可 require 的 react）：
 *  - 用一个 30 行的"迷你 React"（useState/useMemo/useCallback/useSyncExternalStore
 *    + 函数组件展开）把页面树渲染成普通对象；
 *  - 伪造 window.__ModuleLoader__ / slots / configForms，验证注册契约；
 *  - 断言字段、取值与状态行；模拟输入改动 → 点「保存」/「恢复默认」，
 *    断言调回了 form.set / form.unset。
 *
 * 运行：node test/client-smoke.mjs
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = dirname(HERE);

let failures = 0;
let total = 0;
function check(name, ok, detail = "") {
  total += 1;
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ------------------------------------------------------------ 迷你 React */

const stores = new WeakMap();
let current = null;

function renderComponent(fn, props) {
  let store = stores.get(fn);
  if (!store) {
    store = { values: [] };
    stores.set(fn, store);
  }
  const prev = current;
  store.index = 0;
  current = store;
  try {
    return fn(props);
  } finally {
    current = prev;
  }
}

function useState(initial) {
  const store = current;
  const i = store.index++;
  if (store.values.length <= i) store.values[i] = typeof initial === "function" ? initial() : initial;
  const set = (next) => {
    store.values[i] = typeof next === "function" ? next(store.values[i]) : next;
  };
  return [store.values[i], set];
}

/* useEffect / useRef：效果先入队，渲染结束后由 flushEffects() 统一执行（带 deps 比较）。 */
const effectSlots = new WeakMap();
let pendingEffects = [];

function useEffect(fn, deps) {
  const store = current;
  const i = store.index++;
  let slots = effectSlots.get(store);
  if (!slots) {
    slots = [];
    effectSlots.set(store, slots);
  }
  const prev = slots[i];
  const same =
    prev && Array.isArray(deps) && Array.isArray(prev.deps) && deps.length === prev.deps.length && deps.every((d, k) => Object.is(d, prev.deps[k]));
  if (same) return;
  slots[i] = { deps: Array.isArray(deps) ? deps.slice() : null, cleanup: prev ? prev.cleanup : undefined, fn };
  pendingEffects.push({ store, i });
}

function useRef(initial) {
  const store = current;
  const i = store.index++;
  if (!store.refs) store.refs = [];
  if (!(i in store.refs)) store.refs[i] = { current: initial === undefined ? null : initial };
  return store.refs[i];
}

function flushEffects() {
  const queue = pendingEffects;
  pendingEffects = [];
  for (const { store, i } of queue) {
    const slots = effectSlots.get(store);
    const rec = slots && slots[i];
    if (!rec || typeof rec.fn !== "function") continue;
    if (typeof rec.cleanup === "function") rec.cleanup();
    const fn = rec.fn;
    rec.fn = null;
    const cleanup = fn();
    rec.cleanup = typeof cleanup === "function" ? cleanup : undefined;
  }
}

const miniReact = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props || {}), children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children },
  }),
  useState,
  useEffect,
  useRef,
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useSyncExternalStore: (subscribe, read) => {
    subscribe(() => {});
    return read();
  },
};

/** 展开函数组件，返回由宿主元素/文本组成的普通树（children 永远是扁平数组）。 */
function flatten(value) {
  if (value === null || value === undefined || value === false || value === true) return [];
  if (Array.isArray(value)) return value.flatMap(flatten);
  return [value];
}

function expand(node) {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (Array.isArray(node)) return node.map(expand).filter((n) => n !== null);
  if (typeof node === "string" || typeof node === "number") return { text: String(node) };
  if (node.type === undefined) return null;
  if (typeof node.type === "function") return expand(renderComponent(node.type, node.props));
  return { tag: node.type, props: node.props, children: flatten(expand(node.props ? node.props.children : undefined)) };
}

const kidsOf = (node) => (Array.isArray(node.children) ? node.children : []);
const textOf = (node) => (node === null ? "" : node.text !== undefined ? node.text : kidsOf(node).map(textOf).join(" "));
function hosts(node, out = []) {
  if (!node) return out;
  if (node.tag) out.push(node);
  for (const child of kidsOf(node)) hosts(child, out);
  return out;
}

/* ------------------------------------------------------------ 载入 client.js */

const loaded = [];
globalThis.window = { __ModuleLoader__: { load: (d) => loaded.push(d) } };
await import(pathToFileURL(join(PLUGIN_DIR, "lib", "client.js")).href);

check("client.js 调用了 __ModuleLoader__.load", loaded.length === 1, `loaded=${loaded.length}`);
const descriptor = loaded[0] || {};
check("load({ id }) = 包名", descriptor.id === "dsh-open-code-review", String(descriptor.id));
check("factory 是函数", typeof descriptor.factory === "function");

const plugin = descriptor.factory((spec) => {
  if (spec === "react") return miniReact;
  throw new Error(`client.js 依赖了额外模块：${spec}`);
});
check("插件导出 apply", typeof plugin.apply === "function");
const inject = Array.isArray(plugin.inject) ? plugin.inject : [];
check("插件 inject 含 slots", inject.includes("slots"), JSON.stringify(plugin.inject));
/* cordis 的注入是全有全无：inject 里只要有一个服务没人 provide，整个 fiber 就是 INACTIVE、
   apply 根本不跑（设置页整块消失）。所以插件本身不硬依赖 remote，
   remote/remote.session 声明在 apply 内部的子 fiber 上（见下面的子注入断言）。 */
check(
  "插件 inject 不硬依赖 remote",
  inject.includes("slots") && !inject.includes("remote") && !inject.includes("remote.session"),
  JSON.stringify(plugin.inject),
);

/* ------------------------------------------------------------ 注册契约 */

const registrations = [];

/**
 * 造一个「宿主 ctx」桩：主夹具、没有 Remote 桥、服务迟到三个场景共用同一套
 * inject / slots / configForms 表面，注入契约改了只改这一处（评审 #5、#6）。
 * 场景差异一律走 overrides：注册表数组、get / inject 的具体行为。
 */
function makeCtx(overrides = {}) {
  const ctx = {
    injectCalls: [],
    slotInjectCalls: [],
    getCalls: [],
    effectCalls: [],
    localeRegistrations: [],
    registrations, /* 默认写进主夹具的注册表 */
    /* cordis 的服务守卫拦下属性访问时的兜底读取口（ReflectService.get）。 */
    get(name) {
      ctx.getCalls.push(name);
      return undefined;
    },
    inject(deps, cb) {
      ctx.injectCalls.push(deps);
      return cb(ctx);
    },
    /* 注册类动作都要走 ctx.effect（随 fiber 销毁自动撤销）：立刻执行并记下标签。 */
    effect(cb, label) {
      ctx.effectCalls.push(label);
      return cb();
    },
    /* locale 是可选服务：默认桩的 bind 对未知词条返回键名，这样 makeT 会退回内联 zh 文案。 */
    locale: {
      register(ns, pairs) {
        ctx.localeRegistrations.push({ ns, pairs });
        return () => {};
      },
      bind(ns) {
        return (key) => (Object.prototype.hasOwnProperty.call(ctx.localeTexts || {}, key) ? ctx.localeTexts[key] : key);
      },
    },
    slots: {
      inject(name, cb) {
        ctx.slotInjectCalls.push(name);
        return cb();
      },
      register(options, component) {
        ctx.registrations.push({ options, component });
        return () => {};
      },
    },
    configForms: { get: () => ctx.form },
    ...overrides,
  };
  return ctx;
}

const fakeCtx = makeCtx({
  formIds: [],
  onCalls: [],
  /* 主题切换订阅：v0.5.0 起用来催一次重渲染（见下面的 colorScheme 断言）。 */
  on(event, cb) {
    fakeCtx.onCalls.push(event);
    return () => {};
  },
  get(name) {
    fakeCtx.getCalls.push(name);
    if (name === "remote") {
      if (fakeCtx.remoteThrows) throw new Error('cannot get property "remote" without inject');
      return fakeCtx.getFallback;
    }
    /* 主题服务：v0.5.0 起用来决定原生下拉弹出层的配色（见 selectionScheme 断言）。 */
    if (name === "theme") return fakeCtx.themeValue;
    return undefined;
  },
  configForms: {
    get(id) {
      fakeCtx.formIds.push(id);
      if (Array.isArray(fakeCtx.rejectIds) && fakeCtx.rejectIds.includes(id)) throw new Error(`unknown entry: ${id}`);
      return fakeCtx.form;
    },
  },
});

plugin.apply(fakeCtx);
check("apply 注入 configForms", fakeCtx.injectCalls.some((d) => d.includes("configForms")), JSON.stringify(fakeCtx.injectCalls));
check("注册进 plugins.bundle.config", fakeCtx.slotInjectCalls.includes("plugins.bundle.config"), JSON.stringify(fakeCtx.slotInjectCalls));
check("注册进 settings.section", fakeCtx.slotInjectCalls.includes("settings.section"), JSON.stringify(fakeCtx.slotInjectCalls));
check("注册四个 cell（设置页两处 + 进度行 + 回合尾部按钮）", registrations.length === 4, `n=${registrations.length}`);
const dockReg = registrations.find((r) => r.options.name === "conversation.input.dock");
check("进度行注册到 conversation.input.dock", Boolean(dockReg), JSON.stringify(registrations.map((r) => r.options.name)));
check(
  "进度行的 id/order 自取，不与内置席位（todo/goal/queue/git-graph）撞",
  Boolean(dockReg) && dockReg.options.id === "ocr-review-progress" && dockReg.options.order === 15,
  dockReg ? JSON.stringify(dockReg.options) : "没有该 cell",
);
check(
  "apply 为模型目录单独声明 remote 子注入",
  fakeCtx.injectCalls.some((d) => Array.isArray(d) && d.includes("remote") && d.includes("remote.session")),
  JSON.stringify(fakeCtx.injectCalls),
);
check(
  "apply 为文案单独声明 locale 子注入",
  fakeCtx.injectCalls.some((d) => Array.isArray(d) && d.includes("locale")),
  JSON.stringify(fakeCtx.injectCalls),
);

/* 可见文案必须注册进 Client locale 服务（references/ui-plugin.md 的硬要求）。 */
const localeReg = fakeCtx.localeRegistrations.find((r) => r.ns === "dsh-open-code-review") || { pairs: null };
const zhDict = (localeReg.pairs && localeReg.pairs.zh) || {};
const enDict = (localeReg.pairs && localeReg.pairs.en) || {};
check("locale 服务收到本插件的词典（zh + en）", Boolean(localeReg.pairs && zhDict && enDict));
check("文案注册走 ctx.effect（随 fiber 撤销）", fakeCtx.effectCalls.some((l) => typeof l === "string" && l.includes("文案")), JSON.stringify(fakeCtx.effectCalls));
check("zh 词典含生成的字段文案", String(zhDict["field.llmModel.hint"] || "").includes("候选来自 DSH 自己的模型目录"), String(zhDict["field.llmModel.hint"]).slice(0, 60));
check(
  "zh 词典含选项文案与分组名",
  String(zhDict["choice.llmMode.dsh"] || "").startsWith("dsh —")
    && zhDict["group.basic"] === "基础"
    && zhDict["group.route"] === "模型路由"
    && zhDict["group.reviewer"] === "独立评审 agent"
    && zhDict["group.timing"] === "评审时机",
  JSON.stringify([zhDict["choice.llmMode.dsh"], zhDict["group.basic"], zhDict["group.route"], zhDict["group.reviewer"], zhDict["group.timing"]]),
);
check("en 词典覆盖字段标签、按钮与状态文案", enDict["field.llmModel.label"] === "Model" && enDict["button.save"] === "Save" && Boolean(enDict["status.routeDsh"]), JSON.stringify([enDict["field.llmModel.label"], enDict["button.save"]]));
check("四个 cell 都声明了 locale 命名空间", registrations.every((r) => r.options.locale === "dsh-open-code-review"), JSON.stringify(registrations.map((r) => r.options)));
const reg = registrations.find((r) => r.options.name === "plugins.bundle.config") || { options: {}, component: () => null };
const sectionReg = registrations.find((r) => r.options.name === "settings.section") || { options: {}, component: () => null };
check("key = 包名", reg.options.key === "dsh-open-code-review", String(reg.options.key));
check("name = plugins.bundle.config", reg.options.name === "plugins.bundle.config", String(reg.options.name));
check(
  "设置页 id/order/label",
  sectionReg.options.id === "open-code-review" && sectionReg.options.order === 17 && sectionReg.options.label === "代码评审",
  JSON.stringify(sectionReg.options),
);

/* ------------------------------------------------------------ 渲染断言 */

const writes = [];
let snapshot = {
  status: "ready",
  value: {
    enabled: true,
    engine: "auto",
    audience: "agent",
    autoReview: "adaptive",
    autoScope: "workspace",
    autoMaxPerSession: 3,
    autoMinReviewableFiles: 1,
    autoMinIntervalMs: 60000,
    autoSkipSubagents: true,
    autoIncludeDiff: true,
    reviewerAgent: "off",
    reviewerProvider: "spawn",
    reviewerRounds: 3,
    timeoutMinutes: 15,
    progress: true,
    llmBaseUrl: "https://api.commandcode.ai/provider/v1",
    llmProtocol: "openai",
    llmModel: "deepseek/deepseek-v4.1-flash",
    llmApiKeyRef: "COMMANDCODE_API_KEY",
    ocrPath: "",
    verbose: false,
  },
  base: {},
  user: { verbose: true },
  revision: 7,
  writable: true,
  mode: "host",
};
fakeCtx.form = {
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
  set: async (key, value) => {
    writes.push({ op: "set", key, value });
    return true;
  },
  unset: async (key) => {
    writes.push({ op: "unset", key });
    return true;
  },
};

const props = { view: "page" };
const render = () => {
  const built = expand(miniReact.createElement(reg.component, props));
  flushEffects();
  return built;
};
const tree = render();
const html = textOf(tree);
/* 主页只放「要做的决定」这 4 行；高级区（模型路由 2 + 独立评审 agent 1 + 评审时机 1 = 4）默认不渲染；
   其余 15 项是 v0.11.0 起不再露出的配置项，只在诊断区只读列出。 */
const BASIC_LABELS = ["总开关", "默认引擎", "按需评审", "自动评审"];
const ADVANCED_LABELS = ["模型名", "提供方（provider）", "独立评审 agent", "评审先于测试"];
/* 「独立评审 agent」同时是折叠区里那个分组的名字，而收起提示会点名三个分组 —— 它单列。 */
const COLLAPSED_LABELS = ["模型名", "提供方（provider）", "评审先于测试"];
const ADVANCED_KEYS = ["llmModel", "llmProvider", "reviewerAgent", "preTest"];
const HIDDEN_KEYS = ["llmMode", "llmBaseUrl", "llmProtocol", "llmApiKeyRef", "autoScope", "autoMaxPerSession", "autoMinReviewableFiles", "autoMinIntervalMs", "autoSkipSubagents", "autoIncludeDiff", "audience", "ocrPath", "timeoutMinutes", "progress", "verbose"];
const HIDDEN_LABELS = ["LLM 路由", "端点 Base URL", "端点协议", "API Key 引用", "自动评审范围", "每会话上限", "最少可审文件数", "最小间隔", "跳过子代理会话", "委派时带 diff", "结果详细程度", "ocr 可执行文件", "单次超时（分钟）", "评审进度", "调试日志"];
for (const label of BASIC_LABELS) {
  check(`基础组渲染字段「${label}」`, html.includes(label));
}
for (const label of COLLAPSED_LABELS) {
  check(`高级项「${label}」默认收起`, !html.includes(label));
}
check("收起提示里点名了三个分组", html.includes("模型路由") && html.includes("独立评审 agent") && html.includes("评审时机"), html.slice(0, 200));
check("高级设置标题显示项数（收起时也显示 4 项）", html.includes("高级设置（4 项）"), html.slice(0, 180));
check("高级设置默认收起（aria-expanded=false）", hosts(tree).some((n) => n.props && n.props["data-ocr-advanced-toggle"] === "1" && n.props["aria-expanded"] === "false"));
check("收起时说明怎么展开", html.includes("已收起"), html.slice(0, 180));
check("主页说明字段来源徽标", html.includes("设置页已改"));
/* 诊断区：被收起的键没有控件，但键名与当前生效值要能查到（要改就去写 config.json）。 */
const diagRows = hosts(tree).filter((n) => n.props && typeof n.props["data-ocr-diagnostics-row"] === "string");
check("诊断区只读列出全部 15 个被收起的键", diagRows.length === 15 && HIDDEN_KEYS.every((k) => diagRows.some((r) => r.props["data-ocr-diagnostics-row"] === k)), `n=${diagRows.length}`);
check("诊断区写明要改就写 config.json", html.includes("config.json"), textOf(tree).slice(-200));
check("诊断区带出被收起键的当前生效值", textOf(tree).includes("3 · autoMaxPerSession"), textOf(tree).slice(-240));
for (const label of HIDDEN_LABELS) {
  check(`被收起的「${label}」在诊断区里只读出现、没有控件`, textOf(tree).includes(label) && !controlRows(tree).some((r) => HIDDEN_KEYS.includes(r.key)));
}
check("带出条目 id", html.includes("include:dsh-open-code-review"));
check("状态行含 ready/可写", html.includes("状态 ready") && html.includes("可写"));
check("收起时高级区没有任何控件行", controlRows(tree).filter((r) => ADVANCED_KEYS.includes(r.key)).length === 0, `n=${controlRows(tree).length}`);
check("已改字段有标记", html.includes("已改"));
check("enabled 勾选", hosts(tree).some((n) => n.tag === "input" && n.props.type === "checkbox" && n.props.checked === true));

/** 控件行：client.js 每行都带 data-ocr-field-row 标记，行内第一个 input/select 就是控件。 */
function controlRows(node, out = []) {
  if (!node) return out;
  if (node.props && typeof node.props["data-ocr-field-row"] === "string") {
    const all = hosts(node);
    out.push({
      key: node.props["data-ocr-field-row"],
      row: node,
      field: all.find((n) => n.tag === "input" || n.tag === "select"),
      buttons: all.filter((n) => n.tag === "button"),
    });
    return out;
  }
  for (const c of kidsOf(node)) controlRows(c, out);
  return out;
}
const rows = controlRows(tree);
/** 只数高级区的行（展开后整棵树里 = 基础组 + 高级区）。 */
const advancedRows = (t) => controlRows(t).filter((r) => ADVANCED_KEYS.includes(r.key));
check("基础组 4 个控件行（dsh 模式、独立评审 agent=off，含按需评审）", rows.length === 4, `n=${rows.length}`);
/* v0.5.0 步骤 3：默认不自动评审，改成「按需」——这两个决定必须能从主页一眼看出来。 */
const onDemandRow = rows.find((r) => r.key === "onDemand");
check(
  "新增「按需评审」行（基础组，默认勾选）",
  Boolean(onDemandRow) && onDemandRow.field.tag === "input" && onDemandRow.field.props.type === "checkbox" && onDemandRow.field.props.checked === true,
  onDemandRow ? `${onDemandRow.field.tag}/${onDemandRow.field.props.type}/${onDemandRow.field.props.checked}` : "没有该行",
);
const autoReviewRow = rows.find((r) => r.key === "autoReview");
const autoReviewValues = autoReviewRow ? hosts(autoReviewRow.row).filter((n) => n.tag === "option").map((n) => String(n.props.value)) : [];
const autoReviewOptionTexts = autoReviewRow ? hosts(autoReviewRow.row).filter((n) => n.tag === "option").map(textOf) : [];
check(
  "「自动评审」下拉只给 off / adaptive 两档（v0.11.0 收起 inject / followup），off 档写明 v0.5.0 起是默认",
  autoReviewValues.join(",") === "off,adaptive" && autoReviewOptionTexts.some((o) => o.includes("v0.5.0 起默认")),
  JSON.stringify(autoReviewValues),
);
check(
  "「自动评审」的说明写明另两档要写 config.json 的 auto 键",
  html.includes("出厂默认 off") && html.includes("写 config.json 的 auto 键"),
  html.slice(0, 200),
);

/* 高级设置：默认收起 → 点标题展开 → 再点收起（折叠只是不渲染，草稿仍由 saveAll 一起保存） */
const advToggle = (t) => hosts(t).find((n) => n.props && n.props["data-ocr-advanced-toggle"] === "1");
function setAdvanced(open) {
  const btn = advToggle(render());
  if (btn && (btn.props["aria-expanded"] === "true") !== open) btn.props.onClick();
}
check("高级设置有可点的标题", Boolean(advToggle(tree)));
setAdvanced(true);
const advTree = render();
const advRows = controlRows(advTree);
check("展开后高级项 4 行（模型路由 2 + 独立评审 agent 1 + 评审时机 1）", advancedRows(advTree).length === 4, `n=${advancedRows(advTree).length}`);
check("展开后 aria-expanded=true", advToggle(advTree).props["aria-expanded"] === "true");
check("展开后不再显示「已收起」的展开提示", !textOf(advTree).includes("低频参数已收起"));
check(
  "展开后每个高级项都渲染出来",
  ADVANCED_LABELS.every((label) => textOf(advTree).includes(label)),
  ADVANCED_LABELS.filter((l) => !textOf(advTree).includes(l)).join(" / "),
);
check("展开后模型名带出当前值", hosts(advTree).some((n) => n.tag === "input" && n.props.value === "deepseek/deepseek-v4.1-flash"));
check("高级项也有「恢复默认」", advRows.every((r) => r.buttons.some((b) => textOf(b) === "恢复默认")));
const preTestRow = advRows.find((r) => r.key === "preTest");
check(
  "「评审先于测试」行是下拉，三档 off/remind/gate（v0.5.7）",
  Boolean(preTestRow) && preTestRow.field.tag === "select" &&
    hosts(preTestRow.row).filter((n) => n.tag === "option").map((n) => n.props.value).join(",") === "off,remind,gate",
  preTestRow ? hosts(preTestRow.row).filter((n) => n.tag === "option").map((n) => n.props.value).join(",") : "行不存在",
);
/* 高级区的文本框：草稿 → 保存 → form.set（旧用例拿 Base URL 测，那个键已收进诊断区）。 */
const provRow0 = advRows.find((r) => r.key === "llmProvider");
check("高级区有 provider 文本行（dsh 模式）", Boolean(provRow0) && provRow0.field.tag === "input");
if (provRow0) {
  provRow0.field.props.onChange({ target: { value: "other" } });
  const provRow1 = controlRows(render()).find((r) => r.key === "llmProvider");
  const saveProv0 = provRow1 && provRow1.buttons.find((b) => textOf(b) === "保存");
  check("改动后草稿生效（provider）", Boolean(provRow1) && provRow1.field.props.value === "other");
  check("改动后出现「保存」", Boolean(saveProv0));
  if (saveProv0) {
    await saveProv0.props.onClick();
    check("保存调用 form.set(llmProvider)", writes.some((w) => w.op === "set" && w.key === "llmProvider" && w.value === "other"), JSON.stringify(writes.slice(-2)));
  }
}
setAdvanced(false);
check("再点一次收起、DOM 里没有高级行", advancedRows(render()).length === 0 && controlRows(render()).length === 4, `n=${controlRows(render()).length}`);

check("dsh 模式状态行说明走本机桥", html.includes("LLM 走 DSH 本机桥"));
/* v0.11.0：LLM 路由与静态端点三件套从设置页收起 —— 页面给不出控件，改它们要写 config.json。 */
check(
  "端点四键在设置页没有控件（只能写 config.json）",
  !controlRows(render()).some((r) => ["llmMode", "llmBaseUrl", "llmProtocol", "llmApiKeyRef"].includes(r.key)),
  JSON.stringify(controlRows(render()).map((r) => r.key)),
);
check(
  "诊断区写出 endpoint 的写法（llm.mode / baseUrl / protocol / apiKeyRef）",
  textOf(render()).includes("llm.mode = endpoint") && textOf(render()).includes("llm.baseUrl") && textOf(render()).includes("llm.apiKeyRef"),
);
check("改动前没有任何行带「保存」按钮", controlRows(render()).every((r) => !r.buttons.some((b) => textOf(b) === "保存")));
check("每行都有「恢复默认」", rows.every((r) => r.buttons.some((b) => textOf(b) === "恢复默认")));
/* ---------- 收起进诊断区的低频键：任何状态下都不给控件 ---------- */
setAdvanced(true);
const expandedKeys = controlRows(render()).map((r) => r.key);
setAdvanced(false);
const collapsedKeys = controlRows(render()).map((r) => r.key);
check(
  "15 个低频键在收起与展开两种状态下都没有控件（要改就写 config.json）",
  HIDDEN_KEYS.every((k) => !expandedKeys.includes(k) && !collapsedKeys.includes(k)),
  JSON.stringify(HIDDEN_KEYS.filter((k) => expandedKeys.includes(k) || collapsedKeys.includes(k))),
);
check(
  "展开态可见键 = 基础 4 + 高级 4（模型路由 2 / 独立评审 agent 1 / 评审时机 1）",
  expandedKeys.join(",") === "enabled,engine,onDemand,autoReview,llmModel,llmProvider,reviewerAgent,preTest",
  expandedKeys.join(","),
);
check("收起态可见键 = 基础 4", collapsedKeys.join(",") === "enabled,engine,onDemand,autoReview", collapsedKeys.join(","));
check("诊断区说明「键名即是 config.json 的写法」", html.includes("键名") && html.includes("运行期实况"));

/* 折叠态也要能看见「高级区里有待保存的改动」，并且能逐字段撤销。
   用「评审时机」这个下拉来测：它没有内部状态；模型名那行是可搜索下拉，改它会把内部 text/open
   状态留在测试夹具里，污染后面的候选列表用例。 */
setAdvanced(true);
const draftPreRow = controlRows(render()).find((r) => r.key === "preTest");
check("找到高级区的评审时机行", Boolean(draftPreRow) && draftPreRow.field.tag === "select");
if (draftPreRow) draftPreRow.field.props.onChange({ target: { value: "remind" } });
setAdvanced(false);
const collapsedDirty = render();
check("折叠后标题显示「1 项待保存」", textOf(collapsedDirty).includes("1 项待保存"), textOf(collapsedDirty).slice(0, 160));
check("折叠后高级行不在 DOM 里", controlRows(collapsedDirty).length === 4, `n=${controlRows(collapsedDirty).length}`);
setAdvanced(true);
const undoRow = controlRows(render()).find((r) => r.key === "preTest");
const undoBtn = undoRow && undoRow.buttons.find((b) => textOf(b) === "撤销");
check("折叠期间草稿还在，展开后能逐字段撤销", Boolean(undoBtn));
if (undoBtn) undoBtn.props.onClick();
check("撤销后该行不再算脏（值已回到已存值）", !controlRows(render()).find((r) => r.key === "preTest").buttons.some((b) => textOf(b) === "保存"));
setAdvanced(false);
check("撤销后待保存徽标消失", !textOf(render()).includes("项待保存"));

/* ------------------------------------------------------------ 模型名：可搜索下拉 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const modelInputNode = (t) => hosts(t).find((n) => n.tag === "input" && n.props["data-ocr-model-input"] === true);
const modelMenuNode = (t) => hosts(t).find((n) => n.props && n.props["data-ocr-model-menu"] === true);
const modelItemNodes = (t) => hosts(t).filter((n) => n.props && n.props["data-ocr-model-item"] === true);

/* 共用的模型清单：两处目录夹具都从这里取，改内容时只改这一处。 */
const CATALOG_MODELS = [
  { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek v4.1 Flash", description: "部署默认" },
  { id: "glm-5.3-flashx", name: "GLM-5.3 FlashX" },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
];

/* 服务齐全时的目录响应：兜底读取口、服务迟到两个场景也复用这份夹具，别抄第三份。 */
const fullCatalogResponse = async () => ({
  ok: true,
  value: {
    default: { provider: "commandcode", model: "deepseek/deepseek-v4.1-flash" },
    routableProviders: ["commandcode", "other"],
    groups: [
      { id: "commandcode", name: "Command Code", models: CATALOG_MODELS },
      { id: "other", name: "其它提供方", models: [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }] },
    ],
    failures: [{ id: "broken", name: "Broken", message: "timeout" }],
  },
});
fakeCtx.remote = { session: { modelCatalog: fullCatalogResponse } };
/* 后面的降级场景会改写 fakeCtx.remote：收尾时按这份快照恢复，别把共享夹具留在坏状态（评审 #5）。 */
const healthyRemote = fakeCtx.remote;
/* 模型名/提供方在 v0.11.0 起属于「高级设置」里的模型路由组：先展开，再让目录异步读完。 */
setAdvanced(true);
render();
await tick();
const catalogTree = render();check("模型目录读完后给出候选数量", textOf(catalogTree).includes("4 个模型"), textOf(catalogTree).slice(-140));
check("目录读取失败也如实提示", textOf(catalogTree).includes("1 个提供方没读出来"));
check("带出当前模型的友好名", textOf(catalogTree).includes("当前：DeepSeek v4.1 Flash（Command Code）"), textOf(catalogTree).slice(-160));

const mi = modelInputNode(catalogTree);
check("模型名仍是可编辑输入框", Boolean(mi) && mi.props.disabled !== true && mi.props.value === "deepseek/deepseek-v4.1-flash");
check("默认收起候选列表", !modelMenuNode(catalogTree));
check("模型目录来自 ctx.remote.session", textOf(catalogTree).includes("候选来自 DSH 自己的模型目录"));
check(
  "dsh 模式显示 DSH 默认模型（留空即跟随它）",
  textOf(catalogTree).includes("DSH 默认模型") && textOf(catalogTree).includes("commandcode") && hosts(catalogTree).filter((n) => n.props && n.props["data-ocr-model-default"] === true).length === 1,
  textOf(catalogTree).slice(-200),
);

mi.props.onFocus();
const openTree = render();
check("聚焦后展开候选列表", Boolean(modelMenuNode(openTree)));
check("候选带提供方名", textOf(modelMenuNode(openTree)).includes("Command Code") && textOf(modelMenuNode(openTree)).includes("其它提供方"));
check("候选同时给名称与 id", textOf(modelMenuNode(openTree)).includes("GLM-5.3 FlashX") && textOf(modelMenuNode(openTree)).includes("kimi-k2.7-code"));
check("展开时列出全部 4 个模型（不被当前值筛掉）", modelItemNodes(openTree).length === 4, `n=${modelItemNodes(openTree).length}`);

modelInputNode(openTree).props.onChange({ target: { value: "glm" } });
const filteredTree = render();
check("输入即过滤", modelItemNodes(filteredTree).length === 1 && textOf(modelItemNodes(filteredTree)[0]).includes("GLM-5.3 FlashX"), `n=${modelItemNodes(filteredTree).length}`);

modelItemNodes(filteredTree)[0].props.onMouseDown({ preventDefault() {} });
const picked = controlRows(render()).find((r) => r.key === "llmModel");
check("点候选写入草稿", Boolean(picked) && picked.field.props.value === "glm-5.3-flashx", picked ? String(picked.field.props.value) : "没有该行");
const saveModel = picked && picked.buttons.find((b) => textOf(b) === "保存");
check("选中后出现「保存」", Boolean(saveModel));
if (saveModel) {
  await saveModel.props.onClick();
  check("保存模型名调用 form.set(llmModel)", writes.some((w) => w.op === "set" && w.key === "llmModel" && w.value === "glm-5.3-flashx"), JSON.stringify(writes.slice(-2)));
}

/* dsh 路由要 provider：选中候选顺手把它写进 llm.provider（provider 行在高级区里） */
setAdvanced(true);
const provRow = controlRows(render()).find((r) => r.key === "llmProvider");
check("选中候选后 provider 行带出该提供方", Boolean(provRow) && provRow.field.props.value === "commandcode", provRow ? String(provRow.field.props.value) : "没有该行");
const saveProv = provRow && provRow.buttons.find((b) => textOf(b) === "保存");
check("provider 行随即出现「保存」", Boolean(saveProv));
if (saveProv) {
  await saveProv.props.onClick();
  check("保存 provider 调用 form.set(llmProvider)", writes.some((w) => w.op === "set" && w.key === "llmProvider" && w.value === "commandcode"), JSON.stringify(writes.slice(-3)));
}
setAdvanced(false);

/* 键盘：输入过滤成唯一匹配后回车选中（模型名行在高级区，继续展开态） */
setAdvanced(true);
const afterSave = render();
modelInputNode(afterSave).props.onFocus();
modelInputNode(afterSave).props.onChange({ target: { value: "kimi" } });
const oneMatch = render();
modelInputNode(oneMatch).props.onKeyDown({ key: "ArrowDown", preventDefault() {} });
modelInputNode(oneMatch).props.onKeyDown({ key: "Enter", preventDefault() {} });
const kbPicked = controlRows(render()).find((r) => r.key === "llmModel");
check("↑↓ + 回车也能选中", Boolean(kbPicked) && kbPicked.field.props.value === "kimi-k2.7-code", kbPicked ? String(kbPicked.field.props.value) : "没有该行");

/* ------------------------------------------------------------ 独立评审 agent（opt-in） */

controlRows(render()).find((r) => r.key === "reviewerAgent").field.props.onChange({ target: { value: "spawn" } });
const spawnTree = render();
const spawnRows = controlRows(spawnTree);
check("reviewer=spawn 时展开态 11 行（基础 4 + 路由 2 + 子 agent 3 行额外 + 时机 1）", spawnRows.length === 11, `n=${spawnRows.length}`);
check("reviewerAgent 只有 off / spawn 两个选项", (() => {
  const row = spawnRows.find((r) => r.key === "reviewerAgent");
  return Boolean(row) && hosts(row.row).filter((n) => n.tag === "option").length === 2;
})());
check("spawn 后出现子 agent provider / 模型 / 轮次三行", ["reviewerProvider", "reviewerModel", "reviewerRounds"].every((key) => spawnRows.some((r) => r.key === key)));
check("spawn 状态行说明走独立 agent", textOf(spawnTree).includes("评审走独立 agent"));
check("spawn 后轮次上限默认 3（数字框）", (() => {
  const row = spawnRows.find((r) => r.key === "reviewerRounds");
  return Boolean(row) && row.field.props.type === "number" && row.field.props.value === "3";
})());

/* 评审子会话的模型也走同一份 DSH 目录，选中候选写的是 reviewerProvider，不动 llmProvider */
const reviewModelRow = spawnRows.find((r) => r.key === "reviewerModel");
const reviewInput = reviewModelRow && hosts(reviewModelRow.row).find((n) => n.tag === "input" && n.props["data-ocr-model-input"] === true);
check("子 agent 模型行也是可搜索下拉", Boolean(reviewInput) && reviewInput.props.disabled !== true);
if (reviewInput) {
  reviewInput.props.onFocus();
  const reviewMenu = render();
  /* 菜单节点必须在这一行内部找：树里还有模型名那行的菜单，宽泛查找会点到别人的候选。 */
  const reviewMenuRow = controlRows(reviewMenu).find((r) => r.key === "reviewerModel");
  const reviewItems = hosts(reviewMenuRow.row).filter((n) => n.props && n.props["data-ocr-model-item"] === true);
  check("子 agent 模型行能展开候选", reviewItems.length >= 4, `n=${reviewItems.length}`);
  const target = reviewItems.find((n) => textOf(n).includes("Kimi K2.7 Code"));
  check("子 agent 候选里能找到模型", Boolean(target));
  if (target) {
    target.props.onMouseDown({ preventDefault() {} });
    const afterPick = controlRows(render());
    const rm = afterPick.find((r) => r.key === "reviewerModel");
    const rp = afterPick.find((r) => r.key === "reviewerProvider");
    check("选中后写入 reviewerModel 草稿", Boolean(rm) && rm.field.props.value === "kimi-k2.7-code", rm ? String(rm.field.props.value) : "没有该行");
    check("选中后把提供方写进 reviewerProvider（不是 llmProvider）", Boolean(rp) && rp.field.props.value === "commandcode", rp ? String(rp.field.props.value) : "没有该行");
    const saveReviewModel = rm && rm.buttons.find((b) => textOf(b) === "保存");
    if (saveReviewModel) {
      await saveReviewModel.props.onClick();
      check("保存子 agent 模型调用 form.set(reviewerModel)", writes.some((w) => w.op === "set" && w.key === "reviewerModel" && w.value === "kimi-k2.7-code"), JSON.stringify(writes.slice(-2)));
    }
  }
}

/* 切回 off：后面的降级场景与行数断言按默认（不启用）算 */
controlRows(render()).find((r) => r.key === "reviewerAgent").field.props.onChange({ target: { value: "off" } });
const offAgain = controlRows(render());
check("切回 off 后子 agent 三行消失、展开态行数回到 8", offAgain.length === 8 && !offAgain.some((r) => r.key === "reviewerModel"), `n=${offAgain.length}`);
check("切回 off 后状态行不再提独立 agent", !textOf(render()).includes("评审走独立 agent"));
setAdvanced(false);
check("收起后回到基础 4 行", controlRows(render()).length === 4, `n=${controlRows(render()).length}`);

/* Remote 信封报错（{ ok: false, error }）时也要给出可读诊断 */
/* 模型名/提供方在高级区：下面这一串都在看模型行的退化表现，先把高级区展开。 */
setAdvanced(true);
/* 目录换了实现不再自动重取（那是旧实现的 bug）：服务回来/换实现都要显式「重试」或重开设置页。 */
fakeCtx.remote = undefined;
render();
fakeCtx.remote = { session: { modelCatalog: async () => ({ ok: false, error: { code: "peer-unavailable", message: "peer 断了" } }) } };
render();
await tick();
const errTree = render();
check("Remote 信封失败时给出诊断", textOf(errTree).includes("读取 DSH 模型目录失败") && textOf(errTree).includes("peer 断了"), textOf(errTree).slice(-140));

/* 读失败时给一条显式补救路径：旧实现靠"每次渲染都重取"掩盖了这件事，真机上反而刷不出结果。 */
const errModelRow = controlRows(errTree).find((r) => r.key === "llmModel");
const errRetry = errModelRow ? hosts(errModelRow.row).find((n) => n.props && n.props["data-ocr-model-retry"] === true) : null;
check("目录读失败时给出「重试读取目录」入口", Boolean(errRetry), errModelRow ? textOf(errModelRow.row).slice(-90) : "没有该行");
fakeCtx.remote.session.modelCatalog = fullCatalogResponse;
if (errRetry) errRetry.props.onClick();
render(); /* 点完重试要再渲染一次：效果在渲染末尾 flush，之后才是异步取回 */
await tick();
const recoveredTree = render();
check("点「重试」重新读目录并恢复候选", textOf(recoveredTree).includes("4 个模型"), textOf(recoveredTree).slice(-140));

/* 真机回归：宿主 remote namespace 是"生成的"——每次读 `session.modelCatalog` 都拿到一个新函数
   （`resolveCatalogCall` 因此每次渲染都会返回一个新的 `call`）。旧实现把这个函数放进 useEffect
   依赖，真机上就是请求风暴：取目录 → setState → 再渲染 → 再取目录，界面永远停在「正在读取…」、
   模型名选不动（2026-10-13 真机 console 里 30+ 条重复的 /api/session/modelCatalog 就是它）。
   这里用访问器复刻宿主这个特性，断言读取次数是常数级、且反复渲染不再增长。 */
let churnFetches = 0;
const churnRemote = {};
Object.defineProperty(churnRemote, "session", {
  configurable: true,
  get() {
    return {
      get modelCatalog() {
        return async () => {
          churnFetches += 1;
          return fullCatalogResponse();
        };
      },
    };
  },
});
const savedRemote = fakeCtx.remote;
fakeCtx.remote = undefined;
render(); /* 先回到"没有 remote"：deps 变了，但这一步不该取目录 */
fakeCtx.remote = churnRemote;
render(); /* 服务回来：只该取一次 */
await tick();
const churnTree = render();
const churnSettled = churnFetches;
check("生成的 namespace：目录仍然读得回来", textOf(churnTree).includes("4 个模型"), textOf(churnTree).slice(-140));
check("生成的 namespace：读取次数是常数级（props.ctx 一次 + 子 fiber 生效一次），不是每次渲染一次", churnSettled >= 1 && churnSettled <= 2, `fetches=${churnSettled}`);
render();
render();
render();
check(
  "生成的 namespace：反复渲染不再重取（deps 里只留稳定值）",
  churnFetches === churnSettled,
  `fetches=${churnFetches}, settled=${churnSettled}`,
);
fakeCtx.remote = savedRemote;

/* 取不到 ctx.remote 时退化成纯文本输入 */
fakeCtx.remote = undefined;
render();
const noCatalog = render();
check("取不到模型目录时给出诊断", textOf(noCatalog).includes("直接手输模型名即可"));
check("退化后输入框仍可编辑", (() => {
  const n = modelInputNode(noCatalog);
  return Boolean(n) && n.props.disabled !== true;
})());
check("退化后不再渲染候选列表", !modelMenuNode(noCatalog));

/* ctx.remote 属性访问被守卫拦下（cannot get property "remote" without inject）时退回 ctx.get("remote") */
fakeCtx.getFallback = {
  session: {
    modelCatalog: async () => ({
      ok: true,
      value: {
        groups: [
          {
            id: "commandcode",
            name: "Command Code",
            models: [CATALOG_MODELS[0]],
          },
        ],
      },
    }),
  },
};
fakeCtx.getCalls.length = 0; /* 只统计这次场景读了哪些兜底名字 */
Object.defineProperty(fakeCtx, "remote", {
  configurable: true,
  get() {
    throw new Error('cannot get property "remote" without inject');
  },
});
render();
await tick();
const guardedTree = render();
const guardedText = textOf(guardedTree);
check(
  "守卫拦下 ctx.remote 时用 ctx.get 兜底",
  /* 只认状态行那句动态文案（lib/client.js:501）；静态 hint（lib/client.js:86）里也有
     "候选来自 DSH 自己的模型目录"，拿它当断言等于恒真（评审 #10）。 */
  guardedText.includes("候选来自 DSH 自己的模型目录：1 个模型"),
  guardedText.slice(-140),
);
check("兜底路径确实读了 ctx.get(\"remote\")", fakeCtx.getCalls.includes("remote"), JSON.stringify(fakeCtx.getCalls.slice(-3)));
check("守卫的原文不再出现在页面上", !guardedText.includes("without inject"), guardedText.slice(-140));
delete fakeCtx.remote; /* 只删 getter；下面的场景仍要"没有目录"的状态 */
fakeCtx.remote = undefined;
fakeCtx.getFallback = undefined;

/* 守卫拦下属性访问、兜底读取口也抛（remote 桥真的没有）时：只降级成诊断，不崩 */
fakeCtx.remoteThrows = true;
render();
await tick();
const deadTree = render();
const deadText = textOf(deadTree);
check("兜底读取口也失败时给出诊断", deadText.includes("读不到 ctx.remote"), deadText.slice(-160));
check("兜底读取口也失败时输入框仍可编辑", (() => {
  const n = modelInputNode(deadTree);
  return Boolean(n) && n.props.disabled !== true;
})());
check("兜底读取口也失败时不渲染候选列表", !modelMenuNode(deadTree));
fakeCtx.remoteThrows = false;
fakeCtx.remote = healthyRemote; /* 共享夹具恢复健康：后面设置页/条目回退场景还要用它 */

/* 上面的退化场景把高级区展开了（那是共享的组件状态）：卡片/回退 id 用例按默认收起算，先收回去。 */
setAdvanced(false);

/* 插件卡片（plugins.bundle.config 的 summary 视图）：不再渲染整张表单，改成只读摘要 + 去设置页 */
const cardTree = expand(miniReact.createElement(reg.component, { view: "summary" }));
flushEffects();
const cardHtml = textOf(cardTree);
const cardRows = hosts(cardTree).filter((n) => n.props && typeof n.props["data-ocr-summary-row"] === "string");
check("卡片渲染只读摘要（不再是 null）", Boolean(hosts(cardTree).find((n) => n.props && n.props["data-ocr-card-summary"] === "1")), cardHtml.slice(0, 160));
check("摘要只列基础项（基础 4 行，不重复整张表单）", cardRows.length === 4, `n=${cardRows.length}`);
check("摘要行带出当前值（开 / 关 / 选项文案）", cardHtml.includes("开") && cardHtml.includes("关") && cardHtml.includes("auto — "), cardHtml.slice(0, 220));
check("摘要给出完整设置的入口", cardHtml.includes("设置 → 代码评审"), cardHtml.slice(0, 220));
check("摘要里没有可编辑控件", !hosts(cardTree).some((n) => n.tag === "input" || n.tag === "select"));

snapshot = { ...snapshot, status: "loading", writable: false };
check("loading + 不可写时不崩", textOf(render()).includes("正在从宿主读取"));
snapshot = { ...snapshot, status: "unavailable", writable: false, value: undefined };
check("unavailable 时给出原因", textOf(render()).includes("没有暴露给浏览器"));
snapshot = { ...snapshot, status: "ready", writable: true };

/* 条目 id 回退：主 id 查不到时用备用 id */
fakeCtx.rejectIds = ["include:dsh-open-code-review"];
const fbTree = render();
check("主 id 查不到时回退到包名 id", fakeCtx.formIds.includes("dsh-open-code-review") && controlRows(fbTree).length === 4, JSON.stringify(fakeCtx.formIds.slice(-2)));
check("回退后字段仍可编辑", controlRows(fbTree).every((r) => r.field.props.disabled !== true));

/* 两个 id 都查不到：给出诊断而不是崩掉 */
fakeCtx.rejectIds = ["include:dsh-open-code-review", "dsh-open-code-review"];
const noneTree = render();
check("完全没有表单时给出诊断", textOf(noneTree).includes("浏览器侧没有这个条目的表单"));
check("完全没有表单时控件禁用", controlRows(noneTree).every((r) => r.field.props.disabled === true));
fakeCtx.rejectIds = null;

/* 设置导航里的独立页面（standalone 模式） */
snapshot = { ...snapshot, status: "ready", writable: true };
const sectionTree = expand(miniReact.createElement(sectionReg.component, {}));
const sectionHtml = textOf(sectionTree);
check("设置页渲染标题", sectionHtml.includes("代码评审（阿里 OpenCodeReview）"));
check("设置页也带 4 个基础控件行（高级区另算）", controlRows(sectionTree).length === 4, `n=${controlRows(sectionTree).length}`);
check("设置页照样带出条目 id", sectionHtml.includes("include:dsh-open-code-review"));

/* ------------------------------------------------------------ 会话内进度行（conversation.input.dock） */

/* 组件读的是 Client jobs 服务的快照（hooks.jobs → useJobs 选择器），
   也就是和标题栏 Jobs 面板同一份数据；这里用桩提供快照，验证渲染与「两次点击停止」。 */
const watched = [];
const killed = [];
const dockProps = (rows) => ({
  sessionId: "s1",
  useJobs: (select) => select({ rows: { s1: rows }, observed: {} }),
  watchRows: (sessionId) => {
    watched.push(sessionId);
    return () => {};
  },
  killJob: async (sessionId, jobId) => {
    killed.push([sessionId, jobId]);
    return true;
  },
  t: (key, fallback) => fallback,
});
const renderDock = (rows, props = {}) => {
  const built = expand(miniReact.createElement(dockReg.component, { ...dockProps(rows), ...props }));
  flushEffects();
  return built;
};
const liveJob = {
  id: "ocr-review-1",
  kind: "ocr-review",
  label: "评审 · 工作区改动 · dsh-open-code-review",
  status: "running",
  progress: "运行 ocr review（超时 15 分钟）",
  startedAt: Date.now() - 4200,
};

check("没有任务时进度行不占位", renderDock([]) === null);
check(
  "只认本插件的 kind（宿主自己的 bash / subagent 行不进这里）",
  renderDock([{ ...liveJob, kind: "bash", id: "bash-1" }]) === null,
);

const liveTree = renderDock([liveJob]);
const liveText = textOf(liveTree);
check("运行中的评审行带标题与状态词", liveText.includes("评审进度") && liveText.includes("运行中"), liveText);
check("行里带 label 与实时进度行", liveText.includes("评审 · 工作区改动") && liveText.includes("运行 ocr review（超时 15 分钟）"), liveText);
check("行里带已跑时长", /4s|5s/.test(liveText), liveText);
check("运行中有停止按钮", hosts(liveTree).some((n) => n.tag === "button" && textOf(n) === "停止"));
check("组件订阅了本会话的任务行（引用计数 roster 流）", watched.includes("s1"), JSON.stringify(watched));

/* 停止要两次点击（防误触），第二次才真的调 killJob */
const stopBtn = hosts(liveTree).find((n) => n.tag === "button" && textOf(n) === "停止");
stopBtn.props.onClick();
const armedTree = renderDock([liveJob]);
const armedText = textOf(armedTree);
check("第一次点击只变成「再点一次停止」，还没杀任务", armedText.includes("再点一次停止") && killed.length === 0, JSON.stringify(killed));
hosts(armedTree)
  .find((n) => n.tag === "button")
  .props.onClick();
await tick();
check("第二次点击调用 killJob(sessionId, jobId)", killed.length === 1 && killed[0][0] === "s1" && killed[0][1] === "ocr-review-1", JSON.stringify(killed));

const settledJob = { ...liveJob, id: "ocr-review-2", status: "completed", progress: "", detail: "评审完成：3 个文件，1 条问题（8.2s）", finishedAt: Date.now() - 1000 };
const settledText = textOf(renderDock([settledJob]));
check("结算后的行短暂留着，显示完成与终态明细", settledText.includes("已完成") && settledText.includes("1 条问题"), settledText);
check("结算后没有停止按钮", !hosts(renderDock([settledJob])).some((n) => n.tag === "button"));
check(
  "结算超过一分钟后自动让位给 Jobs 面板",
  renderDock([{ ...settledJob, finishedAt: Date.now() - 120000 }]) === null,
);
const stoppingJob = { ...liveJob, id: "ocr-review-3", status: "stopping" };
check("停止中的行显示「停止中…」并仍可再点停止", textOf(renderDock([stoppingJob])).includes("停止中…"));

/* 收尾：把最后创建的定时器清掉（deps 变了就会跑上一个 cleanup），别让 node 卡在事件循环里 */
renderDock([]);

/* ------------------------------------------------------------ 宿主没有 Remote 桥 */

/* remote 子 fiber 声明在 apply 内部，所以"宿主没提供 remote(.*)"只会让子 fiber 不激活
   （cordis 的 INACTIVE），插件本身照样 active：设置页仍在、输入框仍能编辑，只是没有候选列表。 */
const noRemoteRegs = [];
const noRemoteCtx = makeCtx({
  registrations: noRemoteRegs,
  form: fakeCtx.form, /* 本场景在 fakeCtx.form 赋值（260 行）之后才构造 */
  inject(deps, cb) {
    noRemoteCtx.injectCalls.push(deps);
    /* 模拟"服务没人 provide"：cordis 不会调用回调，子 fiber 保持 INACTIVE。
       没有 Remote 桥时 remote.session 与 remote.commands 都不在，按钮 fiber 同样不激活。 */
    if (Array.isArray(deps) && (deps.includes("remote.session") || deps.includes("remote.commands"))) return undefined;
    return cb(noRemoteCtx);
  },
});
plugin.apply(noRemoteCtx);
check(
  "宿主没有 Remote 桥时插件照样 apply 并注册三个 cell（设置页两处 + 进度行；按钮 fiber 保持 pending）",
  noRemoteRegs.length === 3
    && noRemoteCtx.slotInjectCalls.includes("settings.section")
    && !noRemoteRegs.some((r) => r.options.name === "conversation.chat.turnTail"),
  `regs=${noRemoteRegs.length} · ${JSON.stringify(noRemoteRegs.map((r) => r.options.name))}`,
);
check(
  "宿主没有 Remote 桥时确实尝试过 remote 子注入（目录与命令两条）",
  noRemoteCtx.injectCalls.some((d) => Array.isArray(d) && d.includes("remote.session"))
    && noRemoteCtx.injectCalls.some((d) => Array.isArray(d) && d.includes("remote.commands")),
  JSON.stringify(noRemoteCtx.injectCalls),
);
const noRemoteCell = noRemoteRegs.find((r) => r.options.name === "settings.section");
/** 渲染一个独立 cell：跑 effect → 等异步 setState → 用新状态重渲染。
    高级区在 v0.11.0 起默认收起，而模型名/提供方在高级区里，所以每一步都先把标题点开
    （setAdvanced 只作用于主树的 render()，独立 cell 得自己点）。 */
const bareRender = async (cell) => {
  const el = () => miniReact.createElement(cell.component, {});
  const step = () => {
    let tree = expand(el());
    const toggle = advToggle(tree);
    if (toggle && toggle.props["aria-expanded"] !== "true") {
      toggle.props.onClick();
      tree = expand(el());
    }
    return tree;
  };
  step();
  flushEffects();
  await tick();
  step();
  flushEffects();
  return step();
};
const bareTree = noRemoteCell ? await bareRender(noRemoteCell) : null;
const bareText = bareTree ? textOf(bareTree) : "";
check("宿主没有 Remote 桥时设置页仍渲染模型名", bareText.includes("模型名"), bareText.slice(-160));
check("宿主没有 Remote 桥时给出降级说明", bareText.includes("直接手输模型名即可"), bareText.slice(-160));
check("宿主没有 Remote 桥时读不到目录也读了兜底口", noRemoteCtx.getCalls.includes("remote"), JSON.stringify(noRemoteCtx.getCalls.slice(-3)));
check("宿主没有 Remote 桥时输入框仍可编辑", (() => {
  const n = bareTree ? modelInputNode(bareTree) : null;
  return Boolean(n) && n.props.disabled !== true;
})());
check("宿主没有 Remote 桥时不渲染候选列表", !(bareTree && modelMenuNode(bareTree)));

/* ------------------------------------------------------------ 服务迟到：子 fiber 晚于设置页激活 */

/* 真实 GUI 里设置页可能先渲染，remote 服务随后才到；订阅必须能把候选刷新出来。
   两条路径故意给不同目录（兜底 4 个模型 / 子 fiber 1 个模型），这样文案能证明用了哪条。
   ⚠️ 下面「刷新成官方读法的目录」那条断言依赖 `useModelCatalog` 的 deps 里有 `ctx`（服务迟到时
   必须重取一次目录）；谁把 deps 简化成"只留原始值"（去掉 ctx、或换成 locale 服务对象），这里就会红。
   别当成噪音顺手改掉。 */
const lateRegs = [];
let lateFire = null;
const lateRemote = {
  session: {
    modelCatalog: async () => ({
      ok: true,
      value: { groups: [{ id: "late", name: "迟到的提供方", models: [{ id: "late-model", name: "Late Model" }] }] },
    }),
  },
};
const lateCtx = makeCtx({
  registrations: lateRegs,
  form: fakeCtx.form, /* 本场景在 fakeCtx.form 赋值（260 行）之后才构造 */
  get(name) {
    lateCtx.getCalls.push(name);
    return name === "remote" ? fakeCtx.lateFallback : undefined;
  },
  inject(deps, cb) {
    if (Array.isArray(deps) && deps.includes("remote.session")) {
      lateFire = cb; /* 先记住回调：模拟"服务还没 provide，子 fiber 还没激活" */
      return undefined;
    }
    return cb(lateCtx);
  },
});
fakeCtx.lateFallback = { session: { modelCatalog: fullCatalogResponse } };
plugin.apply(lateCtx);
check("服务迟到场景确实拦下了 remote 子注入（下面的 lateFire 依赖它）", typeof lateFire === "function", String(lateFire));
const lateCell = lateRegs.find((r) => r.options.name === "settings.section");
const beforeLate = lateCell ? await bareRender(lateCell) : null;
check(
  "子 fiber 没激活时先用兜底读取口的目录",
  Boolean(beforeLate) && textOf(beforeLate).includes("4 个模型"),
  beforeLate ? textOf(beforeLate).slice(-160) : "没有 cell",
);
if (typeof lateFire === "function") lateFire({ remote: lateRemote });
const afterLate = lateCell ? await bareRender(lateCell) : null;
check(
  "服务迟到、子 fiber 激活后订阅刷新成官方读法的目录",
  Boolean(afterLate) && textOf(afterLate).includes("1 个模型") && !textOf(afterLate).includes("4 个模型"),
  afterLate ? textOf(afterLate).slice(-160) : "没有 cell",
);

/* ------------------------------------------------------------ locale 服务给英文词典 */

/* 宿主语言是英文时，插件文案必须跟着走（词典由上面的 localeReg 取，证明用的是注册的那一份）。 */
const enCtx = makeCtx({
  registrations: [],
  form: fakeCtx.form,
  locale: {
    register(ns, pairs) {
      enCtx.localeRegistrations.push({ ns, pairs });
      return () => {};
    },
    bind: () => (key) => (Object.prototype.hasOwnProperty.call(enDict, key) ? enDict[key] : key),
  },
});
plugin.apply(enCtx);
const enCell = enCtx.registrations.find((r) => r.options.name === "settings.section");
const enTree = enCell ? await bareRender(enCell) : null;
const enHtml = enTree ? textOf(enTree) : "";
check(
  "英文词典下页面渲染英文标题与标签",
  enHtml.includes("Code review (Alibaba OpenCodeReview)") &&
    enHtml.includes("Model") &&
    (enHtml.includes("Save changes") || enHtml.includes("Save all changes")),
  enHtml.slice(0, 220),
);
check(
  "英文词典下状态行、分组标题与按钮也是英文",
  enHtml.includes("LLM through the DSH local bridge") &&
    enHtml.includes("Basics") &&
    enHtml.includes("Advanced settings") &&
    enHtml.includes("Auto review") &&
    enHtml.includes("Reset everything"),
  enHtml.slice(0, 300),
);

/* ------------------------------------ v0.5.0 步骤 1：原生下拉弹出层的可读性 */

const LABEL_TOKEN = "var(--dsw-alias-label-primary)";
const BG_TOKEN = "var(--dsw-alias-bg-layer-2)";
const OPTION_BG_TOKEN = "var(--dsw-alias-bg-overlay)";
const selectsOf = (t) => hosts(t).filter((n) => n.tag === "select");
const optionsOf = (t) => hosts(t).filter((n) => n.tag === "option");

setAdvanced(false);
const noThemeTree = render();
const noThemeSelects = selectsOf(noThemeTree);
check("基础组两个原生下拉都在（引擎/自动评审）", noThemeSelects.length === 2, `n=${noThemeSelects.length}`);
check(
  "下拉不再靠继承配色：文字/底色/边框都走主题 token",
  noThemeSelects.every(
    (n) =>
      n.props.style &&
      n.props.style.color === LABEL_TOKEN &&
      n.props.style.background === BG_TOKEN &&
      String(n.props.style.border).includes("--dsw-alias-border-l1"),
  ),
  JSON.stringify(noThemeSelects.map((n) => n.props.style)),
);
const noThemeOptions = optionsOf(noThemeTree);
check(
  "每个 option 都显式给了文字色与底色（白底白字的根因）",
  noThemeOptions.length >= 5 &&
    noThemeOptions.every((n) => n.props.style && n.props.style.color === LABEL_TOKEN && n.props.style.background === OPTION_BG_TOKEN),
  `n=${noThemeOptions.length}`,
);
check(
  "拿不到主题服务时不写 colorScheme（维持旧行为、也不抛）",
  noThemeSelects.every((n) => !Object.prototype.hasOwnProperty.call(n.props.style, "colorScheme")),
  JSON.stringify(noThemeSelects.map((n) => n.props.style.colorScheme)),
);
fakeCtx.themeValue = { getTheme: () => ({ active: { colorScheme: "light" } }) };
const lightSelects = selectsOf(render());
check(
  "浅色主题下下拉声明 colorScheme=light",
  lightSelects.length === 2 && lightSelects.every((n) => n.props.style.colorScheme === "light"),
  JSON.stringify(lightSelects.map((n) => n.props.style.colorScheme)),
);
fakeCtx.themeValue = { getTheme: () => ({ active: { colorScheme: "dark" } }) };
const darkSelects = selectsOf(render());
check(
  "深色主题下下拉声明 colorScheme=dark",
  darkSelects.length === 2 && darkSelects.every((n) => n.props.style.colorScheme === "dark"),
  JSON.stringify(darkSelects.map((n) => n.props.style.colorScheme)),
);
fakeCtx.themeValue = { getTheme: () => ({ active: {} }) };
check(
  "主题服务形状不对（没有 colorScheme）也只当作没有",
  selectsOf(render()).every((n) => n.props.style.colorScheme === undefined),
  JSON.stringify(selectsOf(render()).map((n) => n.props.style.colorScheme)),
);
check("订阅 theme/change（切主题时催一次重渲染）", fakeCtx.onCalls.includes("theme/change"), JSON.stringify(fakeCtx.onCalls.slice(0, 4)));
fakeCtx.themeValue = { getTheme: () => ({ active: { colorScheme: "light" } }) };
setAdvanced(true);
const presetTree = render();
check(
  "已收起的「最小间隔」不再渲染档位控件（v0.11.0：这个键没有控件，PresetNumber 已删）",
  !hosts(presetTree).some((n) => n.props && (n.props["data-ocr-preset-select"] || n.props["data-ocr-preset-input"])),
  JSON.stringify(hosts(presetTree).map((n) => n.props && n.props["data-ocr-preset-select"]).filter(Boolean)),
);
setAdvanced(false);
fakeCtx.themeValue = undefined;

/* ---------------------------- v0.5.0 步骤 4：回合尾部的「启动代码审核」按钮 */

/* 依赖齐全的 ctx：jobs 快照 + remote.commands.execute 桩（真机契约见 lib/client.js 的注释）。 */
const tailRegs = [];
const executed = [];
const tailWatched = [];
let tailResult = { ok: true, value: { commandId: "cmd-1", result: { kind: "success", text: "评审完成：审查 2 个文件，发现 1 条问题。" } } };
const tailCtx = makeCtx({
  registrations: tailRegs,
  form: fakeCtx.form, /* 复用主夹具的表单：直接改 snapshot 就能模拟开关变化 */
  jobs: {
    state: { rows: {}, observed: {} },
    watchRows: (sessionId) => {
      tailWatched.push(sessionId);
      return () => {};
    },
  },
  remote: {
    commands: {
      execute: async (sessionId, line, attachments) => {
        executed.push([sessionId, line, attachments]);
        return tailResult;
      },
    },
  },
});
plugin.apply(tailCtx);
const tailReg = tailRegs.find((r) => r.options.name === "conversation.chat.turnTail");
check(
  "按钮注册进 conversation.chat.turnTail（id/order 自取，不与内置 todo/plan 撞）",
  Boolean(tailReg) && tailReg.options.id === "ocr-review-on-demand" && tailReg.options.order === 30,
  tailReg ? JSON.stringify(tailReg.options) : JSON.stringify(tailRegs.map((r) => r.options.name)),
);
const tailInjected = tailReg && typeof tailReg.options.inject === "function" ? tailReg.options.inject() : {};
check(
  "注入面齐全（cfgCtx / jobs hooks / watchRows / runReview / t）",
  Boolean(tailInjected.cfgCtx)
    && Boolean(tailInjected.hooks && tailInjected.hooks.jobs)
    && typeof tailInjected.watchRows === "function"
    && typeof tailInjected.runReview === "function"
    && typeof tailInjected.t === "function",
  JSON.stringify(Object.keys(tailInjected)),
);
const tailProps = (rows, props = {}) => ({
  sessionId: "s1",
  ...tailInjected,
  useJobs: (select) => select({ rows: { s1: rows }, observed: {} }),
  t: (key, fallback) => fallback,
  ...props,
});
const renderTail = (rows, props = {}) => {
  const built = expand(miniReact.createElement(tailReg.component, tailProps(rows, props)));
  flushEffects();
  return built;
};
const tailButton = (tree) => (tree ? hosts(tree).find((n) => n.tag === "button") : undefined);
/* R3（v0.12.0 批 1）：宿主没有 jobs（hooks 里没有 jobs / 给不出 useJobs）时，按钮**仍然渲染** ——
   入口不该因为宿主没有进度服务就整块消失。 */
const noJobsTree = expand(
  miniReact.createElement(tailReg.component, {
    sessionId: "s1",
    cfgCtx: tailInjected.cfgCtx,
    hooks: {},
    runReview: tailInjected.runReview,
    t: (key, fallback) => fallback,
    changesFeedReady: () => false,
  }),
);
check(
  "R3：宿主没有 jobs 时按钮仍然渲染（入口不依赖进度服务）",
  noJobsTree !== null && textOf(noJobsTree).includes("启动代码审核"),
  noJobsTree === null ? "返回了 null（入口被藏掉了）" : textOf(noJobsTree).slice(0, 60),
);
check(
  "没有 sessionId 时返回 null",
  expand(miniReact.createElement(tailReg.component, { useJobs: tailProps([]).useJobs })) === null,
);

const idleTree = renderTail([]);
check("默认（总开关/按需评审都开）显示「启动代码审核」", textOf(idleTree).includes("启动代码审核"), textOf(idleTree));
check("按钮订阅了本会话的任务行", tailWatched.includes("s1"), JSON.stringify(tailWatched));

tailButton(idleTree).props.onClick();
await tick();
check(
  '点击走宿主命令：execute(sessionId, "/ocr-review --entry=button", [])（v0.9.0 起带入口标记）',
  executed.length === 1 &&
    executed[0][0] === "s1" &&
    executed[0][1] === "/ocr-review --entry=button" &&
    Array.isArray(executed[0][2]) &&
    executed[0][2].length === 0,
  JSON.stringify(executed),
);
const doneText = textOf(renderTail([]));
check("成功后把命令返回的文本显示出来", doneText.includes("审查 2 个文件"), doneText);

/* 同一会话已有 running 的评审：按钮禁用 + 显示「正在评审…」（数据源同进度行，天然防重复点击） */
const runningTree = renderTail([liveJob]);
check(
  "同会话已有 running 的评审时禁用并显示「正在评审…」",
  textOf(runningTree).includes("正在评审…") && tailButton(runningTree).props.disabled === true,
  textOf(runningTree),
);

/* 失败三条路径，逐条都要有可见文案 */
tailResult = { ok: false, error: { code: "peer-unavailable", message: "peer 断了" } };
tailButton(renderTail([])).props.onClick();
await tick();
check("命令调用失败（ok:false）时显示原因", textOf(renderTail([])).includes("peer 断了"), textOf(renderTail([])));

tailResult = { ok: true, value: { commandId: "cmd-2", result: { kind: "error", text: "插件已关闭（enabled=false）" } } };
tailButton(renderTail([])).props.onClick();
await tick();
check("命令返回 error 时显示命令给的错误文本", textOf(renderTail([])).includes("插件已关闭"), textOf(renderTail([])));

tailResult = { ok: true, value: undefined };
tailButton(renderTail([])).props.onClick();
await tick();
check("命令没被执行（value 为空）时给出提示", textOf(renderTail([])).includes("宿主没有执行这条命令"), textOf(renderTail([])));

/* 两个开关任一关掉：整块不渲染 */
tailResult = { ok: true, value: { commandId: "cmd-3", result: { kind: "success", text: "" } } };
const snapshotKept = snapshot;
snapshot = { ...snapshot, value: { ...snapshot.value, onDemand: false } };
check("onDemand=false 时按钮整块不出现", renderTail([]) === null);
snapshot = { ...snapshot, value: { ...snapshot.value, onDemand: undefined, enabled: false } };
check("enabled=false 时按钮整块不出现", renderTail([]) === null);
snapshot = snapshotKept;

/* v0.11.0：按钮只在「本回合确实动了工作区」时出现。
   改动记录由插件注册的 conversation 定义发布（只发布数据、不发布视图节点）；事件体只有 {turn}，
   所以真正的文件清单要按 seq 去宿主那里取 api/changes.summary。宿主没有这一支时退回「总是显示」。 */
const turnWithChanges = (seq) => ({
  data: { get: (kind) => (kind === "ocrTurnChanges" ? { turn: 1, changesSeq: seq } : undefined) },
});
const fetchSummary = (total) => async () => ({ ok: true, json: async () => ({ total, files: [] }) });
const renderTailReady = async (rows, extra = {}) => {
  const props = {
    changesFeedReady: () => true,
    turn: turnWithChanges(7),
    fetchChanges: fetchSummary(2),
    ...extra,
  };
  renderTail(rows, props);
  await tick();
  return renderTail(rows, props);
};

const changedTree = await renderTailReady([]);
check("宿主给了改动记录、本回合确实改了文件：按钮出现", Boolean(tailButton(changedTree)), textOf(changedTree));
const cleanTree = await renderTailReady([], { fetchChanges: fetchSummary(0) });
check("本回合没有改动（total=0）：按钮不出现", tailButton(cleanTree) === undefined, cleanTree === null ? "null" : textOf(cleanTree));
const noRecordTree = await renderTailReady([], { turn: { data: { get: () => undefined } } });
check("本回合没有改动记录：按钮不出现", tailButton(noRecordTree) === undefined, noRecordTree === null ? "null" : textOf(noRecordTree));
const offlineTree = await renderTailReady([], { fetchChanges: async () => { throw new Error("离线"); } });
check("取不到改动清单时退回「总是显示」（fail-open：别在刚改完代码时把入口藏掉）", Boolean(tailButton(offlineTree)), textOf(offlineTree));
const noRouteTree = await renderTailReady([], { fetchChanges: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
check("路由不可用（404）时同样退回「总是显示」", Boolean(tailButton(noRouteTree)), textOf(noRouteTree));
check("宿主没给改动记录这一支时按钮总是显示（降级路径）", Boolean(tailButton(renderTail([]))), "降级");
check("默认夹具没有 uiConversation：脏检查未生效（退回总是显示）", tailInjected.changesFeedReady() === false, String(tailInjected.changesFeedReady()));

/* 改动记录的定义本身：形状、「只发布数据」的契约、以及数据没变时的引用稳定（宿主靠它避免白刷）。 */
let capturedDef = null;
const defCtx = makeCtx({
  registrations: [],
  uiConversation: { events: { register(definition) { capturedDef = definition; return () => {}; } } },
});
plugin.apply(defCtx);
check(
  "注册了本回合改动记录（走 ctx.effect，随 fiber 撤销）",
  Boolean(capturedDef) && defCtx.effectCalls.includes("本回合改动记录（启动代码审核按钮的脏检查）"),
  JSON.stringify(defCtx.effectCalls.slice(-2)),
);
check(
  "定义只认 turn/start 与 workspace/changes（事件体只有 turn，其它一律 null）",
  capturedDef.kind === "ocrTurnChanges"
    && JSON.stringify(capturedDef.match({ type: "turn/start", data: { turn: 1 } })) === JSON.stringify({ id: "1", role: "start" })
    && JSON.stringify(capturedDef.match({ type: "workspace/changes", data: { turn: 3 }, seq: 42 })) === JSON.stringify({ id: "3", role: "update" })
    && capturedDef.match({ type: "tool/call", data: { turn: 1 } }) === null
    && capturedDef.match({ type: "workspace/changes", data: {} }) === null
    && capturedDef.match({ type: "workspace/changes", data: { turn: "3" } }) === null,
  JSON.stringify([capturedDef.match({ type: "turn/start", data: { turn: 1 } }), capturedDef.match({ type: "workspace/changes", data: { turn: 3 }, seq: 42 })]),
);
const defState = capturedDef.start({}, { event: { type: "turn/start", data: { turn: 2 } } });
let startRejects = false;
try {
  capturedDef.start({}, { event: { type: "workspace/changes", data: { turn: 2 } } });
} catch {
  startRejects = true;
}
check("start 只认 turn/start（其余抛错，宿主会据此拒绝）", defState.turn === 2 && defState.changesSeq === undefined && startRejects, JSON.stringify(defState));
const defAfterUpdate = capturedDef.update({ state: defState }, { event: { type: "workspace/changes", seq: 42 } });
check("update 用事件的 seq 当坐标（清单另取）", defAfterUpdate.changesSeq === 42 && defAfterUpdate.turn === 2, JSON.stringify(defAfterUpdate));
const defFirst = capturedDef.buildLocationData({ state: defAfterUpdate }, "turn", undefined);
const defSame = capturedDef.buildLocationData({ state: defAfterUpdate }, "turn", defFirst);
const defChanged = capturedDef.buildLocationData({ state: { ...defAfterUpdate, changesSeq: 43 } }, "turn", defFirst);
check(
  "发布的 turn 数据 key=kind、没变时返回同一个对象（引用稳定）",
  defFirst.kind === "turn"
    && defFirst.turn === 2
    && defFirst.key === "ocrTurnChanges"
    && defFirst.value.changesSeq === 42
    && defSame === defFirst
    && defChanged !== defFirst
    && defChanged.value.changesSeq === 43,
  JSON.stringify([defFirst, defSame === defFirst, defChanged]),
);
check("步级作用域不发布数据（返回 null）", capturedDef.buildLocationData({ state: defAfterUpdate }, "step", undefined) === null, "step");

console.log(failures === 0 ? `\n全部通过（共 ${total} 项）` : `\n${failures} 项失败（共 ${total} 项）`);
if (failures > 0) process.exitCode = 1;
