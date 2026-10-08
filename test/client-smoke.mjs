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
function check(name, ok, detail = "") {
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
check("插件 inject 含 slots", Array.isArray(plugin.inject) && plugin.inject.includes("slots"), JSON.stringify(plugin.inject));

/* ------------------------------------------------------------ 注册契约 */

const registrations = [];
const fakeCtx = {
  injectCalls: [],
  slotInjectCalls: [],
  formIds: [],
  inject(deps, cb) {
    fakeCtx.injectCalls.push(deps);
    return cb(fakeCtx);
  },
  slots: {
    inject(name, cb) {
      fakeCtx.slotInjectCalls.push(name);
      return cb();
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  },
  configForms: {
    get(id) {
      fakeCtx.formIds.push(id);
      if (Array.isArray(fakeCtx.rejectIds) && fakeCtx.rejectIds.includes(id)) throw new Error(`unknown entry: ${id}`);
      return fakeCtx.form;
    },
  },
};

plugin.apply(fakeCtx);
check("apply 注入 configForms", fakeCtx.injectCalls.some((d) => d.includes("configForms")), JSON.stringify(fakeCtx.injectCalls));
check("注册进 plugins.bundle.config", fakeCtx.slotInjectCalls.includes("plugins.bundle.config"), JSON.stringify(fakeCtx.slotInjectCalls));
check("注册进 settings.section", fakeCtx.slotInjectCalls.includes("settings.section"), JSON.stringify(fakeCtx.slotInjectCalls));
check("共注册两个 cell", registrations.length === 2, `n=${registrations.length}`);
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
    timeoutMinutes: 15,
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
for (const label of ["总开关", "默认引擎", "输出受众", "ocr 可执行文件", "自动评审范围", "每会话上限", "最少可审文件数", "最小间隔（毫秒）", "跳过子代理会话", "委派时带 diff", "端点 Base URL", "端点协议", "模型名", "API Key 引用", "单次超时（分钟）", "调试日志"]) {
  check(`渲染字段「${label}」`, html.includes(label));
}
check("带出条目 id", html.includes("include:dsh-open-code-review"));
check("状态行含 ready/可写", html.includes("状态 ready") && html.includes("可写"));
check("带出模型当前值", hosts(tree).some((n) => n.tag === "input" && n.props.value === "deepseek/deepseek-v4.1-flash"));
check("带出数字字段值", hosts(tree).some((n) => n.tag === "input" && n.props.type === "number" && n.props.value === "3"));
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
check("找到 17 个控件行", rows.length === 17, `n=${rows.length}`);

const modelRow = rows.find((r) => r.field.props.value === "deepseek/deepseek-v4.1-flash");
check("改动前该行没有「保存」", Boolean(modelRow) && !modelRow.buttons.some((b) => textOf(b) === "保存"));
check("每行都有「恢复默认」", rows.every((r) => r.buttons.some((b) => textOf(b) === "恢复默认")));

const urlRow = rows.find((r) => r.field.props.value === "https://api.commandcode.ai/provider/v1");
check("找到 Base URL 行", Boolean(urlRow));
urlRow.field.props.onChange({ target: { value: "https://example.test/v1" } });
const urlRow2 = controlRows(render()).find((r) => r.field.props.value === "https://example.test/v1");
check("改动后草稿生效", Boolean(urlRow2));
const save2 = urlRow2 && urlRow2.buttons.find((b) => textOf(b) === "保存");
check("改动后出现「保存」", Boolean(save2));
if (save2) {
  await save2.props.onClick();
  check("保存调用 form.set(Base URL)", writes.some((w) => w.op === "set" && w.key === "llmBaseUrl" && w.value === "https://example.test/v1"), JSON.stringify(writes));
}

const maxRow = controlRows(render()).find((r) => r.field.props.type === "number" && r.field.props.value === "3");
check("找到数字字段行", Boolean(maxRow));
if (maxRow) {
  maxRow.field.props.onChange({ target: { value: "5" } });
  const maxRow3 = controlRows(render()).find((r) => r.field.props.type === "number" && r.field.props.value === "5");
  const save3 = maxRow3 && maxRow3.buttons.find((b) => textOf(b) === "保存");
  check("数字改动后出现「保存」", Boolean(save3));
  if (save3) await save3.props.onClick();
  check("数字字段写成 number", writes.some((w) => w.op === "set" && w.key === "autoMaxPerSession" && w.value === 5), JSON.stringify(writes));
  const reset = controlRows(render())
    .find((r) => r.field.props.type === "number" && r.field.props.value === "3")
    ?.buttons.find((b) => textOf(b) === "恢复默认");
  if (reset) await reset.props.onClick();
  check("「恢复默认」调用 form.unset", writes.some((w) => w.op === "unset" && w.key === "autoMaxPerSession"), JSON.stringify(writes));
}

/* ------------------------------------------------------------ 模型名：可搜索下拉 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const modelInputNode = (t) => hosts(t).find((n) => n.tag === "input" && n.props["data-ocr-model-input"] === true);
const modelMenuNode = (t) => hosts(t).find((n) => n.props && n.props["data-ocr-model-menu"] === true);
const modelItemNodes = (t) => hosts(t).filter((n) => n.props && n.props["data-ocr-model-item"] === true);

fakeCtx.remote = {
  session: {
    modelCatalog: async () => ({
      ok: true,
      value: {
        default: { provider: "commandcode", model: "deepseek/deepseek-v4.1-flash" },
        routableProviders: ["commandcode", "other"],
        groups: [
          {
            id: "commandcode",
            name: "Command Code",
            models: [
              { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek v4.1 Flash", description: "部署默认" },
              { id: "glm-5.3-flashx", name: "GLM-5.3 FlashX" },
              { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
            ],
          },
          { id: "other", name: "其它提供方", models: [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }] },
        ],
        failures: [{ id: "broken", name: "Broken", message: "timeout" }],
      },
    }),
  },
};
render();
await tick();
const catalogTree = render();
check("模型目录读完后给出候选数量", textOf(catalogTree).includes("4 个模型"), textOf(catalogTree).slice(-140));
check("目录读取失败也如实提示", textOf(catalogTree).includes("1 个提供方没读出来"));
check("带出当前模型的友好名", textOf(catalogTree).includes("当前：DeepSeek v4.1 Flash（Command Code）"), textOf(catalogTree).slice(-160));

const mi = modelInputNode(catalogTree);
check("模型名仍是可编辑输入框", Boolean(mi) && mi.props.disabled !== true && mi.props.value === "deepseek/deepseek-v4.1-flash");
check("默认收起候选列表", !modelMenuNode(catalogTree));
check("模型目录来自 ctx.remote.session", textOf(catalogTree).includes("候选来自 DSH 自己的模型目录"));

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

/* 键盘：输入过滤成唯一匹配后回车选中 */
const afterSave = render();
modelInputNode(afterSave).props.onFocus();
modelInputNode(afterSave).props.onChange({ target: { value: "kimi" } });
const oneMatch = render();
modelInputNode(oneMatch).props.onKeyDown({ key: "ArrowDown", preventDefault() {} });
modelInputNode(oneMatch).props.onKeyDown({ key: "Enter", preventDefault() {} });
const kbPicked = controlRows(render()).find((r) => r.key === "llmModel");
check("↑↓ + 回车也能选中", Boolean(kbPicked) && kbPicked.field.props.value === "kimi-k2.7-code", kbPicked ? String(kbPicked.field.props.value) : "没有该行");

/* Remote 信封报错（{ ok: false, error }）时也要给出可读诊断 */
fakeCtx.remote.session.modelCatalog = async () => ({ ok: false, error: { code: "peer-unavailable", message: "peer 断了" } });
render();
await tick();
const errTree = render();
check("Remote 信封失败时给出诊断", textOf(errTree).includes("读取 DSH 模型目录失败") && textOf(errTree).includes("peer 断了"), textOf(errTree).slice(-140));

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

check("summary 视图渲染为 null", reg.component({ view: "summary" }) === null);

snapshot = { ...snapshot, status: "loading", writable: false };
check("loading + 不可写时不崩", textOf(render()).includes("正在从宿主读取"));
snapshot = { ...snapshot, status: "unavailable", writable: false, value: undefined };
check("unavailable 时给出原因", textOf(render()).includes("没有暴露给浏览器"));
snapshot = { ...snapshot, status: "ready", writable: true };

/* 条目 id 回退：主 id 查不到时用备用 id */
fakeCtx.rejectIds = ["include:dsh-open-code-review"];
const fbTree = render();
check("主 id 查不到时回退到包名 id", fakeCtx.formIds.includes("dsh-open-code-review") && controlRows(fbTree).length === 17, JSON.stringify(fakeCtx.formIds.slice(-2)));
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
check("设置页也带 17 个控件行", controlRows(sectionTree).length === 17, `n=${controlRows(sectionTree).length}`);
check("设置页照样带出条目 id", sectionHtml.includes("include:dsh-open-code-review"));

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
if (failures > 0) process.exitCode = 1;
