# 可信评审优化方案（2026-10-12，目标版本 v0.10.0）

> 目的：让"用阿里 OCR 审代码"成为**出厂默认**，并让它的输出**可核对、可留档、不谎报**。
> 本文是判定线文档：每个阶段都有可验证的完成标准与回看日；不达标就按写好的动作降级。

## 0. 成功标准（可验证）

1. 干净配置下不带 `engine` 调 `ocr_review` 走 OCR 流水线，且**跑之前**能看到"本次几个文件 / 大概多久 / 大概多少钱"。
2. 任一片段未覆盖、diff 被截断、或结果部分失败时，一律不得出现"未发现问题"式结论。
3. "独立评审 agent"（第二双眼睛）在出厂配置下**真的开得起来**（v0.9.0 之前永远走不到）。
4. 自动评审不做**静默换源**：`engine` 定什么，自动评审就用什么（自动评审自 v0.5.0 起出厂 off，本身要显式打开）。
5. `npm test` 8 套全绿；CI 不新增联网/装 ocr 依赖。

## 1. 现状证据（改动前的锚点）

| 事实 | 证据 |
|---|---|
| 旧出厂默认 = delegate | `lib/config.js` 的 `DEFAULTS.engine`；`lib/review.js` 的 `pickEngine()` 兜底；`lib/config.js` 设置页 `.default(DEFAULTS.engine)`；`lib/client.js` 的 `CHOICE.engine`；`lib/index.js` 的工具描述 |
| **第三档在出厂配置下不可达** | `lib/index.js` 工具路径与自动路径两道门都有 `plan.engine !== "delegate"` 前置；`git blame` 显示该行写于 2026-10-09（默认引擎当时是 auto → 条件恒真），2026-10-10 翻默认为 delegate 后变成几乎恒假，而工具 schema 仍承诺"`reviewer:true` 不可用就报 `OCR_REVIEWER_UNAVAILABLE`，不回落" |
| `effort` 在 delegate 下静默无效 | `lib/review.js` 只在 review 分支传 `--effort`；delegate 的 argv 构造里没有它；schema 仍暴露该字段 |
| delegate 规格无回执 | `lib/review.js` 的 `buildDelegateSpec` 只有统计头；diff 由插件裁：`lib/ocr-cli.js` 用 `-U8`、`maxBytes` 默认 120000、**字符级**截断；规格上限却是 `lib/index.js` 里的 200000 |
| `autoEngine` 的归一化缺陷 | `lib/config.js` 的 `normalizeConfig()` 里，`autoEngine` 缺省与"显式空串"被当成同一件事（都回落空串），一旦出厂默认不再是空串，语义就错 |
| 本机未 pin 引擎 | 插件目录 `config.json` 原本只有 `"autoEngine": ""`，没有 `engine` 键 |

## 2. 决策（含被否备选）

- **D1 出厂默认 `engine = "ocr"`，不是 `"auto"`**：`auto` 在没有 LLM 时会**静默降级**成 delegate，用户会拿到"看起来像评审、其实不是流水线"的结果。`ocr` 没配 LLM 时直接失败（`OCR_LLM_MISSING` + `nextStep` 指向 delegate/auto），这是诚实的取舍。
- **D2（修订）`autoEngine` 出厂留空 = 跟随 `engine`，不钉成 `delegate`。**
  原方案曾定为 `"delegate"`（让回合尾自动评审保持便宜）。实施中发现两个反效果：① `engine: "ocr"` 对自动评审不再生效 —— 用户明确选了流水线，自动评审却给 delegate，正是本方案要消灭的"静默换源"；② 自动评审仍被 `engine !== "delegate"` 挡住，"独立评审 agent"在自动路径上继续不可达。
  由于自动评审自 v0.5.0 起**出厂就是 off**（要不要自动跑本身要显式打开），钉死 autoEngine 换来的省钱保护是虚的。改为跟随 engine；自动评审的省钱责任交给已有的 `autoMaxPerSession` / `autoMinIntervalMs` / `autoMinReviewableFiles` 与跑前成本预估（看到预估可以取消这次调用）。回归由既有的 6 条自动档 reviewer 用例承担（它们断言 `engine=ocr` 时自动评审真的走该档）。
- **D3 成本用"跑前可见 + 可取消"处理**，不引入新的审批交互（审批提示可能被宿主禁用；插件也不该自建闸门）。可拒 = 取消这次工具调用。
- **D4 本轮不接 `-b/--background`、不接 `--resume`**：两者服务"长跑/CI"，与"结论可信"正交，且需要新的轮询/会话 id 通路。
- **D5 delegate 的 `effort` 二选一：加一条"已忽略"备注**（保留 schema 字段，ocr 档要用），不删字段、不假装传了。

## 3. 实施分组

### W1 默认档位反转
- `lib/config.js`：`DEFAULTS.engine` → `"ocr"`，`DEFAULTS.autoEngine` → `""`（D2）；修 `normalizeConfig()` 里 `autoEngine` 的缺省/空串语义；设置页 engine 描述同步。
- 五处文案同步：`lib/client.js` 的 `CHOICE.engine`（ocr 提到第一）与中/英 hint、`lib/index.js` 的引擎参数描述 / 工具描述 / 指令第 3 条 / nextSteps。
- 文档：`README.zh.md`、`README.md`、`CHANGELOG.md` 的出厂默认与决策记录。
- 测试：`test/smoke.mjs` 的默认引擎断言改为 ocr + autoEngine 留空；`schemaOverrides` 用例的夹具改用非默认值（否则"取值等于出厂默认 ⇒ 不算覆盖"会把该字段吃掉）。
- 完成标准：干净配置下 `engine` 解析为 `ocr`、`autoEngine` 为空（跟随 engine）；显式 pin 仍生效。

### W4 修可达性门 + 摘掉 schema 装饰（必须在 W1 之后做）
- 去掉 `lib/index.js` 两道门的 `plan.engine !== "delegate"`：工具路径按"显式要求优先"，结果 `engine` 报 `agent` 并在 notes 说明冲突；自动路径由 `autoEngine`/`engine` 决定。
- 修 `lib/index.js` 工具 schema 里 `reviewer` 的描述与实现对齐；工具路径单轮的事实写进 notes。
- delegate 下 `effort` 非空 → 不传 `--effort`，加一条"已忽略"备注。
- 完成标准（判定 **2026-10-19**）：`engine=delegate` + `reviewer:true` 必须真走 reviewer 或明确报错；"静默降级且无 note" 0 次。

### W2 跑前成本预估（W1 的配套）
- `lib/review.js` 的 `costHint(plan, estimate)` 增加可选 `estimate`，输出"本次可审 N 个文件（排除 M）→ 按历史 3~10 分钟/文件约 X~Y 分钟、约 $Z"；无 `estimate` 时逐字保留今天的文案。
- 评审入口在 `engine ∈ {ocr, auto}` 且非 `preview` 时，先跑一次 `ocr delegate preview`（复用既有 preview 采集路径，≤0.3s、不计费）取可审/排除文件数；失败**不阻塞**评审。
- 边界：非 git / 0 可审 / preview 失败 → 退回通用文案；`engine=delegate` 不跑 preview；`preview:true` 复用已有数据。
- 判定 **2026-11-02**：预估区间与实际耗时偏差超 2× → 改用实测中位数。

### W3 覆盖回执 + 部分结果不得 clean
- ocr 侧：守住不传 `--max-tokens-budget`（不产生预算截断的部分结果）；识别 per-file/group 失败并标 `partial`，禁止输出"未发现问题"；超时/被杀一律判失败。**`partial` 必须同步进工具输出 schema**，否则宿主会以"未声明字段"拒收。
- delegate 侧：`buildDelegateSpec` 改分片渲染（片头形如 `[片 i/n · path · 本文件 hunk a-b/c · 字节数]`）；`lib/ocr-cli.js` 的字符级截断改 **hunk 级**（整片丢弃并报告数量）；采集与规格统一到单一上限常量。
- 工具描述与 notes 增硬规则："未回填的片不得计入 clean；读不到就明说未读到"。
- 判定 **2026-10-26**：覆盖率回填 100%；诚实度 0 违规；不达标就把 delegate 裸档降级为"预览"。

### W5 文档、判定线、仓库卫生
- 本文件 + `docs/maturity-assessment-2026-10-10.md` 路线图追加状态。
- `README` 增"可信性承诺"小节（四条可核对的说法 + fail-closed 证据链 + 成本预估示例）；**禁用词**：更准、更强、发现所有 bug、CI 级、安全审计、全仓扫描。
- `.gitignore` 收副产物：`.graphflow/`、`graphflow-out/`、`.dsh-progress/`、`.claude/`、`.trae/`。

## 4. 验收与量表

- **A 硬验收**：`npm test` 8 套全绿；本仓库跑一次真机 `engine=ocr` 评审，首条 note 含 N/时间/成本预估，结果 `engine=ocr`。
- **M1 覆盖回填率 = 100%**（delegate 档 5 个真实改动，人工留档）。
- **M2 已知缺陷召回 ≥2/4**：用 4 个真实历史回归的**修复前 diff** 各跑一次 `engine=ocr` —— ① v0.5.7~v0.5.10 preTest 全局 guard 放行返回 `""`（所有工具输出变 `Error: `）② v0.8.1 delegate 静默忽略 paths ③ v0.8.1 JSONL"取最后一个可解析行"拿到无 issues 片段 ④ v0.8.1 `extraArgs` 未过滤 → spawn TypeError。人工触发、留档原文，不进 CI。
- **M3 诚实度 = 0 违规**：四类注入条件（diff 被截断／分片被丢／非 git／规则正文缺失）下"未发现问题"的出现次数。
- 回看日：**2026-10-19**（W4 可达性）、**2026-10-26**（W3 + M1-M3）、**2026-11-02**（W2 预估复盘）。

## 5. 明确不做（含复活条件）

- P0-1 真人点击 12 用例、市场上架、14 天观测埋点扩展：属"入口与分发"，与"结论可信"正交。
- `-b/--background`、`--resume`、`ocr session compare` 工作流：留给"长跑/CI"批次；复活条件 = 单次评审被硬超时打断 ≥2 次，或用户要接 CI。
- 不把默认改回 `auto`；不新增重试/换模型容错。

## 6. 实施约束

- 顺序：W1 → W4 → W2 → W3 → W5。
- `lib/index.js` 与 `test/smoke.mjs` 被 W1/W2/W3/W4 共同触碰，**同一时间只允许一个写入者**。
- 改默认值后必须重跑 `npm test`（有 6 条自动档 reviewer 用例是"engine 决定自动路径档位"的现成回归）。

## 7. 实施状态（2026-10-12 收口）

| 工作包 | 状态 | 落点 |
| --- | --- | --- |
| W1 默认档反转 | ✅ | `lib/config.js`（`DEFAULTS.engine = "ocr"`、`DEFAULTS.autoEngine = ""`、`normalizeConfig` 区分「缺省」与「显式空串」、设置页描述）、`lib/client.js`（`CHOICE.engine` 顺序 + EN/中文文案）、`lib/index.js`（引擎参数描述、工具描述、指令第 3 条、`nextSteps`）、`config.json`（`autoEngine: ""`） |
| W4 修可达性门 | ✅ | `lib/index.js` 两处 `reviewerWanted` 去掉 `plan.engine !== "delegate"`；工具路径补「只跑 1 轮」备注；`effort` 在 delegate 下给「不生效」备注；工具 schema 的 `reviewer` / `engine` 描述同步 |
| W2 跑前成本预估 | ✅ | `lib/review.js` 新增 `estimateText()` + `costHint(plan, estimate = null)`；`lib/index.js` 新增 `estimateReviewSize()` 并在 `runOcrOnce` 接线（跳过 preview / scan / delegate / 已 abort） |
| W3 覆盖回执 + 部分结果 | ✅ | `lib/review.js` 新增 `splitDiffSlices` / `planDiffSlices` / `truncateDiffByHunk` / `detectPartial` / `buildDelegateSpecDetailed`（`buildDelegateSpec` 保留为取 `.text` 的包装）；`lib/ocr-cli.js` 的 `gitDiff` 改 hunk 级截断；`lib/index.js` 统一 `diffCap`、输出 `partial` / `partialReasons` / `coverage`、ocr 侧 `detectPartial` 且 partial 时摘要不写「未发现问题」；`mkResult` 与工具输出 schema 同步 |
| W5 文档与卫生 | ✅ | `README.zh.md` / `README.md`（默认档三处口径、v0.10.0 加固段、新增「可信性承诺（四条）」、断言数 261）、`CHANGELOG.md`（新增 [0.10.0] + 修正「60 秒」→ 10 分钟）、`package.json`（0.10.0 + 描述）、`.gitignore`（收 GraphFlow / smart-dl 副产物）；本文件 §7 与路线图追加即本行 |

**测试**：`test/smoke.mjs` **261 项全绿**（243 → 248(W4) → 251(W2) → 260(W3) → 261(真机验收修正)）；八套见 `npm test`。

### A 硬验收：真机 `engine=ocr` 一次（✅ 2026-10-12）
- 命令与范围：`scope=commit` · `commit=4507de6`（单文件 `screenshots.json`，+6 行），engine 显式 `ocr`，`timeoutMinutes=25`。
- 实际：`ocr review --commit 4507de6 --format json --audience agent --color never --timeout 25` → **exit 0、9.9s**；
  `status=complete`、`manifest.terminal_state=complete`、`coverage.selected=completed=[screenshots.json]`、`failed=[]`；
  `summary={files_reviewed:1, comments:0, total_tokens:1141, cache_read_tokens:8576}`、`tool_calls.total=3`
  （`code_search`/`file_find`/`file_read` 各 1）；`session_id=88c3a5df-e1dc-4139-b509-2c6d81a6e44c`。
- 判定线逐条：engine 字段 = `ocr` ✅；跑前 note 含规模与时间量级 ✅（「本次实测可审 1 个文件 → 按真机历史约 3~10 分钟」，
  且**按 commit 范围**而不是整个工作区报数）；未发现问题 ✅（`coverage.failed` 为空，clean 属真）。
- **验收暴露的真缺陷（已修）**：`detectPartial` 只认推定字段，真机的部分结果写在 `status` / `manifest.terminal_state` /
  `manifest.coverage`（selected 与 completed+reused 的差额）里 → 真机「选中 8 项、只完成 5 项」时一个信号都不命中，
  仍会输出「未发现问题」。已按真机字段扩展判定并加 1 条断言（smoke 260 → 261）。
- 说明：9.9s 是因为该文件只有 6 行 JSON；`176~600s/文件` 是真实代码文件的真机历史区间，两者不矛盾。

### 与 §3 的差异（已批准范围内，需复查）
- **W2 的成本预估没有给美元金额**。`$0.16/文件` 是 `ocr scan` 的真机口径，`ocr review` 没有同口径数字，写出来就是编 —— 与本版主线「不谎报」冲突。当前口径 = **规模（实测可审文件数）+ 时间量级（5 分钟内 / 未知）**；金额留给 **2026-11-02** 的回看日按实测中位数补，判定条件不变（预估与实际偏差超 2× 就改用实测中位数）。

### 尚未做（本计划范围内）
- ~~**A 硬验收的后半句**：在本仓库跑一次真机 `engine=ocr` 评审~~ → ✅ 2026-10-12 已跑（见 §A 硬验收，单文件提交、9.9s、预估与范围一致，并当场修掉 `detectPartial` 的漏报）。
- **M1 / M2 / M3**：都要真机或人工留档（M1 = delegate 档 5 个真实改动的覆盖回填；M2 = 4 个历史回归的修复前 diff 各跑一次 `engine=ocr`；M3 = 四类注入条件下「未发现问题」的出现次数），按 §4 的回看日执行。M2 的 4 次真机 `ocr` 与 M1/M3 的人工留档同样**按 tokens 计费**，跑之前会先给出范围与量级。
- §5 那批（真人点击 12 用例、市场上架、14 天观测扩展、`-b/--background` 与 `--resume`）仍未做，复活条件不变。

## 8. 后续（v0.11.0 可用性优化，2026-10-12）

本轮的判定线已另立文件：**`docs/usability-plan-2026-10-12.md`**。它处理的是与「结论质量」正交的另一条线 —— 第一次打开时撞上的东西：

1. **可用性优化**（用户原话驱动）：配置面瘦身（26 项 → 首屏 4 + 高级 3 组 + 只读诊断区）、「启动代码审核」按钮只在检测到本回合有改动时出现（`api/changes.summary`，fail-open）、`ocr` 档等待期体验（规模前置 / 超时告警 / `partial` 置顶 / 会话 id 回看）。
2. **本机代理定型**：`llm.bridgePort`（默认 18800）让桥地址跨重启稳定；dsh 模式下桥不可用**不再静默回落** `endpoint`，而是 `OCR_LLM_MISSING` + `nextStep`（`endpoint` 保留为显式逃生门）；路由顺序加入「当前会话正在用的模型」一档。
3. 测试：smoke 261 → **286**、client-smoke 195 → **208**；`npm test` 八套全绿。
4. 本文件 §7 的口径不受影响；§4 的 M1/M2/M3 回看日不变。
