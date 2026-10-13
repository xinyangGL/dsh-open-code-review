# 路线图（Roadmap）

> **这份文件的规矩**：只写能从磁盘核对的东西。每条都带来源（`git` / `CHANGELOG` / 某份方案文档 / 你的原话 + message ref）。
> 状态只有四种：**✅ 已交付** ／ **🟡 已实现待验收** ／ **⬜ 待做（有计划）** ／ **✋ 明确不做（带复活条件）**。
>
> 2026-10-12 说明：上一轮我在对话里说过「v0.12.0 的计划已经写盘」——**那是错的**。`docs/` 里从来没有那些文件
> （`ROADMAP.md`、`review-panels-*`、`ocr-capability-*`、`gap-analysis-*` 都不存在）。本文件是第一次落盘，
> 见 §6 变更记录。

## 1. 已交付

| 版本 | 一句话 | 证据 |
| --- | --- | --- |
| v0.9.0 | 按入口记账：`tool` / `command` / `button` / `auto` 四个桶，每桶 `started/ok/failed/lastAt/lastCode` | commit `4615cb9` |
| v0.10.0 | 默认档回到 `ocr`（`autoEngine` 出厂留空 = 跟随 `engine`）；覆盖回执 + `partial`/`partialReasons`/`coverage` 进工具 schema（partial 时禁止「未发现问题」）；跑前成本预估；修两处 v0.8.0 连带回归（`plan.engine !== "delegate"` 让第三档不可达 + 显式 `reviewer:true` 被静默吞掉） | commit `cfc31eb`；`CHANGELOG.md`；[review-quality-plan-2026-10-12.md](review-quality-plan-2026-10-12.md) §7 |
| v0.11.0 | 设置页三分法（首屏 4 项 / 高级 3 组 / 只读诊断区列 15 个被移出的键）；按钮只在「本回合有改动」时出现（fail-open）；本机桥固定端口 `llm.bridgePort`（默认 18800）；dsh 路由不再静默回落 `endpoint`（`OCR_LLM_MISSING` + `nextStep`）；路由顺序加入「当前会话正在用的模型」；`ocr` 档体验六项 | commit `cfc31eb`；[usability-plan-2026-10-12.md](usability-plan-2026-10-12.md) §7 |
| v0.11.1 | 修「高级设置里的模型名不能选」：模型目录读取风暴（生成的 namespace 每读一次就是新函数，却进了 `useEffect` 依赖）＋8 秒超时与「重试读取目录」按钮；新增模型思考强度 `llm.effort`（仅文件层，转发为 DSH `GenerateOptions.reasoningEffort`） | commit `bd0c9f3` + `a35480b`；`CHANGELOG.md` |

**测试口径**（提交时实测，`npm test` `EXIT=0`）：smoke **286** / killswitch 44 / host-contract 37 / job 51 /
reviewer 45 / bridge 103 / client-smoke **208** / cordis-inject 全部通过。

**v0.11.1 实测**（commit `a35480b`，`npm test` `EXIT=0`）：smoke **287** / killswitch 44 / host-contract 37 /
job 51 / reviewer 45 / bridge **104** / client-smoke 213 / cordis-inject 全部通过。

**这一条必须记下来**：v0.10.0 与 v0.11.0 合成了同一个提交 `cfc31eb` —— 因为 v0.10.0 当时从未提交（HEAD 停在 `v0.9.0`）。
`RELEASING.md` 的「一个 tag 只带一个高风险改动」在这条线上已经被破坏过一次；要不要拆（重写历史）由作者决定。

## 2. 待验收（代码已实现，缺真机或人工留档）

| 项 | 判定线 | 回看日 | 来源 |
| --- | --- | --- | --- |
| W6 可视确认 | 有改动的回合才出现按钮；设置页首屏 4 行、高级折叠；桥地址跨重启仍是 `127.0.0.1:18800` | 刷新页面即可确认 | usability-plan §7（W6 🟡） |
| M1 覆盖回填率 | **100%**（delegate 档 5 个真实改动，人工留档） | 2026-10-26 | review-quality-plan §4 |
| M2 已知缺陷召回 | **≥2/4**（4 个历史回归的修复前 diff 各跑一次真机 `engine=ocr`；**按 tokens 计费**，跑前先报范围与量级） | 2026-10-26 | review-quality-plan §4 |
| M3 诚实度 | **0 违规**（四类注入条件：diff 被截断 / 分片被丢 / 非 git / 规则正文缺失） | 2026-10-26 | review-quality-plan §4 |
| 可用性 M1/M2 | 含一次真机 reload | 2026-10-19 | usability-plan §4 |
| 可用性 M3 + 风险 R1 | 宿主是否把 `workspace/changes` 与 `uiConversation` 暴露给第三方客户端插件 —— 结论写进 README | 2026-10-26 | usability-plan §4 / §7 R1 |
| 可用性 M4 + `ocr` 档观感 | 真机长评审里六项体验的实际观感 | 2026-11-02 | usability-plan §4 |
| v0.11.1 模型候选（原「模型名不能选」） | 刷新页面后能读出候选；读成失败时出现「重试读取目录」而不是永远「正在读取…」；同一地址不再出现 30+ 条重复请求 | 刷新页面即可确认 | 2026-10-13 真机 console；CHANGELOG `0.11.1` |
| v0.11.1 修复本身（已实测两条中的两条） | ✅ 展开「高级设置」后 `/api/session/modelCatalog` 10 秒内**只发 1 次**（修复前同为一次展开会连出 30+ 条）；✅ 读失败时该行直接写出原因（HTTP 403）并渲染「重试读取目录」。⬜ 仍缺：在一个**有 client API 权限**的会话里看到候选真的列出来；而且必须在一个**加载了本版代码**的页面里看 —— 用户当场那个窗口的页面是应用启动（≤ 2026-10-13 13:17:30）时加载的，比修复落盘（`lib/client.js` 13:37:31）早，要整页刷新或重启 DSH 之后才谈得上验收本修复 | 用户刷新页面后确认候选 | 2026-10-13 真机（QuarkPC / 127.0.0.1:19387） |

## 3. 发行门（`RELEASING.md`，尚未做）

- ⬜ **push → tag `v0.11.1` → GitHub Release → CI 六 job 全绿**（`tmp-ci-watch.mjs <sha>`）。
- ⬜ **挂新扩展点的版本先在作者 profile 真机跑满 24 小时**：v0.11.0/v0.11.1 挂了新的客户端扩展点
  （conversation event definition）。**2026-10-13 更正**：本文件先前写「当前进程加载本版的时间 = 2026-10-12 15:52」
  是错的 —— DSH 主机进程（`DeepSeek Harness.exe` PID 59072，本机桥 18800 的占用者）**启动于 2026-10-13 13:17:30**，
  而本版所有改动都落在那个时刻**之后**：`lib/client.js` 13:37:31、`package.json` 13:39:42、提交 `bd0c9f3` 13:42:45、
  `lib/index.js` 13:43:49、`lib/config.js` 与 `lib/bridge.js` 13:43:56、`CHANGELOG.md` 13:47:00、提交 `e8eb966` 13:48:04。
  ⇒ **现在跑着的宿主里没有本版的新代码**，清单里「重启 DSH 后确认 `ocr_status` 报的版本/指纹是本版」这一条还没做到；
  24h 计时必须以「重启并加载了本版的进程」起算。
  加载面分两层（实测）：客户端 bundle 按**页面加载**取盘 —— 修复落盘后新开的页面里已经出现 `data-ocr-model-retry`；
  宿主代码按**进程启动** require —— 桥里的 `llm.effort` 转发必须重启才生效。
  重启后仍需一次真实评审 + 一次失败路径（例如临时把 `timeoutMinutes` 调到 1）。
  **所以本次只提交、没打标签。**
- ⬜ 全新 profile 装卸验收：`dsh plugin --profile <tmp> add github:xinyangGL/dsh-open-code-review`，
  核对包内 `version` 与内容（**不含** `config.json`），然后 `remove`。
- ⚠️ 清单里「CI 等价环境（藏掉 `ocr`）smoke 也全绿」目前**没有可复现的做法**：
  `HAS_OCR` 走的是配置里的 `ocr` 路径，不只看 `PATH`（试过把 Volta 目录从 `PATH` 剔掉，仍然 286 项全绿）。
  要真正验证得给测试加一个钩子；登记为待做。

## 4. ✋ 明确不做（带复活条件）

来源：review-quality-plan §5、usability-plan §5。**这些不是「忘了做」，是有意不做。**

- **P0-1 真人点击 12 用例**、**市场上架**、**14 天观测埋点扩展**：属「入口与分发」，与「结论可信」正交。
- **`-b/--background`、`--resume`、`ocr session compare` 工作流**：留给「长跑 / CI」批次。
  复活条件 = 单次评审被硬超时打断 ≥2 次，或要接 CI。
- **不把默认改回 `auto`**；**不新增重试 / 换模型容错**。
- **per-file 进度条**（ocr 不吐增量输出）、**行号跳转**、**富文本结论卡**。
- **灰色常驻按钮**（禁用态仍占位）：宁可不出现 —— 但这依赖 M2 的真机结论。
- **抬高 `maxIssuesInText = 40` 上限**；**把「本回合有没有改动」变成硬依赖**（脏检查必须 fail-open）。
- **改 `open-code-review` 自己的代码**；**加新的审批交互或新开关**。

## 5. 你提出过、但磁盘上没有落盘记录的方向（待确认后才排期）

下面这些是我从**对话本身**读到的你的诉求，但没有任何文档/代码落盘 —— 我不把它们写成「已批准」。
你确认哪几条，我就把它们升级成带判定线的 ⬜ 条目：

- **更灵活的评审范围**：允许直接指定某些文件或文件夹再评审（对话里 m02608–m02611 那批提问）。
- **跨会话的自动评审触发**：很长的对话里新开一个会话，第一次没有触发自动评审，体验尴尬（同批）。
- **协作式代码评审**：不要「把东西堆给模型」，而是协作式地评（同批）。
- **展示效果对齐 Cursor / Trae 的 review 展示**（同批）。
- （原「模型选择控件不能选了」缺陷已定位并修复，移入 §2 待验收；根因与证据见 §6 的 2026-10-13 条。）
- ~~**模型思考强度（reasoningEffort）配置**~~ → **已实现（v0.11.1，commit `a35480b`）**：`llm.effort`（仅文件层，
  不进设置页）经本机桥转发为 DSH `GenerateOptions.reasoningEffort`；宿主契约已核实
  （`reasoningEffort?: ReasoningEffortId`，且**不支持的值由 DSH 在调用上游之前拒绝**，所以插件不做白名单也不夹取）。
  仍缺的一半：真机跑一次 `ocr` 档，确认它真的改变了思考行为。另澄清：ocr 自己的 `--effort` 是**评审力度**
  （low/medium/high），与模型思考强度不是一回事。

## 6. 变更记录

- **2026-10-12**：首次落盘；同日把 v0.10.0 + v0.11.0 提交为 `cfc31eb`（16 个文件，+2453 / −532），未打标签、未 push。
- **2026-10-13**：
  - 定位并修复「模型名不能选」（原话 m02522）：宿主 `ctx.remote.session` 是**生成的** namespace，每次读
    `session.modelCatalog` 都返回一个**新的**包装函数；旧实现把它放进 `useEffect` 的依赖数组 ⇒ 每次渲染重取
    ⇒ `setState` 再触发渲染 ⇒ 请求风暴，界面永远停在「正在读取 DSH 模型目录…」。真机证据：console 里
    `/api/session/modelCatalog` 同一地址连出 30+ 条。修复见 CHANGELOG `0.11.1`；`client-smoke` 213 项全通过。
  - 失败路径按发行门判定线实测两例（真机、非模拟）：①坏 commit → `OCR_DELEGATE_PREVIEW_FAILED`（0.3s）；
    ②临时把 `llm.mode` 改成 `endpoint` 且指向不存在的 `apiKeyRef` → `OCR_LLM_MISSING`（0.4s）并给出三种原因的
    `nextStep`（跑前还先给了「可审 10 个文件 → 约 30~100 分钟」的预估与超时下限告警）。配置已复原。
  - 真实评审补跑一次：`engine=auto` 且无 LLM 端点时**自动降级 delegate**（note 写明原因），1.4s 出结论、
    覆盖回执 35/38 hunk；`ocr_status` 按入口记账变为 `tool 3 次（成 1 / 败 2）`。
  - 真机复核（QuarkPC 打开 `127.0.0.1:19387`）：展开「高级设置」后 10 秒内 `/api/session/modelCatalog`
    **只有 1 条请求**（修复前同样操作是 30+ 条）；模型名那一行直接写出失败原因
    （`Remote 调用失败：… HTTP 403`）并渲染「重试读取目录」。注：这次浏览器客户端的 client API 整体被拒
    （`/api/smartdl.status`、`/api/settings/describe`、`/api/permissionPresets/catalog` 同样 403），所以表单本身
    停在「正在从宿主读取…」——那是会话权限问题，不是插件缺陷；**候选真的列出来**这一条仍待用户在正常会话里确认。
  - 测试口径更正（同日上午的一次误判）：`npm test` 用「管道 + `Select-Object -Last 40`」跑时 `EXIT=1`，
    换成完整落盘再读，八套各自打印「全部通过」，**整体 `npm exit=0`**
    （286 / 44 / 37 / 51 / 45 / 103 / 213 / cordis-inject）。前面那句「整体 EXIT=1」作废。
  - 新增**模型思考强度** `llm.effort`（仅文件层、不进设置页）：`lib/config.js`（`DEFAULT_LLM_EFFORT = ""`、
    归一化只 trim + 截断 64、**不做白名单**）、`lib/index.js`（`startLlmBridge({ effort: () => cfgNow()?.llm?.effort })`）、
    `lib/bridge.js`（有值才写 `dshOptions.reasoningEffort`，留空不写这个键）。宿主契约由子 agent 从 DSH 源码核实：
    `GenerateOptions.reasoningEffort?: ReasoningEffortId`，且「Unsupported explicit efforts reject before provider
    I/O; no clamping or aliasing is performed」——所以插件不猜枚举、也不夹取。测试：`test/bridge-smoke.mjs` 新增
    一条（转发 + 改配置后下一次请求不带该键）、`test/smoke.mjs` 新增一条（trim / 截断 / 非字符串回默认空）；
    `npm test` `EXIT=0`（smoke 287 / bridge 104 / client-smoke 213）。
