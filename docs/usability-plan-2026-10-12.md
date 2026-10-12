# dsh-open-code-review：可用性优化方案（v0.11.0）

> 本文件是 v0.11.0 的**判定线文档**：每一条都能指着代码、测试或一次真机操作核对。
> 上一轮的判定线在 `docs/review-quality-plan-2026-10-12.md`（v0.10.0：默认档回到 `ocr`、覆盖回执、成本前置）。
> 本轮的四个诉求来自用户原话，逐条翻译成硬验收（§0 表），实施状态在 §7。

## 0. 目标与成功标准

| # | 诉求（用户原话） | 硬验收 |
| --- | --- | --- |
| 1 | 「插件开启一个 llm 的请求代理，然后 ocr 的配置固定为这个代理的地址，插件的配置可以任意修改」 + 「希望 ocr 中的 llm 可以默认使用我当前对话使用的模型」 | 重启后桥地址不变（端口未被占用时）；杀掉桥 → `ocr_review` 以 `OCR_LLM_MISSING` 失败并给 nextStep，**不再回落 endpoint**；在设置里换成模型 M → 下一次评审的路由就是 M，不重启、不碰 ocr；默认路由跟随**当前对话**正在用的模型 |
| 2 | 「现在插件的配置略显复杂，有些默认不会修改的东西就不修改，不要作为配置项放出来」 | 首屏字段行 = 4；折叠态下被移出的键**没有**输入控件；展开高级后控件 ≤ 8（不含仅 `spawn` 时出现的 3 项）；被移出的键写进 `config.json` 后行为与今天**完全一致** |
| 3 | 「这个启动代码审核的按钮，我希望是在检测到有代码修改时才出现这个按钮，而不是什么时候都可以点击这个按钮」 | 空 diff 回合不渲染；有改动的回合渲染；`onDemand = false` 仍不渲染；宿主不提供该能力时降级为「总是显示」（今天的行为） |
| 4 | 「重点优化 ocr 原本的那个工作流模式」 | 开跑那一行就是规模 + 时长预估；预估下限已超过本次超时时**开跑前**告警；`partial` 结果首行置顶；停止/超时说明「保住了什么」；结果带 ocr session id（可用 `ocr session show` / `ocr viewer` 回看） |
| — | 「这个插件尽量的好用」 | `npm test` 八套全绿 + 新增断言；README 双语 + CHANGELOG 同步；本轮判定线落在本文件 |

## 1. 现状核实（改动前读过的代码与宿主产物）

- **配置面**：`lib/client.js` 共 **26** 个字段（原分组 basic 14 / tuning 7 / runtime 5），分组定义与页面渲染分开；枚举白名单在 `lib/config.js` 的 `AUTO_MODES` / `ENGINE_MODES` / `AUDIENCE_MODES` / `SCOPE_MODES` / `LLM_MODES` / `PROTOCOL_MODES` / `REVIEWER_MODES` / `PRETEST_MODES`。
- **按钮**：注册在 client slot `conversation.chat.turnTail`（occupant id `ocr-review-on-demand`），可见性只有 `enabled !== false && onDemand !== false`；点击走 `ctx.remote.commands.execute(sessionId, "/ocr-review --entry=button", [])`。slot 的 entry 能拿到 owner props `{ turn, seq, openFile }`；「返回 null 即不渲染」是 slot 契约明写的。
- **会话事件定义 API**（第一方 `dsh-client-ui-deliverables` 实证）：`ctx.uiConversation.events.register(definition)`，definition 形如 `{ kind, match, start, update, buildLocationData }`；`buildLocationData` 必须返回 `{ kind: "turn", turn, key: <definition.kind>, value }`，**数据没变时返回同一个 `previous` 对象**；entry 用 `owner.turn.data.get(<kind>)` 读回。
- **`workspace/changes` 是真实会话事件**：宿主在「本回合有改动」时 append，事件体只有 `{ turn }`。**事件本身不等于有改动**（首次记录之后，没改动的回合也可能有这个事件），所以必须再取清单：宿主路由 `/api/changes.summary?sessionId=..&seq=..` → `{ turn, cwd, files, total, added, deleted }`，`total > 0` 才算真有改动。
- **桥**：只监听 `127.0.0.1`；`target()` **每次请求现取**（改设置立刻生效）；路由缺失时桥自己硬失败；上游真正用的是插件解析出的 provider/model，ocr 请求体里的 `model` 只是回显。改动前端口随机、且桥不可用时 `resolveLlmRoute` 会**静默回落** `endpoint`。
- **ocr 档的等待体验**：真机实测 **176~600 秒/文件**；改动前 job 第一行只有命令与超时，不告诉你要等多久；`partial` 与失败结论都没有会话 id。
- **结果码**共 15 个（含 `OCR_LLM_MISSING`）。

## 2. 决策 D1–D8

- **D1 配置面三分法**：首屏 4 项（总开关 / 默认引擎 / 按需评审 / 自动评审，且自动评审只给 `off` 与 `adaptive`）+ 折叠的「高级设置」3 组（模型路由 / 独立评审 agent（仅 `spawn` 时显示 3 项）/ 评审先于测试）+ 末尾**只读诊断区**。移出的键**保留 schema 与 `config.json` 约定**（行为零变化），只是不再给输入控件。
  - 否掉的替代：按「常用/不常用」重排但全部保留控件 —— 用户说的是「不要作为配置项放出来」，而控件在那里就会被当成问题。
- **D2 `llm.mode` 固定为 `dsh`、UI 只读**：`endpoint` 三件套移出 UI，但 `config.json` 里仍然完整可用（显式逃生门，`nextStep` 会指向它）。否掉的替代：删掉 endpoint 路由 —— 那是唯一能在宿主没有 `llm` 服务时直连的办法。
- **D3 桥端口固定**：新增 `llm.bridgePort`（默认 **18800**），被占用时自动顺延（最多试 10 个），`ocr_status.bridge.requestedPort` / `portShifted` 说明实际用了哪个。**不进设置页**（默认不用改）。否掉的替代：写进 ocr 的持久配置 —— token 每次启动随机、桥只活在插件生命周期内，写死只会得到 connection refused。
- **D4 桥不可用 = 硬失败**：复用 `OCR_LLM_MISSING`，三种原因各自的 `nextStep`，**一个子进程都不起**（不出结论、也不产生费用）。否掉的替代：继续静默回落 —— 用户会以为跑的是 DSH 的模型。
- **D5 路由顺序**：**插件设置 → 当前会话正在用的模型（`Session.requestContext()`）→ DSH 全局默认**。新增「当前会话」这一档，**不加任何开关**（用户要的就是「跟着我现在用的模型」，不该先教他配）。
- **D6 按钮可见性**：客户端自己注册一个 conversation event definition（`kind = ocrTurnChanges`，只匹配 `turn/start` 与 `workspace/changes`）记下本回合最后一次改动的 `seq`，按钮再取 `api/changes.summary`。**只把「明确读到 `total === 0`」当作没有改动**；其余一切（宿主没有该能力、读不到 `turn.data`、请求失败/404/形状不认识）都 fail-open 显示。
- **D7 ocr 档体验**：见 §0 第 4 条，六项一次做完。
- **D8 明确不做**：见 §5。

## 3. 工作包 W1–W6（改动文件与落点）

- **W1 配置面瘦身**（`lib/client.js` 为主）：三个分组的 `FIELDS`/`GROUPS`；自动评审两档下拉（`optionSlice`，必须按下拉真实顺序挑，不能用 `slice(0,2)` —— `CHOICE.autoReview` 的声明顺序是 `adaptive/inject/followup/off`）；只读诊断区列出被移出的键的「当前值 · 键名」；`dirtyKeys` / 重置只覆盖可见字段；存量配置不在下拉列表里时补一行「当前值」。测试在 `test/client-smoke.mjs`。
- **W2 按钮脏检查**（`lib/client.js`）：`ocrTurnChangesDefinition` + 在回合尾子 fiber 里用**嵌套** `ctx.inject(["uiConversation"])` 注册（顶层 `inject` 是全有全无，写进去会让没有该服务的宿主整插件 inactive）；`ReviewTailCell` 的门放在 `enabled`/`onDemand` 两道之后。
- **W3 代理固定与路由**（`lib/config.js`、`lib/bridge.js`、`lib/index.js`）：`DEFAULT_LLM_BRIDGE_PORT` + `llm.bridgePort` 归一化（1..65535，且**不进设置页 schema**）；`startLlmBridge({ port })` 顺延逻辑（只在 `EADDRINUSE` 时试下一个）；`sessionLlmSelection()` 与新的 `effectiveLlmRoute()`；dsh 不可用时 `resolveLlmRoute` 返回 `unavailable` 而不是 endpoint；`runOcrOnce` 在 `route.unavailable` 时直接 `OCR_LLM_MISSING` 并置 `out.llmMissing`（否则 `engine=auto` 的降级条件不成立）；`ocr_status` 的桥字段补齐 schema。
- **W4 ocr 档体验**（`lib/review.js`、`lib/index.js`）：`estimateMinutes` / `remainingText` / `spendNotice` / `timeoutWarning` / `extractSessionId`；心跳 `heartbeatLine(…, estimate)`；开跑那一行先放规模，预估下限超超时时开跑前告警；用量差值块前移以便失败分支说明「保住了什么」；`TIMEOUT` / `ABORTED` 文案；`partial` 首行置顶（ocr 与 delegate 两条路径都改）；`reviewSessionId` 进结果与输出 schema。
- **W5 文档与无改动路径**：本文件 + README 双语 + CHANGELOG + `package.json` 的 `description`。
- **W6 版本与验收**：`version` → `0.11.0`；八套测试 + 一次真机验收。

## 4. 验收与指标

硬验收 **A1–A5** 见 §0 表（A5 = 八套全绿 + README 双语 + CHANGELOG 记 `[0.11.0]` + 本文件）。

指标：

- **M1 首屏字段数 = 4**（`test/client-smoke.mjs` 断言，可回归）。
- **M2 空 diff 回合不出现按钮的比例 = 100%**（罐头断言 + 一次真机操作；真机不可得时以罐头为准并注明）。
- **M3 桥地址跨重启稳定**（同端口未被占用时，`ocr_status.bridge.url` 每次都是 `llm.bridgePort`）。
- **M4 「桥不可用却回落到静态端点」的出现次数 = 0**（源码级守卫 + `OCR_LLM_MISSING` 断言）。
- 回看日：**2026-10-19**（M1/M2，含一次真机 reload）、**2026-10-26**（M3 + §7 风险 R1 的结论进 README）、**2026-11-02**（M4 + ocr 档六项在真机长评审里的观感）。

## 5. 明确不做（本轮）

- `-b` / `--background` 与 `--resume`（背景评审、断点续跑）：先让前台路径可信。
- per-file 进度条（ocr 不吐增量输出）、行号跳转、富文本结论卡。
- 灰色常驻按钮（禁用态仍占位）：宁可不出现 —— 但这依赖 M2 的真机结论。
- 抬高 `maxIssuesInText = 40` 的上限。
- 把「本回合有没有改动」变成硬依赖（`partial` 式强制）：脏检查必须 fail-open。
- 改 `open-code-review` 自己的代码；加新的审批交互或新开关。

## 6. 实施约束

- 顺序 **W3 → W1 → W2（先做 spike）→ W4 → W5 → W6**；`lib/index.js`、`lib/client.js`、`test/smoke.mjs`、`test/client-smoke.mjs` 同一时间只允许一个写入者。
- **W2 spike 是门**：若宿主既不暴露 `uiConversation`，又拿不到 `turn.data`，就降级为「总是显示」并把结论写进 README —— 不为了这个功能去改 `package.json` 的客户端 inject。
- 改动默认值/配置面之后必须重跑 `npm test` 八套；不能只看 smoke。
- 本轮**不提交、不打标签**（v0.10.0 也仍未提交）。

## 7. 实施状态（2026-10-12 收口）

| 工作包 | 状态 | 落点 | 测试 |
| --- | --- | --- | --- |
| W3 代理固定与路由 | ✅ | `lib/config.js`（`DEFAULT_LLM_BRIDGE_PORT`、`llm.bridgePort` 归一化）、`lib/bridge.js`（顺延 + `requestedPort`/`portShifted`）、`lib/index.js`（`sessionLlmSelection`、`effectiveLlmRoute` 三档、`resolveLlmRoute` 不再回落、`runOcrOnce` 硬失败 + `llmMissing`、`ocr_status` 字段与 schema）、`lib/ocr-cli.js`（不变） | smoke 13 条：跟随当前会话 / 设置优先 / 桥不可用即 `OCR_LLM_MISSING` 且零 spawn / `auto` 仍降级 delegate / 端口顺延 / 占满十连 / `bridgePort` 不进设置页的两条守卫 |
| W1 配置面瘦身 | ✅ | `lib/client.js`（`FIELDS` 三分法、`GROUPS`、`optionSlice`、select 用 `optionsBasic` + 存量值补行、`dirtyKeys`/重置只走可见字段、只读诊断区、`isDirty` 两侧归一）、`lib/config.js`（不动 schema） | client-smoke 新增：收起态 4 行、`advancedRows === 4`、15 个被移出键两种状态下都无控件、诊断区行数与取值、`spawn` 展开 11 行 / 切回 `off` 8 行、预设控件已不存在 |
| W2 按钮脏检查 | ✅ | `lib/client.js`（`ocrTurnChangesDefinition`、嵌套 `ctx.inject(["uiConversation"])` 注册、`ReviewTailCell` 的 `changesFeedReady`/`hasChanges` 门） | client-smoke 12 条：6 条门（`total=2` 显示 / `total=0` 隐藏 / 无 turn 记录隐藏 / 抛错显示 / 404 显示 / 无该能力总是显示）+ 6 条 definition 契约（`ctx.effect` 注册、`match` 只认两种事件、`start` 只认 `turn/start`、`update` 记 `seq`、`buildLocationData` 的 key 与引用稳定性、step 作用域返回 null） |
| W4 ocr 档体验 | ✅ | `lib/review.js`（`estimateMinutes`/`remainingText`/`spendNotice`/`timeoutWarning`/`extractSessionId`/`heartbeatLine` 第 4 参、`NEXT_STEPS` 的 TIMEOUT/ABORTED）、`lib/index.js`（开跑行、告警、用量前移、摘要与 `sessionTag`、`reviewSessionId` + schema、`mkResult`） | smoke 12 条：4 个纯函数、`extractSessionId`、开跑行规模、超时告警、会话 id 与回看提示、不编 id、`partial` 置顶、取消文案、超时文案的源码级守卫 |
| W5 文档 | ✅ | 本文件、`README.zh.md`、`README.md`、`CHANGELOG.md`、`package.json` 的 `description` | — |
| W6 版本与验收 | 🟡 代码与测试完成；宿主侧真机验收通过；按钮与设置页的可视确认待页面刷新后由用户确认 | `package.json` `version = 0.11.0` | `npm test` 八套全绿：smoke **286** / killswitch 44 / host-contract 37 / job 「OK：51 项全部通过」 / reviewer 45 / bridge **103** / client-smoke **208** / cordis-inject「全部通过」（`EXIT=0`）；真机逐条见 7.1 |

### 7.1 真机验收（2026-10-12 重启 DSH 后逐条）

| 判定线 | 结果 | 证据 |
| --- | --- | --- |
| 桥地址跨重启稳定 | ✅ | `ocr_status`：本地桥 `http://127.0.0.1:18800/v1`（首选端口，不再是随机端口） |
| 默认跟随「当前对话正在用的模型」 | ✅ | `LLM 实际路由：DSH 本机桥 http://127.0.0.1:18800/v1（provider=commandcode · model=deepseek/deepseek-v4.1-flash · **来自当前会话**）` —— 与 DSH 全局默认（`ark-coding-plan/deepseek-v4.1-flash`）不同，两条不一致才看得出差别，说明第二档真的在起作用 |
| 上次热重载造成的重复注册已清 | ✅ | `事件钩子：agent/turn-stopping×1、loader/volatile-update×1、tools/pre-execute×1、tools/result×2`；`宿主能力：宿主必需能力齐备（13 项）`（重启前是 ×3/×3/×1/×4 + 假报缺 `events.*`） |
| `ocr` 档结果带会话 id | ✅ | 真机 `ocr_review(scope=commit, commit=4507de6, engine=ocr)`：exit 0 · **6.4s** · 1192 tokens；摘要带 `ocr 会话：baa7ff31-f0f4-414e-8ad5-596da7b06ad5（ocr session show … 回看，ocr viewer 打开界面）`，notes 里另有一条同样的提示 |
| 开跑先给规模 | ✅（结果侧可见） | 同一次运行的 note：`成本提示：engine=ocr … 本次实测可审 1 个文件 → 按真机历史约 3~10 分钟 …`（job 进度面板的「开跑首行」是瞬时的，结果里回看不到，只有单测守着 `job.phase` 那一行） |
| `partial` 首行置顶 / 超时告警 / 停止文案 | ⚪ 本次未触发 | 干净的小提交（0 findings、`coverage.failed = []`）跑不出 partial 与超时；这三项仍只有罐头断言 |
| 端口被占用时顺延 | ⚪ 未构造 | 真机上没有刻意占用 18800；顺延只在单测里用真端口占用验过 |
| 空改动回合不出现按钮 / 有改动回合出现 | ⏳ 待可视确认 | 见下 |

**待用户可视确认（页面刷新后）**：① 只在读文件的回合尾部**没有**「启动代码审核」按钮；② 有 `workspace/changes` 的回合尾部**有**按钮；③ 设置页首屏 4 行控件、「高级设置」默认折叠、末尾诊断区 15 行（列出 `autoMaxPerSession` 这类键的「当前值 · 键名」）。

**为什么这一条我不能自己验**：GUI 根路径 `http://127.0.0.1:19387/` 对不带凭据的请求返回 **401**，我没有你标签页里的凭据，也没有 DSH 运行时的会话上下文可以代跑一次浏览器点击；`lib/client.js` 的改动只能由页面刷新加载（`pnpm run dev:web` 没在跑，客户端不热重载）。

**W5 复检（2026-10-12，重启后追加）**：W5 第一遍漏掉了与配置面耦合的几处旧描述，重启后逐处核出并改写 —— 配置总览表（`README.zh.md:112-122`）、字段表的 `Where` 列（`llm.mode` / `llm.baseUrl` / `llm.protocol` / `llm.apiKeyRef` 与 7 个 `auto*` + `audience` / `ocrPath` / `timeoutMinutes` / `progress` / `verbose` 一律改成「文件层（诊断区只读）」，`llm.provider` → 「高级·模型路由」，`preTest` → 「高级·评审时机」）、`llm.provider` / `llm.model` 的「留空 = 跟随谁」改成三档路由语义、preTest FAQ 的「Advanced → Tuning →」、文件树注释里的 `FIELDS` 计数、以及双语截图说明（截图仍是 0.10.0 版式，已明确标注是旧版）。**教训**：改默认值与界面分组后，要 grep 的不只是「默认值」本身，还有**所有把这些键指到某个界面位置的文字**。

**与 §4 的差异（诚实记录）**：

- **M2 / M3 / M4 的「真机」部分：宿主侧已在重启后逐条核过（见 7.1），只剩按钮与设置页的可视确认**。`lib/index.js` 与 `lib/bridge.js` 的改动要等 DSH 下次加载插件才生效（已通过重启确认）；`lib/client.js` 的改动还要页面刷新（`pnpm run dev:web` 没在跑，客户端 bundle 不会自动重建）。按钮那三条在可视确认之前只能算罐头断言通过。
- 「桥不可用 → `OCR_LLM_MISSING`、零 spawn、note 里不出现 `endpoint`」只有罐头断言；真机上没有刻意杀掉桥来复现（真要做，得在评审中途把 bridge 停掉，风险大于收益）。
- 桥端口顺延只用真端口占用在测试里验证过；真机上「首选端口被别的进程占着」的场景没有刻意构造。
- W1 的「被移出的键写进 `config.json` 后行为与今天完全一致」由「schema 未改 + 诊断区只读 + client-smoke 断言无控件」三条共同保证，没有做逐键的行为回放。
- W4 的 `partial` 置顶与会话回看只有罐头样本（`{ partial: true, … }` 与 `session_id`），没有一次真机长评审产出 `partial` 来对照。

**一条实测教训（2026-10-12，DSH 运行中）**：想不重启就吃到新代码，试过用 `plugin_manager` 对 `include:dsh-open-code-review` 做「停用 → 启用」。结果有三点，都别再试：

1. **不生效**：`apply` 成功，但宿主进程里 `lib/index.js` 来自 Node 的 require 缓存，新桥仍然用随机端口、`bridge` 里没有 `requestedPort` —— 说明跑的还是旧代码。
2. **会累积**：停用没有 dispose 掉上一个 fiber 的注册，每来一轮就多一份。实测 `ocr_status.hooks` 从 `turn-stopping×1 / volatile-update×1 / pre-execute×1 / result×2` 变成 `×2/×2/×1/×3`，再变成 `×3/×3/×1/×4`，同时每份都起一个自己的桥（端口从 62784 → 59931 → 63442 依次变化）。
3. **副作用**：多份注册让新的那份 `armHook` 被当作重复注册拒掉，于是 `ocr_status` 会谎报「宿主缺少 events.* 能力」（宿主其实有）。

清理只能靠重启 DSH（host 进程重启会清掉 require 缓存与整个插件树）。要热重载插件宿主代码，得走 `@deepseek-ai/dsh-hmr` 那条路（本机装了，但本次没有验证它对 linked 插件是否生效）。

**尚未做（§5 明列，不是遗漏）**：`-b`/`--resume`、per-file 进度条、行号跳转、富文本结论卡、抬高 `maxIssuesInText`、新开关/新审批交互。
