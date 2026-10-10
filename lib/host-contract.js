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
    ocr: "Alibaba OpenCodeReview CLI 1.12.12（`ocr`，需单独安装；Windows 要原生 exe）",
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
      detect: (ctx) => hasFn(ctx, "on"),
      degrade: "自动评审不触发（工具与按需评审不受影响）。",
    },
    {
      id: "events.agent/turn-stopping",
      label: "回合收尾事件（agent/turn-stopping）",
      surface: "host",
      required: false,
      detect: (ctx) => hasFn(ctx, "on"),
      degrade: "会话空闲后不会补跑自动评审。",
    },
    {
      id: "events.tools/pre-execute",
      label: "工具预执行闸门（tools/pre-execute）",
      surface: "host",
      required: false,
      detect: (ctx) => hasFn(ctx, "on"),
      degrade: "preTest 不生效：测试命令不会被拦（ocr_status 会报 mechanism: none）。",
    },
    {
      id: "events.loader/volatile-update",
      label: "配置热更新事件（loader/volatile-update）",
      surface: "host",
      required: false,
      detect: (ctx) => hasFn(ctx, "on"),
      degrade: "改设置页后要等下一次工具调用或回合收尾才生效。",
    },
    {
      id: "inject.llm",
      label: "LLM 服务（ctx.llm.stream）",
      surface: "host",
      required: false,
      detect: (ctx) => hasFn(ctx?.llm, "stream"),
      degrade: "dsh 路由回落成静态端点：要自己配 llm.baseUrl + 密钥（密钥会进 ocr 子进程）。",
    },
    {
      id: "inject.jobs",
      label: "Jobs 服务（ctx.jobs.start）",
      surface: "host",
      required: false,
      detect: (ctx) => hasFn(ctx?.jobs, "start"),
      degrade: "没有 Jobs 面板里的进度行（会话内进度行仍在）。",
    },
    {
      id: "inject.skills",
      label: "Skills 服务（ctx.skills.register）",
      surface: "host",
      required: false,
      detect: (ctx) => hasFn(ctx?.skills, "register"),
      degrade: "没有按需评审 skill（回合尾部按钮与 ocr_review 工具仍在）。",
    },
    {
      id: "inject.subagents",
      label: "子代理服务（ctx.subagents.start）",
      surface: "host",
      required: false,
      detect: (ctx) => hasFn(ctx?.subagents, "start"),
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
 * 探测当前宿主。永不抛错：任何一项判断失败都按「缺」处理并记进 errors。
 * @param {object} ctx 宿主上下文（可以是任何形状；缺什么就报什么）
 */
export function probeHost(ctx) {
  const rows = [];
  const missing = [];
  const errors = [];
  let ok = true;
  for (const capability of HOST_CONTRACT.capabilities) {
    let present = null;
    try {
      const verdict = capability.detect(ctx);
      present = verdict === null ? null : verdict === true;
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

/** 把探测结果压成一句话（给 statusText 用）。 */
export function hostSummary(host) {
  if (!host) return "未探测";
  const hostRows = (host.capabilities ?? []).filter((row) => row.surface === "host");
  const absent = hostRows.filter((row) => row.present === false);
  const head = host.ok ? "宿主能力齐备" : `宿主缺必需能力：${host.missing.join("、")}`;
  const tail = absent.length > 0 ? `；缺少 ${absent.map((row) => row.id).join("、")}（各有降级）` : "";
  return `${head}${tail}（共 ${hostRows.length} 项宿主能力，客户端槽位未探测）`;
}

/** 探针状态的可读文本（ocr_status 的备注里用得着）。 */
export function hostNotes(host) {
  const notes = [];
  if (!host) return notes;
  for (const row of host.capabilities ?? []) {
    if (row.present === false && row.surface === "host") {
      notes.push(`宿主没有「${row.label}」：${row.degrade}`);
    }
  }
  for (const line of host.errors ?? []) {
    notes.push(`宿主能力探测报错（按缺失处理）：${line}`);
  }
  return notes;
}
