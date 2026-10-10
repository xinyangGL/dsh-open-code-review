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
 *  2) **包装**：每次注册都包 try/catch —— 注册失败只等于少一个功能，绝不冒泡成插件加载失败。
 *  3) **记账**：成功/失败/被拒都记下来，由 `ocr_status.hooks` 报出来，
 *     于是「插件刚才到底挂了什么」不用翻日志就能回答（事故当天最缺的就是这个）。
 */
export const HOOK_WHITELIST = new Set([
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

const state = { registered: [], errors: [], blocked: [] };

/** 当前进程内的挂载账目（给 ocr_status 用）。 */
export function hookStats() {
  const counts = {};
  for (const event of state.registered) counts[event] = (counts[event] || 0) + 1;
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
 * 挂一个钩子。**永远不抛**：白名单外、宿主不支持、注册本身失败，都只记一笔并返回空卸载函数。
 * @param {object} ctx 宿主/作用域上下文（只要有 `on` 就行）
 * @param {string} event 事件名（必须在 HOOK_WHITELIST 里）
 * @param {Function} handler 处理函数
 * @returns {() => void} 卸载函数（失败时是空函数）
 */
export function armHook(ctx, event, handler) {
  const name = String(event ?? "");
  if (!HOOK_WHITELIST.has(name)) {
    state.blocked.push(name);
    return () => {};
  }
  if (typeof ctx?.on !== "function") {
    state.errors.push({ event: name, message: "宿主没有 ctx.on（这个事件挂不上）" });
    return () => {};
  }
  try {
    const off = ctx.on(name, handler);
    state.registered.push(name);
    return typeof off === "function" ? off : () => {};
  } catch (err) {
    state.errors.push({ event: name, message: String(err?.message ?? err) });
    return () => {};
  }
}
