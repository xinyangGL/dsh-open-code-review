/**
 * 宿主契约清单 + 启动探针（v0.7.0）。
 *
 * 为什么要有这个文件：0.5.7~0.5.9 那次事故的根因是「我们对宿主语义的理解是错的」
 * （guard 放行返回 "" 被宿主当成拒绝理由），而当时**没有任何地方能看出我们挂了哪些面**。
 * 这个清单把「插件依赖宿主的哪些能力、缺了会退化成什么样」写成数据：
 *  - 每一个扩展点（工具/命令/服务注入/事件/客户端槽位）都在 capabilities 里有一条；
 *  - ocr_status 的 host 字段直接回放探测结果，用户和作者都能一眼看出宿主少了什么；
 *  - test/host-contract.mjs 逐条「缺一」验证降级，并做源码级扫描：lib/index.js 里出现的
 *    每个注册点 id 都必须在这个清单里（新增扩展点不登记 = 测试红）。
 *
 * 探针本身是纯只读的鸭子类型检查（typeof xxx === "function"），永不抛错：
 * 任何一项判断抛错都按「缺这个能力」处理，而不是把插件带崩。
 */

import { hookStatsFor } from "./hooks.js";

/** 本插件对客户端（浏览器界面）的依赖：宿主侧探测不到，只能由人在界面里确认。 */
const CLIENT_SURFACES = [
  "设置页表单（settings.section）",
  "插件卡片（plugins.bundle.config）",
  "回合尾部按钮（conversation.chat.turnTail）",
  "输入框停靠进度（conversation.input.dock）",
];

const hasFn = (target, key) => {
  try {
    return typeof target?.[key] === "function";
  } catch {
    return false;
  }
};

/**
 * 读一个服务实例，不需要 inject 声明（v0.7.1）。
 *
 * 为什么不能直接写 `ctx.llm`：cordis 的 ctx 是 Proxy，只对「本 fiber 声明过 inject
 * 或就在父链 store 上」的名字返回服务，其余一律抛
 * `cannot get property "llm" without inject`。v0.7.0 的探针就是直接 `ctx?.llm`，
 * 于是把宿主的 llm / jobs / skills / subagents 全报成「宿主没有」——假阴性比不报更坏：
 * 用户会照着备注去配 llm.baseUrl + 明文密钥，而真正该用的本机桥其实好好的。
 *
 * 宿主给的正当读法是 `ctx.reflect.get(name, false)`（cordis 里那句注释就是
 * "Read a service from the store without the inject requirement."），
 * 依次退让到 root 的 reflect、ctx.get(name)、最后才是直接取属性；每一步都包 try/catch，
 * 因为「探针自己不能成为崩溃点」。（`ctx.subagents` 等直接属性访问在 cordis 上抛错，
 * 所以这条退让只对非 Proxy 的桩 ctx 有用。）
 */
const readService = (ctx, name) => {
  const attempts = [
    () => ctx?.reflect?.get?.(name, false),
    () => ctx?.root?.reflect?.get?.(name, false),
    () => (typeof ctx?.get === "function" ? ctx.get(name) : undefined),
  ];
  for (const attempt of attempts) {
    try {
      const value = attempt();
      /* 真值判定是**故意的**：读不到服务时 `reflect.get(name, false)` 返回 undefined
         （也可能是 null），而服务实例恒为对象 —— 只有用真值判定才能让「这一步没读到」继续退让。
         改成显式判空反而会在第一种读法失败时就停下，把正当读法挡在外面
         （v0.7.3 真机评审第 5 条发现：**不采纳**，理由即此）。 */
      if (value) return value;
    } catch {
      /* 换下一种读法 */
    }
  }
  try {
    return ctx?.[name];
  } catch {
    return undefined;
  }
};

/**
 * 宿主契约清单。
 * surface = host（宿主侧可探测）/ client（只能由人在界面上确认）
 * required = true 表示缺了插件核心就不可用（ocr_status 的 host.ok 会变 false）
 */
export const HOST_CONTRACT = {
  /* 这个清单对应的实测环境。不写死版本号范围：插件不做版本门（新宿主可能多能力少事件），
     而是靠 probeHost 把「实际探测到什么」报出来。package.json 的 dsh.host 是本清单的声明式副本。 */
  verifiedWith: {
    host: "DSH 0.2.0-rc.2 桌面版（2026-10-10 实测：本机桥 + tools/pre-execute + jobs + skills + subagents 均在）",
    node: ">= 20（CI 跑 20/22/24；本机实测 24.19.0）",
    ocr: "Alibaba OpenCodeReview CLI 1.12.12 / 1.12.13（`ocr`，需单独安装；Windows 要原生 exe）",
  },
  capabilities: [
    {
      id: "tools.register",
      label: "工具注册（ctx.tools.register）",
      surface: "host",
      required: true,
      detect: (ctx) => hasFn(ctx?.tools, "register"),
      degrade: "ocr_review / ocr_status 都不会出现在工具列表里 —— 插件等于没装。",
    },
    {
      id: "subprocess.spawn",
      label: "子进程执行（ctx.subprocess.spawn）",
      surface: "host",
      required: true,
      detect: (ctx) => hasFn(ctx?.subprocess, "spawn"),
      degrade: "跑不了 ocr：评审与 ocr_status 的定位都会失败。",
    },
    {
      id: "subprocess.resolveExecutable",
      label: "可执行文件定位（ctx.subprocess.resolveExecutable）",
      surface: "host",
      required: false,
      detect: (ctx) => hasFn(ctx?.subprocess, "resolveExecutable"),
      degrade: "只能靠 config.json 里的 ocrPath 写绝对路径；PATH 上装了 ocr 也找不到。",
    },
    {
      id: "commands.register",
      label: "斜杠命令（ctx.commands.register）",
      surface: "host",
      required: false,
      detect: (ctx) => hasFn(ctx?.commands, "register"),
      degrade: "没有 /ocr-review 命令；回合尾部按钮也点不动（按钮执行的就是这条命令）。",
    },
    {
      id: "credentials.resolve",
      label: "DSH 凭据库（ctx.credentials.resolve）",
      surface: "host",
      required: false,
      detect: (ctx) => hasFn(ctx?.credentials, "resolve"),
      degrade: "endpoint 模式的密钥只能来自 config.json 的字面值或同名环境变量。",
    },
    {
      id: "events.tools/result",
      label: "工具结果事件（tools/result）",
      surface: "host",
      required: false,
      detect: (ctx, deps) => hasFn(ctx, "on") && hookArmed("tools/result", ctx, deps),
      degrade: "自动评审不触发（工具与按需评审不受影响）。",
    },
    {
      id: "events.agent/turn-stopping",
      label: "回合收尾事件（agent/turn-stopping）",
      surface: "host",
      required: false,
      detect: (ctx, deps) => hasFn(ctx, "on") && hookArmed("agent/turn-stopping", ctx, deps),
      degrade: "会话空闲后不会补跑自动评审。",
    },
    {
      id: "events.tools/pre-execute",
      label: "工具预执行闸门（tools/pre-execute）",
      surface: "host",
      required: false,
      detect: (ctx, deps) => hasFn(ctx, "on") && hookArmed("tools/pre-execute", ctx, deps),
      degrade: "preTest 不生效：测试命令不会被拦（ocr_status 会报 mechanism: none）。",
    },
    {
      id: "events.loader/volatile-update",
      label: "配置热更新事件（loader/volatile-update）",
      surface: "host",
      required: false,
      detect: (ctx, deps) => hasFn(ctx, "on") && hookArmed("loader/volatile-update", ctx, deps),
      degrade: "改设置页后要等下一次工具调用或回合收尾才生效。",
    },
    {
      id: "inject.llm",
      label: "LLM 服务（ctx.llm.stream）",
      surface: "host",
      required: false,
      detect: (ctx) => hasFn(readService(ctx, "llm"), "stream"),
      degrade: "dsh 路由回落成静态端点：要自己配 llm.baseUrl + 密钥（密钥会进 ocr 子进程）。",
    },
    {
      id: "inject.jobs",
      label: "Jobs 服务（ctx.jobs.start）",
      surface: "host",
      required: false,
      detect: (ctx) => hasFn(readService(ctx, "jobs"), "start"),
      degrade: "没有 Jobs 面板里的进度行（会话内进度行仍在）。",
    },
    {
      id: "inject.skills",
      label: "Skills 服务（ctx.skills.register）",
      surface: "host",
      required: false,
      detect: (ctx) => hasFn(readService(ctx, "skills"), "register"),
      degrade: "没有按需评审 skill（回合尾部按钮与 ocr_review 工具仍在）。",
    },
    {
      id: "inject.subagents",
      label: "子代理服务（ctx.subagents.start）",
      surface: "host",
      required: false,
      detect: (ctx) => hasFn(readService(ctx, "subagents"), "start"),
      degrade: "「独立评审 agent」档不可用，评审回落 ocr / delegate。",
    },
    {
      id: "client.slots",
      label: `界面槽位（${CLIENT_SURFACES.join("、")}）`,
      surface: "client",
      required: false,
      detect: () => null,
      degrade: "宿主侧探测不到：如果浏览器里看不到设置页/按钮，先刷新页面，再看 ocr_status 的 client 段。",
    },
  ],
};

/**
 * 事件类能力的判据：宿主有 `ctx.on` 只是必要条件 —— 真正要回答的是
 * 「这个事件真的接到插件上了吗」。宿主没有可查询的事件目录（运行时拿不到派发清单），
 * 所以用插件**自己的挂载账目**作证：注册成功过 = 这条链路真的接上了。
 * 没登记过就按「缺」报（例如紧急制动下 apply 直接 return，一个钩子都没挂），
 * 这也正是 v0.7.1 修的第二个假阳性：四条 events.* 原来都只查 `ctx.on`，
 * 于是哪怕一个钩子都没挂上，也照样报 present=true，和 degrade 里写的「不触发」自相矛盾。
 *
 * 账目按 `ctx` 取（`hookStatsFor(ctx)`，不是全局 `hookStats()`）：账目本身是模块级单例，
 * 只代表「这份插件实例挂了什么」，用它回答别的 ctx 就是越界（v0.7.1 自审的第 1 条）。
 * 测试可以走 `deps.hooks` 注入一份固定账目。
 */
const hookArmed = (event, ctx, deps) => {
  const stats = deps?.hooks ?? hookStatsFor(ctx);
  const counts = stats?.counts ?? {};
  return Number(counts[event] ?? 0) > 0;
};

/**
 * 探测当前宿主。永不抛错：任何一项判断失败都按「缺」处理并记进 errors。
 * @param {object} ctx 宿主上下文（可以是任何形状；缺什么就报什么）
 * @param {{hooks?: object}} [deps] 可注入的挂载账目（测试用；不传就读 lib/hooks.js 的实时账目）
 */
export function probeHost(ctx, deps = {}) {
  const rows = [];
  const missing = [];
  const errors = [];
  let ok = true;
  for (const capability of HOST_CONTRACT.capabilities) {
    let present = null;
    try {
      const verdict = capability.detect(ctx, deps);
      /* 三态：null/undefined = 宿主侧不可判定；其余一律布尔化（将来某个 detect 返回
         服务实例之类的真值，也不许被误判成「宿主没有」）。 */
      present = verdict === null || verdict === undefined ? null : Boolean(verdict);
    } catch (err) {
      present = false;
      errors.push(`${capability.id}: ${err?.message ?? String(err)}`);
    }
    if (capability.required && present !== true) {
      ok = false;
      missing.push(capability.id);
    }
    rows.push({
      id: capability.id,
      label: capability.label,
      surface: capability.surface,
      required: capability.required === true,
      present,
      degrade: capability.degrade,
    });
  }
  return { ok, missing, capabilities: rows, errors };
}

/**
 * 行的可读名字：`priority` 决定 label / id 谁优先，缺一个退回另一个，都没有才用占位
 * （行被写坏也不能渲染出字面量 `undefined`）。
 * v0.7.3 真机评审第 6 条发现：原来这是两段只差优先级、占位符字面量还重复的实现，
 * 合成一个带 priority 的小工具，免得两处兜底规则将来漂移。
 */
const rowName = (row, priority = "label") => {
  const pick = (value) => (typeof value === "string" && value.length > 0 ? value : "");
  const first = priority === "id" ? row?.id : row?.label;
  const second = priority === "id" ? row?.label : row?.id;
  return pick(first) || pick(second) || "（未命名能力）";
};

/** 把探测结果压成一句话（给 statusText 用）。入参可能是任何形状（甚至只有 `{ok:false}`），不许抛。 */
export function hostSummary(host) {
  if (!host) return "未探测";
  const hostRows = (Array.isArray(host.capabilities) ? host.capabilities : []).filter(
    (row) => row?.surface === "host",
  );
  const absent = hostRows.filter((row) => row.present === false);
  /* v0.7.3 第 7 条发现：手上有行数据时就以**行数据**为准 —— 只信入参字段的话，
     手工拼装/写坏的对象会输出自相矛盾的句子（`{ok:true, capabilities:[{required:true,present:false}]}`
     → 「宿主必需能力齐备；缺少 xxx」）。没有行数据时才回落到字段。 */
  const requiredAbsent = hostRows.filter((row) => row.required === true && row.present !== true);
  const ok = hostRows.length > 0 ? requiredAbsent.length === 0 : host.ok === true;
  const missing =
    Array.isArray(host.missing) && host.missing.length > 0
      ? host.missing
      : requiredAbsent.map((row) => rowName(row, "id"));
  /* ok 为真只代表**必需**能力齐备（缺可选能力时 ok 仍是 true），所以文案不能写「齐备」了事，
     否则同一句话里「齐备」和后面「缺少 llm、jobs」自相矛盾（v0.7.1 自审的第 2 条）。 */
  const head = ok
    ? "宿主必需能力齐备"
    : `宿主缺必需能力：${missing.length > 0 ? missing.join("、") : "（未列出）"}`;
  const tail = absent.length > 0 ? `；缺少 ${absent.map((row) => rowName(row, "id")).join("、")}（各有降级）` : "";
  return `${head}${tail}（共 ${hostRows.length} 项宿主能力，客户端槽位未探测）`;
}

/** 探针状态的可读文本（ocr_status 的备注里用得着）。同样按「入参可能是任何形状」写。 */
export function hostNotes(host) {
  const notes = [];
  if (!host) return notes;
  for (const row of Array.isArray(host.capabilities) ? host.capabilities : []) {
    if (row?.present === false && row?.surface === "host") {
      /* 兜底本身也要能读：行缺 label/degrade 时输出「undefined」比不输出更糟（第 3 条发现）。 */
      const degrade =
        typeof row.degrade === "string" && row.degrade.length > 0
          ? row.degrade
          : "（这条能力的降级说明缺失 —— 清单被写坏了，请重装插件）";
      notes.push(`宿主没有「${rowName(row)}」：${degrade}`);
    }
  }
  for (const line of Array.isArray(host.errors) ? host.errors : []) {
    notes.push(`宿主能力探测报错（按缺失处理）：${line}`);
  }
  return notes;
}
