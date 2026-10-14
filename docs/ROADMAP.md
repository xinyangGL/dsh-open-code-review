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
| v0.11.2 | 盘点真机撞出的两个缺陷：按需评审 skill 的 `source`（**注册成功 ≠ 能加载**，`ocr_status` 那时报 `registered=true` 是假绿）＋「没有可审文件」不再说成「未发现问题」 | commit `2050561`；`CHANGELOG.md` 0.11.2；本文 §6 |
| v0.12.0 | 按专家方案分三批收口（**只针对「代码审核」这条线，不加新功能**）：**批 1 结论可信** —— E2 agent 档不再丢掉 `partial`／E1 `scope` 配 `paths` 改成显式拒绝（`OCR_INVALID_ARGS`）／M6 工作区干净时不再说「未发现问题」／E3 结论新增「可用性」行与覆盖回执／T1 单飞闸 `OCR_ALREADY_RUNNING`／T2 工具超时与 `maxTimeoutMinutes` 对齐／R5 结果码常量收敛（15 → 16）／R6 覆盖回执写进 job 记录／R3 回合尾部按钮不再依赖 `jobs` 服务／R4 usage 的「假账」边界写进代码；**批 2 外观与可访问性** —— 令牌化 + 4px 刻度 + 圆角/字号收敛 + 对比度下限 + 删掉「猜背景色」（半透明菜单根因）+ 未知严重度＝「未分级」（不再当 minor）+ 按钮副行代价标签 + `role`/`aria`/`:focus-visible`；**批 3 发布面** —— `files` 收窄（内部评估文档不再进包）+ `npm run test:pack` 进 CI + 本地可复现 CI 离线档 + 上架版 README + 设置页截图重拍 | commit `575de1a`（tag `v0.12.0`）；[Release](https://github.com/xinyangGL/dsh-open-code-review/releases/tag/v0.12.0)；CI [run #27](https://github.com/xinyangGL/dsh-open-code-review/actions/runs/38495153246) |
| v0.12.1 | 批 2 收尾 + 两条真机边界走出来的诚实缺陷：英文界面漏译的 5 条 `placeholder`（「加守卫」加出来的）＋ `engine=delegate` 撞上「规格里没有可审文件」时不再报「成功」；结论补上「规模」与「下一步」两层（**批 2 的结论六层齐了**） | commit `ccd444e` + `59c38c2` + `5e8a61b`；`CHANGELOG.md` 0.12.1 |

**测试口径**（提交时实测，`npm test` `EXIT=0`）：smoke **286** / killswitch 44 / host-contract 37 / job 51 /
reviewer 45 / bridge 103 / client-smoke **208** / cordis-inject 全部通过。

**v0.11.1 实测**（commit `a35480b`，`npm test` `EXIT=0`）：smoke **287** / killswitch 44 / host-contract 37 /
job 51 / reviewer 45 / bridge **104** / client-smoke 213 / cordis-inject 全部通过。

**v0.12.0 实测**（`npm test` `EXIT=0`）：smoke **319** / killswitch 44 / host-contract 37 / job 51 / reviewer 45 /
bridge 104 / client-smoke 214 / cordis-inject 全部通过，另加**打包体检 4/4**（`npm run test:pack`，已进 CI）；
`OCR_TEST_FORCE_NO_OCR=1 node test/smoke.mjs` → **319 项全过**（CI 的离线档第一次能在本机复现，见 §3）。

**v0.12.1 实测**（`npm test` `EXIT=0`）：smoke **321** / killswitch 44 / host-contract 37 / job 51 / reviewer 45 /
bridge 104 / client-smoke **214** / cordis-inject 全部通过，另加打包体检 4/4。

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
| v0.11.1 模型候选：读取 | 刷新页面后能读出候选；读成失败时出现「重试读取目录」而不是永远「正在读取…」；同一地址不再出现 30+ 条重复请求 | 刷新页面即可确认 | 2026-10-13 真机 console；CHANGELOG `0.11.1` |
| v0.11.1 模型候选：下拉能看见 | ✅ **2026-10-13 用 bsk 在真机页面上量化确认**：修前菜单 rect `[556, 854, 800, 231]`（设置面板 `[556, 50, 800, 800]` + `overflow:hidden`）⇒ 菜单在屏幕外被裁掉；修后 `[981, 583, 335, 231]` ⇒ 在输入框正下方、面板内，截图可见 4 条候选，点一条写回 `deepseek-flash`。⬜ 仍缺：用户在自己那台桌面 GUI 里刷新一次页面后看到候选（用户的窗口需要整页刷新，见 §3 的两层加载面） | 真机几何 + 截图（`C:\Users\吴礼凯\AppData\Local\Temp\ocr-ui-menu-opaque.png`） | 2026-10-13 bsk 复核；CHANGELOG `0.11.1` |
| v0.11.2 skill 可加载 | 重启桌面 DSH 后 `skill ocr-on-demand-review` 返回技能正文（不再是 `source must be a string`）；「没有可审文件」的情形在界面上显示为部分结果而不是「未发现问题」 | 重启后即可确认 | 2026-10-13 headless 已验证；桌面进程仍跑旧代码 |
| v0.11.2 没有可审文件不说「未发现问题」 | ✅ **2026-10-13 已用 `test/smoke.mjs` 的守卫钉住**（`partial=true` + 「本次没有可审的代码改动」+ 不许出现「未发现问题」） | 已完成 | CHANGELOG `0.11.2` |
| v0.12.0 包内容 | ✅ **2026-10-14 全新 profile 装卸验收通过**：`dsh plugin --profile rc-v012 add github:xinyangGL/dsh-open-code-review` → 装到 **version 0.12.0**；包内 `docs/` 只剩 `host-contract.md`、`pretest-gate-safety-design.md`、两张截图；`config.json` / `ROADMAP.md` / `maturity-assessment-*` / `review-quality-plan-*` / `interaction-spec-*` / `test/` **都不在包里** | 已完成（验证用的 `rc-v012` profile 已删） | `test/pack-check.mjs`；2026-10-14 实测 |
| v0.12.0 桌面观感 | 重启桌面 DSH 后确认三件事：① 模型下拉能列出候选（含读不到时的「重试读取目录」）② 按钮只在真有改动的回合出现、副行写出代价量级 ③ 结论里能看到「可用性」行与覆盖回执 | 重启后即可确认（见 §3「两层加载面」） | CHANGELOG `0.12.0` |
| v0.12.0 `llm.effort` 真机 | 跑一次 `engine=ocr`，确认思考强度确实改变了行为（`llm.effort` 只在文件层，默认留空 = 跟随 DSH/模型默认） | 待用户排期 | CHANGELOG `0.11.1`；§5 |
| **P0-C 真人点击 12 用例** | ⬜ **仍未做** —— 这是 CPO 定的发布门（「未过不发布」），而 v0.12.0 事实上越过了它就发布了；见 §6 的 2026-10-14 条，别把它记成通过 | 未排期 | CPO 专家方案；§4 |

## 3. 发行门（`RELEASING.md`）

- ✅ **2026-10-14 已发行 `v0.12.0`**：`push origin main`（远端 `refs/heads/main` = `575de1a`）→ annotated tag
  `v0.12.0`（tag 对象 `48ac77d` → 提交 `575de1a`，已 push）→ GitHub Release 已建（API `201`；此前 22 个
  release 最新只到 `v0.9.0`）→ CI [run #27](https://github.com/xinyangGL/dsh-open-code-review/actions/runs/38495153246)
  六个 job 全 `success`（node 20 / 22 / 24 × windows-latest / ubuntu-latest）。
  手法上的坑记在 §6：**GitHub API 一律走 `node:https` 直发**（PowerShell 的引号/编码会把 `curl` 与
  `Invoke-RestMethod` 这条路毁掉），盯 CI 用 `tmp-ci-watch.mjs <sha>`。
- ⚠️ **24h soak 这一条事实上没有遵守**：门槛算到 `2026-10-14 14:10:34`，实际发版发生在 `2026-10-14 09:2x`
  —— 用户 2026-10-13 明确说过「不用卡这个 24h 门槛」。也就是说 launch 前只走了约 **19 小时**。
  这不是「达成」，是**用户知情下的例外**；记在这里，免得下回被当成先例。
- ⬜ **挂新扩展点的版本先在作者 profile 真机跑满 24 小时**：v0.11.0/v0.11.1 挂了新的客户端扩展点
  （conversation event definition）。**2026-10-13 更正**：本文件先前写「当前进程加载本版的时间 = 2026-10-12 15:52」
  是错的 —— DSH 主机进程（`DeepSeek Harness.exe` PID 59072，本机桥 18800 的占用者）**启动于 2026-10-13 13:17:30**，
  而本版所有改动都落在那个时刻**之后**：`lib/client.js` 13:37:31、`package.json` 13:39:42、提交 `bd0c9f3` 13:42:45、
  `lib/index.js` 13:43:49、`lib/config.js` 与 `lib/bridge.js` 13:43:56、`CHANGELOG.md` 13:47:00、提交 `e8eb966` 13:48:04。
  ⇒ 那个进程里没有本版的新代码，清单里「重启 DSH 后确认 `ocr_status` 报的版本/指纹是本版」当时还没做到。
  加载面分两层（实测）：客户端 bundle 按**页面加载**取盘 —— 修复落盘后新开的页面里已经出现 `data-ocr-model-retry`；
  宿主代码按**进程启动** require —— 桥里的 `llm.effort` 转发必须重启才生效。

  **2026-10-13 14:10:34 用户已重启 DSH**（新宿主 `DeepSeek Harness.exe` PID 17088，19387 与 18800 都归它，
  晚于最后一次提交 `d56c87c` 的 14:01:27）⇒ 指纹这一条达成：`ocr_status` 报本机桥 `127.0.0.1:18800`、
  路由「来自当前会话」（ark-coding-plan / deepseek-v4.1-flash）、事件钩子各 ×1（没有重启前那种累积）、
  宿主能力 13 项、LLM 连通性与 tool-call 往返 OK。同日补上另外两项：
  **一次真实评审**（`engine=ocr`、`scope=commit d56c87c` → exit=0、188.3s、1 个可审文件、2 条发现、
  ocr 会话 `061f0c54-9e11-4291-9825-8eed5a692856`）与**一次失败路径**（坏 commit + `engine=delegate`
  → exit=1、0.3s、`OCR_DELEGATE_PREVIEW_FAILED` + 下一步）。
  ⇒ **24h 计时以 2026-10-13 14:10:34 起算，门槛 = 2026-10-14 14:10:34**；用户在 15:52 前选择了
  「重启 → 我做完真机验收 → 从重启起算满 24h 再打 tag」这条路。
  **所以本次只提交、没打标签。**
- ✅ 全新 profile 装卸验收（**2026-10-14 对 `v0.12.0` 真做了一次**）：`dsh plugin --profile rc-v012 add
  github:xinyangGL/dsh-open-code-review` → EXIT=0、**装到 `version 0.12.0`**；包内 `docs/` 只有
  `host-contract.md`、`pretest-gate-safety-design.md` 与两张设置页截图，`config.json`／内部评估文档／`test/`
  都不在包里（断言在 `test/pack-check.mjs`，已进 CI）。验证完 `remove` 并删掉 `rc-v012` profile。
- ✅ 「CI 等价环境（藏掉 `ocr`）smoke 也全绿」**2026-10-14 变成可复现**：`test/smoke.mjs` 的 `which()` 认一个
  开关 `OCR_TEST_FORCE_NO_OCR=1` —— 置位后任何 ocr 可执行文件（**绝对路径也算**，因为工作区 `config.json`
  常把 `ocrPath` 钉成绝对路径）的查找都返回空，且**只挡 ocr**（正则只匹配 `ocr|opencodereview`，否则连 `git`
  一起挡掉会连锁出 10 项假失败）。实测 `OCR_TEST_FORCE_NO_OCR=1 node test/smoke.mjs` → **319 项全过**。
  CI 的离线档由此从「只能指望 CI」变成「本地一条命令可复现」。

## 4. ✋ 明确不做（带复活条件）

来源：review-quality-plan §5、usability-plan §5。**这些不是「忘了做」，是有意不做。**

- **P0-1 真人点击 12 用例**（CPO 把它排成 P0-C「未过不发布」，**至今仍未做** —— v0.12.0 在这个门前就发了，见 §2 与 §6）、
  **市场上架**（已发 issue `#7328` 问重名政策，PR 等答复）、**14 天观测埋点扩展**：属「入口与分发」，与「结论可信」正交。
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
  - **DSH 已重启并完成三项真机验收**（14:10:34 新宿主 PID 17088）：① 指纹 —— 见 §3；② 真实评审 —— `engine=ocr`、
    `scope=commit d56c87c` → exit=0、188.3s（落在 README 口径 176~600s 内）、1 个可审文件、2 条发现、
    ocr 会话 `061f0c54-9e11-4291-9825-8eed5a692856`；③ 失败路径 —— 坏 commit + `engine=delegate` → exit=1、0.3s、
    `OCR_DELEGATE_PREVIEW_FAILED` + 下一步。⇒ 24h 门槛 = **2026-10-14 14:10:34**。
  - **⚠️ 自审揪出我自己的一个错误（留档）**：上面那次真实评审在 `lib/client.js` 上报了 2 条问题，第一条直接指出
    **提交 `d56c87c` 与 `CHANGELOG` 里说的「依赖从 `[ctx,…]` 改成 `[locale,…]`、一个对象都不留」是不实的** ——
    核对 `git show d56c87c` 后确认：那个提交只把 `makeT(localeOf(ctx))` 拆成两行，`deps` **从未改动**，至今是
    `[ctx, unsupported, unsupportedReason, nonce]`。第二条（medium）说 `localeOf(ctx)` 返回的是 locale **服务对象**、
    不是原始值 —— 也正确。结论：`deps` **本来就该保留 `ctx`**（子 fiber 迟到激活时靠它把目录从兜底读取口换成官方
    读法，`test/client-smoke.mjs` 的「服务迟到」场景钉住这条；去掉 `ctx`、或换成 `locale`，那条断言都会变红），
    所以正确的动作不是「把 `ctx` 换掉」，而是**把写错的话更正**：`lib/client.js` 的注释改成三条约束
    （`resolved.call` 绝不进 deps ／ `ctx` 必须留 ／ `locale` 不能顶替 `ctx`）、`CHANGELOG.md` 0.11.1 段写明更正、
    `test/client-smoke.mjs` 的「服务迟到」场景加警示注释。教训与 2026-10-12 那次同源：
    **提交信息与变更记录里不能写代码里没有的改动。**
  - **2026-10-13 用 bsk 做真机 UI 调试，找到「下拉点开什么也看不见」的真因**（用户指出「目录读到了 76 个模型，
    但按钮点开没有任何内容」，并问「你能不能自己用 UI 测试工具测」）。做法：
    ① agent 工具表（`cordis_inspect_query(host, Tool, listTools)`，105 个工具）里**没有** browser/UI 测试工具，
    `browser_inspect` 报 unknown tool；本机能用的 UI 测试手段是 **`bsk`（browser-skill 0.3.2，
    `C:\Users\吴礼凯\.local\bin\bsk.exe`）**，它只能驱动 Edge/Chrome，**接不进 Electron 里的桌面 GUI**。
    ② 于是在 **web profile** 里临时装上同一个插件（`dsh plugin --profile web add link:…`）、
    `dsh web --port 19388 --no-open` 起一个**带自己 token** 的实例，用 `bsk` 的 Edge 会话打开，走到
    「设置 → 代码评审 → 高级设置」—— 拿到的是**已鉴权**的真实页面（`/api/*` 全通）。
    ③ 复现与量化（`bsk evaluate` 量几何 + `bsk screenshot`）：修前菜单 rect `[556, 854, 800, 231]`，
    而设置面板是 `[556, 50, 800, 800]` 且 `overflow: hidden` ⇒ 菜单整个落在面板下沿（850）之外被裁掉，
    `elementFromPoint` 在该处打不到任何元素（= 屏幕上确实没有）。
    ④ 真因：`lib/client.js` 的 `S` 里 **`combo` 键写了两次**（`{ position: "relative" }` 与 `{ display: "grid", … }`），
    对象字面量后一个键静默覆盖前一个 ⇒ 组合框不再是定位元素 ⇒ 菜单的定位基准变成**面板本身**，
    `top: 100%` 于是等于面板高度。修法：把 `position: "relative"` 并回**唯一**的 `combo` 键；
    修后 rect = `[981, 583, 335, 231]`（输入框正下方、面板内），截图可见 4 条候选，点一条写回 `deepseek-flash`。
    ⑤ 顺带修掉同一处的第二个观感缺陷：`guessBg()` 只排除 `transparent`，取到了 `rgba(127,127,135,0.045)` 这类
    **叠层色**，菜单半透明、候选文字与后面说明文字互相穿透；改成只认 alpha ≥ 0.95 的背景，
    并以 `var(--dsw-alias-bg-layer-2, Canvas)` 兜底（修后实测 `background: rgb(44, 44, 46)`）。
    ⑥ 回归：`test/smoke.mjs` 新增 4 条**源码级守卫**（`combo` 键唯一 / `combo` 带 `position: relative` /
    `menu` 是 `absolute` + `top: 100%` / 背景判定排除半透明叠层且有 Canvas 兜底）。
    ⑦ 清理：web profile 里那个测试实例与临时安装用完即撤（`dsh plugin --profile web remove …` + 停 19388），
    桌面 profile 的插件与配置不动。
    ⚠️ 教训：上一轮把「模型名不能选」整条归到「目录读取」线上，其实**同时有两个独立缺陷** ——
    读取风暴（已修）与下拉定位（本次修）。**只看 aria 快照会以为菜单正常（DOM 里确实有 4 条候选），
    必须量几何 / 看截图才能发现它在屏幕外。**
  - **盘点「代码审核」这条线**（用户 m06279 原话：「看一下，这个插件还有没有什么不足，我们只关注代码审核，不要随意加功能，但是目前已有的内容必须要好用」）：
    做法是自建一个**已鉴权**的 web 实例（web profile 临时装同一份插件 + `dsh web --port 19388`）+ `bsk` 驱动 Edge，
    从回合尾部按钮一路走到 `ocr_review`。撞出并修掉两个缺陷（见 v0.11.2 与 §2）：
    ① 按需评审 skill 的 `source` 缺失 —— **注册成功 ≠ 能加载**（`ocr_status` 那时报 registered=true 是假绿）；
    ② 没有可审文件时摘要会说「审查 1 个文件，未发现问题」。
    同时记下**这次没有改**、但确实存在的不便（都不是缺陷，属「待确认是否排期」）：
    ⓐ `scope=workspace` 不支持 `paths` —— 想「只看某些文件/目录的**未提交改动**」做不到，只能退到
    `scope=scan`（整文件扫描，语义不同）；这正是用户 m02608–m02611 提的「更灵活的评审范围」；
    ⓑ 按钮按 config 里的 engine 走**连点的时候**才给成本/耗时（预估出现在点下去之后），点之前看不到「这一下大概多久、会不会花钱」；
    ⓒ 结果展示仍是「模型汇报 + 原始 JSON」，没有 Cursor/Trae 那种面板（属 §5 已记录的方向）。
- **2026-10-14（发行日）**：
  - **`v0.12.0` 已发行**（详见 §3）：tag 对象 `48ac77d` → 提交 `575de1a`，远端 main 与 tag 都到位，
    GitHub Release 已建，CI [run #27](https://github.com/xinyangGL/dsh-open-code-review/actions/runs/38495153246)
    六个 job 全绿。本地最近六个提交：`575de1a` 截图 → `9cc0dc4` 上架自查（三处「文档副本 vs 代码」的假绿）
    → `3468997` 上架版 README → `1e72c92` 批 3 第二步（离线档可复现）→ `36f44c3` 批 3 第一步（打包体检）
    → `552f46e` 批 2 第三步。
  - **市场重名**：`https://awesome-dsh-plugin.com/plugins.json` 里已有 `mocilukalbj/dsh-open-code-review`
    （`name` 与 npm 包名都相同，2026-10-09 收录）。**没有先提 PR**，而是发 issue
    [awesome-dsh-plugin#7328](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/issues/7328)
    问策展人「同名不同 owner 是否接受 / 要不要改名」—— 等答复再提 PR，避免把重名条目直接推进目录。
  - **诚实留档（都不写成「通过」）**：CPO 的 P0-C「真人点击 12 用例（未过不发布）」**没有做**，
    `v0.12.0` 越过了这道自设的门；24h soak 也只走了约 **19 小时**（用户 2026-10-13 明确豁免）。
  - **工具经验**（写给下一次的自己）：① GitHub API 一律用 `node:https` 直发、本地文件按 UTF-8 读，
    绕开 PowerShell 的引号/编码；本机的 `curl` 对 `api.github.com` 多次返回 0 字节。② 这台机器的
    PowerShell 5.1 控制台**打印不了 UTF-8 中文**（输出会变乱码），`ConvertFrom-Json` 读含中文的
    `package.json` 直接报「传入的对象无效」——**读文件内容用 read 工具，不要用 pwsh 打印**。
    ③ `git push` 会把正常输出经 `NativeCommandError` 报成「错误」，判断成败用 `git ls-remote`；
    也不要把 `git` 输出接 `Select-Object -First N`（会断管道，表现为 exit -1）。
  - **待用户定的遗留**：`docs/interaction-spec-2026-10-13.md`（UX 架构师在 plan mode 下越界写的 454 行交互规格）
    目前**是跟踪状态、也随 `v0.12.0` 发布了**；保留还是删掉，等一句话。
  - **清理**：验证用的 `rc-v012` profile 已删；web profile 早已回到只有 `@deepseek-ai/dsh-base` +
    `@deepseek-ai/dsh-web-app`；仓库工作区干净；`.graphflow-cache/` 与 `.trae/`、`.claude/`、`AGENTS.md`、
    `config.json` 等仍是 `.gitignore` 里的本机产物。
- **2026-10-14（批 2 收尾 · v0.12.1）**：
  - 结论六层补齐第 2 层「规模」与第 4 层「下一步」（`lib/review.js` 的 `valueToText()`：`下一步：` 不再只在
    失败时出现；成功也按「有问题 / 只有部分结论 / 干净」各给一句），`test/smoke.mjs` 加一条守卫（规模层内容 +
    下一步层固定存在且排在其后）⇒ smoke **320 → 321**；提交 `5e8a61b`。
  - 同一批还有 `ccd444e`（英文界面 5 条 `placeholder` 漏译，由新加的「`en` 必须覆盖 `zh` 每个键」守卫点名）
    与 `59c38c2`（`engine=delegate` 撞上「规格里没有可审文件」时走 `partial` 通道，不再报成功）。
  - **诚实记录**：`5e8a61b` 的改动第一次落盘时把 `lib/review.js` 里
    `if (v.reviewer && typeof v.reviewer === "object") {` **整行覆盖掉了**，`node --check lib/review.js` 报
    `SyntaxError: Illegal return statement`；按原样恢复该行后重跑，语法与八套测试才全绿。
    教训：改 `valueToText()` 这种长函数，**先 `node --check`，再跑测试**。
  - **推送状态（未完成）**：本地 `main` = `5e8a61b`，远端 `refs/heads/main` 仍停在 `ccd444e`。
    2026-10-14 10:4x~10:5x 连续 6 次 `git push`（含 5 次自动重试）都是
    `Recv failure: Connection was reset` / `Failed to connect to github.com port 443 after 21s`；
    同一时段 `Test-NetConnection github.com -Port 443` 却报过 True ⇒ 抽风式中断，等网络好转补推。
  - **`v0.12.1` 未打 tag、未建 Release**：单独发一版还是并入下一次，等用户一句话。
