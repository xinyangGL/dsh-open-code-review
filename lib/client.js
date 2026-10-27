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
        ["ocr", "ocr — 跑 OCR 自己的「确定性工程 × LLM」流水线（每文件 3~6 分钟、按 tokens 计费；v0.10.0 起默认，跑前给成本预估）"],
        ["delegate", "delegate — 不调 LLM，几秒出规则 + 文件 + diff 规格（免费档）"],
        ["auto", "auto — 先跑 OCR 流水线，没配 LLM 时降级 delegate（结论来源会随环境变化）"],
      ],
      audience: [
        ["agent", "摘要 — 只回结论与问题清单（默认，省 token）"],
        ["human", "详细 — 连评审过程一起回（更啰嗦，便于排查）"],
      ],
      llmMode: [
        ["dsh", "dsh — 走 DSH：插件本机桥 → DSH 的模型/密钥/配额（推荐）"],
        ["endpoint", "endpoint — ocr 直连下面的静态端点（老行为）"],
      ],
      llmProtocol: [
        ["openai", "openai — OpenAI 兼容的 /chat/completions 路由"],
        ["anthropic", "anthropic — Anthropic Messages 协议"],
      ],
    };

    /**
     * 配置面三分法（v0.11.0）：
     *  - basic：要做的决定，首屏 3 项（默认展开）；
     *  - route：低频但有实际取值意义的项，收进「高级设置」折叠区；
     *  - hidden：**默认不用改的项不作为配置项放出来**（用户 m01109 的原话），但键仍保留在
     *    host schema 与 config.json 里 —— 行为契约完全不变，只是不再在设置页渲染控件；
     *    诊断区会把它们的当前生效值只读列出来（含键名），想改就写 config.json。
     *
     * onlyMode 限定该行只在某种 llm.mode 下渲染（dsh 不需要地址与密钥）。
     * group=basic 的行是「要做的决定」，其余收进「高级设置」折叠区（默认收起）。
     * number 字段带 options 时渲染成「常用档位 + 自定义」组合控件，存储仍是数字。
     * optionsBasic 是下拉在设置页里实际给出的选项（比 CHOICE 里少；旧值不在其中时会补一行
     * 「当前值」，避免存量配置在 UI 上看起来是空的）。
     */
    const FIELDS = [
      { key: "enabled", label: "总开关", kind: "boolean", group: "basic", default: true, hint: "关闭后 ocr_review 与 /ocr-review 会拒绝执行（ocr_status 仍可用于诊断）。" },
      { key: "engine", label: "默认引擎", kind: "select", group: "basic", options: CHOICE.engine, hint: "出厂默认 ocr（跑流水线、跑前有成本预估）；想秒回不花钱选 delegate。三档见 README。" },
      { key: "onDemand", label: "按需评审", kind: "boolean", group: "basic", default: true, hint: "默认开：本回合有代码改动时，回合尾部出现「启动代码审核」按钮；并注册按需 skill —— 你说「验证 / 评审」时模型才跑 ocr_review。关掉后只剩模型工具与 /ocr-review 命令。" },

      /* 高级 · 模型路由（dsh 模式：ocr → 本机桥 → DSH 的模型与配额） */
      { key: "llmModel", label: "模型名", kind: "model", group: "route", providerKey: "llmProvider", placeholder: "留空 = 跟随当前对话/DSH 默认模型", hint: "映射到 OCR_LLM_MODEL。候选来自 DSH 自己的模型目录（点开输入框就能选）。留空（推荐）= 依次跟随：插件设置 → **当前对话正在用的模型** → DSH 默认模型；填了就固定用这个。" },
      { key: "llmProvider", label: "提供方（provider）", kind: "text", group: "route", onlyMode: "dsh", placeholder: "留空 = 跟随当前对话", hint: "dsh 模式转发给 DSH 用的 provider id；留空 = 跟随当前对话正在用的 provider，再退回 DSH 默认模型的 provider。在「模型名」里选中候选时自动写入。" },

      /* 以下 8 项不再作为设置页配置项（键与行为都在，只是没有控件） */
      { key: "llmMode", label: "LLM 路由", kind: "select", group: "hidden", options: CHOICE.llmMode, hint: "出厂固定 dsh（本机桥）。要直连静态端点请在 config.json 里写 llm.mode=endpoint，并同时写 llm.baseUrl / llm.protocol / llm.apiKeyRef。" },
      { key: "llmBaseUrl", label: "端点 Base URL", kind: "text", group: "hidden", onlyMode: "endpoint", placeholder: "https://api.commandcode.ai/provider/v1", hint: "endpoint 模式才用：映射到 OCR_LLM_URL。" },
      { key: "llmProtocol", label: "端点协议", kind: "select", group: "hidden", onlyMode: "endpoint", options: CHOICE.llmProtocol, hint: "endpoint 模式才用：映射到 OCR_LLM_PROTOCOL。CommandCode 的 DeepSeek v4.1 只支持 openai。" },
      { key: "llmApiKeyRef", label: "API Key 引用", kind: "text", group: "hidden", onlyMode: "endpoint", placeholder: "COMMANDCODE_API_KEY", hint: "endpoint 模式才用：DSH 凭据库里的引用名（映射到 OCR_LLM_TOKEN），不落明文密钥；明文密钥仍可放 config.json 的 llm.apiKey。" },
      { key: "audience", label: "结果详细程度", kind: "select", group: "hidden", options: CHOICE.audience, hint: "映射到 ocr --audience。" },
      { key: "ocrPath", label: "ocr 可执行文件", kind: "text", group: "hidden", placeholder: "留空=自动探测（Volta 真实 exe 优先）", hint: "绝对路径。留空则按 PATH、Volta、全局 npm 目录依次探测。Windows 上要指原生 exe，别指 .cmd。" },
      { key: "timeoutMinutes", label: "单次超时（分钟）", kind: "number", group: "hidden", min: 1, max: 60, hint: "传给 ocr --timeout，同时作为插件侧硬超时；要更大的值请直接写 config.json 的 maxTimeoutMinutes。" },
      { key: "verbose", label: "调试日志", kind: "boolean", group: "hidden", default: false, hint: "在 DSH 日志里打印 ocr 命令行、env 与耗时。" },
    ];

    /**
     * 设置页分组：basic 是「要做的决定」（默认展开），其余收进下方「高级设置」折叠区
     * （默认收起，点标题才展开）。group=hidden 的字段不属于任何一组，页面不渲染控件，
     * 只在诊断区里只读列出。
     */
    const GROUPS = [
      { id: "basic", name: "基础" },
      { id: "route", name: "模型路由", advanced: true },
    ];

    /** 折叠区里所有字段都按这个顺序渲染。 */
    const ADVANCED_GROUPS = GROUPS.filter((group) => group.advanced);
    const BASIC_GROUPS = GROUPS.filter((group) => !group.advanced);
    /** 不作为配置项露出的字段（键仍在 host schema / config.json 里，诊断区只读展示）。 */
    const HIDDEN_FIELDS = FIELDS.filter((field) => field.group === "hidden");

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
      "advanced.collapsedHint": "低频参数已收起（模型路由）。默认值对多数人够用；要改就点上面的标题展开。",
      "advanced.dirty": "{count} 项待保存",
      "advanced.dirtyTitle": "折叠的高级项里有还没保存的改动",
      "preset.unset": "默认（跟随出厂值）",
      "preset.custom": "自定义…",
      "card.lead": "只读摘要。完整设置：设置 → 代码评审。",
      "card.more": "在上面点「代码评审」可以改这些值（含高级项）。",
      "card.on": "开",
      "card.off": "关",
      "card.unset": "跟随默认",
      "diagnostics.title": "诊断（只读）",
      "diagnostics.lead": "下面这些值当前生效，但不再作为设置项露出 —— 默认不用改。要改就写 config.json（键名即是写法）。运行期实况（本机桥地址、按入口计数、凭据来源）跑一次 ocr_status 就能看到。",
      "diagnostics.entryLabel": "宿主条目",
      "diagnostics.hidden": "已收起的配置项（{count}）",
      "diagnostics.hiddenHint": "当前生效值，只读。「键名」是 config.json 里的写法。",
      "preset.currentValue": "{value}（当前值 · 保存前不变）",
      "diagnostics.common": "常被问到的三项",
      "diagnostics.commonText": "llm.mode = endpoint（直连静态端点，需同时写 llm.baseUrl / llm.protocol / llm.apiKeyRef）、maxTimeoutMinutes（超时上限）。",
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
      "picker.timeout": "等待 {seconds} 秒没有响应",
      "picker.retry": "重试读取目录",
      "picker.error": "读取 DSH 模型目录失败：{error}。直接手输模型名即可。",
      "picker.empty": "DSH 模型目录里没有可用模型，直接手输模型名即可。",
      "picker.current": "当前：{name}{group}。",
      "picker.failures": "；{count} 个提供方没读出来",
      "picker.candidates": "{head}候选来自 DSH 自己的模型目录：{count} 个模型{extra}。可搜索、可手输；从候选里选中会把提供方一起写上。",
      "picker.dshDefault": "DSH 默认模型：{provider} / {model}；模型名与提供方留空就跟着它走（密钥与配额也由 DSH 决定）。",
      "picker.menuHead": "DSH 模型目录 · {count} 个模型",
      "picker.listLabel": "DSH 模型候选",
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
    /* v0.12.4（M9）：就绪态只说人话 —— entry id / state / mode / writable 这些宿主内部字段只在异常态出现。 */
    "status.readyDsh": "插件已就绪 · 配置改动立即生效 · 评审用 DSH 的模型与额度",
    "status.readyEndpoint": "插件已就绪 · 配置改动立即生效 · 评审走你自己配的 LLM 端点",
      "status.loading": "正在从宿主读取…",
      "status.unavailable": "这个命名空间没有暴露给浏览器，或连接处于 process-local 内存模式",
      "tail.start": "启动代码审核",
      "tail.running": "正在评审…",
      "tail.hint": "对这一回合的改动按需跑一次代码评审（同一条 /ocr-review 命令）。",
      "tail.callFailed": "没能启动评审：{detail} → 先跑 ocr_status 看接入状态。",
    /* 副行代价标签（批 2）：点下去之前先知道大概要花多久、花不花钱。档位来自设置页那份配置快照。 */
    "tail.costOcr": "ocr 档：约 3~10 分钟/文件、按 tokens 计费 · 跑前会先给预估",
    "tail.costDelegate": "delegate 档：不调 LLM，几秒出规格 · 由当前模型按规则审",
    "tail.costAuto": "auto 档：配了 LLM 就走 ocr 流水线（约 3~10 分钟/文件）",
    "tail.costUnknown": "点下后会先给范围与成本预估",
      "tail.unknownCommand": "宿主没有执行这条命令：/ocr-review 可能没注册，或返回了空结果。",
      "tail.failed": "评审没能启动，宿主没给出原因：跑 ocr_status 看接入状态（多半是 ocr 没装好或模型路由没配）。",
    /* v0.12.4（M2）：点下去之前先知道这一下要审多少东西。读不到数字就只说档位，不编数。 */
    "tail.changes": "本回合 {count} 个文件改动",
    /* v0.12.4（M4）：首次使用的落点 —— 设置页 basic 区的三步静态引导。 */
    "gettingStarted.title": "三步开始用",
    "gettingStarted.step1": "① 装 ocr：npm i -g @alibaba-group/open-code-review（Windows 需要原生 exe，见 README）。",
    "gettingStarted.step2": "② 在「高级设置 → 模型路由」里点开模型下拉，选一个候选（会同时写入 provider）。",
    "gettingStarted.step3": "③ 有改动的回合点回合尾部的「启动代码审核」，或直接说「评审一下」／用 /ocr-review。",
    };

    /** en 词典：字段/选项的键与 zhDictionary() 生成的一致（缺的词条会退回 zh）。 */
    const TEXT_EN = {
      "group.basic": "Basics",
      "group.route": "Model routing",
      "section.navTitle": "Code review",
      "page.title": "Code review (Alibaba OpenCodeReview)",
      "page.lead": "Settings page of dsh-open-code-review. Decisions live under Basics; low-frequency parameters are folded into Advanced settings below (click to expand). The same form also renders on the Settings → Plugins → dsh-open-code-review card.",
      "page.footer": "Changes take effect immediately and are stored in the current profile (they do not follow you to another profile or machine — just set them again). The config.json in the plugin directory is only the file layer; it carries keys the settings page does not show (extraArgs / env / llm.apiKey / maxTimeoutMinutes). A plugin installed from GitHub (git install) lives inside node_modules and is overwritten on upgrade, so use <DSH_HOME>/dsh-open-code-review.json instead. Run ocr_status to see where each key actually comes from.",
      "page.sourceHint": "Rows marked “{badge}” were changed from the settings page; unmarked rows use the factory default or the file layer.",
      "advanced.title": "Advanced settings ({count})",
      "advanced.collapsedHint": "Low-frequency parameters are folded away (model routing). The defaults suit most setups; click the title above to expand.",
      "advanced.dirty": "{count} unsaved",
      "advanced.dirtyTitle": "Some folded advanced fields have unsaved changes",
      "preset.unset": "Default (factory value)",
      "preset.custom": "Custom…",
      "card.lead": "Read-only summary. Full settings: Settings → Code review.",
      "card.more": "Click “Code review” above to change these values (including the advanced ones).",
      "card.on": "on",
      "card.off": "off",
      "card.unset": "default",
      "diagnostics.title": "Diagnostics (read-only)",
      "diagnostics.lead": "These values are in effect but are no longer exposed as settings — you normally never change them. To change one, write config.json (the key name is the config.json spelling). For runtime facts (bridge address, per-entry counters, credential source) run ocr_status.",
      "diagnostics.entryLabel": "Host entry",
      "diagnostics.hidden": "Folded configuration keys ({count})",
      "diagnostics.hiddenHint": "Currently effective values, read-only. “Key” is the config.json spelling.",
      "preset.currentValue": "{value} (current value · unchanged until saved)",
      "diagnostics.common": "Three that get asked about",
      "diagnostics.commonText": "llm.mode = endpoint (talk to a static endpoint directly — write llm.baseUrl / llm.protocol / llm.apiKeyRef as well), maxTimeoutMinutes (the hard timeout ceiling).",
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
      "picker.timeout": "no response after {seconds}s",
      "picker.retry": "Retry the catalog",
      "picker.error": "Failed to read the DSH model catalog: {error}. Just type the model name.",
      "picker.empty": "The DSH model catalog has no usable model; just type the model name.",
      "picker.current": "Current: {name}{group}.",
      "picker.failures": "; {count} provider(s) could not be read",
      "picker.dshDefault": "DSH default model: {provider} / {model}. Leave model and provider empty to follow it (keys and quota come from DSH too).",
      "picker.candidates": "{head}Candidates come from the DSH model catalog: {count} model(s){extra}. Searchable and free-form; picking one also records its provider.",
      "picker.menuHead": "DSH model catalog · {count} model(s)",
      "picker.listLabel": "DSH model candidates",
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
    "status.readyDsh": "Plugin ready · config changes apply immediately · reviews use DSH's models and quota",
    "status.readyEndpoint": "Plugin ready · config changes apply immediately · reviews use your own LLM endpoint",
      "status.loading": "reading from the host…",
      "status.unavailable": "this namespace is not exposed to the browser, or the connection runs in process-local memory mode",
      "tail.start": "Start code review",
      "tail.running": "Reviewing…",
      "tail.hint": "Run one on-demand code review for this turn (the same /ocr-review command).",
      "tail.callFailed": "Could not start the review: {detail}",
    "tail.costOcr": "ocr engine: ~3–10 min per file, billed per token · an estimate comes first",
    "tail.costDelegate": "delegate engine: no LLM call, spec in seconds · your model reviews by the rules",
    "tail.costAuto": "auto engine: uses the OCR pipeline when an LLM is configured (~3–10 min per file)",
    "tail.costUnknown": "you'll get the scope and cost estimate before it runs",
      "tail.unknownCommand": "The host did not run the command: /ocr-review may not be registered, or it returned nothing.",
      "tail.failed": "The review did not start and the host gave no reason: run ocr_status (usually ocr is not installed, or the model route is unset).",
    "tail.changes": "{count} changed file(s) this turn",
    "gettingStarted.title": "Three steps to start",
    "gettingStarted.step1": "1. Install ocr: npm i -g @alibaba-group/open-code-review (Windows needs the native exe; see README).",
    "gettingStarted.step2": "2. Under Advanced settings → Model routing, open the model dropdown and pick a candidate (it writes the provider too).",
    "gettingStarted.step3": "3. On a turn with changes, click Start code review at the turn tail — or just say \"review this\", or use /ocr-review.",
      "field.enabled.label": "Enabled",
      "field.enabled.hint": "When off, ocr_review / /ocr-review refuse to run (ocr_status still works for diagnostics).",
      "field.engine.label": "Default engine",
      "field.engine.hint": "An engine passed explicitly by the model wins over this default. The factory default is ocr (runs OCR's pipeline and shows a cost estimate before it starts); pick delegate for a free spec in seconds. See “Choosing an engine” in the README for the three tiers.",
      "field.audience.label": "Result detail",
      "field.audience.hint": "Maps to ocr --audience.",
      "field.ocrPath.label": "ocr executable",
      "field.ocrPath.placeholder": "empty = auto-detect (real Volta exe first)",
      "field.ocrPath.hint": "Absolute path. Empty means probing PATH, Volta, then the global npm directory.",
      "field.onDemand.label": "On-demand review",
      "field.onDemand.hint": "On by default: every completed turn ends with a “Start code review” button, and a runtime skill tells the model to run ocr_review when you ask it to verify/review. Turning it off leaves only the model tool and the /ocr-review command.",
      "field.llmMode.label": "LLM route",
      "field.llmMode.hint": "dsh (recommended): ocr is a separate child process that cannot reach cordis, so the plugin runs a tiny OpenAI-compatible bridge on 127.0.0.1 guarded by a random token and forwards requests to DSH ctx.llm.stream — model, provider, credentials, account rotation and quota all stay with DSH, so no URL or key is needed below. endpoint: ocr talks to the static endpoint directly (previous behaviour).",
      "field.llmModel.label": "Model",
      "field.llmModel.placeholder": "empty = follow the current conversation / the DSH default model",
      "field.llmModel.hint": "Maps to OCR_LLM_MODEL; empty follows the DSH default model (dsh mode). Candidates come from the DSH model catalog, searchable and free-form; picking one also writes its provider — a mismatch reports Model not supported.",
      "field.llmProvider.label": "Provider",
      "field.llmProvider.placeholder": "empty = follow the current conversation",
      "field.llmProvider.hint": "Provider id forwarded to DSH in dsh mode (a group id of the DSH model catalog); leave it empty to follow the provider of the DSH default model. Filled in automatically when you pick a candidate.",
      "field.llmBaseUrl.label": "Endpoint base URL",
      "field.llmBaseUrl.placeholder": "https://api.commandcode.ai/provider/v1",
      "field.llmBaseUrl.hint": "endpoint mode only: maps to OCR_LLM_URL.",
      "field.llmProtocol.label": "Endpoint protocol",
      "field.llmProtocol.hint": "endpoint mode only: maps to OCR_LLM_PROTOCOL. CommandCode DeepSeek v4.1 only supports openai.",
      "field.llmApiKeyRef.label": "API key reference",
      "field.llmApiKeyRef.placeholder": "COMMANDCODE_API_KEY",
      "field.llmApiKeyRef.hint": "endpoint mode only: a reference name in the DSH credential store (maps to OCR_LLM_TOKEN); no plaintext secret is stored. A literal key may still go to llm.apiKey in config.json.",
      "field.timeoutMinutes.label": "Timeout (minutes)",
      "field.timeoutMinutes.hint": "Passed to ocr --timeout and used as the plugin-side hard timeout; this table is capped at the factory value — write config.json for anything larger.",
      "field.verbose.label": "Debug logging",
      "field.verbose.hint": "Print the ocr command line, env and timings into the DSH log.",
      "choice.engine.ocr": "ocr — run OCR's own “deterministic engineering × LLM” pipeline (3–6 minutes per file, billed by tokens; the factory default since 0.10.0, with a cost estimate before it starts)",
      "choice.engine.delegate": "delegate — no LLM, rules + files + diff spec in seconds (the free tier)",
      "choice.engine.auto": "auto — run the OCR pipeline first, degrade to delegate when no LLM is configured (the source of the conclusion then depends on the machine)",
      "choice.audience.agent": "summary — conclusions and the issue list only (default, saves tokens)",
      "choice.audience.human": "detailed — include the review process (wordier, easier to debug)",
      "choice.llmMode.dsh": "dsh — through DSH: plugin-local bridge → DSH model / credentials / quota (recommended)",
      "choice.llmMode.endpoint": "endpoint — ocr talks to the static endpoint below (previous behaviour)",
      "choice.llmProtocol.openai": "openai — OpenAI-compatible /chat/completions route",
      "choice.llmProtocol.anthropic": "anthropic — Anthropic Messages protocol",
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

    /* 模型候选菜单的 id 序号：给输入框的 aria-controls / aria-activedescendant 用（可访问性）。 */
    let modelMenuSeq = 0;

    const S = {
      wrap: { fontSize: 13, lineHeight: 1.6, color: "inherit" },
      head: { margin: "0 0 12px" },
      title: { fontSize: 15, fontWeight: 600, margin: "0 0 4px" },
      lead: { fontSize: 12, opacity: 0.6, margin: 0, wordBreak: "break-word" },
      status: { fontSize: 12, opacity: 0.68, margin: "0 0 12px", display: "flex", flexWrap: "wrap", gap: "4px 12px" },
      section: { margin: "0 0 12px" },
      sectionTitle: { fontSize: 12, fontWeight: 600, opacity: 0.58, letterSpacing: "0.04em", margin: "0 0 8px" },
      row: { display: "grid", gridTemplateColumns: "minmax(140px, 190px) minmax(0, 1fr)", gap: "4px 12px", alignItems: "start", padding: "4px 0", borderTop: "1px solid var(--dsw-alias-border-l1)" },
      label: { fontSize: 13, opacity: 0.9, paddingTop: 4, wordBreak: "break-word" },
      control: { minWidth: 0 },
      input: { width: "100%", boxSizing: "border-box", padding: "4px 8px", fontSize: 13, fontFamily: "inherit", color: "inherit", background: "var(--dsw-alias-bg-layer-1, Canvas)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 6 },
      select: { width: "100%", boxSizing: "border-box", padding: "4px 8px", fontSize: 13, fontFamily: "inherit", color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-layer-2)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 6 },
      /* 原生弹出层是浏览器画的：必须显式给配色，否则「继承来的文字色 × 系统的弹层底色」
         会撞成白底白字（真机踩过：选项都在 DOM 里，但看起来像没有别的选项）。 */
      option: { color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-overlay)" },
      hint: { fontSize: 12, opacity: 0.58, marginTop: 4, wordBreak: "break-word" },
      note: { fontSize: 11, opacity: 0.62, marginTop: 4, wordBreak: "break-word" },
      noteBtn: { marginLeft: 8, padding: "0 8px", fontSize: 11, fontFamily: "inherit", color: "inherit", background: "transparent", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 6, cursor: "pointer" },
      comboRow: { display: "flex", gap: 4, alignItems: "stretch" },
      comboBtn: { flex: "0 0 auto", padding: "0 8px", fontSize: 12, fontFamily: "inherit", color: "inherit", background: "transparent", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 6, cursor: "pointer" },
      /* 浮层固定用 `bg-layer-3`（UI 规范）：不再靠 guessBg() 沿 DOM 往上猜底色 —— 猜到的常常是
         α<0.95 的叠层色，菜单就成了半透明、文字穿透（2026-10-13 真机截图确认过）。 */
      menu: { position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, zIndex: 40, maxHeight: "min(264px, 42vh)", overflowY: "auto", background: "var(--dsw-alias-bg-layer-3, Canvas)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 8, boxShadow: "0 10px 28px rgba(0,0,0,0.32)", padding: 4 },
      /* 抬头是 sticky：底色必须不透明，否则滚动时下面的候选会从字缝里透出来。 */
      menuHead: { fontSize: 11, opacity: 0.62, padding: "4px 8px 8px", position: "sticky", top: 0, background: "var(--dsw-alias-bg-layer-3, Canvas)" },
      menuEmpty: { fontSize: 12, opacity: 0.62, padding: 8 },
      menuItem: { display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", padding: "4px 8px", borderRadius: 6, cursor: "pointer" },
      menuItemActive: { display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", padding: "4px 8px", borderRadius: 6, cursor: "pointer", background: "var(--dsw-alias-bg-layer-2, Canvas)" },
      menuItemText: { minWidth: 0, flex: "1 1 auto" },
      menuItemName: { fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      menuItemSub: { fontSize: 11, opacity: 0.58, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      menuItemGroup: { flex: "0 0 auto", fontSize: 10.5, opacity: 0.58, whiteSpace: "nowrap" },
      actions: { display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" },
      btn: { padding: "4px 8px", fontSize: 12, fontFamily: "inherit", color: "inherit", background: "transparent", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 6, cursor: "pointer" },
      btnPrimary: { padding: "4px 8px", fontSize: 12, fontFamily: "inherit", color: "inherit", background: "var(--dsw-alias-bg-layer-1, Canvas)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 6, cursor: "pointer", fontWeight: 600 },
      msg: (kind) => ({ fontSize: 12, margin: "8px 0 0", color: kind === "err" ? "var(--dsw-alias-label-error)" : "inherit", opacity: kind === "err" ? 1 : 0.75 }),
      pill: { marginLeft: 8, padding: "0 8px", fontSize: 10.5, lineHeight: "15px", borderRadius: 999, border: "1px solid var(--dsw-alias-border-l1)", opacity: 0.8, display: "inline-block", verticalAlign: "middle" },
      footer: { fontSize: 12, opacity: 0.55, marginTop: 12, wordBreak: "break-word" },
      /* 「常用档位 + 自定义」组合控件：下拉占满，自定义输入框固定窄列。
         `position: relative` 必须留在这个键里 —— 它是 S.menu（position:absolute + top:100%）的定位基准。
         2026-10-13 真机踩过：这个键原先写了两遍，后一个覆盖掉前一个的 `position: relative`，
         菜单的定位基准于是变成设置面板本身（面板是 overflow:hidden），
         `top: 100%` = 面板底部下方 ⇒ 点开下拉「什么也看不见」（DOM 里有菜单，屏幕上没有）。 */
      combo: { position: "relative", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8, alignItems: "center" },
      comboCustom: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 118px", gap: 8, alignItems: "center" },
      /* 高级设置折叠区：默认收起，只留一行可点的标题。 */
      /* 高级设置折叠区：容器底色用 layer-1（规范：只许用 layer-1/2/3，不许自造 α 叠层色）。 */
      advanced: { margin: "0 0 12px", padding: "8px 12px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-layer-1, Canvas)" },
      advancedHead: { display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: 0, margin: 0, fontFamily: "inherit", fontSize: 12, fontWeight: 600, color: "inherit", background: "transparent", border: "none", cursor: "pointer", opacity: 0.78 },
      /* 卡片摘要视图：只读的「标签 / 值」两列。 */
      summaryRow: { display: "grid", gridTemplateColumns: "minmax(120px, 170px) minmax(0, 1fr)", gap: "4px 12px", padding: "4px 0" },
      summaryValue: { fontSize: 13, opacity: 0.85, wordBreak: "break-word" },
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

    /** 目录读取的超时：远端一直不回就早点收场，别让候选框永远停在「正在读取…」。 */
    const CATALOG_TIMEOUT_MS = 8000;

    /**
     * 读取 DSH 自己的模型目录：`ctx.remote.session.modelCatalog()`（客户端 namespace `session`
     * 由宿主服务 sessionController 生成，描述逐字："Host service backing the generated
     * `ctx.remote.session` namespace."），所以浏览器侧不需要自己的 Remote 方法。
     * 取不到时降级成"纯文本输入"，只影响候选列表。
     *
     * 依赖数组是 `[ctx, unsupported, unsupportedReason, nonce]`（见函数末尾），三条约束都别动：
     * 1. **`resolved.call` 绝不能进 deps**：它是每次读属性都新生成的包装函数（生成的 namespace 就是
     *    这样），放进 deps 会让每次渲染都重取一次目录，而取完 setState 又触发渲染 —— 真机上就是
     *    请求风暴（2026-10-13 实测同一地址连出 30+ 条），界面永远停在「正在读取…」（模型名选不动
     *    的根因）。函数与会话对象已用 ref 接住。
     * 2. **`ctx` 必须留**：子 fiber 迟到激活时（设置页先渲染、`remote` 服务后到）靠它重取一次目录，
     *    才能从兜底读取口换成官方读法 —— `test/client-smoke.mjs` 的「服务迟到」场景钉的就是这条。
     *    `ctx` 只随宿主的渲染变，不会被本组件自己的 setState 改掉，因此不会自激。
     * 3. **`locale` 不能拿来顶替 `ctx`**：`localeOf(ctx)` 返回的是 locale **服务对象**，不是原始值，
     *    当依赖只是又换了一种对象；它在这里只用于取文案 `t`，而文案不参与「要不要重取目录」的判定。
     */
    function useModelCatalog(ctx) {
      const [state, setState] = React.useState({ status: "loading", groups: [], failures: [], error: "", default: null });
      const [nonce, setNonce] = React.useState(0);
      const locale = localeOf(ctx);
      const t = makeT(locale);
      const resolved = resolveCatalogCall(ctx);
      const callRef = React.useRef(resolved.call);
      callRef.current = resolved.call;
      const sessionRef = React.useRef(resolved.session);
      sessionRef.current = resolved.session;
      const unsupported = !resolved.call;
      const unsupportedReason = resolved.error;
      React.useEffect(() => {
        let alive = true;
        let timer = null;
        const settle = (next) => {
          if (!alive) return;
          alive = false;
          if (timer !== null) clearTimeout(timer);
          setState(next);
        };
        if (unsupported) {
          setState({ status: "unsupported", groups: [], failures: [], error: unsupportedReason, default: null });
          return () => {
            alive = false;
          };
        }
        setState((prev) =>
          prev.status === "loading" ? prev : { status: "loading", groups: prev.groups, failures: prev.failures, error: "", default: prev.default },
        );
        /* 远端一直不回也得收场：否则候选框永远停在 loading，用户以为「坏了、点不动」。 */
        timer = setTimeout(
          () => settle({ status: "error", groups: [], failures: [], error: fmt(t("picker.timeout"), { seconds: CATALOG_TIMEOUT_MS / 1000 }), default: null }),
          CATALOG_TIMEOUT_MS,
        );
        Promise.resolve()
          .then(() => callRef.current.call(sessionRef.current))
          .then((result) => {
            const normalized = normalizeCatalog(unwrapRemote(result, t));
            settle({ status: "ready", groups: normalized.groups, failures: normalized.failures, error: "", default: normalized.default });
          })
          .catch((err) => settle({ status: "error", groups: [], failures: [], error: String((err && err.message) || err), default: null }));
        return () => {
          alive = false;
          if (timer !== null) clearTimeout(timer);
        };
      }, [ctx, unsupported, unsupportedReason, nonce]);
      return { state, retry: () => setNonce((n) => n + 1) };
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
      const { state: catalog, retry: retryCatalog } = useModelCatalog(remoteCtx || props.ctx);
      /* dsh 路由下：留空就跟随 DSH 默认模型，所以把当前默认模型直接显示出来。 */
      const showDshDefault = props.mode === "dsh";
      const [open, setOpen] = React.useState(false);
      const [query, setQuery] = React.useState(null);
      const [active, setActive] = React.useState(0);
      const wrapRef = React.useRef(null);
      /* 菜单 id：输入框靠 aria-controls / aria-activedescendant 指向它（可访问性）。 */
      const menuId = React.useMemo(() => `ocr-model-menu-${++modelMenuSeq}`, []);

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

      /** 下拉是不透明浮层，颜色取自最近的不透明祖先背景（主题明暗都适用）。
       *  只认「真正不透明」的背景：半透明叠层（rgba 且 alpha < 0.95）不能算。
       *  2026-10-13 真机踩过：第一版只排除 transparent，于是取到了 rgba(127,127,135,0.045) 这种叠层，
       *  菜单变成半透明，候选文字与后面的说明文字互相穿透（能用，但看不清）。 */
      const openMenu = () => {
        setOpen(true);
        setActive(0);
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
            {
              style: S.menu,
              id: menuId,
              role: "listbox",
              "aria-label": t("picker.listLabel", "DSH 模型候选"),
              "data-ocr-model-menu": true,
            },
            h("div", { style: S.menuHead }, fmt(t("picker.menuHead"), { count: flat.length })),
            shown.length === 0
              ? h("div", { style: S.menuEmpty }, text.trim() ? fmt(t("picker.noMatch"), { text: text.trim() }) : t("picker.noOptions"))
              : null,
            shown.map((item, i) =>
              h(
                "div",
                {
                  key: `${item.id}#${i}`,
                  id: `${menuId}-${i}`,
                  role: "option",
                  "aria-selected": i === active ? "true" : "false",
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
            role: "combobox",
            "aria-expanded": open ? "true" : "false",
            "aria-controls": menuId,
            "aria-autocomplete": "list",
            "aria-activedescendant": open && shown.length > 0 ? `${menuId}-${Math.min(active, shown.length - 1)}` : undefined,
            "data-ocr-model-input": true,
            onFocus: () => openMenu(),
            onChange: (e) => {
              const next = e.target.value;
              setQuery(next);
              setActive(0);
              setOpen(true);
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
              "aria-label": open ? t("picker.collapse") : t("picker.expand"),
              "aria-haspopup": "listbox",
              title: open ? t("picker.collapse") : t("picker.expand"),
              onClick: () => (open ? setOpen(false) : openMenu()),
            },
            open ? "▴" : "▾",
          ),
        ),
        menu,
        h(
          "div",
          { style: S.note },
          note(),
          catalog.status === "error" || catalog.status === "unsupported"
            ? h(
                "button",
                {
                  type: "button",
                  style: S.noteBtn,
                  disabled,
                  "data-ocr-model-retry": true,
                  onClick: () => retryCatalog(),
                },
                t("picker.retry"),
              )
            : null,
        ),
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
      const fields = FIELDS.filter((field) => BASIC_GROUPS.some((group) => group.id === field.group) && !field.onlyMode);
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
        /* 两边都按「空 = 没设置」归一：宿主表单里没有这个键时 valueOf 给 undefined，
           撤销写回 undefined 之后必须能算干净，否则那行会永远挂着「保存」。 */
        const norm = (value) => (value === undefined || value === null ? "" : String(value));
        return norm(draft[field.key]) !== norm(valueOf(snap, field));
      };
      /* hidden 组在这张页面上没有控件：不渲染的行不该出现在「待保存 / 全部恢复默认」里。 */
      const visibleFields = FIELDS.filter((field) => field.group !== "hidden");
      const dirtyKeys = visibleFields.filter(isDirty).map((field) => field.key);
      /* 草稿优先：改过的控件要立刻显示新值（否则下拉看起来像没生效）。 */
      const currentValue = (field) => (Object.prototype.hasOwnProperty.call(draft, field.key) ? draft[field.key] : valueOf(snap, field));
      /* dsh 模式藏掉静态端点那几行（它们对桥不起作用），endpoint 模式则藏掉 provider。 */
      const llmMode = String(currentValue(fieldOf("llmMode")) ?? "") === "endpoint" ? "endpoint" : "dsh";
      const visibleField = (field) => !field.onlyMode || field.onlyMode === llmMode;
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
        for (const field of visibleFields) await write(field.key, "unset");
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
          /*
           * optionsBasic：设置页只给最常改的档位（其余档位仍在 CHOICE 与 host schema 里，
           * 写 config.json 依旧有效）。存量配置落在被收起的档位上时补一行「当前值」，
           * 否则下拉会显示成第一个选项、看起来像配置丢了。
           */
          const all = field.options || [];
          const shown = Array.isArray(field.optionsBasic) && field.optionsBasic.length ? field.optionsBasic : all;
          const raw = value === undefined || value === null ? "" : String(value);
          const inList = raw === "" || shown.some(([optionValue]) => String(optionValue) === raw);
          return h(
            "select",
            { value: raw, disabled, onChange: (e) => change(field.key, e.target.value), style: selectStyle(scheme) },
            shown.map(([optionValue, text]) => h("option", { key: optionValue, value: optionValue, style: S.option }, t("choice." + field.key + "." + optionValue, text))),
            inList ? null : h("option", { key: "__current", value: raw, style: S.option }, fmt(t("preset.currentValue", "{value}（当前值 · 保存前不变）"), { value: raw })),
          );
        }
        const raw = value === undefined || value === null ? "" : String(value);
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
        /* v0.12.4（M9）：就绪态只说人话 —— entry id / state / mode / writable 都是宿主内部字段，
           只在 loading / unavailable / 只读这些异常态才露出来（那时用户才需要它们去排查）。 */
        if (snap.status === "ready" && snap.writable !== false) {
          /* 就绪态一句人话；但「评审走哪条路」是用户真会问的，保留 LLM 路由这一段。 */
          const bits = [llmMode === "dsh" ? t("status.readyDsh") : t("status.readyEndpoint")];
          bits.push(llmMode === "dsh" ? t("status.routeDsh") : t("status.routeEndpoint"));
          return h(
            "div",
            { style: S.status, "data-ocr-status": "ready" },
            h("span", { "data-ocr-status-ready": "1" }, bits.join(" · ")),
          );
        }
        const parts = [];
        parts.push(fmt(t("status.entry"), { id: entry.id }));
        if (!form) parts.push(fmt(t("status.noForm"), { ids: ENTRY_IDS.join(" / ") }));
        parts.push(fmt(t("status.state"), { status: snap.status }));
        if (snap.mode) parts.push(fmt(t("status.mode"), { mode: snap.mode }));
        parts.push(snap.writable === false ? t("status.readonly") : t("status.writable"));
        parts.push(llmMode === "dsh" ? t("status.routeDsh") : t("status.routeEndpoint"));
        if (snap.status === "loading") parts.push(t("status.loading"));
        if (snap.status === "unavailable") parts.push(t("status.unavailable"));
        return h("div", { style: S.status }, parts.map((text, i) => h("span", { key: i }, text)));
      };

      /**
       * 只读诊断区（v0.11.0 配置面三分法的第三段）：把不再露出的键连同「config.json 里的写法」
       * 一起摊开，用户需要时抄进 config.json 即可 —— 而不是在设置页给这些默认不改的项留控件。
       * 这里只读得到设置快照（浏览器侧拿不到宿主运行期数据），运行期实况一律指向 ocr_status。
       */
      const diagValue = (field) => {
        const value = currentValue(field);
        if (field.kind === "boolean") return value ? t("card.on", "开") : t("card.off", "关");
        if (value === undefined || value === null || value === "") return t("card.unset", "跟随默认");
        const hit = (field.options || []).find(([optionValue]) => String(optionValue) === String(value));
        return hit ? t("choice." + field.key + "." + hit[0], hit[1]) : String(value);
      };

      const diagnostics = () =>
        h(
          "section",
          { style: S.advanced, "data-ocr-diagnostics": "1" },
          h("p", { style: S.sectionTitle }, t("diagnostics.title", "诊断（只读）")),
          h("p", { style: S.hint }, t("diagnostics.lead")),
          /* v0.12.4（M9）：把宿主内部字段（条目 id / 状态 / 模式 / 是否可写）从状态行挪到这块只读区 ——
             就绪时状态行只说人话，排查时才来这里看。这一行刻意不带 data-ocr-diagnostics-row，
             免得混进上面「已收起的配置项（15）」的计数。 */
          h(
            "div",
            { style: S.summaryRow, "data-ocr-diagnostics-entry": "1" },
            h("span", { style: S.label }, t("diagnostics.entryLabel", "宿主条目")),
            h(
              "span",
              { style: S.summaryValue },
              [
                fmt(t("status.entry"), { id: entry.id }),
                fmt(t("status.state"), { status: snap.status }),
                snap.mode ? fmt(t("status.mode"), { mode: snap.mode }) : "",
                snap.writable === false ? t("status.readonly") : t("status.writable"),
              ]
                .filter(Boolean)
                .join(" · "),
            ),
          ),
          h("p", { style: S.sectionTitle }, fmt(t("diagnostics.hidden", "已收起的配置项（{count}）"), { count: HIDDEN_FIELDS.length })),
          h("p", { style: S.hint }, t("diagnostics.hiddenHint")),
          HIDDEN_FIELDS.map((field) =>
            h(
              "div",
              { key: field.key, style: S.summaryRow, "data-ocr-diagnostics-row": field.key },
              h("span", { style: S.label }, t("field." + field.key + ".label", field.label)),
              h("span", { style: S.summaryValue }, `${diagValue(field)} · ${field.key}`),
            ),
          ),
          h("p", { style: S.sectionTitle }, t("diagnostics.common", "常被问到的三项")),
          h("p", { style: S.hint }, t("diagnostics.commonText")),
        );

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
        /* v0.12.4（M4）：首次使用的落点 —— 三步静态引导（不占配置项，只负责把人领进门）。 */
        h(
          "section",
          { style: S.advanced, "data-ocr-getting-started": "1" },
          h("p", { style: S.sectionTitle }, t("gettingStarted.title", "三步开始用")),
          h("p", { style: S.hint }, t("gettingStarted.step1")),
          h("p", { style: S.hint }, t("gettingStarted.step2")),
          h("p", { style: S.hint }, t("gettingStarted.step3")),
        ),
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
        diagnostics(),
        h(
          "p",
          { style: S.footer },
          t("page.footer"),
        ),
      );
    }

    /* -------------------------------- 回合尾部的「启动代码审核」按钮（按需评审的入口） */

    /** 按钮与提示的配色同样走主题 token：深/浅主题都不靠继承。 */
    const T = {
      wrap: { display: "flex", alignItems: "center", gap: 8, marginTop: 2, fontSize: 12, lineHeight: "18px", minWidth: 0 },
      btn: {
        flex: "0 0 auto",
        padding: "1px 12px",
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
        padding: "1px 12px",
        fontSize: 12,
        fontFamily: "inherit",
        color: "var(--dsw-alias-label-primary)",
        background: "var(--dsw-alias-bg-layer-2)",
        border: "1px solid var(--dsw-alias-border-l1)",
        borderRadius: 6,
        cursor: "default",
        /* 不再整块降透明度：文字对比度会掉到下限以下（UI 规范：对比度下限优先于「看起来灰一点」）。 */
      },
      note: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.62 },
      /* 副行代价标签（批 2）：按钮里的小字副标题 —— 字号取 5 档里的最小档，透明度守对比度下限。 */
      cost: { display: "block", fontSize: 10.5, lineHeight: "14px", marginTop: 2, fontWeight: 400, opacity: 0.58 },
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
     * 本回合「动过工作区没有」：宿主在回合收尾时追加 `workspace/changes` 事件，事件体只有
     * `{ turn }`，真正的文件清单要按事件的 seq 去宿主那里取（`api/changes.summary`）。
     * 我们注册一份只发布数据的 conversation 定义（不发布视图节点），按钮再读本回合的数据决定
     * 是否出现 —— 第一方的 deliverables 卡片用的是同一套机制。宿主没有 uiConversation 时这一支
     * 不激活，按钮退回「总是显示」，见 changesFeedReady。
     */
    const TURN_CHANGES_KIND = "ocrTurnChanges";
    const CHANGES_SUMMARY_ROUTE = "api/changes.summary";
    const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
    const isTurnNumber = (value) => Number.isSafeInteger(value) && value >= 0;

    const ocrTurnChangesDefinition = {
      kind: TURN_CHANGES_KIND,
      match: (event) => {
        if (event.type === "turn/start") return { id: String(event.data.turn), role: "start" };
        if (event.type === "workspace/changes" && isRecord(event.data) && isTurnNumber(event.data.turn)) {
          return { id: String(event.data.turn), role: "update" };
        }
        return null;
      },
      start: (_context, match) => {
        if (match.event.type !== "turn/start") throw new Error("ocrTurnChanges start requires turn/start");
        return { turn: match.event.data.turn, changesSeq: undefined };
      },
      update: (context, match) => {
        if (match.event.type !== "workspace/changes") return context.state;
        return { ...context.state, changesSeq: match.event.seq };
      },
      /* 只发布数据：数据没变时返回同一个对象，宿主才不会白刷（引用稳定是宿主的约定）。 */
      buildLocationData: (context, scope, previous) => {
        if (scope !== "turn" || context.state === undefined) return null;
        if (
          previous
          && previous.kind === "turn"
          && previous.turn === context.state.turn
          && previous.key === TURN_CHANGES_KIND
          && previous.value
          && previous.value.changesSeq === context.state.changesSeq
        ) {
          return previous;
        }
        return {
          kind: "turn",
          turn: context.state.turn,
          key: TURN_CHANGES_KIND,
          value: { turn: context.state.turn, changesSeq: context.state.changesSeq },
        };
      },
    };

    /**
     * 席位组件的守门人：只要求 sessionId（这个席位是 session 级的）。
     */
    function ReviewTailButton(props) {
      /* 这里只要求 sessionId：宿主没给这个字段就把槽让出来，别让它渲染成错误占位符。
         「正在评审…」只由本组件自己的点击状态决定；重复点击由插件侧的单飞闸（OCR_ALREADY_RUNNING）挡。 */
      if (!props.sessionId) return null;
      return h(ReviewTailCell, props);
    }

    /**
     * 本体：一个按钮，点了就走宿主的 `/ocr-review` 命令（设置页关掉 enabled 时，命令自己会拒绝
     * 并把原因回传）。「正在评审…」与防重复点击都由本组件自己的状态 + 插件侧单飞闸负责。
     */
    /**
     * 副行代价标签（批 2 · P0-G「点前看到代价」）：**不新增任何宿主读取通道** —— 档位本来就在
     * 设置页那份配置快照里（`snap`），按钮已经读过它了。认不出档位时给一句「点下后会先给预估」，
     * **不编数字**（审批过的口径：不给美元金额，人读不懂的精度不算诚实）。这里的「约 3~10 分钟/文件」
     * 是 README 里 176~600s/文件 的保守说法。
     */
    function engineCost(t, engine) {
      const key = String(engine ?? "").trim().toLowerCase();
      if (key === "delegate") return t("tail.costDelegate", "delegate 档：不调 LLM，几秒出规格 · 由当前模型按规则审");
      if (key === "ocr") return t("tail.costOcr", "ocr 档：约 3~10 分钟/文件、按 tokens 计费 · 跑前会先给预估");
      if (key === "auto") return t("tail.costAuto", "auto 档：配了 LLM 就走 ocr 流水线（约 3~10 分钟/文件）");
      return t("tail.costUnknown", "点下后会先给范围与成本预估");
    }

    function ReviewTailCell(props) {
      const { sessionId, runReview, cfgCtx } = props;
      /* 席位会把 locale 绑好传进来；万一没有，就退回内联中文原文。 */
      const t = typeof props.t === "function" ? props.t : (key, fallback) => fallback;
      const entry = React.useMemo(() => (cfgCtx ? resolveEntry(cfgCtx) : { id: ENTRY_ID, form: null }), [cfgCtx]);
      const snap = useSnapshot(entry.form || NULL_FORM);
      const [state, setState] = React.useState({ status: "idle", text: "" });

      /*
       * 本回合有没有改动：宿主给了改动记录（changesFeedReady）时，按钮只在「本回合确实改了文件」
       * 前出现；宿主不给这一支时退回「总是显示」，不把入口藏起来。
       * 事件的 seq 只是坐标，清单要去宿主那里取：取不到（网络/404）时按「有改动」处理 —— 宁可
       * 多给一个入口，也别在用户刚改完代码时把按钮藏掉。
       */
      const feedReady = typeof props.changesFeedReady === "function" ? props.changesFeedReady() : false;
      const changes = props.turn && props.turn.data && typeof props.turn.data.get === "function" ? props.turn.data.get(TURN_CHANGES_KIND) : undefined;
      const changesSeq = feedReady && changes && Number.isSafeInteger(changes.changesSeq) ? changes.changesSeq : null;
      /* null = 不知道（fail-open，照常给入口）；数字 = 宿主明确报出的本回合改动文件数（只有 0 才隐藏）。 */
      const [changeCount, setChangeCount] = React.useState(null);
      React.useEffect(() => {
        if (changesSeq === null) {
          setChangeCount(null);
          return undefined;
        }
        let alive = true;
        const url = `${CHANGES_SUMMARY_ROUTE}?sessionId=${encodeURIComponent(sessionId)}&seq=${changesSeq}`;
        const read = typeof props.fetchChanges === "function" ? props.fetchChanges : (target) => globalThis.fetch(target);
        Promise.resolve()
          .then(() => read(url))
          .then((response) => (response && response.ok ? response.json() : null))
          .then((data) => {
            /* 只有明确读到「本回合 0 个改动」才隐藏；读不懂 / 请求失败一律按有改动处理（fail-open）。
               v0.12.4（M2）：把数字留下来喂按钮副行（「本回合 N 个文件改动」），不再压成布尔值丢掉。 */
            if (!alive) return;
            setChangeCount(data && Number.isSafeInteger(data.total) && data.total >= 0 ? data.total : null);
          })
          .catch(() => {
            if (alive) setChangeCount(null);
          });
        return () => {
          alive = false;
        };
      }, [changesSeq, sessionId, props.fetchChanges]);

      /* 关掉总开关或按需评审就整块不出现（读到默认值时按"开着"处理，命令侧还会再兜一道）。 */
      if (valueOf(snap, fieldOf("enabled")) === false) return null;
      if (valueOf(snap, fieldOf("onDemand")) === false) return null;
      /*
       * 只有「明确读到本回合 0 处改动」才隐藏。feedReady 为真但这一回合没有留下改动记录
       * （宿主没发 workspace/changes，或本回合是在页面刷新前完成的）：按「不知道」处理，
       * 照常给出入口 —— 与上面那条注释同一个取舍：宁可多给一个入口，也别在用户刚改完
       * 代码时把按钮藏掉（真机上出现过：宿主改动服务不可用时按钮整块消失，功能静默失灵）。
       */
      if (feedReady && changeCount === 0) return null;
      const busy = state.status === "running";
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
          h(
            "span",
            {
              style: T.cost,
              "data-ocr-tail-cost": String(valueOf(snap, fieldOf("engine")) ?? ""),
              "data-ocr-tail-count": changeCount === null ? "" : String(changeCount),
            },
            changeCount === null
              ? engineCost(t, valueOf(snap, fieldOf("engine")))
              : `${fmt(t("tail.changes", "本回合 {count} 个文件改动"), { count: changeCount })} · ${engineCost(t, valueOf(snap, fieldOf("engine")))}`,
          ),
        ),
        state.text ? h("span", { style: state.status === "error" ? T.err : T.note, "data-ocr-tail-note": state.status, title: state.text }, state.text) : null,
      );
    }

    /** 组件内兜底：把异常翻成可显示的文案。 */
    function missingText(t, err) {
      return fmt(t("tail.callFailed", "没能启动评审：{detail}"), { detail: String((err && err.message) || err) });
    }

    /**
     * 焦点环（可访问性）：插件所有可见样式都写在行内，而行内样式**表达不了 `:focus-visible`** ——
     * 所以这里给本次加载注入一张只有一条规则的样式表，作用域限定在插件自己的 `data-ocr-*` 容器上。
     * 幂等（同 id 只插一次）、拿不到 document 时静默跳过（测试环境就是这种）。
     */
    let focusRingDone = false;
    function ensureFocusRing() {
      if (focusRingDone) return;
      try {
        if (typeof document === "undefined" || !document.head || typeof document.getElementById !== "function") return;
        if (document.getElementById("ocr-plugin-focus-style")) {
          focusRingDone = true;
          return;
        }
        const style = document.createElement("style");
        style.id = "ocr-plugin-focus-style";
        style.textContent = [
          '[data-ocr-field-row] :focus-visible,',
          '[data-ocr-group] :focus-visible,',
          '[data-ocr-advanced] :focus-visible,',
          '[data-ocr-diagnostics] :focus-visible,',
          '[data-ocr-card-summary] :focus-visible,',
          '[data-ocr-summary-row] :focus-visible,',
          '[data-ocr-model-combo] :focus-visible,',
          '[data-ocr-review-tail] :focus-visible {',
          '  outline: 2px solid var(--dsw-alias-label-primary, currentColor);',
          '  outline-offset: 2px;',
          '}',
        ].join("\n");
        document.head.appendChild(style);
        focusRingDone = true;
      } catch {
        /* 注入失败就只是没有焦点环，不影响功能 */
      }
    }

    function apply(ctx) {
      /* 焦点环：行内样式写不出 :focus-visible，所以给这次加载注入一张极小的样式表（只覆盖插件自己的
         那些 data-ocr-* 容器）。注入失败不影响任何功能，只是没有焦点环。 */
      ensureFocusRing();
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

      /* 回合尾部的「启动代码审核」按钮：按需评审的入口之一，点了走宿主的 commands 服务执行
         /ocr-review。
         v0.12.5：这个入口连 hooks 都不给 —— 按钮照常出现、照常可点；
         防重复点击由插件侧的单飞闸负责。 */
      ctx.inject(["configForms", "remote", "remote.commands"], (tailCtx) => {
        const tailT = makeT(localeOf(tailCtx));
        /* 本回合改动记录：注册一份只发布数据的 conversation 定义（第一方 deliverables 卡片同款机制）。
           宿主没有 uiConversation、或注册失败（key 重复 / 契约不符）时只关掉脏检查这一支：
           按钮退回「总是显示」，评审本身照常 —— 宁可多一个入口，也别把入口藏掉。 */
        let changesFeedReady = false;
        tailCtx.inject(["uiConversation"], (changesCtx) => {
          /* cordis 的服务 callback 什么时候跑由宿主决定（不在上面的 try 里），所以兜底放在这里。 */
          try {
            changesCtx.effect(
              () => changesCtx.uiConversation.events.register(ocrTurnChangesDefinition),
              "本回合改动记录（启动代码审核按钮的脏检查）",
            );
            changesFeedReady = true;
          } catch {
            changesFeedReady = false;
          }
        });
        tailCtx.slots.inject("conversation.chat.turnTail", () =>
          tailCtx.slots.register(
            {
              name: "conversation.chat.turnTail",
              id: "ocr-review-on-demand",
              order: 30,
              locale: LOCALE_NS,
              inject: () => ({
                cfgCtx: tailCtx,
                runReview: (sessionId) => runOcrReviewCommand(tailCtx, sessionId, tailT),
                t: tailT,
                changesFeedReady: () => changesFeedReady,
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
