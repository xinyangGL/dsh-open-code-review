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
        ["auto", "auto — 先跑 OCR 流水线，没配 LLM 时降级 delegate"],
        ["ocr", "ocr — 只用 OCR 自己的 LLM 流水线"],
        ["delegate", "delegate — 不调 LLM，只产出规则 + 文件 + diff 规格"],
      ],
      audience: [
        ["agent", "agent — 只给摘要（默认，省 token）"],
        ["human", "human — 带进度输出"],
      ],
      autoReview: [
        ["adaptive", "adaptive — 模型在跑就注入，空闲就开新回合"],
        ["inject", "inject — 只把结果注入当前上下文"],
        ["followup", "followup — 直接开一个新回合"],
        ["off", "off — 不做自动评审"],
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
    };

    /** LLM 分组标题（llmMode=endpoint 时才显示静态端点那几行）。 */
    const LLM_GROUP = "LLM 路由（ocr 引擎）";

    /**
     * 设置页字段表。顺序即渲染顺序，`group` 是分组标题；
     * number 字段的 min/max 与宿主 schema 的校验范围保持一致；
     * onlyMode 限定该行只在某种 llm.mode 下渲染（dsh 不需要地址与密钥）。
     */
    const FIELDS = [
      { key: "enabled", label: "总开关", kind: "boolean", group: "overview", default: true, hint: "关闭后停掉自动评审，且 ocr_review 与 /ocr-review 会拒绝执行（ocr_status 仍可用于诊断）。" },
      { key: "engine", label: "默认引擎", kind: "select", group: "overview", options: CHOICE.engine, hint: "模型显式传 engine 时以调用参数为准。" },
      { key: "audience", label: "输出受众", kind: "select", group: "overview", options: CHOICE.audience, hint: "映射到 ocr --audience。" },
      { key: "ocrPath", label: "ocr 可执行文件", kind: "text", group: "overview", placeholder: "留空=自动探测（Volta 真实 exe 优先）", hint: "绝对路径。留空则按 PATH、Volta、全局 npm 目录依次探测。" },

      { key: "autoReview", label: "自动评审", kind: "select", group: "auto", options: CHOICE.autoReview, hint: "触发条件：回合结束 + 本回合有文件写入。" },
      { key: "autoScope", label: "自动评审范围", kind: "select", group: "auto", options: CHOICE.autoScope, hint: "与 ocr_review 的 scope 参数同义。" },
      { key: "autoMaxPerSession", label: "每会话上限", kind: "number", group: "auto", min: 0, max: 50, hint: "每个会话最多自动评审几次（防改—评—改死循环）；0 = 不限？不，0 = 永不自动评审。" },
      { key: "autoMinReviewableFiles", label: "最少可审文件数", kind: "number", group: "auto", min: 1, max: 50, hint: "可审文件少于该值时跳过自动评审。" },
      { key: "autoMinIntervalMs", label: "最小间隔（毫秒）", kind: "number", group: "auto", min: 0, max: 3600000, hint: "两次自动评审之间的冷却时间，默认 60000。" },
      { key: "autoSkipSubagents", label: "跳过子代理会话", kind: "boolean", group: "auto", default: true, hint: "子代理（delegationDepth > 0）的回合结束不触发自动评审。" },
      { key: "autoIncludeDiff", label: "委派时带 diff", kind: "boolean", group: "auto", default: true, hint: "自动评审降级到 delegate 时，是否把 unified diff 一并放进规格。" },

      { key: "llmMode", label: "LLM 路由", kind: "select", group: "llm", options: CHOICE.llmMode, hint: "dsh（推荐）：ocr 是独立子进程、进不了 cordis，所以插件在 127.0.0.1 起一个只认随机 token 的 OpenAI 兼容小桥，把请求转给 DSH 的 ctx.llm.stream —— 模型、provider、密钥、账号轮换与配额全由 DSH 决定，下面不用填地址与 key。endpoint：ocr 直连静态端点（老行为）。" },
      { key: "llmModel", label: "模型名", kind: "model", group: "llm", placeholder: "deepseek/deepseek-v4.1-flash", hint: "映射到 OCR_LLM_MODEL。候选来自 DSH 自己的模型目录（含 Command Code 全部模型），可搜索、可手输；从候选里选中时会把它的提供方一起写进下面那行 —— 配错会报 Model not supported。" },
      { key: "llmProvider", label: "提供方（provider）", kind: "text", group: "llm", onlyMode: "dsh", placeholder: "commandcode", hint: "dsh 模式转发给 DSH 用的 provider id（DSH 模型目录里的组 id）；在「模型名」里选中候选时自动写入。" },
      { key: "llmBaseUrl", label: "端点 Base URL", kind: "text", group: "llm", onlyMode: "endpoint", placeholder: "https://api.commandcode.ai/provider/v1", hint: "endpoint 模式才用：映射到 OCR_LLM_URL。" },
      { key: "llmProtocol", label: "端点协议", kind: "select", group: "llm", onlyMode: "endpoint", options: CHOICE.llmProtocol, hint: "endpoint 模式才用：映射到 OCR_LLM_PROTOCOL。CommandCode 的 DeepSeek v4.1 只支持 openai。" },
      { key: "llmApiKeyRef", label: "API Key 引用", kind: "text", group: "llm", onlyMode: "endpoint", placeholder: "COMMANDCODE_API_KEY", hint: "endpoint 模式才用：DSH 凭据库里的引用名（映射到 OCR_LLM_TOKEN），不落明文密钥；明文密钥仍可放 config.json 的 llm.apiKey。" },

      { key: "timeoutMinutes", label: "单次超时（分钟）", kind: "number", group: "other", min: 1, max: 60, hint: "传给 ocr --timeout，同时作为插件侧硬超时。" },
      { key: "verbose", label: "调试日志", kind: "boolean", group: "other", default: false, hint: "在 DSH 日志里打印 ocr 命令行、env 与耗时。" },
    ];

    /** 设置页分组（id 给 FIELDS.group 用，name 是 zh 原文/词典兜底）。 */
    const GROUPS = [
      { id: "overview", name: "总览" },
      { id: "auto", name: "自动评审" },
      { id: "llm", name: LLM_GROUP },
      { id: "other", name: "其他" },
    ];

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
      "page.lead": "dsh-open-code-review 的设置页。同一个表单也渲染在「设置 → 插件 → dsh-open-code-review」卡片的描述下方。",
      "page.footer": "改动写进 profile 的卷动配置（volatile）并立即生效，无需重启；config.json 仍可用于这里没有的高级项（extraArgs / env / llm.apiKey）。",
      "button.save": "保存",
      "button.saving": "保存中…",
      "button.undo": "撤销",
      "button.reset": "恢复默认",
      "button.saveChanges": "保存改动",
      "button.saveAllChanges": "保存全部改动（{count}）",
      "button.resetAll": "全部恢复默认",
      "row.changed": "已改",
      "row.overridden": "这个字段被设置页覆盖过，清掉就回到默认值",
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
      "status.loading": "正在从宿主读取…",
      "status.unavailable": "这个命名空间没有暴露给浏览器，或连接处于 process-local 内存模式",
    };

    /** en 词典：字段/选项的键与 zhDictionary() 生成的一致（缺的词条会退回 zh）。 */
    const TEXT_EN = {
      "group.overview": "Overview",
      "group.auto": "Auto review",
      "group.llm": "LLM routing (ocr engine)",
      "group.other": "Other",
      "section.navTitle": "Code review",
      "page.title": "Code review (Alibaba OpenCodeReview)",
      "page.lead": "Settings page of dsh-open-code-review. The same form also renders below the description of the Settings → Plugins → dsh-open-code-review card.",
      "page.footer": "Changes go to the profile volatile config and take effect immediately without a restart; config.json still carries the advanced options that are not shown here (extraArgs / env / llm.apiKey).",
      "button.save": "Save",
      "button.saving": "Saving…",
      "button.undo": "Undo",
      "button.reset": "Reset to default",
      "button.saveChanges": "Save changes",
      "button.saveAllChanges": "Save all changes ({count})",
      "button.resetAll": "Reset everything",
      "row.changed": "changed",
      "row.overridden": "This field is overridden by the settings page; clearing it returns to the default",
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
      "status.loading": "reading from the host…",
      "status.unavailable": "this namespace is not exposed to the browser, or the connection runs in process-local memory mode",
      "field.enabled.label": "Enabled",
      "field.enabled.hint": "When off, auto review stops and ocr_review / /ocr-review refuse to run (ocr_status still works for diagnostics).",
      "field.engine.label": "Default engine",
      "field.engine.hint": "An engine passed explicitly by the model wins over this default.",
      "field.audience.label": "Output audience",
      "field.audience.hint": "Maps to ocr --audience.",
      "field.ocrPath.label": "ocr executable",
      "field.ocrPath.placeholder": "empty = auto-detect (real Volta exe first)",
      "field.ocrPath.hint": "Absolute path. Empty means probing PATH, Volta, then the global npm directory.",
      "field.autoReview.label": "Auto review",
      "field.autoReview.hint": "Triggers when a turn ends and that turn wrote files.",
      "field.autoScope.label": "Auto review scope",
      "field.autoScope.hint": "Same meaning as the scope argument of ocr_review.",
      "field.autoMaxPerSession.label": "Runs per session",
      "field.autoMaxPerSession.hint": "How many auto reviews one session may run (guards against edit-review-edit loops); 0 disables auto review entirely.",
      "field.autoMinReviewableFiles.label": "Min reviewable files",
      "field.autoMinReviewableFiles.hint": "Skip auto review when fewer reviewable files changed.",
      "field.autoMinIntervalMs.label": "Min interval (ms)",
      "field.autoMinIntervalMs.hint": "Cooldown between two auto reviews, 60000 by default.",
      "field.autoSkipSubagents.label": "Skip subagent sessions",
      "field.autoSkipSubagents.hint": "Turns of subagents (delegationDepth > 0) do not trigger auto review.",
      "field.autoIncludeDiff.label": "Include diff when delegating",
      "field.autoIncludeDiff.hint": "Whether the unified diff is put into the review spec when auto review degrades to delegate.",
      "field.llmMode.label": "LLM route",
      "field.llmMode.hint": "dsh (recommended): ocr is a separate child process that cannot reach cordis, so the plugin runs a tiny OpenAI-compatible bridge on 127.0.0.1 guarded by a random token and forwards requests to DSH ctx.llm.stream — model, provider, credentials, account rotation and quota all stay with DSH, so no URL or key is needed below. endpoint: ocr talks to the static endpoint directly (previous behaviour).",
      "field.llmModel.label": "Model",
      "field.llmModel.hint": "Maps to OCR_LLM_MODEL. Candidates come from the DSH model catalog (including every Command Code model); searchable and free-form; picking a candidate also writes its provider into the row below — a mismatch reports Model not supported.",
      "field.llmProvider.label": "Provider",
      "field.llmProvider.hint": "Provider id forwarded to DSH in dsh mode (a group id of the DSH model catalog); filled in automatically when you pick a candidate.",
      "field.llmBaseUrl.label": "Endpoint base URL",
      "field.llmBaseUrl.hint": "endpoint mode only: maps to OCR_LLM_URL.",
      "field.llmProtocol.label": "Endpoint protocol",
      "field.llmProtocol.hint": "endpoint mode only: maps to OCR_LLM_PROTOCOL. CommandCode DeepSeek v4.1 only supports openai.",
      "field.llmApiKeyRef.label": "API key reference",
      "field.llmApiKeyRef.hint": "endpoint mode only: a reference name in the DSH credential store (maps to OCR_LLM_TOKEN); no plaintext secret is stored. A literal key may still go to llm.apiKey in config.json.",
      "field.timeoutMinutes.label": "Timeout (minutes)",
      "field.timeoutMinutes.hint": "Passed to ocr --timeout and used as the plugin-side hard timeout.",
      "field.verbose.label": "Debug logging",
      "field.verbose.hint": "Print the ocr command line, env and timings into the DSH log.",
      "choice.engine.auto": "auto — run the OCR pipeline first, degrade to delegate when no LLM is configured",
      "choice.engine.ocr": "ocr — only the OCR LLM pipeline",
      "choice.engine.delegate": "delegate — no LLM, just the rules + files + diff spec",
      "choice.audience.agent": "agent — summary only (default, saves tokens)",
      "choice.audience.human": "human — with progress output",
      "choice.autoReview.adaptive": "adaptive — inject while the model is running, start a new turn when idle",
      "choice.autoReview.inject": "inject — inject the result into the current context",
      "choice.autoReview.followup": "followup — start a new turn",
      "choice.autoReview.off": "off — no auto review",
      "choice.autoScope.workspace": "workspace — uncommitted working-tree changes",
      "choice.autoScope.range": "range — branch/commit range",
      "choice.autoScope.commit": "commit — a single commit",
      "choice.autoScope.scan": "scan — whole-file scan",
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
      select: { width: "100%", boxSizing: "border-box", padding: "4px 6px", fontSize: 13, fontFamily: "inherit", color: "inherit", background: "rgba(127,127,135,0.08)", border: "1px solid rgba(127,127,135,0.38)", borderRadius: 6 },
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
    };

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
      return { groups, failures };
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
      const [state, setState] = React.useState({ status: "loading", groups: [], failures: [], error: "" });
      const t = makeT(localeOf(ctx));
      const resolved = resolveCatalogCall(ctx);
      React.useEffect(() => {
        let alive = true;
        if (!resolved.call) {
          setState({ status: "unsupported", groups: [], failures: [], error: resolved.error });
          return () => {
            alive = false;
          };
        }
        setState((prev) =>
          prev.status === "loading" ? prev : { status: "loading", groups: prev.groups, failures: prev.failures, error: "" },
        );
        Promise.resolve()
          .then(() => resolved.call.call(resolved.session))
          .then((result) => {
            if (!alive) return;
            const normalized = normalizeCatalog(unwrapRemote(result, t));
            setState({ status: "ready", groups: normalized.groups, failures: normalized.failures, error: "" });
          })
          .catch((err) => {
            if (!alive) return;
            setState({ status: "error", groups: [], failures: [], error: String((err && err.message) || err) });
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
      );
    }

    function ConfigPage(props) {
      const ctx = props.ctx;
      const standalone = props.standalone === true;
      /* 可见文案走 Client locale 服务；props.t 允许调用方（或测试）直接注入取词函数。 */
      const t = React.useMemo(() => props.t || makeT(localeOf(ctx)), [props.t, ctx]);
      const labelText = React.useCallback((key) => t("field." + key + ".label", labelOf(key)), [t]);
      const remoteScope = props.remoteScope;
      const entry = React.useMemo(() => resolveEntry(ctx), [ctx]);
      const form = entry.form;
      const snap = useSnapshot(form || NULL_FORM);
      const [draft, setDraft] = React.useState({});
      const [busy, setBusy] = React.useState("");
      const [msg, setMsg] = React.useState(null);

      const disabled = snap.status !== "ready" || snap.writable === false;
      const dirtyKeys = Object.keys(draft);
      /* 草稿优先：改过的控件要立刻显示新值（否则下拉看起来像没生效）。 */
      const currentValue = (field) => (Object.prototype.hasOwnProperty.call(draft, field.key) ? draft[field.key] : valueOf(snap, field));
      /* dsh 模式藏掉静态端点那几行（它们对桥不起作用），endpoint 模式则藏掉 provider。 */
      const llmMode = String(currentValue(fieldOf("llmMode")) ?? "") === "endpoint" ? "endpoint" : "dsh";
      const visibleField = (field) => !field.onlyMode || field.onlyMode === llmMode;

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
        for (const key of Object.keys(draft)) await write(key, "set");
      }, [draft, write]);

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
            { value: value === undefined ? "" : String(value), disabled, onChange: (e) => change(field.key, e.target.value), style: S.select },
            (field.options || []).map(([optionValue, text]) => h("option", { key: optionValue, value: optionValue }, t("choice." + field.key + "." + optionValue, text))),
          );
        }
        const raw = value === undefined || value === null ? "" : String(value);
        if (field.kind === "model") {
          return h(ModelPicker, {
            ctx,
            remoteScope,
            field,
            value: raw,
            disabled,
            dirty: Object.prototype.hasOwnProperty.call(draft, field.key),
            onChange: (next, provider) => {
              change(field.key, next);
              if (provider) change("llmProvider", provider);
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
        const dirty = Object.prototype.hasOwnProperty.call(draft, field.key);
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

      const statusLine = () => {
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
        GROUPS.map((group) =>
          h(
            "div",
            { key: group.id, style: S.section },
            h("p", { style: S.sectionTitle }, t("group." + group.id, group.name)),
            FIELDS.filter((field) => field.group === group.id && visibleField(field)).map(row),
          ),
        ),
        h(
          "p",
          { style: S.footer },
          t("page.footer"),
        ),
      );
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
            (ownerProps = {}) => (ownerProps.view === "summary" ? null : h(ConfigPage, { ctx: scoped, remoteScope, t: pageT })),
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
    }

    // inject 是 cordis 的服务可见性开关（package.json 的 dsh.client.inject 只影响加载/预取）。
    // 这里只写"缺了整个设置页就没意义"的服务：cordis 的注入是全有全无，把
    // "remote"/"remote.session" 写在这儿，会让"宿主没有 Remote 桥"升级成"插件永远 inactive、
    // 设置页整块消失"。那两个名字在 apply 内部的子 fiber 上声明（createRemoteScope），
    // 拿不到就只是没有候选列表、退回手输，见 README 的降级说明。
    return { apply, inject: ["slots"] };
  },
});
