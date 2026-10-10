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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  /* ---- 3.5) v0.7.1：读不到标记时要说清原因；标记路径解析本身也在保护范围里 ----
     这一组是 v0.7.0 真机评审对 lib/killswitch.js 提的四条（第 6~9 条发现）的回归门。 */
  {
    /* 3.5a 标记是个目录也算命中：statSync 的成功路径与文件完全一样（存在即禁用）。 */
    const dirHome = mkdtempSync(join(tmpdir(), "ocr-killswitch-dir-"));
    process.env.DSH_HOME = dirHome;
    mkdirSync(join(dirHome, HOME_MARKER_NAME));
    const byDir = killSwitchState();
    process.env.DSH_HOME = homeDir;
    rmSync(dirHome, { recursive: true, force: true });
    check("v0.7.1：标记路径存在（哪怕是个目录）即判定禁用 —— statSync 的成功路径与文件一致",
      byDir.disabled === true && byDir.source === "file" && byDir.path === join(dirHome, HOME_MARKER_NAME),
      JSON.stringify(byDir));

    /* 3.5b 非 ENOENT 的失败必须留下原因（原来用 existsSync：EACCES/ENOTDIR/非法路径全被吞成
       「没标记」，于是 error 字段永远是空的，那条诊断路径是死的）。
       Windows 上造不出稳定的非 ENOENT 失败（文件当目录 → ENOENT、超长路径 → ENOENT、
       process.env 里的 NUL 会被 Node 截断），所以这条分支由源码级断言钉住；
       Linux 上的 ENOTDIR/ELOOP 会走它，CI 也在 Linux 上跑。 */
    const ksSource = readFileSync(new URL("../lib/killswitch.js", import.meta.url), "utf8");
    const ksCode = ksSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    check("v0.7.1：只有非 ENOENT 的读标记失败才记 error（正常不存在不算错），且该分支真的在代码里",
      clean.error === "" && /err\?\.code !== "ENOENT"[\s\S]{0,80}out\.error/.test(ksCode),
      `cleanError=${JSON.stringify(clean.error)} nonEnoentBranch=${/err\?\.code !== "ENOENT"/.test(ksCode)}`);

    /* 3.5c 源码级防漂移：不许回到 existsSync；错误只记首次；两条消息共用同一份路径解析。 */
    check("v0.7.1：killswitch 不再用 existsSync（它把一切错误吞成 false），改用 statSync + ENOENT 特判",
      !/\bexistsSync\b/.test(ksCode) && /\bstatSync\b/.test(ksCode) && /ENOENT/.test(ksCode),
      `existsSync=${/\bexistsSync\b/.test(ksCode)} statSync=${/\bstatSync\b/.test(ksCode)}`);
    check("v0.7.1：路径解析（dshHome/join）在 try 里，两条消息共用同一份结果，错误只记首次",
      /const resolveMarkerPaths = \(\) => \{[\s\S]*?try\s*\{[\s\S]*?markerPaths\(\)/.test(ksCode) &&
        /!out\.error/.test(ksCode) &&
        !/markerPaths\(\)\.join/.test(ksCode),
      `resolve=${/const resolveMarkerPaths = \(\) => \{[\s\S]*?try\s*\{[\s\S]*?markerPaths\(\)/.test(ksCode)}`);
  }

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
  /* v0.7.2：真机复验时看到拒绝表头写着 engine=auto（其实一个引擎都没跑）——
     拒绝路径必须把 engine 置空，渲染成「未执行」（schema 里 engine 是 string，空串合法）。 */
  check("v0.7.2：制动拒绝的表头不谎报引擎（没有任何引擎跑过 → engine=未执行）",
    refused.engine === "" &&
      (await reviewTool.output.render({}, refused))[0].text.startsWith(
        "阿里 OpenCodeReview · engine=未执行 · scope=",
      ),
    JSON.stringify((await reviewTool.output.render({}, refused))[0].text.split("\n")[0]));

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
