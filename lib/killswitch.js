/**
 * 应用外紧急制动（kill switch）—— v0.7.0 起。
 *
 * v0.5.7~v0.5.9 那次事故（preTest 注册的全局 guard 在放行时 `return ""`，而宿主用
 * `reason !== void 0` 判定「返回了字符串就是拒绝」⇒ **每一次工具调用**都渲染成 `Error: `）
 * 暴露的不只是「空字符串」这一个边界，而是一个更本质的问题：
 * 插件一旦挂到工具面上，就**没有任何从应用外面把它关掉**的办法 ——
 * 应用内的设置页、工具、命令全都不可用，只能卸载、改代码或装回旧版。
 *
 * 所以这个开关刻意**不依赖 cordis、不依赖配置解析、不依赖插件自己的任何代码路径**：
 *   1) 环境变量 `DSH_OPEN_CODE_REVIEW_DISABLE=1`（启动前设，或写进宿主启动脚本）；
 *   2) 标记文件 `<DSH_HOME>/dsh-open-code-review.disabled`（默认 ~/.dsh/…）；
 *   3) 标记文件 `<插件目录>/.disabled`（DSH_HOME 也不知道在哪时，直接戳插件目录）。
 * 任一命中即禁用。命中时 apply() **只注册两个工具**（都要能回答「已禁用」），
 * 不注册任何事件监听、命令、LLM 桥、skill 与注入 —— 也就不会再有任何东西能拖垮工具面。
 *
 * 解除：删掉标记文件（或从启动环境里去掉环境变量）后重启 DSH。
 * 运行中删掉标记会让两个工具立刻恢复工作，但**钩子要等下一次重启**才会挂回来 ——
 * 这是我们故意的：宁可少挂一个功能，也不能挂错。
 *
 * 本模块只做只读判断，绝不写盘；出现任何异常（EACCES/EBUSY 等）一律 fail-open（当作没禁用），
 * 并把错误留在 `error` 字段里，由 ocr_status 报出来。
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_DIR, dshHome } from "./config.js";

/** 设成 1/true/yes/on（大小写无关）即禁用；"0"/"false"/空串都算没设。 */
export const DISABLE_ENV = "DSH_OPEN_CODE_REVIEW_DISABLE";
/** DSH_HOME 下的标记文件（推荐用这个）。 */
export const HOME_MARKER_NAME = "dsh-open-code-review.disabled";
/** 插件目录下的标记文件（备选）。 */
export const PLUGIN_MARKER_NAME = ".disabled";

/** 真值判定：只认 1/true/yes/on，其它（含 "0"/"false"）都算没设。 */
export function truthyEnv(value) {
  return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

/** 两个标记文件的完整路径（顺序即判定优先级：先 DSH_HOME，后插件目录）。 */
export function markerPaths() {
  return [join(dshHome(), HOME_MARKER_NAME), join(PLUGIN_DIR, PLUGIN_MARKER_NAME)];
}

const msgOf = (err) => (err?.message ? String(err.message) : String(err));

/**
 * 解析标记路径，但**不抛**：`dshHome()`/`join()` 本身也可能因为环境怪异而抛错，
 * 而这条路径上任何抛错都会违背本模块的 fail-open 契约（v0.7.0 真机评审的第 6 条发现）。
 * @returns {{paths: string[], error: string}}
 */
const resolveMarkerPaths = () => {
  try {
    return { paths: markerPaths(), error: "" };
  } catch (err) {
    return { paths: [], error: msgOf(err) };
  }
};

/**
 * 读一次制动状态。**只读**，任何异常都 fail-open。
 * @returns {{disabled: boolean, source: ""|"env"|"file", path: string, env: string, reason: string, error: string}}
 */
export function killSwitchState() {
  const out = { disabled: false, source: "", path: "", env: DISABLE_ENV, reason: "", error: "" };
  if (truthyEnv(process.env[DISABLE_ENV])) {
    out.disabled = true;
    out.source = "env";
    out.reason = `环境变量 ${DISABLE_ENV} 已设置`;
    return out;
  }
  const { paths, error } = resolveMarkerPaths();
  if (error) out.error = error;
  for (const path of paths) {
    try {
      /* 用 statSync 而不是 existsSync：existsSync 把一切错误都吞成 false，
         于是 EACCES/EBUSY/ELOOP 和「文件不存在」长得一模一样，`error` 字段永远是空的
         —— 那个字段存在的意义就是「说不清为什么读不到时别闷着」（第 7 条发现）。 */
      statSync(path);
    } catch (err) {
      /* ENOENT 是正常情况（没写标记），不记错；其它错误只在首次出现时记录，
         免得后面那个路径把真正的原因覆盖掉（第 8 条发现）。 */
      if (err?.code !== "ENOENT" && !out.error) out.error = msgOf(err);
      continue;
    }
    out.disabled = true;
    out.source = "file";
    out.path = path;
    out.reason = `标记文件存在：${path}`;
    return out;
  }
  return out;
}

/** 单个布尔判断（工具/闸门的热路径用；每次真读一次，不做缓存 —— 制动不能有延迟）。 */
export function runtimeDisabled() {
  return killSwitchState().disabled;
}

/** 给日志/工具结果用的一段说明：怎么解除。 */
export function killSwitchText(sw = killSwitchState()) {
  if (!sw.disabled) return "";
  const how =
    sw.source === "env"
      ? `从宿主启动环境里去掉 ${DISABLE_ENV}（或改成 0）后重启 DSH`
      : `删除 ${sw.path || "标记文件"} 后重启 DSH`;
  return `已由紧急制动禁用（${sw.reason}）。${how} 即可恢复。`;
}

/** apply() 里命中制动时打的一行日志（含两处标记路径，方便用户自己检查）。 */
export function killSwitchLogText(sw = killSwitchState()) {
  const { paths } = resolveMarkerPaths();
  const where = paths.length > 0 ? paths.join(" 或 ") : sw.path || "（标记路径解析不出来，请检查 DSH_HOME 与插件目录）";
  return (
    `${killSwitchText(sw)}本次只注册 ocr_status / ocr_review 两个工具，` +
    `不挂任何事件监听、命令、LLM 桥与 skill。标记位置：${DISABLE_ENV}=1、${where}。`
  );
}
