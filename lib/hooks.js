/**
 * 爆炸半径预算（v0.7.0）—— 所有「往宿主事件上挂钩子」的注册都必须经过 `armHook()`。
 *
 * 由来：v0.5.7~v0.5.9 的 preTest 用 `ctx.tools.guard()` 注册了一个**全局** guard，放行时
 * `return ""`，而宿主的判定是 `reason !== void 0` ⇒ 每一次工具调用都渲染成 `Error: `（近 5 小时）。
 * 那次事故不是「一个 API 用错了」这么简单：**任何**一个钩子写错语义、挂错事件、或注册时抛错，
 * 都可能拖垮整个工具面或让插件加载失败，而插件自己没有任何机制能在应用外观测、收敛它。
 *
 * 所以从这里开始，挂钩子只有一条路：
 *  1) **白名单**：只允许挂下面这几个事件；别的名字一律拒绝（挂错事件 = 静默失效或越权）；
 *     这条同时也是回归防线 —— 想挂新事件必须先改这份清单（评审时看得见）。
 *     白名单本身保持模块私有（导出的是冻结副本 + 判定函数）：导出一个可变 Set 等于把
 *     「挂钩子只有一条路」的承诺交给导入方去守（v0.7.1 的评审发现）。
 *  2) **包装**：每次注册都包 try/catch —— 注册失败只等于少一个功能，绝不冒泡成插件加载失败。
 *  3) **记账**：成功/失败/被拒都记下来，由 `ocr_status.hooks` 报出来，
 *     于是「插件刚才到底挂了什么」不用翻日志就能回答（事故当天最缺的就是这个）。
 *     v0.7.1 起卸载函数会**回收**自己那条账（否则重复 arm/unarm 会让计数虚高，
 *     `ocr_status.hooks.counts` 就在骗人，而这一层存在的全部意义就是「不骗人」）。
 */
const WHITELIST = new Set([
  /** 统计写入、失效 preTest 的覆盖状态。 */
  "tools/result",
  /** preTest 闸门：**唯一**有否决权的地方，且必须返回 `{kind:"deny", reason}`（绝不返回字符串）。 */
  "tools/pre-execute",
  /** 自动评审的触发点，以及写后失效。 */
  "agent/turn-stopping",
  /** 设置页热更新（volatile-update）。 */
  "loader/volatile-update",
  /** 客户端主题变化（lib/client.js 用）。 */
  "theme/change",
]);

/** 白名单的只读副本（冻结数组：看得见，但改不了）。 */
export const HOOK_WHITELIST = Object.freeze([...WHITELIST]);

/** 事件名是否在白名单里（armHook 之外的代码/测试只该用这个判定，不该碰内部集合）。 */
export function isWhitelistedHook(event) {
  return typeof event === "string" && WHITELIST.has(event);
}

/** errors/blocked 只用来诊断，长进程里没有理由无限增长。 */
const MAX_DIAGNOSTIC_ENTRIES = 50;

const state = { registered: [], errors: [], blocked: [] };

/** index.js 用它把「注册失败」报给用户；不设也可以，失败仍会记进 hookStats。 */
let logger = null;
export function setHookLogger(fn) {
  logger = typeof fn === "function" ? fn : null;
}

const noop = () => {};
const warn = (message) => {
  try {
    logger?.(message);
  } catch {
    /* 记账优先：日志本身失败不算注册失败 */
  }
};
const pushCapped = (list, entry) => {
  list.push(entry);
  if (list.length > MAX_DIAGNOSTIC_ENTRIES) list.splice(0, list.length - MAX_DIAGNOSTIC_ENTRIES);
};

/** 当前进程内的挂载账目（给 ocr_status 用）。 */
export function hookStats() {
  const counts = {};
  for (const entry of state.registered) {
    if (!entry.active) continue;
    counts[entry.event] = (counts[entry.event] || 0) + 1;
  }
  return {
    registered: Object.keys(counts).sort(),
    counts,
    errors: state.errors.map((entry) => `${entry.event}: ${entry.message}`),
    blocked: [...state.blocked],
  };
}

/** 仅测试用：清空账目（模块级状态不该在测试之间互相污染）。 */
export function resetHookStats() {
  state.registered.length = 0;
  state.errors.length = 0;
  state.blocked.length = 0;
}

/**
 * 事件名归一。`String(event)` 本身也可能抛（带抛错 toString 的对象），
 * 而那会破坏本模块「永远不抛」的契约 —— 所以这一步也在保护范围里。
 * @returns {string|null} 归一后的事件名；null 表示「这个名字根本解析不出来」
 */
const safeEventName = (event) => {
  try {
    if (typeof event === "string") return event;
    if (event === null || event === undefined) return "";
    return String(event);
  } catch {
    return null;
  }
};

/**
 * 挂一个钩子。**永远不抛**：白名单外、宿主不支持、handler 不是函数、注册本身失败，
 * 都只记一笔并返回空卸载函数。
 * @param {object} ctx 宿主/作用域上下文（只要有 `on` 就行）
 * @param {string} event 事件名（必须在白名单里）
 * @param {Function} handler 处理函数
 * @returns {() => void} 卸载函数（失败时是空函数；成功时调它会回收账目并调用宿主的 off）
 */
export function armHook(ctx, event, handler) {
  const name = safeEventName(event);
  if (name === null) {
    pushCapped(state.blocked, "(事件名无法解析：toString 抛错)");
    warn("挂钩子时事件名无法解析（toString 抛错），已按拒绝处理");
    return noop;
  }
  if (!WHITELIST.has(name)) {
    pushCapped(state.blocked, name);
    return noop;
  }
  if (typeof handler !== "function") {
    pushCapped(state.errors, { event: name, message: "handler 不是函数（跳过注册）" });
    warn(`${name} 的 handler 不是函数，已跳过注册`);
    return noop;
  }
  if (typeof ctx?.on !== "function") {
    pushCapped(state.errors, { event: name, message: "宿主没有 ctx.on（这个事件挂不上）" });
    warn(`宿主没有 ctx.on，${name} 挂不上（少一个功能，不影响其它）`);
    return noop;
  }
  try {
    const off = ctx.on(name, handler);
    const entry = { event: name, active: true };
    state.registered.push(entry);
    return () => {
      if (!entry.active) return;
      entry.active = false;
      const index = state.registered.indexOf(entry);
      if (index >= 0) state.registered.splice(index, 1);
      if (typeof off === "function") {
        try {
          off();
        } catch {
          /* 卸载失败不算注册失败；账目已经回收 */
        }
      }
    };
  } catch (err) {
    pushCapped(state.errors, { event: name, message: String(err?.message ?? err) });
    warn(`${name} 注册失败：${String(err?.message ?? err)}（少一个功能，不影响其它）`);
    return noop;
  }
}
