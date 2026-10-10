/**
 * 紧急制动（kill switch）的离线冒烟测试 —— v0.7.0。
 *
 * 目的（对应 CPO 的 M1「应用外紧急制动」）：证明「标记命中 ⇒ 插件只留两个工具、
 * 一个钩子都不挂」，以及「没命中 ⇒ 一切照旧」。v0.5.7~v0.5.9 那次事故里，
 * 应用内的设置页/工具/命令全都不可用，唯一能救命的只有应用外的开关 —— 所以这一组断言
 * 是插件的最后一道防线，任何时候都不该被删掉。
 *
 * 关键安全约定：**标记文件只写在临时 DSH_HOME 里**，绝不碰真实插件目录 ——
 * 否则测试中途被杀就会把用户的插件永久禁用（要人工删文件才能恢复）。
 *
 * 用法：node test/killswitch-smoke.mjs
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mod from "../lib/index.js";
import {
  DISABLE_ENV,
  HOME_MARKER_NAME,
  PLUGIN_MARKER_NAME,
  killSwitchLogText,
  killSwitchState,
  killSwitchText,
  markerPaths,
  runtimeDisabled,
  truthyEnv,
} from "../lib/killswitch.js";

const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
  if (!ok) failures += 1;
}

/* 记住环境现场，最后原样还原（这是唯一会改动全局状态的一组测试）。 */
const savedEnv = process.env.DSH_HOME;
const savedDisable = process.env[DISABLE_ENV];
const homeDir = mkdtempSync(join(tmpdir(), "ocr-killswitch-"));
process.env.DSH_HOME = homeDir;
delete process.env[DISABLE_ENV];

const homeMarker = join(homeDir, HOME_MARKER_NAME);
/** 测试开始前真实插件目录里是否已有 .disabled（测试不该动它，最后要一模一样）。 */
const pluginMarkerBefore = existsSync(markerPaths()[1]);

/** 假 ctx：只记录被调用了什么，不真的接宿主。 */
function fakeCtx() {
  const calls = { tools: [], commands: [], injects: 0, ons: [], effects: 0 };
  return {
    calls,
    tools: {
      register(spec) {
        calls.tools.push(spec);
        return () => {};
      },
    },
    commands: { register(command) { calls.commands.push(command); } },
    inject() { calls.injects += 1; return () => {}; },
    on(event, handler) { calls.ons.push({ event, handler }); return () => {}; },
    effect() { calls.effects += 1; return () => {}; },
    logger: { info() {}, warn() {} },
  };
}

try {
  /* ---- 1) truthyEnv：只认 1/true/yes/on ---- */
  check("truthyEnv：1/true/yes/on（含大小写与空白）都算设了",
    truthyEnv("1") && truthyEnv("true") && truthyEnv("TRUE") && truthyEnv(" yes ") && truthyEnv("on"));
  check("truthyEnv：0/false/no/空/别的数字都不算",
    !truthyEnv("0") && !truthyEnv("false") && !truthyEnv("no") && !truthyEnv("") && !truthyEnv("2"));
  check("truthyEnv：非字符串一律不算", !truthyEnv(undefined) && !truthyEnv(1) && !truthyEnv(null));

  /* ---- 2) 标记位置 ---- */
  const paths = markerPaths();
  check("markerPaths：恰好两个位置（DSH_HOME 优先、插件目录兜底）", paths.length === 2 && paths[0] === homeMarker);
  check("markerPaths：第二个在插件目录里，文件名是 .disabled",
    paths[1].endsWith(PLUGIN_MARKER_NAME) && paths[1].includes("dsh-open-code-review"));

  /* ---- 3) 无标记 + 无环境变量 = 不制动 ---- */
  const clean = killSwitchState();
  check("无标记且无环境变量：未制动", clean.disabled === false && clean.source === "" && clean.path === "");
  check("无标记且无环境变量：没有意外报错", clean.error === "");
  check("runtimeDisabled() 与 killSwitchState() 一致", runtimeDisabled() === clean.disabled);

  /* ---- 4) 标记文件命中 ---- */
  writeFileSync(homeMarker, "disabled by test\n", "utf8");
  const byFile = killSwitchState();
  check("标记文件存在：判定为已禁用", byFile.disabled === true && byFile.source === "file");
  check("标记文件存在：报出的是这个路径", byFile.path === homeMarker);
  check("标记文件存在：reason 指名了那个文件", byFile.reason.includes(HOME_MARKER_NAME));
  const text = killSwitchText(byFile);
  check("killSwitchText 告诉用户怎么解除（删掉 + 重启）", text.includes(homeMarker) && text.includes("重启") && text.includes("禁用"));
  const logText = killSwitchLogText(byFile);
  check("killSwitchLogText 同时点出环境变量与两个标记位置",
    logText.includes(DISABLE_ENV) && logText.includes(HOME_MARKER_NAME) && logText.includes(PLUGIN_MARKER_NAME));
  check("runtimeDisabled()：命中后为 true", runtimeDisabled() === true);

  /* ---- 5) 制动命中时 apply()：只留两个工具，零钩子 ---- */
  const offCtx = fakeCtx();
  mod.apply(offCtx, {});
  const toolNames = offCtx.calls.tools.map((spec) => spec.name).join(",");
  check("制动命中：恰好注册两个工具（ocr_review, ocr_status）", toolNames === "ocr_review,ocr_status", toolNames);
  check("制动命中：不注册任何事件监听（这才是 0.5.7 事故打不到工具面的原因）", offCtx.calls.ons.length === 0);
  check("制动命中：不注册斜杠命令", offCtx.calls.commands.length === 0);
  check("制动命中：不做任何服务注入（桥/subagents/jobs/skills 全不挂）", offCtx.calls.injects === 0);
  check("制动命中：仍注册生命周期 effect（它只做收尾，不拦截任何调用）", offCtx.calls.effects === 1);

  const statusTool = offCtx.calls.tools.find((spec) => spec.name === "ocr_status");
  const status = await statusTool.execute({ checkLlm: false }, {});
  check("制动命中：ocr_status 仍可用，并自报 disabled/disabledBy",
    status.disabled === true && status.disabledBy === "file", JSON.stringify(status.disabled));
  check("制动命中：ocr_status 的备注解释当前状态", (status.notes || []).some((note) => note.includes("紧急制动")));
  check("制动命中：ocr_status 的开关字段仍反映配置（enabled 与制动是两件事）", status.enabled === true);
  check("制动命中：statusText 渲染出制动横幅",
    (await statusTool.output.render({}, status))[0].text.includes("紧急制动"));

  const reviewTool = offCtx.calls.tools.find((spec) => spec.name === "ocr_review");
  const refused = await reviewTool.execute({}, {});
  check("制动命中：ocr_review 直接拒绝，结果码是 OCR_DISABLED", refused.ok === false && refused.code === "OCR_DISABLED");
  check("制动命中：拒绝理由里带解除办法", String(refused.summary || "").includes("重启"));
  check("制动命中：拒绝时说明 ocr_status 不受影响",
    (refused.notes || []).some((note) => note.includes("ocr_status 不受紧急制动影响")));

  /* ---- 6) 环境变量命中（与文件等价的第二只手） ---- */
  rmSync(homeMarker, { force: true });
  process.env[DISABLE_ENV] = "1";
  const byEnv = killSwitchState();
  check("环境变置=1：判定为已禁用，源是 env", byEnv.disabled === true && byEnv.source === "env");
  check("环境变量命中：解除说明指向环境变量而不是文件",
    killSwitchText(byEnv).includes(DISABLE_ENV) && !killSwitchText(byEnv).includes("删除"));
  process.env[DISABLE_ENV] = "0";
  check("环境变量=0：不算禁用", killSwitchState().disabled === false);
  process.env[DISABLE_ENV] = "false";
  check("环境变量=false：不算禁用", killSwitchState().disabled === false);
  delete process.env[DISABLE_ENV];

  /* ---- 7) 没命中时一切照旧（命令/注入/钩子都回来了） ---- */
  const onCtx = fakeCtx();
  mod.apply(onCtx, {});
  check("未命中：两个工具照常注册", onCtx.calls.tools.map((spec) => spec.name).join(",") === "ocr_review,ocr_status");
  check("未命中：斜杠命令注册回来", onCtx.calls.commands.length === 1);
  check("未命中：服务注入照常（llm/subagents/jobs/skills）", onCtx.calls.injects >= 1, String(onCtx.calls.injects));
  check("未命中：事件监听照常挂（含 preTest 的 tools/pre-execute）",
    onCtx.calls.ons.length >= 1 && onCtx.calls.ons.every((entry) => typeof entry.event === "string"),
    onCtx.calls.ons.map((entry) => entry.event).join(","));

  /* ---- 8) 收尾：确认真实插件目录里没有被我们写进标记 ---- */
  check("测试没有把标记写进真实插件目录（防手抖把插件永久禁用）",
    existsSync(markerPaths()[1]) === pluginMarkerBefore,
    markerPaths()[1]);
} finally {
  /* 还原环境现场，并保证临时目录被删掉。 */
  if (savedEnv === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedEnv;
  if (savedDisable === undefined) delete process.env[DISABLE_ENV];
  else process.env[DISABLE_ENV] = savedDisable;
  rmSync(homeDir, { recursive: true, force: true });
}

for (const line of results) console.log(line);
console.log(`\n${failures === 0 ? "全部通过" : `${failures} 条失败`}（共 ${results.length} 项）`);
process.exit(failures === 0 ? 0 : 1);
