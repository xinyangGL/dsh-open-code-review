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
      llmProtocol: [
        ["openai", "openai — OpenAI 兼容的 /chat/completions 路由"],
        ["anthropic", "anthropic — Anthropic Messages 协议"],
      ],
    };

    /**
     * 设置页字段表。顺序即渲染顺序，`group` 是分组标题；
     * number 字段的 min/max 与宿主 schema 的校验范围保持一致。
     */
    const FIELDS = [
      { key: "enabled", label: "总开关", kind: "boolean", group: "总览", default: true, hint: "关闭后停掉自动评审，且 ocr_review 与 /ocr-review 会拒绝执行（ocr_status 仍可用于诊断）。" },
      { key: "engine", label: "默认引擎", kind: "select", group: "总览", options: CHOICE.engine, hint: "模型显式传 engine 时以调用参数为准。" },
      { key: "audience", label: "输出受众", kind: "select", group: "总览", options: CHOICE.audience, hint: "映射到 ocr --audience。" },
      { key: "ocrPath", label: "ocr 可执行文件", kind: "text", group: "总览", placeholder: "留空=自动探测（Volta 真实 exe 优先）", hint: "绝对路径。留空则按 PATH、Volta、全局 npm 目录依次探测。" },

      { key: "autoReview", label: "自动评审", kind: "select", group: "自动评审", options: CHOICE.autoReview, hint: "触发条件：回合结束 + 本回合有文件写入。" },
      { key: "autoScope", label: "自动评审范围", kind: "select", group: "自动评审", options: CHOICE.autoScope, hint: "与 ocr_review 的 scope 参数同义。" },
      { key: "autoMaxPerSession", label: "每会话上限", kind: "number", group: "自动评审", min: 0, max: 50, hint: "每个会话最多自动评审几次（防改—评—改死循环）；0 = 不限？不，0 = 永不自动评审。" },
      { key: "autoMinReviewableFiles", label: "最少可审文件数", kind: "number", group: "自动评审", min: 1, max: 50, hint: "可审文件少于该值时跳过自动评审。" },
      { key: "autoMinIntervalMs", label: "最小间隔（毫秒）", kind: "number", group: "自动评审", min: 0, max: 3600000, hint: "两次自动评审之间的冷却时间，默认 60000。" },
      { key: "autoSkipSubagents", label: "跳过子代理会话", kind: "boolean", group: "自动评审", default: true, hint: "子代理（delegationDepth > 0）的回合结束不触发自动评审。" },
      { key: "autoIncludeDiff", label: "委派时带 diff", kind: "boolean", group: "自动评审", default: true, hint: "自动评审降级到 delegate 时，是否把 unified diff 一并放进规格。" },

      { key: "llmBaseUrl", label: "端点 Base URL", kind: "text", group: "LLM 端点（ocr 引擎）", placeholder: "https://api.commandcode.ai/provider/v1", hint: "映射到 OCR_LLM_URL。默认值指向本机实测可用的 CommandCode 路由。" },
      { key: "llmProtocol", label: "端点协议", kind: "select", group: "LLM 端点（ocr 引擎）", options: CHOICE.llmProtocol, hint: "映射到 OCR_LLM_PROTOCOL。CommandCode 的 DeepSeek v4.1 只支持 openai。" },
      { key: "llmModel", label: "模型名", kind: "model", group: "LLM 端点（ocr 引擎）", placeholder: "deepseek/deepseek-v4.1-flash", hint: "映射到 OCR_LLM_MODEL。可搜索的下拉候选来自 DSH 自己的模型目录（含 Command Code 全部模型），也允许手输端点认识的其它名字 —— 配错会报 Model not supported。" },
      { key: "llmApiKeyRef", label: "API Key 引用", kind: "text", group: "LLM 端点（ocr 引擎）", placeholder: "COMMANDCODE_API_KEY", hint: "写的是 DSH 凭据库里的引用名（映射到 OCR_LLM_TOKEN），不落明文密钥；明文密钥仍可放 config.json 的 llm.apiKey。" },

      { key: "timeoutMinutes", label: "单次超时（分钟）", kind: "number", group: "其他", min: 1, max: 60, hint: "传给 ocr --timeout，同时作为插件侧硬超时。" },
      { key: "verbose", label: "调试日志", kind: "boolean", group: "其他", default: false, hint: "在 DSH 日志里打印 ocr 命令行、env 与耗时。" },
    ];

    const GROUPS = ["总览", "自动评审", "LLM 端点（ocr 引擎）", "其他"];

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
      msg: (kind) => ({ fontSize: 12, margin: "8px 0 0", color: kind === "err" ? "#e5534b" : "inherit", opacity: kind === "err" ? 1 : 0.75 }),
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

    /** 解析 `ctx.remote.session.modelCatalog`（可能整体不存在，也可能被抛出）。 */
    function resolveCatalogCall(ctx) {
      try {
        const session = ctx && ctx.remote ? ctx.remote.session : null;
        if (session && typeof session.modelCatalog === "function") {
          return { session, call: session.modelCatalog, error: "" };
        }
        return { session: null, call: null, error: "这个 DSH 版本没有把 ctx.remote.session.modelCatalog() 暴露给浏览器" };
      } catch (err) {
        return { session: null, call: null, error: String((err && err.message) || err) };
      }
    }

    /**
     * Remote 方法返回的是 `RemoteResult<T>` 信封（`{ ok: true, value }` / `{ ok: false, error }`，
     * 见 dsh-typert-protocol 的 types.d.ts），这里统一解包；也兼容直接返回业务值的实现。
     */
    function unwrapRemote(result) {
      if (result && typeof result === "object" && "ok" in result) {
        if (result.ok === false) {
          const err = result.error;
          const detail = err && typeof err === "object" ? err.message || err.code || JSON.stringify(err) : String(err);
          throw new Error(`Remote 调用失败：${detail}`);
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
            const normalized = normalizeCatalog(unwrapRemote(result));
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
      const catalog = useModelCatalog(props.ctx);
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
        for (const g of catalog.groups) for (const m of g.models) out.push({ id: m.id, name: m.name, description: m.description, group: g.name });
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
          /* 浏览器/测试环境拿不到 computedStyle 时用兜底色 */
        }
        return "#232326";
      };

      const openMenu = () => {
        setOpen(true);
        setActive(0);
        setBg(guessBg());
      };

      const choose = (item) => {
        onChange(item.id);
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
        if (catalog.status === "loading") return "正在读取 DSH 模型目录…（也可以直接手输）";
        if (catalog.status === "unsupported") return `没有候选列表：${catalog.error}。直接手输模型名即可。`;
        if (catalog.status === "error") return `读取 DSH 模型目录失败：${catalog.error}。直接手输模型名即可。`;
        if (!flat.length) return "DSH 模型目录里没有可用模型，直接手输模型名即可。";
        const known = flat.find((m) => m.id === String(value === undefined || value === null ? "" : value));
        const head = known ? `当前：${known.name}${known.group ? `（${known.group}）` : ""}。` : "";
        const extra = catalog.failures.length ? `；${catalog.failures.length} 个提供方没读出来` : "";
        return `${head}候选来自 DSH 自己的模型目录：${flat.length} 个模型${extra}。可搜索、可手输。`;
      };

      const menu = open
        ? h(
            "div",
            { style: Object.assign({ background: bg || "#232326" }, S.menu), "data-ocr-model-menu": true },
            h("div", { style: S.menuHead }, `DSH 模型目录 · ${flat.length} 个模型`),
            shown.length === 0
              ? h("div", { style: S.menuEmpty }, text.trim() ? `没有匹配「${text.trim()}」的模型；按回车就把这个值写进去` : "目录里没有可选项，直接手输")
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
            matches.length > shown.length ? h("div", { style: S.menuEmpty }, `还有 ${matches.length - shown.length} 个，继续输入可缩小范围`) : null,
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
            placeholder: field.placeholder,
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
              title: open ? "收起候选列表" : "展开候选列表（DSH 模型目录）",
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
      const entry = React.useMemo(() => resolveEntry(ctx), [ctx]);
      const form = entry.form;
      const snap = useSnapshot(form || NULL_FORM);
      const [draft, setDraft] = React.useState({});
      const [busy, setBusy] = React.useState("");
      const [msg, setMsg] = React.useState(null);

      const disabled = snap.status !== "ready" || snap.writable === false;
      const dirtyKeys = Object.keys(draft);

      const change = React.useCallback((key, value) => {
        setDraft((prev) => ({ ...prev, [key]: value }));
        setMsg(null);
      }, []);

      const write = React.useCallback(
        async (key, action) => {
          const field = fieldOf(key);
          if (!field) return true;
          if (!form) {
            setMsg({ kind: "err", text: "没有可用的配置表单，无法写入" });
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
              setMsg({ kind: "ok", text: `${labelOf(key)} ${action === "unset" ? "已恢复默认" : "已保存"}` });
            } else {
              setMsg({ kind: "err", text: `${labelOf(key)} 未写入：宿主拒绝了这次修改（或当前模式只读）` });
            }
            return ok;
          } catch (err) {
            setMsg({ kind: "err", text: `${labelOf(key)} 写入失败：${String((err && err.message) || err)}` });
            return false;
          } finally {
            setBusy("");
          }
        },
        [draft, form],
      );

      const saveAll = React.useCallback(async () => {
        for (const key of Object.keys(draft)) await write(key, "set");
      }, [draft, write]);

      const resetAll = React.useCallback(async () => {
        for (const field of FIELDS) await write(field.key, "unset");
      }, [write]);

      const control = (field) => {
        const value = valueOf(snap, field);
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
            (field.options || []).map(([optionValue, text]) => h("option", { key: optionValue, value: optionValue }, text)),
          );
        }
        const raw = Object.prototype.hasOwnProperty.call(draft, field.key) ? draft[field.key] : value === undefined ? "" : String(value);
        if (field.kind === "model") {
          return h(ModelPicker, {
            ctx,
            field,
            value: raw,
            disabled,
            dirty: Object.prototype.hasOwnProperty.call(draft, field.key),
            onChange: (next) => change(field.key, next),
          });
        }
        return h("input", {
          type: field.kind === "number" ? "number" : "text",
          value: raw === undefined || raw === null ? "" : raw,
          min: field.min,
          max: field.max,
          placeholder: field.placeholder,
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
            field.label,
            isOverridden(snap, field.key) ? h("span", { style: S.pill, title: "这个字段被设置页覆盖过，清掉就回到默认值" }, "已改") : null,
          ),
          h(
            "div",
            { style: S.control },
            control(field),
            dirty
              ? h(
                  "div",
                  { style: S.actions },
                  h("button", { type: "button", style: S.btnPrimary, disabled: busy === field.key, onClick: () => write(field.key, "set") }, busy === field.key ? "保存中…" : "保存"),
                  h("button", { type: "button", style: S.btn, disabled: Boolean(busy), onClick: () => change(field.key, valueOf(snap, field)) }, "撤销"),
                  h("button", { type: "button", style: S.btn, disabled: Boolean(busy), onClick: () => write(field.key, "unset") }, "恢复默认"),
                )
              : h("div", { style: S.actions }, h("button", { type: "button", style: S.btn, disabled: disabled || busy === field.key, onClick: () => write(field.key, "unset") }, "恢复默认")),
            h("div", { style: S.hint }, field.hint),
          ),
        );
      };

      const statusLine = () => {
        const parts = [];
        parts.push(`条目 ${entry.id}`);
        if (!form) parts.push(`浏览器侧没有这个条目的表单（试过 ${ENTRY_IDS.join(" / ")}）`);
        parts.push(`状态 ${snap.status}`);
        if (snap.mode) parts.push(`模式 ${snap.mode}`);
        parts.push(snap.writable === false ? "不可写" : "可写");
        if (snap.status === "loading") parts.push("正在从宿主读取…");
        if (snap.status === "unavailable") parts.push("这个命名空间没有暴露给浏览器，或连接处于 process-local 内存模式");
        return h("div", { style: S.status }, parts.map((text, i) => h("span", { key: i }, text)));
      };

      return h(
        "div",
        { style: S.wrap },
        standalone
          ? h(
              "div",
              { style: S.head },
              h("h2", { style: S.title }, "代码评审（阿里 OpenCodeReview）"),
              h(
                "p",
                { style: S.lead },
                "dsh-open-code-review 的设置页。同一个表单也渲染在「设置 → 插件 → dsh-open-code-review」卡片的描述下方。",
              ),
            )
          : null,
        statusLine(),
        h(
          "div",
          { style: S.actions },
          h("button", { type: "button", style: S.btnPrimary, disabled: disabled || dirtyKeys.length === 0 || Boolean(busy), onClick: saveAll }, dirtyKeys.length > 1 ? `保存全部改动（${dirtyKeys.length}）` : "保存改动"),
          h("button", { type: "button", style: S.btn, disabled: disabled || Boolean(busy), onClick: resetAll }, "全部恢复默认"),
        ),
        msg ? h("p", { style: S.msg(msg.kind) }, msg.text) : null,
        GROUPS.map((group) =>
          h(
            "div",
            { key: group, style: S.section },
            h("p", { style: S.sectionTitle }, group),
            FIELDS.filter((field) => field.group === group).map(row),
          ),
        ),
        h(
          "p",
          { style: S.footer },
          `改动写进 profile 的卷动配置（volatile）并立即生效，无需重启；config.json 仍可用于这里没有的高级项（extraArgs / env / llm.apiKey）。`,
        ),
      );
    }

    function apply(ctx) {
      ctx.inject(["configForms"], (scoped) => {
        scoped.slots.inject("plugins.bundle.config", () =>
          scoped.slots.register(
            {
              name: "plugins.bundle.config",
              key: BUNDLE,
            },
            (ownerProps = {}) => (ownerProps.view === "summary" ? null : h(ConfigPage, { ctx: scoped })),
          ),
        );
        // 同一个表单再挂一份到「设置」导航里（settings.section 是打开的 list 席位，id 自取）。
        scoped.slots.inject("settings.section", () =>
          scoped.slots.register(
            {
              name: "settings.section",
              id: "open-code-review",
              order: 17,
              label: "代码评审",
            },
            () => h(ConfigPage, { ctx: scoped, standalone: true }),
          ),
        );
      });
    }

    return { apply, inject: ["slots"] };
  },
});
