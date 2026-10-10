/**
 * dsh-open-code-review 的浏览器半侧（client half）。
 *
 * 为什么需要它：DSH 的「设置 → 插件」页面只渲染插件**自己**在浏览器侧注册的东西
 * （见 @deepseek-ai/dsh-client-ui-plugin-manager 的 config-ledger：bundles 来自
 * `plugins.bundle.config` 的注册账本，rows 来自 `plugins.row.config`）。宿主侧的
 * schemastery 配置 schema 只提供数据面，不会自动生成页面，所以插件必须在这里注册
 * 一个 cell，key 用 **npm 包名**（`dsh-open-code-review`），页面就会在
 * bundle 详情页的「描述」和「行列表」之间渲染本组件。
 *
 * 另外，为了不必记住「设置 → 插件 → 本插件卡片」这条路径，这里还往
 * `settings.section` 注册了一个设置页（左侧设置导航里显示为「代码评审」），
 * 渲染同一个表单组件（standalone 模式多一段标题）。
 *
 * 表单来源：宿主把 volatile 配置节点投影成 profile 条目的设置表单，浏览器侧由
 * `@deepseek-ai/dsh-client-ui-settings` 的 `configForms` 服务统一管理。这里用
 * `ctx.configForms.get(entryId)` 拿到通用的 ConfigForm（含 getSnapshot/subscribe/
 * set/unset），读写都走 Host 文档，改完立即生效（volatile 广播），无需重启。
 *
 * 模块格式：`window.__ModuleLoader__.load({ id, factory })`，factory 返回一个
 * cordis 客户端插件（`{ inject, apply }`）。整个文件是经典脚本，不要用 import。
 */
window.__ModuleLoader__.load({
  id: "dsh-open-code-review",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    /** 本 bundle 的 npm 包名 —— 也就是 plugins.bundle.config 的 key。 */
    const BUNDLE = "dsh-open-code-review";
    /**
     * 宿主配置条目的 id（通常形如 `include:<patchId>`）。客户端的设置镜像理论上用同一个键，
     * 但为了让页面在键不同的版本上也能用，这里按顺序回退尝试，取第一个可用的。
     */
    const ENTRY_ID = "include:dsh-open-code-review";
    const ENTRY_IDS = [ENTRY_ID, "dsh-open-code-review"];

    const CHOICE = {
      engine: [
        ["delegate", "delegate — 不调 LLM，几秒出规则 + 文件 + diff 规格（v0.8.0 起默认）"],
        ["ocr", "ocr — 只用 OCR 自己的 LLM 流水线（每文件 3~6 分钟、按 tokens 计费）"],
        ["auto", "auto — 先跑 OCR 流水线，没配 LLM 时降级 delegate"],
      ],
      audience: [
        ["agent", "摘要 — 只回结论与问题清单（默认，省 token）"],
        ["human", "详细 — 连评审过程一起回（更啰嗦，便于排查）"],
      ],
      autoMinIntervalMs: [
        ["30000", "30 秒"],
        ["60000", "1 分钟（默认）"],
        ["300000", "5 分钟"],
        ["600000", "10 分钟"],
      ],
      autoReview: [
        ["adaptive", "adaptive — 模型在跑就注入，空闲就开新回合"],
        ["inject", "inject — 只把结果注入当前上下文"],
        ["followup", "followup — 直接开一个新回合"],
        ["off", "off — 不做自动评审（v0.5.0 起默认，改成按需）"],
      ],
      autoScope: [
        ["workspace", "workspace — 未提交的工作区改动"],
        ["range", "range — 分支/提交区间"],
        ["commit", "commit — 单个提交"],
        ["scan", "scan — 整文件扫描"],
      ],
      llmMode: [
        ["dsh", "dsh — 走 DSH：插件本机桥 → DSH 的模型/密钥/配额（推荐）"],
        ["endpoint", "endpoint — ocr 直连下面的静态端点（老行为）"],
      ],
      llmProtocol: [
        ["openai", "openai — OpenAI 兼容的 /chat/completions 路由"],
        ["anthropic", "anthropic — Anthropic Messages 协议"],
      ],
      reviewerAgent: [
        ["off", "off — 不启用（默认，评审走 ocr / delegate）"],
        ["spawn", "spawn — 每轮自动评审起一个只读子 agent"],
      ],
      preTest: [
        ["off", "off — 不干预测试命令（默认）"],
        ["remind", "remind — 放行测试，结果回来后提醒评审"],
        ["gate", "gate — 没评审就直接跑测试会被挡回（建议先用 remind 观察几次）"],
      ],
    };

    /**
     * 设置页字段表。顺序即渲染顺序，`group` 是分组标题；
     * number 字段的 min/max 与宿主 schema 的校验范围保持一致；
     * onlyMode 限定该行只在某种 llm.mode 下渲染（dsh 不需要地址与密钥）。
     * group=basic 的行是「要做的决定」，其余收进「高级设置」折叠区（默认收起）。
     * number 字段带 options 时渲染成「常用档位 + 自定义」组合控件，存储仍是数字。
     */
    const FIELDS = [
      { key: "enabled", label: "总开关", kind: "boolean", group: "basic", default: true, hint: "关闭后停掉自动评审，且 ocr_review 与 /ocr-review 会拒绝执行（ocr_status 仍可用于诊断）。" },
      { key: "engine", label: "默认引擎", kind: "select", group: "basic", options: CHOICE.engine, hint: "模型显式传 engine 时以调用参数为准。三档怎么选见 README「引擎三档选择」。" },
      { key: "autoReview", label: "自动评审", kind: "select", group: "basic", options: CHOICE.autoReview, hint: "触发条件：回合结束 + 本回合有文件写入。出厂默认 off（改成按需评审，见下一行）；冷却与上限在「高级设置」里。" },
      { key: "onDemand", label: "按需评审", kind: "boolean", group: "basic", default: true, hint: "默认开：每条已完成回合的尾部有「启动代码审核」按钮，并注册按需 skill —— 你说「验证 / 评审」时模型才跑 ocr_review。关掉后只剩模型工具与 /ocr-review 命令。" },
      { key: "reviewerAgent", label: "独立评审 agent", kind: "select", group: "basic", options: CHOICE.reviewerAgent, hint: "off：评审走 ocr / delegate（默认）。spawn：每轮起一个只读子 agent（自己的上下文与模型，工具只有 read / grep / glob），findings 回传给编码 agent 逐条修，改完自动开下一轮 —— 直到干净或到轮次上限。细节见 README「独立评审 agent」。" },
      { key: "reviewerProvider", label: "子 agent provider", kind: "text", group: "basic", onlyReviewer: "spawn", placeholder: "spawn", hint: "映射到 reviewer.provider。默认 spawn（DSH 的子代理插件）；填错会报 OCR_REVIEWER_UNAVAILABLE，错误里会列出可用名字。" },
      { key: "reviewerModel", label: "子 agent 模型", kind: "model", group: "basic", onlyReviewer: "spawn", providerKey: "reviewerProvider", placeholder: "留空=跟随该 provider 的默认模型", hint: "映射到 reviewer.model（同样是 DSH 模型目录里的 id）。评审子会话用它自己的模型，与编码 agent 解耦；从候选里选中会把提供方写进上一行。" },
      { key: "reviewerRounds", label: "往返轮次上限", kind: "number", group: "basic", onlyReviewer: "spawn", min: 1, max: 10, hint: "同一份改动最多往返几轮（默认 3，最多 10）：到上限后停止自动复审并列出仍未确认的条目。" },
      { key: "llmMode", label: "LLM 路由", kind: "select", group: "basic", options: CHOICE.llmMode, hint: "dsh（推荐）：ocr 是独立子进程、进不了 cordis，所以插件在 127.0.0.1 起一个只认随机 token 的 OpenAI 兼容小桥，把请求转给 DSH 的 ctx.llm.stream —— 模型、provider、密钥、账号轮换与配额全由 DSH 决定，下面不用填地址与 key。endpoint：ocr 直连静态端点（老行为）。" },
      { key: "llmModel", label: "模型名", kind: "model", group: "basic", providerKey: "llmProvider", placeholder: "deepseek/deepseek-v4.1-flash", hint: "映射到 OCR_LLM_MODEL；留空 = 跟随 DSH 的默认模型（dsh 模式）。候选来自 DSH 自己的模型目录，可搜索、可手输，从候选里选中会一并写入提供方 —— 配错会报 Model not supported。" },
      { key: "llmBaseUrl", label: "端点 Base URL", kind: "text", group: "basic", onlyMode: "endpoint", placeholder: "https://api.commandcode.ai/provider/v1", hint: "endpoint 模式才用：映射到 OCR_LLM_URL。" },
      { key: "llmProtocol", label: "端点协议", kind: "select", group: "basic", onlyMode: "endpoint", options: CHOICE.llmProtocol, hint: "endpoint 模式才用：映射到 OCR_LLM_PROTOCOL。CommandCode 的 DeepSeek v4.1 只支持 openai。" },
      { key: "llmApiKeyRef", label: "API Key 引用", kind: "text", group: "basic", onlyMode: "endpoint", placeholder: "COMMANDCODE_API_KEY", hint: "endpoint 模式才用：DSH 凭据库里的引用名（映射到 OCR_LLM_TOKEN），不落明文密钥；明文密钥仍可放 config.json 的 llm.apiKey。" },

      { key: "autoScope", label: "自动评审范围", kind: "select", group: "tuning", options: CHOICE.autoScope, hint: "与 ocr_review 的 scope 参数同义。" },
      { key: "autoMaxPerSession", label: "每会话上限", kind: "number", group: "tuning", min: 0, max: 50, hint: "每个会话最多自动评审几次（防改—评—改死循环）；0 = 本会话不自动评审（手动仍可用）。" },
      { key: "autoMinReviewableFiles", label: "最少可审文件数", kind: "number", group: "tuning", min: 1, max: 50, hint: "可审文件少于该值时跳过自动评审。" },
      { key: "autoMinIntervalMs", label: "最小间隔", kind: "number", group: "tuning", min: 0, max: 3600000, options: CHOICE.autoMinIntervalMs, hint: "两次自动评审之间的冷却时间。下拉是常用档位；选「自定义…」可手填毫秒（默认 60000）。" },
      { key: "autoSkipSubagents", label: "跳过子代理会话", kind: "boolean", group: "tuning", default: true, hint: "子代理（delegationDepth > 0）的回合结束不触发自动评审。" },
      { key: "autoIncludeDiff", label: "委派时带 diff", kind: "boolean", group: "tuning", default: true, hint: "自动评审降级到 delegate 时，是否把 unified diff 一并放进规格。" },
      { key: "preTest", label: "评审先于测试", kind: "select", group: "tuning", options: CHOICE.preTest, hint: "跑单元测试/构建之前先评审这批改动。off = 不管（默认）；remind = 放行测试，结果回来后提醒模型；gate = 没被一次成功的 ocr_review 覆盖就直接跑测试会被挡回。建议先用 remind 跑一两次，确认提醒真能落到模型身上、评审确实会跑，再开 gate —— gate 是真的会打断测试流程。写文件会作废覆盖状态。" },

      { key: "audience", label: "结果详细程度", kind: "select", group: "runtime", options: CHOICE.audience, hint: "映射到 ocr --audience。" },
      { key: "ocrPath", label: "ocr 可执行文件", kind: "text", group: "runtime", placeholder: "留空=自动探测（Volta 真实 exe 优先）", hint: "绝对路径。留空则按 PATH、Volta、全局 npm 目录依次探测。" },
      { key: "timeoutMinutes", label: "单次超时（分钟）", kind: "number", group: "runtime", min: 1, max: 60, hint: "传给 ocr --timeout，同时作为插件侧硬超时；这张表的上限固定为出厂值，要更大的值请直接写 config.json。" },
      { key: "progress", label: "评审进度", kind: "boolean", group: "runtime", default: true, hint: "把每次评审登记成后台任务：Jobs 面板（会话标题栏）里能看到实时进度行与可展开的 ocr 输出，输入框上方也有一条进度行（可停止）。关掉后评审照跑，只是不可见。" },
      { key: "llmProvider", label: "提供方（provider）", kind: "text", group: "runtime", onlyMode: "dsh", placeholder: "commandcode", hint: "dsh 模式转发给 DSH 用的 provider id（DSH 模型目录里的组 id）；留空 = 跟随 DSH 默认模型的 provider。在「模型名」里选中候选时自动写入。" },
      { key: "verbose", label: "调试日志", kind: "boolean", group: "runtime", default: false, hint: "在 DSH 日志里打印 ocr 命令行、env 与耗时。" },
    ];

    /**
     * 设置页分组：basic 是「要做的决定」（默认展开），advanced 的组收进下方
     * 「高级设置」折叠区（默认收起，点标题才展开）——参数项不占主页面。
     */
    const GROUPS = [
      { id: "basic", name: "基础" },
      { id: "tuning", name: "调优", advanced: true },
      { id: "runtime", name: "运行与诊断", advanced: true },
    ];

    /** 折叠区里所有字段都按这个顺序渲染（调优在前，运行与诊断在后）。 */
    const ADVANCED_GROUPS = GROUPS.filter((group) => group.advanced);
    const BASIC_GROUPS = GROUPS.filter((group) => !group.advanced);

    /* ------------------------------------------------------------ 文案（Client locale 服务） */

    /**
     * 文案命名空间。可见文案统一走 dsh-client-locale 的 locale 服务：有服务时用它的
     * zh/en 词典（切语言时组件会重渲染），没有服务时退回 TEXT_ZH 里的中文原文。
     * 字段标签、说明、占位符与下拉选项的 zh 由 FIELDS/CHOICE 现场生成，不两处维护。
     */
    const LOCALE_NS = "dsh-open-code-review";

    /** 非字段类文案的 zh 原文（键与 TEXT_EN 一一对应）。带 {name} 的是模板，用 fmt() 填。 */
    const TEXT_ZH = {
      "section.navTitle": "代码评审",
      "page.title": "代码评审（阿里 OpenCodeReview）",
      "page.lead": "dsh-open-code-review 的设置页。要做的决定都在「基础」里；低频参数收进下面的「高级设置」（点一下展开）。同一个表单也渲染在「设置 → 插件 → dsh-open-code-review」卡片上。",
      "page.footer": "改动立即生效，并保存在当前 profile 的配置里（换 profile 或换机器不跟随，重新设一次即可）。插件目录的 config.json 只是文件层，能写设置页没有的键（extraArgs / env / llm.apiKey / maxTimeoutMinutes）；从 GitHub（git 安装）装的插件目录在 node_modules 里、升级会被覆盖，请改用 <DSH_HOME>/dsh-open-code-review.json。跑一次 ocr_status 能看到每个键的实际来源。",
      "page.sourceHint": "带「{badge}」标记的行是被设置页改过的；没有标记的行用的是出厂默认或文件层的值。",
      "advanced.title": "高级设置（{count} 项）",
      "advanced.collapsedHint": "调优与运行/诊断参数已收起。默认值对多数人够用；要改就点上面的标题展开。",
      "advanced.dirty": "{count} 项待保存",
      "advanced.dirtyTitle": "折叠的高级项里有还没保存的改动",
      "preset.unset": "默认（跟随出厂值）",
      "preset.custom": "自定义…",
      "card.lead": "只读摘要。完整设置：设置 → 代码评审。",
      "card.more": "在上面点「代码评审」可以改这些值（含高级项）。",
      "card.on": "开",
      "card.off": "关",
      "card.unset": "跟随默认",
      "button.save": "保存",
      "button.saving": "保存中…",
      "button.undo": "撤销",
      "button.reset": "恢复默认",
      "button.saveChanges": "保存改动",
      "button.saveAllChanges": "保存全部改动（{count}）",
      "button.resetAll": "全部恢复默认",
      "row.changed": "设置页已改",
      "row.overridden": "这一项被设置页改过（保存在当前 profile 里）；「恢复默认」会清掉这层改动",
      "form.noForm": "没有可用的配置表单，无法写入",
      "form.saved": "{label} 已保存",
      "form.reset": "{label} 已恢复默认",
      "form.rejected": "{label} 未写入：宿主拒绝了这次修改（或当前模式只读）",
      "form.writeFailed": "{label} 写入失败：{error}",
      "catalog.noRemote": "读不到 ctx.remote：宿主没把 Remote 桥提供给插件（或插件不在能读 remote 的上下文里）",
      "catalog.noMethod": "这个 DSH 版本没有把 ctx.remote.session.modelCatalog() 暴露给浏览器",
      "catalog.callFailed": "Remote 调用失败：{detail}",
      "picker.loading": "正在读取 DSH 模型目录…（也可以直接手输）",
      "picker.unsupported": "没有候选列表：{error}。直接手输模型名即可。",
      "picker.error": "读取 DSH 模型目录失败：{error}。直接手输模型名即可。",
      "picker.empty": "DSH 模型目录里没有可用模型，直接手输模型名即可。",
      "picker.current": "当前：{name}{group}。",
      "picker.failures": "；{count} 个提供方没读出来",
      "picker.candidates": "{head}候选来自 DSH 自己的模型目录：{count} 个模型{extra}。可搜索、可手输；从候选里选中会把提供方一起写上。",
      "picker.dshDefault": "DSH 默认模型：{provider} / {model}；模型名与提供方留空就跟着它走（密钥与配额也由 DSH 决定）。",
      "picker.menuHead": "DSH 模型目录 · {count} 个模型",
      "picker.noMatch": "没有匹配「{text}」的模型；按回车就把这个值写进去",
      "picker.noOptions": "目录里没有可选项，直接手输",
      "picker.more": "还有 {count} 个，继续输入可缩小范围",
      "picker.expand": "展开候选列表（DSH 模型目录）",
      "picker.collapse": "收起候选列表",
      "status.entry": "条目 {id}",
      "status.noForm": "浏览器侧没有这个条目的表单（试过 {ids}）",
      "status.state": "状态 {status}",
      "status.mode": "模式 {mode}",
      "status.writable": "可写",
      "status.readonly": "不可写",
      "status.routeDsh": "LLM 走 DSH 本机桥",
      "status.routeEndpoint": "LLM 直连静态端点",
      "status.reviewerAgent": "评审走独立 agent（只读子 agent，findings 回传编码 agent）",
      "status.loading": "正在从宿主读取…",
      "status.unavailable": "这个命名空间没有暴露给浏览器，或连接处于 process-local 内存模式",
      "progress.title": "评审进度",
      "progress.running": "运行中",
      "progress.completed": "已完成",
      "progress.failed": "失败",
      "progress.killed": "已停止",
      "progress.stopping": "停止中…",
      "progress.stop": "停止",
      "progress.stopConfirm": "再点一次停止",
      "progress.hint": "完整输出在会话标题栏的「后台任务」里（可展开、可停止）。",
      "tail.start": "启动代码审核",
      "tail.running": "正在评审…",
      "tail.hint": "对这一回合的改动按需跑一次代码评审（同一条 /ocr-review 命令；进度看标题栏的「后台任务」）。",
      "tail.callFailed": "没能启动评审：{detail}",
      "tail.unknownCommand": "宿主没有执行这条命令：/ocr-review 可能没注册，或返回了空结果。",
      "tail.failed": "评审没能启动。",
    };

    /** en 词典：字段/选项的键与 zhDictionary() 生成的一致（缺的词条会退回 zh）。 */
    const TEXT_EN = {
      "group.basic": "Basics",
      "group.tuning": "Tuning",
      "group.runtime": "Runtime & diagnostics",
      "section.navTitle": "Code review",
      "page.title": "Code review (Alibaba OpenCodeReview)",
      "page.lead": "Settings page of dsh-open-code-review. Decisions live under Basics; low-frequency parameters are folded into Advanced settings below (click to expand). The same form also renders on the Settings → Plugins → dsh-open-code-review card.",
      "page.footer": "Changes take effect immediately and are stored in the current profile (they do not follow you to another profile or machine — just set them again). The config.json in the plugin directory is only the file layer; it carries keys the settings page does not show (extraArgs / env / llm.apiKey / maxTimeoutMinutes). A plugin installed from GitHub (git install) lives inside node_modules and is overwritten on upgrade, so use <DSH_HOME>/dsh-open-code-review.json instead. Run ocr_status to see where each key actually comes from.",
      "page.sourceHint": "Rows marked “{badge}” were changed from the settings page; unmarked rows use the factory default or the file layer.",
      "advanced.title": "Advanced settings ({count})",
      "advanced.collapsedHint": "Tuning and runtime/diagnostics parameters are folded away. The defaults suit most setups; click the title above to expand.",
      "advanced.dirty": "{count} unsaved",
      "advanced.dirtyTitle": "Some folded advanced fields have unsaved changes",
      "preset.unset": "Default (factory value)",
      "preset.custom": "Custom…",
      "card.lead": "Read-only summary. Full settings: Settings → Code review.",
      "card.more": "Click “Code review” above to change these values (including the advanced ones).",
      "card.on": "on",
      "card.off": "off",
      "card.unset": "default",
      "button.save": "Save",
      "button.saving": "Saving…",
      "button.undo": "Undo",
      "button.reset": "Reset to default",
      "button.saveChanges": "Save changes",
      "button.saveAllChanges": "Save all changes ({count})",
      "button.resetAll": "Reset everything",
      "row.changed": "set here",
      "row.overridden": "Changed from the settings page (stored in the current profile); “Reset to default” clears that layer",
      "form.noForm": "No configuration form is available; cannot write",
      "form.saved": "{label} saved",
      "form.reset": "{label} reset to default",
      "form.rejected": "{label} not written: the host rejected this change (or the current mode is read-only)",
      "form.writeFailed": "{label} write failed: {error}",
      "catalog.noRemote": "ctx.remote is not readable: the host did not expose the Remote bridge to the plugin (or the plugin is not in a context that can read remote)",
      "catalog.noMethod": "This DSH version does not expose ctx.remote.session.modelCatalog() to the browser",
      "catalog.callFailed": "Remote call failed: {detail}",
      "picker.loading": "Reading the DSH model catalog… (you can also type a model name)",
      "picker.unsupported": "No candidate list: {error}. Just type the model name.",
      "picker.error": "Failed to read the DSH model catalog: {error}. Just type the model name.",
      "picker.empty": "The DSH model catalog has no usable model; just type the model name.",
      "picker.current": "Current: {name}{group}.",
      "picker.failures": "; {count} provider(s) could not be read",
      "picker.dshDefault": "DSH default model: {provider} / {model}. Leave model and provider empty to follow it (keys and quota come from DSH too).",
      "picker.candidates": "{head}Candidates come from the DSH model catalog: {count} model(s){extra}. Searchable and free-form; picking one also records its provider.",
      "picker.menuHead": "DSH model catalog · {count} model(s)",
      "picker.noMatch": "Nothing matches “{text}”; press Enter to write this value as is",
      "picker.noOptions": "Nothing to pick here; type the name",
      "picker.more": "{count} more — keep typing to narrow it down",
      "picker.expand": "Expand candidates (DSH model catalog)",
      "picker.collapse": "Collapse candidates",
      "status.entry": "entry {id}",
      "status.noForm": "no form for this entry in the browser (tried {ids})",
      "status.state": "state {status}",
      "status.mode": "mode {mode}",
      "status.writable": "writable",
      "status.readonly": "read-only",
      "status.routeDsh": "LLM through the DSH local bridge",
      "status.routeEndpoint": "LLM talks to the static endpoint",
      "status.reviewerAgent": "review runs a separate agent (read-only subagent; findings go back to the coding agent)",
      "status.loading": "reading from the host…",
      "status.unavailable": "this namespace is not exposed to the browser, or the connection runs in process-local memory mode",
      "progress.title": "Review progress",
      "progress.running": "running",
      "progress.completed": "done",
      "progress.failed": "failed",
      "progress.killed": "stopped",
      "progress.stopping": "stopping…",
      "progress.stop": "Stop",
      "progress.stopConfirm": "Click again to stop",
      "progress.hint": "The full output lives in the session header's Jobs panel (expandable, stoppable).",
      "tail.start": "Start code review",
      "tail.running": "Reviewing…",
      "tail.hint": "Run one on-demand code review for this turn (the same /ocr-review command; watch the Jobs panel in the session header).",
      "tail.callFailed": "Could not start the review: {detail}",
      "tail.unknownCommand": "The host did not run the command: /ocr-review may not be registered, or it returned nothing.",
      "tail.failed": "Could not start the review.",
      "field.enabled.label": "Enabled",
      "field.enabled.hint": "When off, auto review stops and ocr_review / /ocr-review refuse to run (ocr_status still works for diagnostics).",
      "field.engine.label": "Default engine",
      "field.engine.hint": "An engine passed explicitly by the model wins over this default. See “Choosing an engine” in the README for the three tiers.",
      "field.audience.label": "Result detail",
      "field.audience.hint": "Maps to ocr --audience.",
      "field.ocrPath.label": "ocr executable",
      "field.ocrPath.placeholder": "empty = auto-detect (real Volta exe first)",
      "field.ocrPath.hint": "Absolute path. Empty means probing PATH, Volta, then the global npm directory.",
      "field.autoReview.label": "Auto review",
      "field.autoReview.hint": "Triggers when a turn ends and that turn wrote files. The factory default is off (on-demand review replaced it, see the next row); cooldown and caps live in Advanced settings.",
      "field.onDemand.label": "On-demand review",
      "field.onDemand.hint": "On by default: every completed turn ends with a “Start code review” button, and a runtime skill tells the model to run ocr_review when you ask it to verify/review. Turning it off leaves only the model tool and the /ocr-review command.",
      "field.autoScope.label": "Auto review scope",
      "field.autoScope.hint": "Same meaning as the scope argument of ocr_review.",
      "field.autoMaxPerSession.label": "Runs per session",
      "field.autoMaxPerSession.hint": "How many auto reviews one session may run (guards against edit-review-edit loops); 0 = no auto review in this session (manual review still works).",
      "field.autoMinReviewableFiles.label": "Min reviewable files",
      "field.autoMinReviewableFiles.hint": "Skip auto review when fewer reviewable files changed.",
      "field.autoMinIntervalMs.label": "Min interval",
      "field.autoMinIntervalMs.hint": "Cooldown between two auto reviews. The dropdown offers the common presets; pick Custom… to type milliseconds (default 60000).",
      "field.autoSkipSubagents.label": "Skip subagent sessions",
      "field.autoSkipSubagents.hint": "Turns of subagents (delegationDepth > 0) do not trigger auto review.",
      "field.autoIncludeDiff.label": "Include diff when delegating",
      "field.autoIncludeDiff.hint": "Whether the unified diff is put into the review spec when auto review degrades to delegate.",
      "field.preTest.label": "Review before tests",
      "field.preTest.hint": "Review this batch of changes before running tests/builds. off = do nothing (default); remind = let the test run and remind the model after it returns; gate = a test command is refused until one successful ocr_review covers the changes. Try `remind` for a couple of turns first — make sure the reminder actually reaches the model and the review really runs — before you arm `gate`, which does interrupt the test flow. Writing a file clears the coverage.",
      "field.reviewerAgent.label": "Independent review agent",
      "field.reviewerAgent.hint": "off: review goes through ocr / delegate (default). spawn: every round starts a read-only subagent (its own context and model; only read / grep / glob), hands the findings back to the coding agent to fix one by one, and opens the next round after the next write — until clean or the round cap is reached. See “Independent review agent” in the README.",
      "field.reviewerProvider.label": "Subagent provider",
      "field.reviewerProvider.hint": "Maps to reviewer.provider. Default spawn (the DSH subagent plugin); a wrong name reports OCR_REVIEWER_UNAVAILABLE and lists the available names.",
      "field.reviewerModel.label": "Subagent model",
      "field.reviewerModel.placeholder": "empty = the provider default model",
      "field.reviewerModel.hint": "Maps to reviewer.model (an id from the DSH model catalog). The review child session uses its own model, decoupled from the coding agent; picking a candidate writes its provider into the row above.",
      "field.reviewerRounds.label": "Round cap",
      "field.reviewerRounds.hint": "How many review rounds one change may take (default 3, max 10); after the cap the plugin stops auto review and lists what is still unconfirmed.",
      "choice.reviewerAgent.off": "off — disabled (default: review goes through ocr / delegate)",
      "choice.reviewerAgent.spawn": "spawn — start a read-only subagent for each round",
      "field.llmMode.label": "LLM route",
      "field.llmMode.hint": "dsh (recommended): ocr is a separate child process that cannot reach cordis, so the plugin runs a tiny OpenAI-compatible bridge on 127.0.0.1 guarded by a random token and forwards requests to DSH ctx.llm.stream — model, provider, credentials, account rotation and quota all stay with DSH, so no URL or key is needed below. endpoint: ocr talks to the static endpoint directly (previous behaviour).",
      "field.llmModel.label": "Model",
      "field.llmModel.hint": "Maps to OCR_LLM_MODEL; empty follows the DSH default model (dsh mode). Candidates come from the DSH model catalog, searchable and free-form; picking one also writes its provider — a mismatch reports Model not supported.",
      "field.llmProvider.label": "Provider",
      "field.llmProvider.hint": "Provider id forwarded to DSH in dsh mode (a group id of the DSH model catalog); leave it empty to follow the provider of the DSH default model. Filled in automatically when you pick a candidate.",
      "field.llmBaseUrl.label": "Endpoint base URL",
      "field.llmBaseUrl.hint": "endpoint mode only: maps to OCR_LLM_URL.",
      "field.llmProtocol.label": "Endpoint protocol",
      "field.llmProtocol.hint": "endpoint mode only: maps to OCR_LLM_PROTOCOL. CommandCode DeepSeek v4.1 only supports openai.",
      "field.llmApiKeyRef.label": "API key reference",
      "field.llmApiKeyRef.hint": "endpoint mode only: a reference name in the DSH credential store (maps to OCR_LLM_TOKEN); no plaintext secret is stored. A literal key may still go to llm.apiKey in config.json.",
      "field.timeoutMinutes.label": "Timeout (minutes)",
      "field.timeoutMinutes.hint": "Passed to ocr --timeout and used as the plugin-side hard timeout; this table is capped at the factory value — write config.json for anything larger.",
      "field.progress.label": "Review progress",
      "field.progress.hint": "Registers each review as a background job: the Jobs panel (session header) shows the live progress line and an expandable ocr output stream, plus a stoppable progress line above the composer. Turning it off only hides progress — reviews still run.",
      "field.verbose.label": "Debug logging",
      "field.verbose.hint": "Print the ocr command line, env and timings into the DSH log.",
      "choice.engine.delegate": "delegate — no LLM, rules + files + diff spec in seconds (default since 0.8.0)",
      "choice.engine.ocr": "ocr — only the OCR LLM pipeline (3–6 minutes per file, billed by tokens)",
      "choice.engine.auto": "auto — run the OCR pipeline first, degrade to delegate when no LLM is configured",
      "choice.audience.agent": "summary — conclusions and the issue list only (default, saves tokens)",
      "choice.audience.human": "detailed — include the review process (wordier, easier to debug)",
      "choice.autoMinIntervalMs.30000": "30 seconds",
      "choice.autoMinIntervalMs.60000": "1 minute (default)",
      "choice.autoMinIntervalMs.300000": "5 minutes",
      "choice.autoMinIntervalMs.600000": "10 minutes",
      "choice.autoReview.adaptive": "adaptive — inject while the model is running, start a new turn when idle",
      "choice.autoReview.inject": "inject — inject the result into the current context",
      "choice.autoReview.followup": "followup — start a new turn",
      "choice.autoReview.off": "off — no auto review (factory default since v0.5.0: on-demand instead)",
      "choice.autoScope.workspace": "workspace — uncommitted working-tree changes",
      "choice.autoScope.range": "range — branch/commit range",
      "choice.autoScope.commit": "commit — a single commit",
      "choice.autoScope.scan": "scan — whole-file scan",
      "choice.llmMode.dsh": "dsh — through DSH: plugin-local bridge → DSH model / credentials / quota (recommended)",
      "choice.llmMode.endpoint": "endpoint — ocr talks to the static endpoint below (previous behaviour)",
      "choice.llmProtocol.openai": "openai — OpenAI-compatible /chat/completions route",
      "choice.llmProtocol.anthropic": "anthropic — Anthropic Messages protocol",
      "choice.preTest.off": "off — do not touch test commands (default)",
      "choice.preTest.remind": "remind — allow the test, remind after it returns",
      "choice.preTest.gate": "gate — refuse to run tests without a review (try remind first)",
    };

    /** zh 词典：TEXT_ZH + 由 FIELDS/CHOICE/GROUPS 现场生成的字段文案。 */
    function zhDictionary() {
      const zh = { ...TEXT_ZH };
      for (const group of GROUPS) zh["group." + group.id] = group.name;
      for (const field of FIELDS) {
        zh["field." + field.key + ".label"] = field.label;
        if (field.hint) zh["field." + field.key + ".hint"] = field.hint;
        if (field.placeholder) zh["field." + field.key + ".placeholder"] = field.placeholder;
        for (const [value, text] of field.options || []) zh["choice." + field.key + "." + value] = text;
      }
      return zh;
    }

    /** 注册给 locale 服务的词典。 */
    function textPairs() {
      return { zh: zhDictionary(), en: TEXT_EN };
    }

    /** 极简模板：把 {name} 换成 values[name]（文案带变量时用）。 */
    function fmt(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (values && values[key] !== undefined ? String(values[key]) : match));
    }

    /** 取 Client locale 服务（可选服务）：属性访问优先，否则退到不要求注入的读取口。 */
    function localeOf(ctx) {
      if (!ctx) return null;
      try {
        if (ctx.locale) return ctx.locale;
      } catch {
        /* 注入守卫拦下属性访问：落到下面的兜底读取口 */
      }
      try {
        return (typeof ctx.get === "function" && ctx.get("locale")) || null;
      } catch {
        return null;
      }
    }

    /** 文案函数：优先 locale 服务，缺服务/缺词条时退回内联 zh 原文。 */
    function makeT(locale) {
      const zh = zhDictionary();
      const zhOf = (key, fallback) => (zh[key] !== undefined ? zh[key] : fallback !== undefined ? fallback : key);
      let bound = null;
      if (locale && typeof locale.bind === "function") {
        try {
          bound = locale.bind(LOCALE_NS);
        } catch {
          bound = null;
        }
      }
      if (!bound) return zhOf;
      return (key, fallback) => {
        try {
          const value = bound(key);
          if (typeof value === "string" && value !== "" && value !== key) return value;
        } catch {
          /* 服务抛错就退回内联文案 */
        }
        return zhOf(key, fallback);
      };
    }

    const S = {
      wrap: { fontSize: 13, lineHeight: 1.6, color: "inherit" },
      head: { margin: "0 0 12px" },
      title: { fontSize: 15, fontWeight: 600, margin: "0 0 4px" },
      lead: { fontSize: 12, opacity: 0.6, margin: 0, wordBreak: "break-word" },
      status: { fontSize: 12, opacity: 0.68, margin: "2px 0 10px", display: "flex", flexWrap: "wrap", gap: "4px 10px" },
      section: { margin: "0 0 14px" },
      sectionTitle: { fontSize: 12, fontWeight: 600, opacity: 0.58, letterSpacing: "0.04em", margin: "0 0 8px" },
      row: { display: "grid", gridTemplateColumns: "minmax(140px, 190px) minmax(0, 1fr)", gap: "4px 12px", alignItems: "start", padding: "5px 0", borderTop: "1px solid rgba(127,127,135,0.14)" },
      label: { fontSize: 13, opacity: 0.9, paddingTop: 3, wordBreak: "break-word" },
      control: { minWidth: 0 },
      input: { width: "100%", boxSizing: "border-box", padding: "4px 7px", fontSize: 13, fontFamily: "inherit", color: "inherit", background: "rgba(127,127,135,0.08)", border: "1px solid rgba(127,127,135,0.38)", borderRadius: 6 },
      select: { width: "100%", boxSizing: "border-box", padding: "4px 6px", fontSize: 13, fontFamily: "inherit", color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-layer-2)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 6 },
      /* 原生弹出层是浏览器画的：必须显式给配色，否则「继承来的文字色 × 系统的弹层底色」
         会撞成白底白字（真机踩过：选项都在 DOM 里，但看起来像没有别的选项）。 */
      option: { color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-overlay)" },
      hint: { fontSize: 11.5, opacity: 0.58, marginTop: 3, wordBreak: "break-word" },
      note: { fontSize: 11, opacity: 0.62, marginTop: 3, wordBreak: "break-word" },
      combo: { position: "relative" },
      comboRow: { display: "flex", gap: 4, alignItems: "stretch" },
      comboBtn: { flex: "0 0 auto", padding: "0 8px", fontSize: 12, fontFamily: "inherit", color: "inherit", background: "transparent", border: "1px solid rgba(127,127,135,0.38)", borderRadius: 6, cursor: "pointer" },
      menu: { position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, zIndex: 40, maxHeight: 264, overflowY: "auto", border: "1px solid rgba(127,127,135,0.45)", borderRadius: 8, boxShadow: "0 10px 28px rgba(0,0,0,0.32)", padding: 4 },
      menuHead: { fontSize: 11, opacity: 0.55, padding: "4px 6px 6px", position: "sticky", top: 0 },
      menuEmpty: { fontSize: 11.5, opacity: 0.6, padding: "6px" },
      menuItem: { display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", padding: "5px 7px", borderRadius: 6, cursor: "pointer" },
      menuItemActive: { display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", padding: "5px 7px", borderRadius: 6, cursor: "pointer", background: "rgba(127,127,135,0.22)" },
      menuItemText: { minWidth: 0, flex: "1 1 auto" },
      menuItemName: { fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      menuItemSub: { fontSize: 11, opacity: 0.55, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      menuItemGroup: { flex: "0 0 auto", fontSize: 10.5, opacity: 0.5, whiteSpace: "nowrap" },
      actions: { display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" },
      btn: { padding: "3px 9px", fontSize: 12, fontFamily: "inherit", color: "inherit", background: "transparent", border: "1px solid rgba(127,127,135,0.42)", borderRadius: 6, cursor: "pointer" },
      btnPrimary: { padding: "3px 9px", fontSize: 12, fontFamily: "inherit", color: "inherit", background: "rgba(127,127,135,0.16)", border: "1px solid rgba(127,127,135,0.5)", borderRadius: 6, cursor: "pointer", fontWeight: 600 },
      msg: (kind) => ({ fontSize: 12, margin: "8px 0 0", color: kind === "err" ? "var(--dsw-alias-label-error)" : "inherit", opacity: kind === "err" ? 1 : 0.75 }),
      pill: { marginLeft: 6, padding: "0 5px", fontSize: 10.5, lineHeight: "15px", borderRadius: 999, border: "1px solid rgba(127,127,135,0.5)", opacity: 0.8, display: "inline-block", verticalAlign: "middle" },
      footer: { fontSize: 11.5, opacity: 0.55, marginTop: 12, wordBreak: "break-word" },
      /* 「常用档位 + 自定义」组合控件：下拉占满，自定义输入框固定窄列。 */
      combo: { display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 6, alignItems: "center" },
      comboCustom: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 118px", gap: 6, alignItems: "center" },
      /* 高级设置折叠区：默认收起，只留一行可点的标题。 */
      advanced: { margin: "0 0 14px", padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(127,127,135,0.24)", background: "rgba(127,127,135,0.045)" },
      advancedHead: { display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: 0, margin: 0, fontFamily: "inherit", fontSize: 12, fontWeight: 600, color: "inherit", background: "transparent", border: "none", cursor: "pointer", opacity: 0.78 },
      /* 卡片摘要视图：只读的「标签 / 值」两列。 */
      summaryRow: { display: "grid", gridTemplateColumns: "minmax(120px, 170px) minmax(0, 1fr)", gap: "2px 10px", padding: "2px 0" },
      summaryValue: { fontSize: 12.5, opacity: 0.85, wordBreak: "break-word" },
    };

    /**
     * 当前主题是浅色还是深色。原生 <select> 的弹出层由浏览器按 color-scheme 画，
     * 光靠继承的文字色对不上；主题服务拿不到时返回空串（不写 colorScheme，维持旧行为）。
     */
    function themeSchemeOf(ctx) {
      try {
        const theme = ctx && typeof ctx.get === "function" ? ctx.get("theme") : ctx && ctx.theme;
        const snap = theme && typeof theme.getTheme === "function" ? theme.getTheme() : null;
        const scheme = snap && snap.active ? snap.active.colorScheme : "";
        return scheme === "light" || scheme === "dark" ? scheme : "";
      } catch (err) {
        return "";
      }
    }

    /**
     * 跟随 theme/change 刷新：值在渲染时同步读（主题服务就是个 getter），
     * 订阅只负责在主题切换时催一次重渲染；拿不到主题服务就一直是空串。
     */
    function useThemeScheme(ctx) {
      const [, setTick] = React.useState(0);
      React.useEffect(() => {
        let off = null;
        try {
          if (ctx && typeof ctx.on === "function") off = ctx.on("theme/change", () => setTick((n) => n + 1));
        } catch (err) {
          off = null;
        }
        return () => {
          try {
            if (typeof off === "function") off();
          } catch (err) {
            /* 已经卸载 */
          }
        };
      }, [ctx]);
      return themeSchemeOf(ctx);
    }

    /** select 的运行时样式：把当前 colorScheme 内联进去，其余沿用 S.select。 */
    function selectStyle(scheme) {
      return scheme ? Object.assign({}, S.select, { colorScheme: scheme }) : S.select;
    }

    const fieldOf = (key) => FIELDS.find((f) => f.key === key);
    const labelOf = (key) => (fieldOf(key) || {}).label || key;

    /** 订阅 ConfigForm 的快照（getSnapshot 引用稳定，可直接给 useSyncExternalStore）。 */
    function useSnapshot(form) {
      const subscribe = React.useCallback((notify) => form.subscribe(notify), [form]);
      const read = React.useCallback(() => form.getSnapshot(), [form]);
      return React.useSyncExternalStore(subscribe, read, read);
    }

    /** 拿不到表单时的替身：让 hook 调用保持无条件（hooks 不能条件调用）。 */
    const UNAVAILABLE_SNAP = {
      status: "unavailable",
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
      mode: "memory",
    };
    const NULL_FORM = {
      subscribe: () => () => {},
      getSnapshot: () => UNAVAILABLE_SNAP,
      set: async () => false,
      unset: async () => false,
      mutate: async () => false,
    };

    /**
     * 取本插件的配置表单：按 ENTRY_IDS 依次尝试，跳过取不到或明确 unavailable 的键。
     * 全都不可用时返回 form: null，让页面显示诊断而不是抛异常。
     */
    function resolveEntry(ctx) {
      let first = null;
      for (const id of ENTRY_IDS) {
        let form;
        try {
          form = ctx.configForms.get(id);
        } catch {
          continue;
        }
        if (!form || typeof form.getSnapshot !== "function") continue;
        let snap = null;
        try {
          snap = form.getSnapshot();
        } catch {
          snap = null;
        }
        if (!first) first = { id, form };
        if (!snap || snap.status !== "unavailable") return { id, form };
      }
      return first || { id: ENTRY_ID, form: null };
    }

    function valueOf(snap, field) {
      const section = snap && snap.value && typeof snap.value === "object" ? snap.value : undefined;
      const value = section ? section[field.key] : undefined;
      return value === undefined ? field.default : value;
    }

    function isOverridden(snap, key) {
      const user = snap && snap.user;
      return Boolean(user && typeof user === "object" && Object.prototype.hasOwnProperty.call(user, key));
    }

    /** 输入值 → 写入值：number 转数字，空串表示"清掉覆盖，回到默认"。 */
    function coerce(field, raw) {
      if (field.kind === "number") {
        if (raw === "" || raw === null || raw === undefined) return undefined;
        const n = Number(raw);
        return Number.isFinite(n) ? n : undefined;
      }
      if (field.kind === "boolean") return Boolean(raw);
      if (typeof raw === "string") return raw;
      return raw;
    }

    /* ------------------------------------------------------------ 模型目录（下拉候选） */

    /** 下拉最多渲染多少条（再多就靠输入过滤）。 */
    const MENU_LIMIT = 200;

    /**
     * 把宿主 `sessionController.modelCatalog()` 的返回值规范化成渲染用的分组表。
     * 形状（Host 侧 ModelCatalog）：{ default, routableProviders, groups[], failures[] }，
     * group = { id, name, models: [{ id, name, description?, reasoning? }] }。这里对每一层都做防御，
     * 拿到别的形状也只当"目录为空"，不会让设置页崩掉。
     */
    function normalizeCatalog(catalog) {
      const rawGroups = Array.isArray(catalog && catalog.groups) ? catalog.groups : [];
      const groups = [];
      for (const g of rawGroups) {
        if (!g) continue;
        const models = [];
        const rawModels = Array.isArray(g.models) ? g.models : [];
        for (const m of rawModels) {
          if (!m) continue;
          const id = m.id === undefined || m.id === null ? "" : String(m.id);
          if (!id) continue;
          models.push({
            id,
            name: m.name === undefined || m.name === null || m.name === "" ? id : String(m.name),
            description: typeof m.description === "string" ? m.description : "",
          });
        }
        if (!models.length) continue;
        const groupId = g.id === undefined || g.id === null ? String(groups.length) : String(g.id);
        groups.push({ id: groupId, name: String(g.name || g.id || "未命名提供方"), models });
      }
      const failures = (Array.isArray(catalog && catalog.failures) ? catalog.failures : [])
        .filter(Boolean)
        .map((f) => ({ name: String(f.name || f.id || "提供方"), message: String(f.message || "") }));
      /* catalog.default = DSH 当前的默认路由（agentDefaultModel），设置页留空时桥就是用它转发的。 */
      const rawDefault = catalog && catalog.default && typeof catalog.default === "object" ? catalog.default : null;
      const def = rawDefault
        ? { provider: String(rawDefault.provider || ""), model: String(rawDefault.model || "") }
        : null;
      return { groups, failures, default: def && def.model ? def : null };
    }

    /**
     * 模型目录要读 `ctx.remote.session.modelCatalog()`，但 remote 能不能读由 cordis 的 inject 决定，
     * 而注入是"全有全无"：Fiber._refresh()（cordis lib/index.js:1320-1327）只要 inject 里有一个名字
     * 找不到实现，整个 fiber 就是 INACTIVE——插件根本不 apply、设置页整块消失。
     * 所以插件本身只注入 slots（永远在），remote/remote.session 声明在一个子 fiber 上：
     * 子 fiber 激活时走官方读法 `ctx.remote`，没激活时退回不要求注入的 `ctx.get("remote")`
     * （= ReflectService.get，strict=false），再拿不到也只是没有候选列表、输入框照常用。
     */
    function createRemoteScope(scoped) {
      let holder = null;
      const listeners = new Set();
      const notify = () => {
        for (const fn of Array.from(listeners)) {
          try {
            fn();
          } catch (err) {
            /* 订阅者自己的渲染异常不该连累其它订阅者 */
          }
        }
      };
      if (scoped && typeof scoped.inject === "function") {
        scoped.inject(["remote", "remote.session"], (remoteCtx) => {
          holder = remoteCtx;
          notify();
          return () => {
            if (holder === remoteCtx) {
              holder = null;
              notify();
            }
          };
        });
      }
      return {
        /** 子 fiber 激活时返回那个声明过 remote 的 ctx，否则 null。 */
        current: () => holder,
        /** 订阅 remote 服务的出现/消失（设置页可能在服务到齐之前就渲染了）。 */
        subscribe(listener) {
          if (typeof listener !== "function") return () => {};
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    }

    /** 取 `ctx.remote`：优先属性访问（子 fiber 声明过注入时可用），否则退到不要求注入的读取口。 */
    function remoteOf(ctx) {
      if (!ctx) return null;
      try {
        if (ctx.remote) return ctx.remote;
      } catch (err) {
        /* 未声明注入：落到下面的兜底读取口 */
      }
      if (typeof ctx.get === "function") {
        try {
          return ctx.get("remote") || null;
        } catch (err) {
          return null;
        }
      }
      return null;
    }

    /** 解析 `ctx.remote.session.modelCatalog`（可能整体不存在，也可能被抛出）。 */
    function resolveCatalogCall(ctx) {
      const remote = remoteOf(ctx);
      const t = makeT(localeOf(ctx));
      if (!remote) {
        return { session: null, call: null, error: t("catalog.noRemote") };
      }
      try {
        const session = remote.session;
        if (session && typeof session.modelCatalog === "function") {
          return { session, call: session.modelCatalog, error: "" };
        }
        return { session: null, call: null, error: t("catalog.noMethod") };
      } catch (err) {
        return { session: null, call: null, error: String((err && err.message) || err) };
      }
    }

    /**
     * Remote 方法返回的是 `RemoteResult<T>` 信封（`{ ok: true, value }` / `{ ok: false, error }`，
     * 见 dsh-typert-protocol 的 types.d.ts），这里统一解包；也兼容直接返回业务值的实现。
     */
    function unwrapRemote(result, t) {
      const tt = typeof t === "function" ? t : makeT(null);
      if (result && typeof result === "object" && "ok" in result) {
        if (result.ok === false) {
          const err = result.error;
          const detail = err && typeof err === "object" ? err.message || err.code || JSON.stringify(err) : String(err);
          throw new Error(fmt(tt("catalog.callFailed"), { detail }));
        }
        return result.value;
      }
      return result;
    }

    /**
     * 读取 DSH 自己的模型目录：`ctx.remote.session.modelCatalog()`（客户端 namespace `session`
     * 由宿主服务 sessionController 生成，描述逐字："Host service backing the generated
     * `ctx.remote.session` namespace."），所以浏览器侧不需要自己的 Remote 方法。
     * 取不到时降级成"纯文本输入"，只影响候选列表。
     */
    function useModelCatalog(ctx) {
      const [state, setState] = React.useState({ status: "loading", groups: [], failures: [], error: "", default: null });
      const t = makeT(localeOf(ctx));
      const resolved = resolveCatalogCall(ctx);
      React.useEffect(() => {
        let alive = true;
        if (!resolved.call) {
          setState({ status: "unsupported", groups: [], failures: [], error: resolved.error, default: null });
          return () => {
            alive = false;
          };
        }
        setState((prev) =>
          prev.status === "loading" ? prev : { status: "loading", groups: prev.groups, failures: prev.failures, error: "", default: prev.default },
        );
        Promise.resolve()
          .then(() => resolved.call.call(resolved.session))
          .then((result) => {
            if (!alive) return;
            const normalized = normalizeCatalog(unwrapRemote(result, t));
            setState({ status: "ready", groups: normalized.groups, failures: normalized.failures, error: "", default: normalized.default });
          })
          .catch((err) => {
            if (!alive) return;
            setState({ status: "error", groups: [], failures: [], error: String((err && err.message) || err), default: null });
          });
        return () => {
          alive = false;
        };
      }, [resolved.call, resolved.error]);
      return state;
    }

    /** 空白=全量；否则按空白分词，每个词都要能在 id 或 name 里找到。 */
    function filterModels(items, query) {
      const text = String(query === undefined || query === null ? "" : query).trim().toLowerCase();
      if (!text) return items;
      const words = text.split(/\s+/).filter(Boolean);
      return items.filter((item) => {
        const hay = `${item.id} ${item.name} ${item.group}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }

    /**
     * 模型名输入框 + 可搜索下拉。
     * 输入框本身仍是自由文本（写入值就是它显示的内容），下拉只是候选：点条目、或者
     * ↑↓ 移动 + 回车选中；Esc 收起。取不到模型目录时退化成普通输入框。
     */
    function ModelPicker(props) {
      const field = props.field;
      const value = props.value;
      const disabled = props.disabled;
      const onChange = props.onChange;
      const remoteScope = props.remoteScope;
      /* 可见文案走 Client locale 服务；拿不到服务时 makeT 会退回内联中文。 */
      const t = props.t || makeT(localeOf(props.ctx));
      /* 目录读取用哪个 ctx：remote 子 fiber 激活后用它的（官方读法），否则用宿主给的 scoped。 */
      const [remoteCtx, setRemoteCtx] = React.useState(() =>
        remoteScope && typeof remoteScope.current === "function" ? remoteScope.current() : null,
      );
      React.useEffect(() => {
        if (!remoteScope || typeof remoteScope.subscribe !== "function") return undefined;
        setRemoteCtx(remoteScope.current());
        return remoteScope.subscribe(() => setRemoteCtx(remoteScope.current()));
      }, [remoteScope]);
      const catalog = useModelCatalog(remoteCtx || props.ctx);
      /* dsh 路由下：留空就跟随 DSH 默认模型，所以把当前默认模型直接显示出来。 */
      const showDshDefault = props.mode === "dsh";
      const [open, setOpen] = React.useState(false);
      const [query, setQuery] = React.useState(null);
      const [active, setActive] = React.useState(0);
      const [bg, setBg] = React.useState("");
      const wrapRef = React.useRef(null);

      const text = query === null ? (value === undefined || value === null ? "" : String(value)) : query;
      /* 只有"用户真的在输入"时才算过滤词：刚展开列表时应该看到全部候选，而不是被当前值筛成一条。 */
      const needle = query === null ? "" : query;
      const flat = React.useMemo(() => {
        const out = [];
        for (const g of catalog.groups) for (const m of g.models) out.push({ id: m.id, name: m.name, description: m.description, group: g.name, provider: g.id });
        return out;
      }, [catalog]);
      const matches = React.useMemo(() => filterModels(flat, needle), [flat, needle]);
      const shown = matches.slice(0, MENU_LIMIT);

      /** 下拉是不透明浮层，颜色取自最近的不透明祖先背景（主题明暗都适用）。 */
      const guessBg = () => {
        try {
          let el = wrapRef.current && wrapRef.current.parentElement;
          while (el) {
            const color = window.getComputedStyle(el).backgroundColor;
            if (color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") return color;
            el = el.parentElement;
          }
        } catch {
          /* 浏览器/测试环境拿不到 computedStyle 时用主题令牌兜底 */
        }
        return "var(--dsw-alias-bg-layer-2)";
      };

      const openMenu = () => {
        setOpen(true);
        setActive(0);
        setBg(guessBg());
      };

      const choose = (item) => {
        /* 选中的候选知道自己的 provider（= DSH 模型目录里的组 id），顺手告诉宿主，dsh 路由就不用再猜。 */
        onChange(item.id, item.provider);
        setQuery(null);
        setOpen(false);
      };

      React.useEffect(() => {
        if (!open) return undefined;
        if (typeof document === "undefined" || !document.addEventListener) return undefined;
        const onDocDown = (ev) => {
          const root = wrapRef.current;
          if (root && ev && ev.target && root.contains && root.contains(ev.target)) return;
          setOpen(false);
        };
        document.addEventListener("mousedown", onDocDown);
        return () => document.removeEventListener("mousedown", onDocDown);
      }, [open]);

      const onKeyDown = (e) => {
        const key = e && e.key;
        if (key === "ArrowDown") {
          if (e.preventDefault) e.preventDefault();
          if (!open) openMenu();
          else setActive((i) => Math.min(i + 1, Math.max(shown.length - 1, 0)));
          return;
        }
        if (key === "ArrowUp") {
          if (e.preventDefault) e.preventDefault();
          setActive((i) => Math.max(i - 1, 0));
          return;
        }
        if (key === "Enter") {
          if (!open) return;
          if (e.preventDefault) e.preventDefault();
          if (shown[active]) choose(shown[active]);
          else if (text.trim()) choose({ id: text.trim() });
          return;
        }
        if (key === "Escape") {
          setOpen(false);
          return;
        }
        if (key === "Tab") setOpen(false);
      };

      const note = () => {
        if (catalog.status === "loading") return t("picker.loading");
        if (catalog.status === "unsupported") return fmt(t("picker.unsupported"), { error: catalog.error });
        if (catalog.status === "error") return fmt(t("picker.error"), { error: catalog.error });
        if (!flat.length) return t("picker.empty");
        const known = flat.find((m) => m.id === String(value === undefined || value === null ? "" : value));
        const head = known ? fmt(t("picker.current"), { name: known.name, group: known.group ? `（${known.group}）` : "" }) : "";
        const extra = catalog.failures.length ? fmt(t("picker.failures"), { count: catalog.failures.length }) : "";
        return fmt(t("picker.candidates"), { head, count: flat.length, extra });
      };

      const menu = open
        ? h(
            "div",
            { style: Object.assign({ background: bg || "var(--dsw-alias-bg-layer-2)" }, S.menu), "data-ocr-model-menu": true },
            h("div", { style: S.menuHead }, fmt(t("picker.menuHead"), { count: flat.length })),
            shown.length === 0
              ? h("div", { style: S.menuEmpty }, text.trim() ? fmt(t("picker.noMatch"), { text: text.trim() }) : t("picker.noOptions"))
              : null,
            shown.map((item, i) =>
              h(
                "div",
                {
                  key: `${item.id}#${i}`,
                  "data-ocr-model-item": true,
                  title: item.description || item.id,
                  style: i === active ? S.menuItemActive : S.menuItem,
                  onMouseEnter: () => setActive(i),
                  onMouseDown: (ev) => {
                    if (ev && ev.preventDefault) ev.preventDefault();
                    choose(item);
                  },
                },
                h(
                  "div",
                  { style: S.menuItemText },
                  h("div", { style: S.menuItemName }, item.name),
                  item.id === item.name ? null : h("div", { style: S.menuItemSub }, item.id),
                ),
                item.group ? h("span", { style: S.menuItemGroup }, item.group) : null,
              ),
            ),
            matches.length > shown.length ? h("div", { style: S.menuEmpty }, fmt(t("picker.more"), { count: matches.length - shown.length })) : null,
          )
        : null;

      return h(
        "div",
        { style: S.combo, ref: wrapRef, "data-ocr-model-combo": true },
        h(
          "div",
          { style: S.comboRow },
          h("input", {
            type: "text",
            value: text,
            placeholder: field.placeholder ? t("field." + field.key + ".placeholder", field.placeholder) : undefined,
            disabled,
            spellCheck: false,
            "data-ocr-model-input": true,
            onFocus: () => openMenu(),
            onChange: (e) => {
              const next = e.target.value;
              setQuery(next);
              setActive(0);
              setOpen(true);
              setBg(guessBg());
              onChange(next);
            },
            onKeyDown,
            style: Object.assign({}, S.input, { flex: "1 1 auto" }),
          }),
          h(
            "button",
            {
              type: "button",
              style: S.comboBtn,
              disabled,
              tabIndex: -1,
              title: open ? t("picker.collapse") : t("picker.expand"),
              onClick: () => (open ? setOpen(false) : openMenu()),
            },
            open ? "▴" : "▾",
          ),
        ),
        menu,
        h("div", { style: S.note }, note()),
        showDshDefault && catalog.default
          ? h(
              "div",
              { style: S.note, "data-ocr-model-default": true },
              fmt(t("picker.dshDefault"), { provider: catalog.default.provider || "?", model: catalog.default.model }),
            )
          : null,
      );
    }

    /**
     * number 字段的「常用档位 + 自定义」控件（目前只有 autoMinIntervalMs）。
     * 下拉值是字符串，但存储仍是数字（coerce 按 kind="number" 转），所以宿主 schema 不用改；
     * 「自定义…」只切本组件的本地状态，值本身留在 draft 里由上层保存。
     */
    function PresetNumber(props) {
      const field = props.field;
      const t = props.t;
      const value = props.value;
      const disabled = props.disabled === true;
      const [custom, setCustom] = React.useState(false);
      const presets = (field.options || []).map(([v, text]) => [String(v), text]);
      const rawText = value === undefined || value === null ? "" : String(value);
      const isPreset = presets.some(([v]) => v === rawText);
      /* 值不是某个档位（文件层写的、或选了「自定义」）时就显示输入框；
         选了「默认」会把 draft 清成空串，此时回到下拉的"默认"档。 */
      const editingCustom = isPreset ? false : custom || rawText !== "";
      const selectValue = editingCustom ? "custom" : isPreset ? rawText : "";
      const change = props.onChange;
      return h(
        "div",
        { style: editingCustom ? S.comboCustom : S.combo },
        h(
          "select",
          {
            value: selectValue,
            disabled,
            style: selectStyle(props.scheme),
            "data-ocr-preset-select": field.key,
            onChange: (e) => {
              const next = e.target.value;
              if (next === "custom") {
                setCustom(true);
                change(field.key, "");
                return;
              }
              setCustom(false);
              change(field.key, next);
            },
          },
          h("option", { key: "__unset", value: "", style: S.option }, t("preset.unset", "默认（跟随出厂值）")),
          presets.map(([v, text]) => h("option", { key: v, value: v, style: S.option }, t("choice." + field.key + "." + v, text))),
          h("option", { key: "__custom", value: "custom", style: S.option }, t("preset.custom", "自定义…")),
        ),
        editingCustom
          ? h("input", {
              type: "number",
              value: rawText,
              min: field.min,
              max: field.max,
              disabled,
              spellCheck: false,
              "data-ocr-preset-input": field.key,
              onChange: (e) => change(field.key, e.target.value),
              style: S.input,
            })
          : null,
      );
    }

    /**
     * 插件卡片（plugins.bundle.config）的 summary 席位：只读摘要 + 一行指向设置页。
     * 卡片上不再重复整张表单（那份表单在「设置 → 代码评审」里），避免两处状态互相打架。
     */
    function ConfigSummary(props) {
      const ctx = props.ctx;
      const t = React.useMemo(() => props.t || makeT(localeOf(ctx)), [props.t, ctx]);
      const entry = React.useMemo(() => resolveEntry(ctx), [ctx]);
      const snap = useSnapshot(entry.form || NULL_FORM);
      const valueText = (field) => {
        const value = valueOf(snap, field);
        if (field.kind === "boolean") return value ? t("card.on", "开") : t("card.off", "关");
        if (value === undefined || value === null || value === "") return t("card.unset", "跟随默认");
        const hit = (field.options || []).find(([v]) => String(v) === String(value));
        return hit ? t("choice." + field.key + "." + hit[0], hit[1]) : String(value);
      };
      /* 只列基础组里无条件的行：条件行随模式出现，摘要不必跟着变。 */
      const fields = FIELDS.filter((field) => BASIC_GROUPS.some((group) => group.id === field.group) && !field.onlyMode && !field.onlyReviewer);
      return h(
        "div",
        { style: S.wrap, "data-ocr-card-summary": "1" },
        h("p", { style: S.lead }, t("card.lead", "只读摘要。完整设置：设置 → 代码评审。")),
        h(
          "div",
          { style: { marginTop: 8 } },
          fields.map((field) =>
            h(
              "div",
              { key: field.key, style: S.summaryRow, "data-ocr-summary-row": field.key },
              h("span", { style: S.label }, t("field." + field.key + ".label", field.label)),
              h("span", { style: S.summaryValue }, valueText(field)),
            ),
          ),
        ),
        h("p", { style: S.footer }, t("card.more", "在上面点「代码评审」可以改这些值（含高级项）。")),
      );
    }

    function ConfigPage(props) {
      const ctx = props.ctx;
      const standalone = props.standalone === true;
      /* 可见文案走 Client locale 服务；props.t 允许调用方（或测试）直接注入取词函数。 */
      const t = React.useMemo(() => props.t || makeT(localeOf(ctx)), [props.t, ctx]);
      const labelText = React.useCallback((key) => t("field." + key + ".label", labelOf(key)), [t]);
      const remoteScope = props.remoteScope;
      /* 原生下拉弹出层的配色跟着主题走（见 selectStyle）。 */
      const scheme = useThemeScheme(ctx);
      const entry = React.useMemo(() => resolveEntry(ctx), [ctx]);
      const form = entry.form;
      const snap = useSnapshot(form || NULL_FORM);
      const [draft, setDraft] = React.useState({});
      const [busy, setBusy] = React.useState("");
      const [msg, setMsg] = React.useState(null);
      /* 高级设置默认收起（决策项上主页面、参数项进折叠区）。 */
      const [advancedOpen, setAdvancedOpen] = React.useState(false);

      const disabled = snap.status !== "ready" || snap.writable === false;
      /**
       * 草稿值与已存值相同就不算改动：点了「撤销」的行要能自己把「保存 / 待保存」消掉，
       * 否则一个「值已经回到原样」的行会一直算脏，折叠区的「N 项待保存」也会虚报。
       */
      const isDirty = (field) => {
        if (!Object.prototype.hasOwnProperty.call(draft, field.key)) return false;
        const stored = valueOf(snap, field);
        return String(draft[field.key]) !== String(stored === undefined || stored === null ? "" : stored);
      };
      const dirtyKeys = FIELDS.filter(isDirty).map((field) => field.key);
      /* 草稿优先：改过的控件要立刻显示新值（否则下拉看起来像没生效）。 */
      const currentValue = (field) => (Object.prototype.hasOwnProperty.call(draft, field.key) ? draft[field.key] : valueOf(snap, field));
      /* dsh 模式藏掉静态端点那几行（它们对桥不起作用），endpoint 模式则藏掉 provider。 */
      const llmMode = String(currentValue(fieldOf("llmMode")) ?? "") === "endpoint" ? "endpoint" : "dsh";
      /* reviewer.agent=spawn 才显示子 agent 那几行。 */
      const reviewerMode = String(currentValue(fieldOf("reviewerAgent")) ?? "off") === "spawn" ? "spawn" : "off";
      const visibleField = (field) =>
        (!field.onlyMode || field.onlyMode === llmMode) && (!field.onlyReviewer || field.onlyReviewer === reviewerMode);
      const fieldsOfGroup = (group) => FIELDS.filter((field) => field.group === group.id && visibleField(field));
      /* 高级区的字段清单只用来数个数与徽标（收起时它们不渲染，但草稿仍由 saveAll 保存）。 */
      const advancedFields = ADVANCED_GROUPS.flatMap(fieldsOfGroup);
      const dirtyAdvanced = advancedFields.filter(isDirty).length;

      const change = React.useCallback((key, value) => {
        setDraft((prev) => ({ ...prev, [key]: value }));
        setMsg(null);
      }, []);

      const write = React.useCallback(
        async (key, action) => {
          const field = fieldOf(key);
          if (!field) return true;
          if (!form) {
            setMsg({ kind: "err", text: t("form.noForm") });
            return false;
          }
          setBusy(key);
          try {
            let ok;
            if (action === "unset") {
              ok = await form.unset(key);
            } else {
              const value = coerce(field, draft[key]);
              ok = value === undefined ? await form.unset(key) : await form.set(key, value);
            }
            if (ok) {
              setDraft((prev) => {
                const next = { ...prev };
                delete next[key];
                return next;
              });
              setMsg({ kind: "ok", text: fmt(t(action === "unset" ? "form.reset" : "form.saved"), { label: labelText(key) }) });
            } else {
              setMsg({ kind: "err", text: fmt(t("form.rejected"), { label: labelText(key) }) });
            }
            return ok;
          } catch (err) {
            setMsg({ kind: "err", text: fmt(t("form.writeFailed"), { label: labelText(key), error: String((err && err.message) || err) }) });
            return false;
          } finally {
            setBusy("");
          }
        },
        [draft, form, labelText],
      );

      const saveAll = React.useCallback(async () => {
        for (const key of dirtyKeys) await write(key, "set");
      }, [dirtyKeys, write]);

      const resetAll = React.useCallback(async () => {
        for (const field of FIELDS) await write(field.key, "unset");
      }, [write]);

      const control = (field) => {
        const value = currentValue(field);
        if (field.kind === "boolean") {
          return h("input", {
            type: "checkbox",
            checked: Boolean(value),
            disabled,
            onChange: (e) => change(field.key, e.target.checked),
            style: { width: 15, height: 15, margin: "4px 0 0", accentColor: "inherit" },
          });
        }
        if (field.kind === "select") {
          return h(
            "select",
            { value: value === undefined ? "" : String(value), disabled, onChange: (e) => change(field.key, e.target.value), style: selectStyle(scheme) },
            (field.options || []).map(([optionValue, text]) => h("option", { key: optionValue, value: optionValue, style: S.option }, t("choice." + field.key + "." + optionValue, text))),
          );
        }
        const raw = value === undefined || value === null ? "" : String(value);
        /* number + options = 常用档位下拉（选「自定义…」再手填数字）。 */
        if (field.kind === "number" && field.options && field.options.length) {
          return h(PresetNumber, { field, value, disabled, t, scheme, onChange: change });
        }
        if (field.kind === "model") {
          return h(ModelPicker, {
            ctx,
            remoteScope,
            field,
            mode: llmMode,
            value: raw,
            disabled,
            dirty: Object.prototype.hasOwnProperty.call(draft, field.key),
            onChange: (next, provider) => {
              change(field.key, next);
              if (provider && field.providerKey) change(field.providerKey, provider);
            },
          });
        }
        return h("input", {
          type: field.kind === "number" ? "number" : "text",
          value: raw === undefined || raw === null ? "" : raw,
          min: field.min,
          max: field.max,
          placeholder: field.placeholder ? t("field." + field.key + ".placeholder", field.placeholder) : undefined,
          disabled,
          spellCheck: false,
          onChange: (e) => change(field.key, e.target.value),
          style: S.input,
        });
      };

      const row = (field) => {
        const dirty = isDirty(field);
        return h(
          "div",
          { key: field.key, style: S.row, "data-ocr-field-row": field.key },
          h(
            "label",
            { style: S.label },
            t("field." + field.key + ".label", field.label),
            isOverridden(snap, field.key) ? h("span", { style: S.pill, title: t("row.overridden") }, t("row.changed")) : null,
          ),
          h(
            "div",
            { style: S.control },
            control(field),
            dirty
              ? h(
                  "div",
                  { style: S.actions },
                  h("button", { type: "button", style: S.btnPrimary, disabled: busy === field.key, onClick: () => write(field.key, "set") }, busy === field.key ? t("button.saving") : t("button.save")),
                  h("button", { type: "button", style: S.btn, disabled: Boolean(busy), onClick: () => change(field.key, valueOf(snap, field)) }, t("button.undo")),
                  h("button", { type: "button", style: S.btn, disabled: Boolean(busy), onClick: () => write(field.key, "unset") }, t("button.reset")),
                )
              : h("div", { style: S.actions }, h("button", { type: "button", style: S.btn, disabled: disabled || busy === field.key, onClick: () => write(field.key, "unset") }, t("button.reset"))),
            h("div", { style: S.hint }, t("field." + field.key + ".hint", field.hint)),
          ),
        );
      };

      const renderGroup = (group) =>
        h(
          "div",
          { key: group.id, style: S.section, "data-ocr-group": group.id },
          h("p", { style: S.sectionTitle }, t("group." + group.id, group.name)),
          fieldsOfGroup(group).map(row),
        );

      const statusLine = () => {
        const parts = [];
        parts.push(fmt(t("status.entry"), { id: entry.id }));
        if (!form) parts.push(fmt(t("status.noForm"), { ids: ENTRY_IDS.join(" / ") }));
        parts.push(fmt(t("status.state"), { status: snap.status }));
        if (snap.mode) parts.push(fmt(t("status.mode"), { mode: snap.mode }));
        parts.push(snap.writable === false ? t("status.readonly") : t("status.writable"));
        parts.push(llmMode === "dsh" ? t("status.routeDsh") : t("status.routeEndpoint"));
        if (reviewerMode === "spawn") parts.push(t("status.reviewerAgent"));
        if (snap.status === "loading") parts.push(t("status.loading"));
        if (snap.status === "unavailable") parts.push(t("status.unavailable"));
        return h("div", { style: S.status }, parts.map((text, i) => h("span", { key: i }, text)));
      };

      return h(
        "div",
        { style: S.wrap },
        standalone
          ? h(
              "div",
              { style: S.head },
              h("h2", { style: S.title }, t("page.title")),
              h("p", { style: S.lead }, t("page.lead")),
            )
          : null,
        statusLine(),
        h(
          "div",
          { style: S.actions },
          h("button", { type: "button", style: S.btnPrimary, disabled: disabled || dirtyKeys.length === 0 || Boolean(busy), onClick: saveAll }, dirtyKeys.length > 1 ? fmt(t("button.saveAllChanges"), { count: dirtyKeys.length }) : t("button.saveChanges")),
          h("button", { type: "button", style: S.btn, disabled: disabled || Boolean(busy), onClick: resetAll }, t("button.resetAll")),
        ),
        msg ? h("p", { style: S.msg(msg.kind) }, msg.text) : null,
        h("p", { style: S.hint }, fmt(t("page.sourceHint"), { badge: t("row.changed") })),
        BASIC_GROUPS.map(renderGroup),
        h(
          "section",
          { style: S.advanced, "data-ocr-advanced": advancedOpen ? "open" : "closed" },
          h(
            "button",
            {
              type: "button",
              style: S.advancedHead,
              "data-ocr-advanced-toggle": "1",
              "aria-expanded": advancedOpen ? "true" : "false",
              onClick: () => setAdvancedOpen((open) => !open),
            },
            h("span", null, `${advancedOpen ? "▾" : "▸"} ${fmt(t("advanced.title"), { count: advancedFields.length })}`),
            dirtyAdvanced > 0
              ? h("span", { style: S.pill, title: t("advanced.dirtyTitle") }, fmt(t("advanced.dirty"), { count: dirtyAdvanced }))
              : null,
          ),
          advancedOpen
            ? ADVANCED_GROUPS.map(renderGroup)
            : h("p", { style: S.hint }, t("advanced.collapsedHint")),
        ),
        h(
          "p",
          { style: S.footer },
          t("page.footer"),
        ),
      );
    }

    /* --------------------------------------------- 会话内进度行（composer 上方） */

    /**
     * 显示哪几类后台任务：本插件的评审 job（kind=ocr-review）。
     * 宿主自己的 bash / subagent 任务由标题栏的 Jobs 面板负责，这里不重复。
     */
    const JOB_KIND_PREFIX = "ocr-review";

    /** 结算后的行还留在输入框上方多久（之后交给 Jobs 面板看）。 */
    const SETTLED_LINGER_MS = 60000;

    /** 快照里还没有这个会话的行时的占位（复用同一个数组，免得每次渲染都换引用）。 */
    const EMPTY_LIST = [];

    const P = {
      wrap: { margin: "0 0 6px", padding: "5px 9px", borderRadius: 8, border: "1px solid rgba(127,127,135,0.3)", background: "rgba(127,127,135,0.07)", fontSize: 12, lineHeight: "18px" },
      head: { fontSize: 11, opacity: 0.55, marginBottom: 2 },
      row: { display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 },
      state: { flex: "0 0 auto", fontSize: 11, opacity: 0.62 },
      label: { flex: "0 0 auto", maxWidth: "45%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 },
      text: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.72 },
      time: { flex: "0 0 auto", opacity: 0.5, fontVariantNumeric: "tabular-nums" },
      stop: { flex: "0 0 auto", padding: "0 5px", fontSize: 11, fontFamily: "inherit", color: "inherit", background: "transparent", border: "1px solid rgba(127,127,135,0.42)", borderRadius: 6, cursor: "pointer", opacity: 0.8 },
      hint: { fontSize: 11, opacity: 0.45, marginTop: 1 },
    };

    /** 这条 job 还在跑吗（stopping 也算：用户已经点过停止，等它落地）。 */
    function jobLive(job) {
      return job.status === "running" || job.status === "stopping";
    }

    /** 一句话状态。 */
    function jobStateText(job, t) {
      if (job.status === "running") return t("progress.running", "运行中");
      if (job.status === "stopping") return t("progress.stopping", "停止中…");
      if (job.status === "completed") return t("progress.completed", "已完成");
      if (job.status === "failed") return t("progress.failed", "失败");
      return t("progress.killed", "已停止");
    }

    /** 时长：运行中按现在算，结算后按 finishedAt（宿主的 startedAt/finishedAt 都是毫秒时间戳）。 */
    function jobElapsed(job, now) {
      const started = Number(job.startedAt) || now;
      const ended = Number(job.finishedAt) || now;
      const seconds = Math.max(0, Math.round((ended - started) / 1000));
      if (seconds < 60) return `${seconds}s`;
      return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
    }

    /** 只渲染本插件的 job，并且给了 sessionId 才渲（这个席位是 session 级的）。 */
    function ReviewProgressLine(props) {
      const { useJobs, sessionId } = props;
      if (typeof useJobs !== "function" || !sessionId) return null;
      return h(ReviewProgressRows, props);
    }

    /**
     * 进度行本体：直接读 jobs 服务的快照（hooks.jobs → useJobs 选择器），
     * 也就是和标题栏 Jobs 面板同一份数据，所以两处显示天然一致。
     */
    function ReviewProgressRows(props) {
      const { sessionId, useJobs, watchRows, killJob } = props;
      /* 席位会把 locale 绑好传进来；万一没有，就退回内联中文原文。 */
      const t = typeof props.t === "function" ? props.t : (key, fallback) => fallback;
      const rows = useJobs((state) => state.rows[sessionId]) || EMPTY_LIST;
      /* 引用计数的 roster 流：组件在时订阅，离开时释放（宿主自己管理共享）。 */
      React.useEffect(() => (typeof watchRows === "function" ? watchRows(sessionId) : undefined), [sessionId, watchRows]);
      const [armed, setArmed] = React.useState("");
      const [, setTick] = React.useState(0);
      const now = Date.now();
      const mine = rows.filter((job) => job && String(job.kind || "").startsWith(JOB_KIND_PREFIX));
      const visible = mine
        .filter((job) => jobLive(job) || now - (Number(job.finishedAt) || 0) < SETTLED_LINGER_MS)
        .slice(-2);
      const needTick = mine.some(jobLive) || visible.length > 0;
      /* 运行中的那一行要走着秒；刚结算的行要能自己消失。 */
      React.useEffect(() => {
        if (!needTick) return undefined;
        const id = setInterval(() => setTick((n) => n + 1), 1000);
        return () => clearInterval(id);
      }, [needTick]);
      React.useEffect(() => {
        if (armed === "") return undefined;
        const id = setTimeout(() => setArmed(""), 4000);
        return () => clearTimeout(id);
      }, [armed]);
      if (visible.length === 0) return null;
      const stop = (job) => {
        if (armed !== job.id) {
          setArmed(job.id);
          return;
        }
        setArmed("");
        if (typeof killJob === "function") {
          Promise.resolve(killJob(sessionId, job.id)).catch(() => {});
        }
      };
      return h(
        "div",
        { style: P.wrap, "data-ocr-review-progress": "1" },
        h("div", { style: P.head }, t("progress.title", "评审进度")),
        visible.map((job) =>
          h(
            "div",
            { key: job.id, style: P.row },
            h("span", { style: P.state }, jobStateText(job, t)),
            h("span", { style: P.label, title: job.label }, job.label),
            h("span", { style: P.text, title: job.progress || job.detail || "" }, job.progress || job.detail || ""),
            h("span", { style: P.time }, jobElapsed(job, now)),
            jobLive(job)
              ? h("button", { type: "button", style: P.stop, onClick: () => stop(job) }, armed === job.id ? t("progress.stopConfirm", "再点一次停止") : t("progress.stop", "停止"))
              : null,
          ),
        ),
      );
    }

    /* -------------------------------- 回合尾部的「启动代码审核」按钮（按需评审的入口） */

    /** 按钮与提示的配色同样走主题 token：深/浅主题都不靠继承。 */
    const T = {
      wrap: { display: "flex", alignItems: "center", gap: 8, marginTop: 2, fontSize: 12, lineHeight: "18px", minWidth: 0 },
      btn: {
        flex: "0 0 auto",
        padding: "1px 10px",
        fontSize: 12,
        fontFamily: "inherit",
        color: "var(--dsw-alias-label-primary)",
        background: "var(--dsw-alias-bg-layer-2)",
        border: "1px solid var(--dsw-alias-border-l1)",
        borderRadius: 6,
        cursor: "pointer",
      },
      btnBusy: {
        flex: "0 0 auto",
        padding: "1px 10px",
        fontSize: 12,
        fontFamily: "inherit",
        color: "var(--dsw-alias-label-primary)",
        background: "var(--dsw-alias-bg-layer-2)",
        border: "1px solid var(--dsw-alias-border-l1)",
        borderRadius: 6,
        cursor: "default",
        opacity: 0.6,
      },
      note: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.62 },
      /* 失败也要看得见：不加重量、只加粗一档 + 前缀，避免猜一个不存在的主题色名。 */
      err: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600, opacity: 0.92 },
    };

    /**
     * 执行宿主的 `/ocr-review`。Remote 客户端契约（asar 抽出的 commands 描述符）：
     * `ctx.remote.commands.execute(agentId, line, submittedAttachments)` → `RemoteResult<{commandId, result}>`，
     * `result` 是 `{kind:"success", text?}` 或 `{kind:"error", text}`。这里把三层失败都翻成 `{ok, text}`。
     *
     * `--entry=button` 是 v0.9.0 的入口标记：插件侧靠它把「按钮点的」与「手输命令」分开记账，
     * 收下后就剥掉，不进模型提示词。手输 `/ocr-review` 不带标记 ⇒ 记成 command。
     */
    async function runOcrReviewCommand(ctx, sessionId, t) {
      const missing = (detail) => ({ ok: false, text: fmt(t("tail.callFailed", "没能启动评审：{detail}"), { detail }) });
      let res;
      try {
        res = await ctx.remote.commands.execute(sessionId, "/ocr-review --entry=button", []);
      } catch (err) {
        return missing(String((err && err.message) || err));
      }
      if (!res || res.ok !== true) {
        const err = res && res.error;
        const detail = err && typeof err === "object" ? err.message || err.code || JSON.stringify(err) : String(err);
        return missing(detail || "?");
      }
      const execution = res.value;
      if (!execution || typeof execution !== "object") return { ok: false, text: t("tail.unknownCommand", "宿主没有执行这条命令。") };
      const result = execution.result;
      if (result && result.kind === "error") return { ok: false, text: result.text || t("tail.failed", "评审没能启动。") };
      return { ok: true, text: (result && result.text) || "" };
    }

    /**
     * 席位组件的守门人：依赖没给全（宿主没有 jobs / remote.commands）就什么都不显示，
     * 插件其余部分照常 —— 见 apply 里那个子 fiber 的说明。
     */
    function ReviewTailButton(props) {
      const { useJobs, sessionId } = props;
      if (typeof useJobs !== "function" || !sessionId) return null;
      return h(ReviewTailCell, props);
    }

    /**
     * 本体：一个按钮，点了就走宿主的 `/ocr-review` 命令（设置页关掉 enabled 时，命令自己会拒绝
     * 并把原因回传）。同一会话已有 running 的评审 job 时按钮禁用并显示「正在评审…」——数据源就是
     * 进度行那份 jobs 快照，天然防重复点击。
     */
    function ReviewTailCell(props) {
      const { sessionId, useJobs, watchRows, runReview, cfgCtx } = props;
      /* 席位会把 locale 绑好传进来；万一没有，就退回内联中文原文。 */
      const t = typeof props.t === "function" ? props.t : (key, fallback) => fallback;
      const entry = React.useMemo(() => (cfgCtx ? resolveEntry(cfgCtx) : { id: ENTRY_ID, form: null }), [cfgCtx]);
      const snap = useSnapshot(entry.form || NULL_FORM);
      const rows = useJobs((state) => state.rows[sessionId]) || EMPTY_LIST;
      React.useEffect(() => (typeof watchRows === "function" ? watchRows(sessionId) : undefined), [sessionId, watchRows]);
      const [state, setState] = React.useState({ status: "idle", text: "" });
      /* 关掉总开关或按需评审就整块不出现（读到默认值时按"开着"处理，命令侧还会再兜一道）。 */
      if (valueOf(snap, fieldOf("enabled")) === false) return null;
      if (valueOf(snap, fieldOf("onDemand")) === false) return null;
      const running = rows.some((job) => job && String(job.kind || "").startsWith(JOB_KIND_PREFIX) && jobLive(job));
      const busy = running || state.status === "running";
      const start = () => {
        if (busy) return;
        setState({ status: "running", text: "" });
        Promise.resolve()
          .then(() => (typeof runReview === "function" ? runReview(sessionId) : { ok: false, text: t("tail.failed", "评审没能启动。") }))
          .then((res) => {
            if (!res || res.ok !== true) {
              setState({ status: "error", text: (res && res.text) || t("tail.failed", "评审没能启动。") });
              return;
            }
            setState({ status: "done", text: res.text || "" });
          })
          .catch((err) => setState({ status: "error", text: missingText(t, err) }));
      };
      return h(
        "div",
        { style: T.wrap, "data-ocr-review-tail": "1" },
        h(
          "button",
          {
            type: "button",
            style: busy ? T.btnBusy : T.btn,
            disabled: busy,
            title: t("tail.hint", "对这一回合的改动按需跑一次代码评审（同 /ocr-review）。"),
            onClick: start,
          },
          busy ? t("tail.running", "正在评审…") : t("tail.start", "启动代码审核"),
        ),
        state.text ? h("span", { style: state.status === "error" ? T.err : T.note, "data-ocr-tail-note": state.status, title: state.text }, state.text) : null,
      );
    }

    /** 组件内兜底：把异常翻成可显示的文案。 */
    function missingText(t, err) {
      return fmt(t("tail.callFailed", "没能启动评审：{detail}"), { detail: String((err && err.message) || err) });
    }

    function apply(ctx) {
      /* 可见文案注册到 Client locale 服务（可选服务：拿不到就退回内联 zh 原文）。
         注册是 ctx 拥有的 effect，fiber 销毁时自动撤销。 */
      ctx.inject(["locale"], (localeCtx) => {
        localeCtx.effect(() => localeCtx.locale.register(LOCALE_NS, textPairs()), "设置页文案（zh/en）");
      });
      ctx.inject(["configForms"], (scoped) => {
        /* 目录读取的服务依赖单独挂一个子 fiber（见 createRemoteScope）：
           宿主没提供 remote(.*) 时只是没有候选列表，插件本身和设置页都不受影响。 */
        const remoteScope = createRemoteScope(scoped);
        /* 设置页与导航文案：有 locale 服务就取词，没有就退回 zh 原文。 */
        const pageT = makeT(localeOf(scoped));
        scoped.slots.inject("plugins.bundle.config", () =>
          scoped.slots.register(
            {
              name: "plugins.bundle.config",
              key: BUNDLE,
              locale: LOCALE_NS,
            },
            (ownerProps = {}) =>
              ownerProps.view === "summary"
                ? h(ConfigSummary, { ctx: scoped, t: pageT })
                : h(ConfigPage, { ctx: scoped, remoteScope, t: pageT }),
          ),
        );
        // 同一个表单再挂一份到「设置」导航里（settings.section 是打开的 list 席位，id 自取）。
        scoped.slots.inject("settings.section", () =>
          scoped.slots.register(
            {
              name: "settings.section",
              id: "open-code-review",
              order: 17,
              label: pageT("section.navTitle"),
              locale: LOCALE_NS,
            },
            () => h(ConfigPage, { ctx: scoped, remoteScope, standalone: true, t: pageT }),
          ),
        );
      });

      /* 会话内进度行：直接订阅 Client jobs 服务的快照（和标题栏 Jobs 面板同一份数据）。
         拿不到 jobs 服务时这个子 fiber 保持 pending —— 插件其余部分与设置页照常工作，
         只是没有进度行（评审本身仍在 host 侧正常跑）。 */
      ctx.inject(["jobs"], (jobsCtx) => {
        jobsCtx.slots.inject("conversation.input.dock", () =>
          jobsCtx.slots.register(
            {
              name: "conversation.input.dock",
              id: "ocr-review-progress",
              order: 15,
              locale: LOCALE_NS,
              inject: () => ({
                hooks: { jobs: jobsCtx.jobs.state },
                watchRows: (sessionId) => jobsCtx.jobs.watchRows(sessionId),
                killJob: async (sessionId, jobId) => (await jobsCtx.jobs.kill(sessionId, jobId)).ok,
                /* 文案：locale 服务在就是词表，不在就是内联 zh（槽位的 locale 字段只是自报家门，
                   宿主不会替非内置命名空间注入 t）。 */
                t: makeT(localeOf(jobsCtx)),
              }),
            },
            ReviewProgressLine,
          ),
        );
      });

      /* 回合尾部的「启动代码审核」按钮：按需评审的入口之一，点了走宿主的 commands 服务执行
         /ocr-review。依赖（jobs / configForms / remote.commands）少任何一个这个子 fiber 就
         保持 pending —— 只是没有按钮，评审本身仍可由模型或手输 /ocr-review 触发。 */
      ctx.inject(["jobs", "configForms", "remote", "remote.commands"], (tailCtx) => {
        const tailT = makeT(localeOf(tailCtx));
        tailCtx.slots.inject("conversation.chat.turnTail", () =>
          tailCtx.slots.register(
            {
              name: "conversation.chat.turnTail",
              id: "ocr-review-on-demand",
              order: 30,
              locale: LOCALE_NS,
              inject: () => ({
                cfgCtx: tailCtx,
                hooks: { jobs: tailCtx.jobs.state },
                watchRows: (sessionId) => tailCtx.jobs.watchRows(sessionId),
                runReview: (sessionId) => runOcrReviewCommand(tailCtx, sessionId, tailT),
                t: tailT,
              }),
            },
            ReviewTailButton,
          ),
        );
      });
    }

    // inject 是 cordis 的服务可见性开关（package.json 的 dsh.client.inject 只影响加载/预取）。
    // 这里只写"缺了整个设置页就没意义"的服务：cordis 的注入是全有全无，把
    // "remote"/"remote.session" 写在这儿，会让"宿主没有 Remote 桥"升级成"插件永远 inactive、
    // 设置页整块消失"。那两个名字在 apply 内部的子 fiber 上声明（createRemoteScope），
    // 拿不到就只是没有候选列表、退回手输，见 README 的降级说明。
    return { apply, inject: ["slots"] };
  },
});
