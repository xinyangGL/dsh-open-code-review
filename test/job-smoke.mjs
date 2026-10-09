/**
 * 评审进度（可选 jobs 能力）离线冒烟：
 * - lib/job.js 的报告器语义（进度行 / 输出环 / 结算幂等 / kill→cancel→abort / 降级）；
 * - 等待者必须挂上（否则结算事件 awaited:false，宿主会往会话里塞「后台任务完成」唤醒消息）；
 * - lib/ocr-cli.js 的实时流泵（onChunk 增量读，不重复、不丢尾）。
 *
 * 不依赖 DSH 宿主：registry / subprocess 都是按 @deepseek-ai/dsh-jobs-local 与
 * subprocess 服务契约写的最小替身。
 *
 * 用法：node test/job-smoke.mjs
 */
import { REVIEW_JOB_KIND, humanMs, noJob, oneLine, startJob } from "../lib/job.js";
import { runCommand } from "../lib/ocr-cli.js";

const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function log(message) {
  console.log(`      · ${message}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ 最小 jobs 替身 */

/**
 * 按 dsh-jobs-local 的语义实现：start 同步调用 spec.run(handle) 并返回 `<kind>-N`；
 * handle.append/updateProgress 写进环；hooks.done 落地即结算；hooks.cancel 由 kill 触发。
 */
function fakeRegistry(options = {}) {
  const jobs = new Map();
  const waits = [];
  let counter = 0;
  const registry = {
    jobs,
    waits,
    spec: null,
    kills: [],
    start(spec) {
      if (options.rejectWith) throw new Error(options.rejectWith);
      counter += 1;
      const id = `${spec.kind}-${counter}`;
      const record = {
        id,
        kind: spec.kind,
        label: spec.label,
        owner: spec.owner,
        progress: "",
        output: [],
        status: "running",
        detail: undefined,
        awaited: false,
      };
      jobs.set(id, record);
      registry.spec = spec;
      const handle = {
        id,
        append: (text, opts = {}) => record.output.push({ text, channel: opts.channel ?? "stdout" }),
        updateProgress: (line) => {
          record.progress = line;
        },
      };
      const hooks = spec.run(handle);
      record.hooks = hooks;
      hooks.done.then(
        (outcome) => {
          record.status = outcome?.status ?? "completed";
          record.detail = outcome?.detail;
        },
        () => {
          record.status = "failed";
        },
      );
      return id;
    },
    wait(id, timeoutMs, owner) {
      const record = jobs.get(id);
      waits.push({ id, timeoutMs, owner });
      if (options.waitRejects) return Promise.reject(new Error("wait 失败"));
      return new Promise((resolve) => {
        const poll = setInterval(() => {
          if (!record || record.status !== "running") {
            clearInterval(poll);
            record.awaited = true;
            resolve(jobs.get(id));
          }
        }, 5);
      });
    },
    kill(id, caller, reason) {
      registry.kills.push({ id, caller, reason });
      jobs.get(id)?.hooks?.cancel(reason);
      return { ok: true };
    },
  };
  return registry;
}

/* ------------------------------------------------------------------ 1. 降级形态 */

{
  const dead = startJob(null, { label: "评审 · 工作区改动" });
  check("没有 jobs 服务时退化成 noJob", dead.live === false && dead.id === "" && dead.why.length > 0, dead.why);
  let threw = "";
  try {
    dead.progress("x");
    dead.log("x");
    dead.out("x");
    dead.phase("x");
    dead.finish({ status: "completed" });
  } catch (err) {
    threw = String(err && err.message);
  }
  check("noJob 的所有方法都是空操作", threw === "", threw);
  check("noJob.cancelled() 恒为 false", dead.cancelled() === false);

  const empty = noJob();
  check("noJob() 默认不带原因", empty.live === false && empty.kind === REVIEW_JOB_KIND);

  const broken = startJob(
    {
      start() {
        throw new Error("background jobs unavailable: no job controller serves this agent");
      },
    },
    { label: "x" },
  );
  check(
    "start 被拒时降级并带上宿主的原因",
    broken.live === false && broken.why.includes("no job controller serves this agent"),
    broken.why,
  );
}

/* ------------------------------------------------------------------ 2. 报告器语义 */

{
  const registry = fakeRegistry();
  const cancels = [];
  const job = startJob(registry, {
    label: "评审 · 提交区间 main..feature-x · my-repo",
    owner: "session-1",
    timeoutMs: 15 * 60000,
    onCancel: (reason) => cancels.push(reason),
  });
  check("登记成功并拿到 job id", job.live === true && job.id === "ocr-review-1", job.id);
  check("kind 是自定义的 ocr-review", registry.spec.kind === REVIEW_JOB_KIND);
  check("label / owner 原样传给宿主", registry.spec.label.startsWith("评审 · 提交区间") && registry.spec.owner === "session-1");
  check("run 在 start 内同步调用（handle 已就绪）", registry.jobs.get(job.id) !== undefined);

  const waits = registry.waits;
  check(
    "登记后立刻挂等待者（结算才会带 awaited，避免唤醒噪音）",
    waits.length === 1 && waits[0].id === job.id && waits[0].owner === "session-1",
    JSON.stringify(waits[0]),
  );
  check(
    "等待者 deadline = 评审超时 + 余量",
    waits[0].timeoutMs === 15 * 60000 + 60000,
    String(waits[0].timeoutMs),
  );

  job.progress("运行 ocr review（超时 15 分钟）");
  check("progress 写进 JobView.progress", registry.jobs.get(job.id).progress === "运行 ocr review（超时 15 分钟）");

  job.log("ocr 结果：exit=0 · 3 个文件 · 1 条问题");
  const logLine = registry.jobs.get(job.id).output.at(-1);
  check(
    "log 走 log 通道并带时间戳",
    logLine.channel === "log" && /^\[\d{2}:\d{2}:\d{2}\] ocr 结果/.test(logLine.text),
    logLine.text.trim(),
  );

  job.out("stdout 片段");
  job.out("stderr 片段", "stderr");
  const outLines = registry.jobs.get(job.id).output.slice(-2);
  check("out 按通道原样追加（实时流）", outLines[0].text === "stdout 片段" && outLines[0].channel === "stdout" && outLines[1].channel === "stderr");
  job.out("");
  check("空片段不写环", registry.jobs.get(job.id).output.at(-1).text === "stderr 片段");

  job.phase("delegate：可审 12 个文件（排除 3 个）");
  const record = registry.jobs.get(job.id);
  check("phase = progress + log", record.progress.startsWith("delegate：") && record.output.at(-1).channel === "log");

  const long = job.progress.call(null, undefined);
  check("progress(undefined) 不抛错", long === undefined);
  job.progress("x".repeat(400));
  check("超长进度行被收成一行", record.progress.length <= 160, String(record.progress.length));

  check("elapsedMs 是正数", Number.isFinite(job.elapsedMs) && job.elapsedMs >= 0);
  check("还没结算时 cancelled() 为 false", job.cancelled() === false);

  job.finish({ status: "completed", detail: "评审完成：3 个文件，1 条问题（8.2s）" });
  await sleep(10);
  check("finish 让 job 结算成 completed", registry.jobs.get(job.id).status === "completed", registry.jobs.get(job.id).status);
  check("结算明细写进 detail", registry.jobs.get(job.id).detail.includes("1 条问题"));
  check("结算后 live=false（调用方据此不再写进度）", job.live === false);

  job.finish({ status: "failed", detail: "二次结算" });
  await sleep(10);
  check("重复 finish 是幂等的", registry.jobs.get(job.id).status === "completed" && job.live === false);
}

/* ------------------------------------------------------------------ 3. kill → cancel → abort */

{
  const registry = fakeRegistry();
  const seen = [];
  const job = startJob(registry, {
    label: "评审 · 工作区改动 · repo",
    owner: "session-2",
    timeoutMs: 60000,
    onCancel: (reason) => seen.push(reason),
  });
  registry.kill(job.id, "session-2", "用户停止");
  await sleep(10);
  check("kill 触发 onCancel（插件在这里 abort 评审）", seen.length === 1 && seen[0] === "用户停止", JSON.stringify(seen));
  check("cancel 后 cancelled() 为 true", job.cancelled() === true);

  /* 评审自己先落地时，必须结算成 killed —— 否则面板会显示成「已完成」。 */
  job.finish({ status: "completed", detail: "评审完成" });
  await sleep(10);
  check("被停止过的评审即使成功返回也结算成 killed", registry.jobs.get(job.id).status === "killed", registry.jobs.get(job.id).status);
  check("killed 的明细以停止原因为准，评审结果附在后面", registry.jobs.get(job.id).detail === "用户停止（评审完成）", registry.jobs.get(job.id).detail);
}

/* ------------------------------------------------------------------ 4. 等待者拒绝不炸 */

{
  let unhandled = 0;
  const onUnhandled = () => {
    unhandled += 1;
  };
  process.on("unhandledRejection", onUnhandled);
  const registry = fakeRegistry({ waitRejects: true });
  const job = startJob(registry, { label: "评审 · 工作区改动", owner: "session-3" });
  await sleep(20);
  check("wait 拒绝时静默吞掉（没有 unhandledRejection）", unhandled === 0 && job.live === true, String(unhandled));
  job.finish({ status: "completed" });
  process.off("unhandledRejection", onUnhandled);
}

/* ------------------------------------------------------------------ 5. 文案助手 */

{
  check("oneLine 折叠换行", oneLine("a\n  b") === "a ⏎ b", oneLine("a\n  b"));
  check("oneLine 截断加省略号", oneLine("abcdef", 4) === "abc…", oneLine("abcdef", 4));
  check("oneLine(null) 是空串", oneLine(null) === "" && oneLine(undefined) === "");
  check("humanMs 秒", humanMs(8240) === "8.2s", humanMs(8240));
  check("humanMs 分钟", humanMs(62500) === "1m03s" || humanMs(62500) === "1m02s", humanMs(62500));
  check("humanMs(0) = 0.0s", humanMs(0) === "0.0s", humanMs(0));
}

/* ------------------------------------------------------------------ 6. ocr-cli 实时流泵 */

{
  /** 只实现 runCommand 用到的部分：collected 偏移式 reader + done。 */
  function spawnStreaming(chunks) {
    let stdout = "";
    let stderr = "";
    let resolveDone = null;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const finish = (outcome = { exitCode: 0, signal: null }) => resolveDone(outcome);
    const timer = setInterval(() => {
      if (chunks.length === 0) return;
      stdout += chunks.shift();
      if (chunks.length === 0) {
        clearInterval(timer);
        finish();
      }
    }, 60);
    if (chunks.length === 0) {
      clearInterval(timer);
      setTimeout(() => finish(), 20);
    }
    const reader = (get) => ({
      readFrom: (from = 0) => {
        const text = get();
        const offset = Math.max(0, Math.min(Number(from) || 0, text.length));
        return { text: text.slice(offset), nextOffset: text.length, lossy: false };
      },
    });
    return {
      handle: {
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        collected: { stdout: reader(() => stdout), stderr: reader(() => stderr) },
        done,
        terminate: () => {
          clearInterval(timer);
          resolveDone({ exitCode: null, signal: "SIGTERM" });
        },
      },
      feed: (text, stream = "stdout") => {
        if (stream === "stderr") stderr += text;
        else stdout += text;
      },
      finish: () => {
        clearInterval(timer);
        finish();
      },
    };
  }

  const runtime = spawnStreaming(["第一段", "第二段", "第三段"]);
  const seen = [];
  const ctx = { subprocess: { spawn: () => runtime.handle } };
  const running = runCommand(ctx, {
    exe: "ocr",
    argv: ["review"],
    cwd: process.cwd(),
    onChunk: (text, stream) => seen.push({ text, stream }),
    chunkIntervalMs: 100,
  });
  await sleep(70);
  runtime.feed("错误一段", "stderr");
  const result = await running;
  check("有 onChunk 时返回的仍是完整输出", result.stdout === "第一段第二段第三段", JSON.stringify(result.stdout));
  check("实时流至少分了两拍（不是全在收尾一次性倒出）", seen.length >= 2, JSON.stringify(seen));
  check(
    "实时流把增量都送出且不重复（stdout）",
    seen.filter((item) => item.stream === "stdout").map((item) => item.text).join("") === "第一段第二段第三段",
    JSON.stringify(seen),
  );
  check("stderr 也走同一条泵", seen.some((item) => item.stream === "stderr" && item.text === "错误一段"), JSON.stringify(seen));

  const runtime2 = spawnStreaming([]);
  let calls = 0;
  const result2 = await runCommand(
    { subprocess: { spawn: () => runtime2.handle } },
    { exe: "ocr", argv: ["review"], cwd: process.cwd(), onChunk: () => (calls += 1) },
  );
  check("没有输出时不回调", calls === 0 && result2.stdout === "");
}

/* ------------------------------------------------------------------ 汇总 */

console.log(results.join("\n"));
console.log(failures === 0 ? `\nOK：${results.length} 项全部通过` : `\nFAILED：${results.length} 项里 ${failures} 项失败`);
log("注：真实 ocr 进程与 GUI 面板需要 DSH 侧验证（node test/smoke.mjs / 重启后看面板）");
process.exit(failures === 0 ? 0 : 1);
