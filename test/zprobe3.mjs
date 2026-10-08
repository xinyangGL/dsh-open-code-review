/**
 * 预检设置页盲点：Host 是「从 schema 的 meta.volatile 节点投影表单」，
 * 所以这里直接检查每个字段节点的 meta，而不是解析后的运行时值。
 */
import { Config, SCHEMA_AVAILABLE, DEFAULTS } from "../lib/config.js";

console.log("SCHEMA_AVAILABLE =", SCHEMA_AVAILABLE, "| typeof Config =", typeof Config);

const meta = Config?.meta ?? {};
console.log("schema.meta 顶层键 =", Object.keys(meta));
const dict = meta.dict ?? Config?.dict ?? {};
const keys = Object.keys(dict);
console.log("字段数 =", keys.length);

let volatileOk = 0;
let descOk = 0;
let defaultOk = 0;
for (const key of keys) {
  const node = dict[key];
  const m = node?.meta ?? {};
  const vol = m.volatile === true || m.volatile !== undefined;
  if (vol) volatileOk += 1;
  if (typeof m.description === "string" && m.description.length > 0) descOk += 1;
  if (m.default !== undefined) defaultOk += 1;
  console.log(
    `  ${key.padEnd(24)} volatile=${String(vol).padEnd(5)} default=${JSON.stringify(m.default)?.slice(0, 42)?.padEnd(42)} desc=${(m.description ?? "").slice(0, 34)}`,
  );
}
console.log(`\nvolatile 字段 ${volatileOk}/${keys.length} · 有描述 ${descOk}/${keys.length} · 有默认值 ${defaultOk}/${keys.length}`);
console.log("DEFAULTS（第 1 层）键 =", Object.keys(DEFAULTS).join(", "));
