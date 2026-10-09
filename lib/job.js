/**
 * 评审进度（可选能力）：把一次评审登记成 DSH 的 background job。
 *
 * 为什么要登记 job（而不是自己画进度条）：
 * - DSH 的 jobs 服务是「一次长任务」的唯一真相：GUI 的 Jobs 面板直接渲染
 *   `JobView.progress`（运行中的一行实时进度）与 job 的输出环（可展开的实时流），
 *   不需要插件自己写 UI；插件侧的进度行也从同一份快照派生，两处显示天然一致。
 * - 登记是**可选**的：宿主没装 job controller（`ctx.jobs.start` 抛
 *   "background jobs unavailable: …"）时这里退化成 NO_JOB，评审照常跑，只是没有进度可见。
 *
 * 契约（对照 @deepseek-ai/dsh-jobs-local 的实现）：
 * - `start(spec)` 同步返回 job id；`spec.run(handle)` 也在 start 里**同步**调用，
 *   所以 run 里只能建 handle，真正的异步工作留在外面。
 * - `handle.updateProgress(line)` 覆盖「运行中的一行」；`handle.append(text, {channel})`
 *   追加到输出环（channel: stdout | stderr | log）。
 * - `hooks.done` 落地即 job 结算（completed/killed/failed）。
 * - `hooks.cancel(reason)` 由 `jobs.kill()` 触发：我们要把它转成评审自己的 abort。
 * - **结算前必须有等待者**：`settled` 事件带 `awaited: waitResolvers.length > 0`，
 *   而 dsh-tool-jobs 只对「非 awaited、非 teardown、有 owner」的结算发唤醒消息
 *   （`dsh-tool-jobs/lib/index.js:269`）。评审自己就是那个等待者，因此这里在 start
 *   之后立刻挂一个 `jobs.wait(id, …)`——不这么做，每次评审结束都会往会话里灌一条
 *   「后台任务完成」的噪音消息。
 */

/** 评审 job 的 kind（Jobs 面板会原样显示这个徽章，见 dsh-client-ui-jobs 的行渲染）。 */
export const REVIEW_JOB_KIND = "ocr-review";

/** 结算兜底：kill 后工作若迟迟不落地，也要让 job 终结，避免行永远停在「停止中」。 */
const CANCEL_GRACE_MS = 20000;

/** 注册等待者时多给的时间（评审自己的超时会先到）。 */
const WATCH_EXTRA_MS = 60000;

/** 面板副行只有一行，超长的进度文案自己先收一下。 */
const PROGRESS_MAX = 160;

/** 本机时间戳，用于输出环里的叙事行。 */
function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/** 把任意值收成一行短文本。 */
export function oneLine(value, max = PROGRESS_MAX) {
  const text = String(value === undefined || value === null ? "" : value)
    .replace(/\s*\r?\n\s*/g, " ⏎ ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 毫秒 → 人读时长（面板/文案用）。 */
export function humanMs(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  if (total < 60) return `${total.toFixed(total < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(total / 60);
  const seconds = Math.round(total % 60);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/** jobs 服务可用吗（可选的宿主服务，缺了就退化成无进度）。 */
export function hasJobs(registry) {
  return Boolean(registry && typeof registry.start === "function");
}

/**
 * 退化形态：没有 jobs 服务、或 `start` 被拒（并发上限/没有 controller）时用。
 * 所有方法都是空操作，调用方不必分支。
 */
export function noJob(why = "") {
  return {
    live: false,
    id: "",
    kind: REVIEW_JOB_KIND,
    why: String(why || ""),
    progress() {},
    log() {},
    out() {},
    phase() {},
    finish() {},
    cancelled: () => false,
  };
}

/**
 * 登记一次评审的 job。
 *
 * @param registry jobs 服务（`ctx.jobs`）。
 * @param options.kind JobKind（默认 `ocr-review`）。
 * @param options.label 面板主行文案（短：作用域 + 仓库名）。
 * @param options.owner 会话 id（`exec.agent.id`）；Jobs 面板按它过滤。
 * @param options.timeoutMs 评审自己的超时，用来给等待者定 deadline。
 * @param options.onCancel `jobs.kill()` 时调用的回调（用它 abort 评审）。
 * @returns 报告器（`noJob()` 形态时全是空操作）。
 */
export function startJob(registry, options = {}) {
  const kind = String(options.kind || REVIEW_JOB_KIND);
  const label = oneLine(options.label || "代码评审", 120);
  const owner = options.owner || undefined;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 0;
  const onCancel = typeof options.onCancel === "function" ? options.onCancel : null;

  if (!hasJobs(registry)) return noJob("宿主没有 jobs 服务");

  let handle = null;
  let settleJob = null;
  let settled = false;
  let cancelReason = "";
  let graceTimer = null;
  const startedAt = Date.now();
  const done = new Promise((resolve) => {
    settleJob = resolve;
  });

  const settle = (outcome) => {
    if (settled) return;
    settled = true;
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    try {
      settleJob(outcome);
    } catch {
      /* 结算失败不影响评审本身 */
    }
  };

  let id = "";
  try {
    id = registry.start({
      kind,
      label,
      ...(owner ? { owner } : {}),
      run: (job) => {
        handle = job;
        return {
          done,
          cancel: (reason) => {
            cancelReason = oneLine(reason || "已停止", 120);
            try {
              if (onCancel) onCancel(cancelReason);
            } catch {
              /* abort 回调抛错不该影响 job 结算 */
            }
            if (graceTimer) clearTimeout(graceTimer);
            graceTimer = setTimeout(() => settle({ status: "killed", detail: cancelReason }), CANCEL_GRACE_MS);
            if (typeof graceTimer.unref === "function") graceTimer.unref();
          },
        };
      },
    });
  } catch (err) {
    return noJob(err && err.message ? err.message : "jobs.start 被拒绝");
  }

  /* 挂一个等待者：结算事件才会带 awaited:true，dsh-tool-jobs 才不会为这次评审
     发一条「后台任务完成」的唤醒消息（评审结果由工具返回值/自动评审正文自己交代）。 */
  if (typeof registry.wait === "function") {
    try {
      const watchingMs = (timeoutMs > 0 ? timeoutMs : 30 * 60 * 1000) + WATCH_EXTRA_MS;
      const watching = registry.wait(id, watchingMs, owner);
      if (watching && typeof watching.catch === "function") watching.catch(() => {});
    } catch {
      /* 等待者只是降噪手段，失败不影响评审 */
    }
  }

  const safe = (fn) => {
    if (!handle) return;
    try {
      fn();
    } catch {
      /* 进度是旁路：任何一次写入失败都不该打断评审 */
    }
  };

  const reporter = {
    live: true,
    id,
    kind,
    label,
    why: "",
    get elapsedMs() {
      return Date.now() - startedAt;
    },
    /** 面板副行：运行中的一行实时进度。 */
    progress(line) {
      safe(() => handle.updateProgress(oneLine(line)));
    },
    /** 输出环：一条带时间戳的叙事行。 */
    log(line) {
      safe(() => handle.append(`[${stamp()}] ${oneLine(line, 400)}\n`, { channel: "log" }));
    },
    /** 输出环：原样追加子进程输出（实时流）。 */
    out(text, channel = "stdout") {
      const chunk = String(text === undefined || text === null ? "" : text);
      if (chunk === "") return;
      safe(() => handle.append(chunk, { channel: channel === "stderr" ? "stderr" : "stdout" }));
    },
    /** 进度 + 叙事一起写（最常用）。 */
    phase(line) {
      reporter.progress(line);
      reporter.log(line);
    },
    /** 评审落地：结算 job。outcome: { status, detail }。 */
    finish(outcome = {}) {
      const wanted = cancelReason ? "killed" : ["completed", "failed", "killed"].includes(outcome.status) ? outcome.status : "completed";
      /* 被停止过就以停止原因为准（面板副行显示的是终态原因），评审自己的结果附在后面。 */
      const own = oneLine(outcome.detail || "", 160);
      const detail = oneLine(cancelReason ? (own ? `${cancelReason}（${own}）` : cancelReason) : own, 200);
      settle({ status: wanted, ...(detail ? { detail } : {}) });
      reporter.live = false;
    },
    /** 这次评审是否被用户/模型停过。 */
    cancelled: () => cancelReason !== "",
  };

  return reporter;
}
