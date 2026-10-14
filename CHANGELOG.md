# Changelog

All notable changes to **dsh-open-code-review**. Versions follow SemVer; the plugin is
distributed as a DSH bundle (`dsh plugin --profile <profile> add github:xinyangGL/dsh-open-code-review`).

## [0.12.3] — 2026-10-14（provider 与 model 混搭 —— 这条会让评审在真机上全部失败）

把 `llm.mode=dsh` 的评审在真机上跑通时撞出来的：`ocr_status` 报路由是
`provider=commandcode · model=deepseek/deepseek-v4-flash`，而插件本机桥的统计里 6 次请求**全部失败**，
最近错误是 `pi-ai provider "ark-coding-plan" has no configured model "deepseek/deepseek-v4-flash"` ——
同一次评审里，provider 与 model 来自**两个不同的来源**。

根因：`effectiveLlmRoute()` 用两条独立的 `||` 链分别取 provider 与 model（配置里没写 provider 时就去借
「当前会话正在用的 provider」），而桥**每个请求**都重新解析一次路由；会话级来源时有时无（子 fiber 还没激活、
宿主没给 session 上下文），于是同一个评审里出现两次不同的解析结果 —— 一次是
`commandcode + deepseek/deepseek-v4-flash`（合法），下一次是 `ark-coding-plan + 同一条模型名`（不存在）。

Fixed

- **`lib/index.js`**：`effectiveLlmRoute()` 改成只接受**完整的一对**（插件设置 → 当前会话 → DSH 默认模型）。
  配置里只写了一半（典型的：设置页只填了模型名、provider 留空）时，只有当别的来源给出**同一个模型**
  （缺 provider）或**同一个 provider**（缺模型）才借另一半；配不上就返回空路由 + 原因，走既有的
  `OCR_LLM_MISSING`，并明确提示「去设置页的模型下拉里重选一次（会同时写入 provider）」。
- **`lib/index.js`**：新增 `resolveProviderForModel()` / `resolveRoutePair()` —— 只写了一半时问一次 DSH 模型目录
  （`llm.listProviders()` + `llm.listModels()`，谁声明了这个模型就用谁），问到就用，
  `source` 标成「插件设置 + DSH 模型目录」。
- **`lib/index.js`**：新增 `bridgeRoutePin` —— 评审开始时解析出的那对路由会被桥**钉住**；桥只在请求体的
  model 相同（或为空）时用它，不再随会话状态的抖动漂移。
- **`lib/bridge.js`**：`target()` 现在接收请求体里的 model，用来判断「这次请求还属不属于被钉住的那对」。

Tests

- `test/smoke.mjs` +3：事故回归（目录里 `commandcode` 声明了那条模型 ⇒ 端点必须是 `commandcode/…`、
  `source` 含「DSH 模型目录」、**不得**出现 `ark-coding-plan`）、`OCR_LLM_MODEL` 取值正确、目录查不到时
  报错含「只写了模型名」。
- `test/bridge-smoke.mjs` +1：`target` 收到请求体的 model；命中 `bridgeRoutePin` 时用被钉住的那对。
- `test/smoke.mjs`（测试纪律，D7）：**文件层隔离** —— 把 `DSH_OPEN_CODE_REVIEW_CONFIG` 指到一个空 JSON，
  路由类断言不再取决于「这个 checkout 里的活 `config.json` 写了什么」。这条是被本机的现网兜底逼出来的：
  把 `llm.provider` 补进 `config.json` 之后，5 条路由断言跟着红了，正好证明测试一直没和文件层隔离。
- smoke **324** / killswitch 44 / host-contract 37 / job 51 / reviewer 45 / bridge **105** / client-smoke 214 / cordis-inject + 打包体检 4/4。

Note

- 已经踩到的现网配置（设置页只填了模型名、provider 留空）**不必等新版本**也能恢复：把 provider 补进
  `config.json` 的 `llm.provider` 即可 —— 设置页里空着的 provider 不会遮住文件层的值
  （`schemaOverrides()` 会跳过「无意义 / 等于默认值」的字段）。

## [0.12.2] — 2026-10-14（回合尾部入口的 fail-open 加固 —— 这条是脚本化回归走出来的）

P0-C 12 用例回归里，「按钮正例」在**已鉴权的测试 GUI** 上撞出真问题：回合尾部压根没有入口。
定位到 `lib/client.js` 的 turnTail 入口把「宿主有改动服务、但这一回合没留下改动记录」当成
「本回合没改动」，直接 `return null` —— 与同一段代码顶部注释承诺的 fail-open（读不到就退回
「总是显示」）相反。旁证：宿主改动服务不可用时，按钮整块静默消失（功能在，入口没了）。

Fixed

- **`lib/client.js`**：`if (feedReady && (changesSeq === null || hasChanges !== true)) return null;`
  → `if (feedReady && hasChanges === false) return null;` —— 只有明确读到 `total=0` 才隐藏；
  记录缺失、请求失败、路由不可用一律给出入口。

Tests

- `test/client-smoke.mjs`：「本回合没有改动记录」的断言从「按钮不出现」改成「按钮出现（按不知道处理）」，
  注释里写明取舍来由。smoke **321** / client-smoke **214**，其余同 v0.12.1。

## [0.12.1] — 2026-10-14（英文界面的 placeholder 补齐 —— 这条缺陷是「加守卫」加出来的）

**v0.12.0 发布后我补了一条「`en` 词典必须覆盖 `zh` 词典的每一个键」的源码级守卫，它当场点名 5 条** ——
全是 `placeholder`：`field.llmModel.placeholder`、`field.llmProvider.placeholder`、
`field.reviewerProvider.placeholder`、`field.llmBaseUrl.placeholder`、`field.llmApiKeyRef.placeholder`。
`makeT()` 在词典里找不到键时会退回**内联中文原文**，所以界面语言是英文时，这 5 个输入框的灰字提示一直是中文
（其余字段的 placeholder 都有 en 条目，只有这几条漏了）。

Fixed

- **`lib/client.js`**：补上这 5 条英文 placeholder（`empty = follow the current conversation / the DSH
  default model`、`empty = follow the current conversation`、`spawn`、`https://api.commandcode.ai/provider/v1`、
  `COMMANDCODE_API_KEY`）。

**同日后来补上第二条同源缺陷（这条是「真机边界」走出来的）**：`engine=delegate` 撞上「规格里没有可审文件」时，
返回的是**「成功（exit=0）」**—— 一个文件都没审，却很容易被读成「评审通过、没问题」。这与 v0.12.0 修的 M6（ocr
档）与 E2（评审 agent 档）是同一个失败方向，只是发生在 delegate 档。

- **`lib/index.js`（delegate 档）**：`targetFiles` 为空（既没点名 `paths`，`ocr delegate preview` 又给了空清单）
  且不是 `preview: true` 时，走 `partial` 通道并写清原因（三种口径：「本次没有检测到任何代码改动（工作区是干净的）」／
  「改动全都落在被排除的文件类型上（见已排除清单）」／「规格里没有可审文件」）—— 摘要因此变成
  `⚠️ 部分结果（…）：委派模式：0 个可审文件…`，结论文本的「可用性」行写「只能作为部分结论」。与 M6、E2 同一口径。
  真机复现（2026-10-14，干净工作区）：修前 `partial=false`、摘要只有「成功…0 个可审文件」。

Tests

- **`test/smoke.mjs`**：新增一条 —— delegate 档空清单必须 `partial=true`、摘要以 `⚠️ 部分结果` 开头、notes 里明说
  「没有做出任何结论」。计数：`test/smoke.mjs` 319 → **320**。
- **`test/client-smoke.mjs`**：新增一条守卫 —— `en` 词典必须覆盖 `zh` 词典的**每一个**键，失败时**直接列出
  缺的键名**（不是只说「不齐」）。这条守卫就是发现上面 5 条的原因，留着防止以后再漏。
  计数：`test/client-smoke.mjs` 213 → **214**。

**同日再补上批 2 的最后两层结论结构（第 2 层「规模」与第 4 层「下一步」）**：结论原本要读者自己从后面几行里拼
出「这次到底审了多大一块」，而且只有失败才给「下一步：」——成功的结论读到最后不知道下一步干什么。现在两层都
固定存在：`规模：可审 N 个文件（+a -b） · 排除 c 个 · 改动 d 个 hunk`；`下一步：…`（有宿主/插件给的 nextStep
就用它，成功时按「有问题 / 只有部分结论 / 干净」三种情形各给一句）。批 2 的结论六层至此齐了（L1 结论行 /
L2 规模 / L3 问题+分组计数 / L4 下一步 / L5 出处 / L6 附录固定存在），本条补上的是 L2 与 L4。

Changed

- **`lib/review.js`**：`valueToText()` 增加「规模」层，「下一步」层不再只在失败时出现（第 4 层固定存在）。

Tests

- **`test/smoke.mjs`**：新增一条 —— 规模层必须给出「可审 N 个文件（+增删）· 排除 N 个 · 改动 N 个 hunk」，
  下一步层必须固定存在且排在规模层之后（失败仍优先用 `nextStep`）。计数：320 → **321**。

## [0.12.0] — 2026-10-13（批 1 + 批 2 + 打包体检）

**只针对「代码审核」这条线的不足盘点（不加新功能，但已有的内容必须好用）：先修最危险的三条 —— 结论会在不该干净的时候说干净。**

Fixed
- **E2（最危险）**：`engine=agent`（独立评审 agent）这一档会丢掉规格的「部分结果」标记 —— 子 agent 只看得到
  半份规格（diff 被按 hunk 截断 / 缺规则正文 / 拿不到 diff），**clean 摘要却照写「未发现问题」**。
  v0.11.2 修的是 ocr 档同一个失败方向，agent 档漏了。现在这一档**无条件继承** `partial` / `partialReasons` /
  `coverage`；clean + partial 时不再输出「未发现问题」，改成 `⚠️ 部分结果（…）` 开头 + 「只覆盖了部分改动，
  已覆盖的部分没有发现问题」，并给出「缩小范围重跑 / 改用 ocr 引擎」的下一步。
- **E1（承诺了做不到的事）**：`scope=workspace` 配 `paths` 过去被**静默忽略** —— `ocr` 的根命令是 `ocr review`，
  它没有 `--path`（只有 `ocr scan` 有），所以「只审 lib/x.js」实际审的是全部未提交改动；更糟的是规格预估
  （`estimateReviewSize`）还按 `paths` 报了一个比实际更小的规模。现在这种组合**显式报错**
  （`OCR_INVALID_ARGS`，并给出 `scope=scan` / `scope=commit|range` / `engine=delegate` 三条出路），
  预估里那段按 `paths` 过滤一并删掉。`engine=delegate`（真的会用 paths 过滤规格）与 `scope=scan` 不受影响。
  README 的命令示例与工具 schema 说明同步改（原来那句「只审 src/ 下的改动」是做不到的）。
- **M6（说反了的话）**：工作区**完全干净**时，`reviewedFileCount()` 的回落链（`files` → `total_files` →
  `reviewable_count`）会让摘要写成**「审查 N 个文件，未发现问题」**——可这次一个文件都没审。现在分成三种：
  ① 连改动都没有（`emptyReview`）→「本次没有检测到任何代码改动」；② 有改动但一个都没审到
  （`nothingReviewable`）→「没有可审的代码改动」+ 列出被排除的文件；③ 真审了文件且问题清单为空 → 才允许
  说「未发现问题」。①② 都带 `partial=true`，结论里明说「没有做出任何结论」。

- **E3（结论难用）**：结论头部只有一行状态，`partial` / `coverage` / `reviewSessionId` 三个字段要读者自己拼。现在
  多了一行**可用性**：`可用性：可作为本次范围的完整结论` / `**只能作为部分结论**：有未覆盖的部分，不能当作
  「未发现问题」` / `本次没有成功，没有结论`，后面接覆盖回执（`收录 7/12 个 hunk · 2/3 个文件片 · 丢弃 5 个
  hunk · diff 被截断`）与 `ocr 会话：…`。工具 schema 里 `partial` / `coverage` 的说明也指向这一行。

- **T1（没有互斥）**：同一插件实例能同时跑多条评审流水线 —— 自动评审与手动点击撞在一起时，两条流水线抢同一份
  配额、结论互相覆盖。现在加了**单飞闸**：第二次调用立刻拿到 `OCR_ALREADY_RUNNING`（带上「谁在跑、跑了多久」）
  与下一步；闸门在 `finally` 里释放，跑完照常能再调。
- **T2（超时不对齐）**：`ocr_review` 的宿主侧兜底超时曾固定 30 分钟，而 `maxTimeoutMinutes` 默认 60 分钟 ⇒ 用户
  把上限调大后，先掐断的是宿主，拿到的是宿主级中断，而不是带 `nextStep` 的 `OCR_TIMEOUT` 结果。现在按启动时
  生效的上限 + 60s 宽限算（默认 61 分钟）；改 `maxTimeoutMinutes` 与改 `llm.bridgePort` 一样要重启才生效。
- **R5（常量收敛）**：`lib/index.js` 里曾有一处手写的结果码字符串 `OCR_REVIEWER_UNCERTAIN`（写错一个字符只有
  真机才看得见），现在一律走 `REVIEWER_CODES`，并加了一条源码级守卫防止再写回来。
- **R4（假账的前提被关掉）**：`usage` 是「桥的累计 usage 前后差」，并发时会把他人的请求算进本轮 —— 这条机制洞
  被 T1 的单飞闸关掉（同一实例同时只跑一次评审），并把这条不变式写进代码：**放开并发就必须改成 per-run 记账**。
- **R3（入口依赖了不该依赖的服务）**：回合尾部的「启动代码审核」按钮过去要求宿主提供 `jobs` 服务
  （依赖列表 `["jobs", "configForms", …]`）—— 「宿主没有 jobs」会把**入口整块藏掉**，而 jobs 只用来显示
  「正在评审…」这行进度。现在按钮子 fiber 的依赖只剩 `["configForms", "remote", "remote.commands"]`，
  取不到 `ctx.jobs` 时退回恒 `undefined` 的选择器（hook 调用次数与 jobs 在不在无关），按钮照常出现、照常可点；
  防重复点击由 T1 的单飞闸负责。**已知边界**（不粉饰）：没有 jobs 时**没有可视化停止入口** —— 停止按钮长在
  进度行里（走 `jobs.kill`）。真机复现见 `test/client-smoke.mjs` 的 R3 用例（宿主没有 jobs 时按钮仍渲染）。
- **R6（覆盖回执只留了一半）**：结论里的「可用性」行会写覆盖回执（收录几个 hunk、丢没丢），但 **job 记录里没有** ——
  长评审过几天回到 Jobs 面板翻账，就只剩「完成：…（12m03s）」，看不出当时到底覆盖了多少改动。现在
  `coverageSummary()` 是**唯一一份文案**，结论的可用性行与 `finishReviewJob()` 共用它；job 的完成明细后面会带上
  ` · 覆盖：收录 3/5 个 hunk · 2/3 个文件片`。

Changed（外观与可访问性 · 批 2 第一步）
- **令牌化**：容器的底色只用 `--dsw-alias-bg-layer-1/2/3`（浮层固定 `bg-layer-3`），边框统一
  `--dsw-alias-border-l1` —— 不再自造 `rgba(127,127,135,0.0x)` 这种半透明叠层色当容器底。**删掉了
  `guessBg()`/`isOpaque()`**：它们沿 DOM 往上猜祖先底色，猜到的常常是 α<0.95 的叠层色（菜单半透明、
  文字穿透的根因）；现在菜单写死令牌 + `Canvas` 兜底，抬头也给了不透明底色（sticky 滚动时不再透字）。
- **刻度收敛**：间距回到 4px 刻度（`5px→4px`、`7px→8px`、`9px→8px`、`14px→12px`、`gap 6→8`），
  圆角只用 4/6/8/999（`5px→6px`），字号收成 5 档（10.5/11/12/13/15，去掉 11.5 与 12.5）。
- **对比度**：二级文本按「layer-1/2 上 ≥50%、layer-3 上 ≥55%」重算 —— `progress.hint` 0.45→0.58、
  `menuItemGroup` 0.5→0.58、`menuItemSub` 0.55→0.58、`progress.time` 0.5→0.55；`btnBusy` 的整块
  `opacity: 0.6` 去掉（容器整体降透明度会把对比度压到下限以下）。
- **可访问性**：模型候选菜单 `role=listbox` + 每项 `role=option`/`aria-selected`、输入框
  `role=combobox` + `aria-expanded`/`aria-controls`/`aria-activedescendant`、展开按钮补
  `aria-label`/`aria-haspopup`；进度卡 `role=status` + `aria-live=polite`、耗时 `aria-hidden`（秒数
  每秒都变，不该反复读屏）。行内样式表达不了 `:focus-visible`，所以注入一张只含一条规则的样式表
  （作用域限定插件自己的 `data-ocr-*` 容器，幂等，拿不到 `document` 时静默跳过）。
- 菜单高度改为 `min(264px, 42vh)`（小窗口里不再顶到屏幕外）。

Fixed（上架前自查：文档副本与代码对不上的三处）
- **`config.example.json` 的 `engine` 写的是 `"auto"`**（出厂默认自 v0.10.0 起是 `"ocr"`）—— 模板是给新用户
  **直接复制**的，复制粘贴即悄悄回到 v0.10.0 之前的行为，还与 README 的「Choosing an engine」自相矛盾。
  改成 `"ocr"`，并加一条断言：模板里写明了值的那 9 个键（enabled / engine / auto / onDemand / audience /
  timeoutMinutes / maxTimeoutMinutes / llm.mode / reviewer.agent）必须与 `DEFAULTS` 一致。
- **README 的两条可信性承诺里引用了不存在的字段 `engineSource`**（`lib/` 下根本没有这个字段）—— 改成
  `ocr_status` 真正返回的 `engine`，并指明用 `configSource` / `fileValues` 回答「这个值来自文件层还是设置页」。
- **`docs/host-contract.md` 手抄的 `dsh.host.capabilities` 只有 6 条**，真身是 14 条（`package.json` 原文）——
  改成真身，并写明「别再另抄一份」；那份文档的 `ocr` 实测版本也补成 `1.12.12 / 1.12.13`。
- 顺带把「只在文件层生效的键」在双语 README 里补全（`llm.bridgePort`、`llm.effort`、`includeDiffMaxBytes`、
  `maxIssuesInText` 之前被一句 `and the other file only keys` 糊过去）。

Changed（批 3 第一步：打包与 CI —— 「陌生人装到的是什么」）
- **包只发该发的**：`files` 从整个 `docs/` 收窄到 README 真正链到的那几份
  （`docs/host-contract.md`、`docs/pretest-gate-safety-design.md`、两张设置页截图）；
  内部自评（`maturity-assessment`，里面写着「还不成熟」）、`ROADMAP.md`、`*-plan-*.md` **不再进包**，
  README.zh 里对它们的引用改成 **GitHub 绝对链接**（并把「内部文档，不随包发布」写明）。
- **`npm run test:pack`（新增 `test/pack-check.mjs`）**：跑一次 `npm pack --dry-run` 并断言四件事 ——
  ① 版本号三处一致（package.json / npm 打出来的包 / CHANGELOG 最新一节）；② 必需文件都在包里
  （插件主体 + 两份 README + 示例配置 + README 里链到的图与文档）；③ 活配置 `config.json`、日志、
  `test/`、内部计划与自评、`.git`/`node_modules`、GraphFlow 产物都没进包；④ README（中英）里每个
  `docs/…` 引用**要么就在包里、要么写成了 GitHub 绝对链接**。这条断言当场就抓出 3 处读者点不开的引用。
- **CI 加一步**：`npm run test:pack` 进 `.github/workflows/ci.yml`（离线套件之后、cordis 之前）。
  原来 CI 只回答「代码对不对」，不回答「发出去的是个什么东西」。
- **本地复现 CI 的离线档**（以前只能指望 CI）：`test/smoke.mjs` 的 `which()` 认一个新开关
  `OCR_TEST_FORCE_NO_OCR=1` —— 置位后任何 ocr 可执行文件的查找都返回空。两个坑写在注释里：
  **绝对路径也要挡**（工作区 `config.json` 常把 `ocrPath` 钉成绝对路径，只挡 PATH 查找挡不住 —— 上一次
  就是因此「复现不出来」），**正则只匹配 ocr**（否则连 `git` 一起挡掉，连锁出 10 项假失败）。
  实测 `OCR_TEST_FORCE_NO_OCR=1 node test/smoke.mjs` → **319 项全过**（与装了 ocr 时**同数**：离线档是把真机断言换成等价断言，不是跳过） ⇒ 「CI 等价环境」从「没做过」
  变成「做过一次、有命令可复现」。
- `npm test` 末尾接上 `npm run test:pack`：本地一条命令 = 八套离线套件 + 打包体检。


- **严重程度不再有「未知 = 低」**：结论里的档位统一按 高/中/低 展示，**认不出来的一律「未分级」**。
  改动落在两处：`lib/reviewer.js` 的 `parseFindings()` 把不认识的 severity 归一成 `unknown`（原来是
  `minor`，注释里就写着「未知值统一归 minor」——那等于替模型低估一个问题），`SEVERITY_RANK` 把
  `unknown` 排在 `major` 之后、`minor` 之前；`lib/review.js` 新增导出 `severityLabel()`，认不出来的一律
  `未分级`（上游措辞五花八门：critical/blocker/error/major/medium/warning/nit/建议/P2/数字…）。
- **结论第 3 层带分组计数**：`发现问题 N 条（涉及 M 个文件）：高 a · 中 b · 低 c · 未分级 d` —— 一眼看出
  这次是「一堆小问题」还是「一条真要命的」。
- **回合尾按钮加副行代价标签**（四位专家里三位都点到的「点前看不到代价」）：按 `engine` 档位给文案 ——
  `ocr` 档「约 3~10 分钟/文件、按 tokens 计费 · 跑前会先给预估」、`delegate` 档「不调 LLM，几秒出规格」、
  `auto` 档「配了 LLM 就走 ocr 流水线」、认不出档位时只承诺「点下后会先给范围与成本预估」。
  **不新增宿主读取通道**（档位本来就在按钮已经读过的那份配置快照里），**不编美元金额**（审批口径：
  人读不懂的精度不算诚实；`$0.16/文件` 是 `ocr scan` 的口径，`ocr review` 没有同口径数字）。
- **结论第 6 层（附录）固定存在**：不管有没有附加材料，最后都有一行 `附录：…` —— 有材料就列出材料清单
  （审查规格 / 配置提示 / N 条备注 / 被截断的输出 / stderr / 原始 JSON），没有就明写「无附加输出」；
  读的人不必猜「这次还有没有更多细节」。第 2/4/5 层（代价规模 / 下一步 / 出处）继续由已有的行承担：
  规模在头部与可审文件清单里，下一步在失败与部分结果时给出，出处是 `命令：`/`仓库：`/`ocr 会话：` 那几行
  —— 不重复造第三份说法。
- **停止的武装态写出后果**：进度卡里点过一次「停止」后，多出一行后果句「再点一次会终止这次评审：已经产出
  的部分结论会保留，没跑完的文件没有结论（不是「没问题」）」。原来是只有一个「再点一次停止」的按钮，
  用户得自己猜再点一次会发生什么。

Tests
- **上架前自查**：`test/smoke.mjs` 318 → **319** 条 —— 新增「`config.example.json` 里写明了值的 9 个键必须与
  `DEFAULTS` 一致」（模板是给新用户复制粘贴的，与默认相反就等于改默认）。
- **批 2**：`test/smoke.mjs` 306 → **318** 条（十二条源码级 / 结论结构守卫）：三张样式表都取到（守卫不能空跑）、同一张表里
  没有重复键、间距在 4px 刻度上（1/2px 仅限紧凑控件）、圆角只用 4/6/8/999、字号只有 5 档、没有半透明叠层色
  当容器背景、菜单与抬头走 `bg-layer-3` 且 `guessBg`/`isOpaque` 已删、可访问性角色与焦点环注入在位、
  严重程度映射（critical/MAJOR/中文 → 高；P2 → 中；nit/建议 → 低；unheard-of/空/数字 → **未分级**）、
  回合尾按钮的副行代价标签（档位取自已有配置快照，认不出档位时不编数字）、结论的附录行固定存在
  （有材料列材料、没有写「无附加输出」）、进度卡武装态的后果句。
  （这些是排版层事实，mini-DOM 没有排版引擎量不出来；真机复核仍走 bsk 的 aria 快照 + 元素几何。）
  同时删掉了旧守卫「背景只认真正不透明的祖先」—— 它锁的正是这次要删掉的机制。
- `test/reviewer-smoke.mjs`：未知 severity 的断言从「归 minor」改成「归 `unknown`」（不再替模型低估）。
- **批 1**：`test/smoke.mjs` 291 → **306** 条：E1 三条（拒绝 / delegate 与 scan 不误伤 / 预估不再按 paths 少报规模）、
  E2 一条（超大 diff 逼出规格截断 + 子 agent 说 clean → `partial=true`、摘要标 `⚠️ 部分结果`、不含
  「未发现问题」）、M6 三条（空改动 / 全被排除 / 真干净不误伤）、E3 两条（部分结果的可用性行 + 覆盖回执，
  以及完整/失败两种口径）、T1 两条（并发第二次 → `OCR_ALREADY_RUNNING`；闸门在跑完后释放）、T2 一条
  （宿主侧兜底超时 > 30 分钟）、R5 一条（`lib/index.js` 里没有手写结果码）、R6 一条（覆盖回执单一来源，
  空输入返回空串）、R3 一条（源码级：按钮子 fiber 的依赖里没有 jobs、进度行仍要 jobs、按钮只守 `sessionId`）；
  结果码表 15 → 16。
- `test/client-smoke.mjs` 213 条：把「没有 useJobs 时返回 null」那条**改成 R3 的新语义** —— 宿主没有 jobs 时
  按钮**仍然渲染**（原来那条锁定的正是要被改掉的行为）；另外给按钮本体加了 `NO_ROWS_HOOK` 兜底，
  宿主给不出 hook 时不再 TypeError。
- **CI 修复**：`v0.11.0：端口全被占` 这条用例在**离线档**（机器上没装 ocr）必然先报 `OCR_NOT_FOUND`，
  此前没分档 ⇒ GitHub Actions 六个 job 全 `FAIL Offline test suites`。现在按 `HAS_OCR` 分档断言
  （离线档断言「失败原因确实是找不到 ocr」——不静默跳过、也不把环境缺 ocr 误判成产品缺陷）。

## [0.11.2] — 2026-10-13

**盘点「已有的东西到底好不好用」时真机撞出来的两个缺陷：按需评审 skill 注册成功却读不出来；改动全是不可审类型时会说「未发现问题」。**（两条都不是重构，是把声明与实际对齐。）

Fixed
- **按需评审 skill「注册成功、模型一读就红」**：`加载技能 Error: loaded skill "ocr-on-demand-review" source must be a string`。
  宿主的 `skills.register()` 只补 `invocation` 与 `provider`、**不补 `source`**（`dsh-skill/lib/index.js` 的
  `register` 与 `validateDefinition` 是两个地方），而加载时还要再跑一遍 `validateDefinition()`
  （要求 `name/description/source/provider/content` 全是字符串）。于是 `ocr_status` 只看「register 有没有抛错」
  ⇒ 报 `registered=true`、功能却是坏的：用户说「验证一下 / 评审」时模型拿不到技能正文，只剩命令注入的那段提示词撑着。
  现在定义里补上 `source: "runtime"`。
  - 复现（跑着的桌面宿主，1 行）：`skill ocr-on-demand-review` → 上面那条报错。
  - 修后验证（全新 headless profile，装同一份插件）：同一调用拿到技能正文原样返回，不再报错。
- **没有可审文件时会说「未发现问题」**：工作区只有一个 `.txt` 改动时，`ocr review` 返回 `reviewable_count=0`
  + 空 `files` + 空 `issues` + `exit 0`；而 `reviewedFileCount()` 的回落会把 `total_files` 当成「审了几个文件」
  ⇒ 摘要打出**「审查 1 个文件，未发现问题」**，可这次一个文件都没审。这正是本插件最不该出现的失败方向
  （与 W3「部分结果不许当未发现问题」同一条规矩）。现在这种情形按**部分结果**处理：`partial=true` +
  「本次没有可审的代码改动」+ 列出被排除的文件 + 下一步（换 `scope` 或显式给 `paths`）。

Tests
- `test/smoke.mjs` 新增 2 条守卫：① skill 定义满足宿主加载校验（`source` 必须自己给 —— 注册期查不出来，
  只有加载期才会炸）；② 没有可审文件时摘要既说清原因、也**不许**出现「未发现问题」。

## [0.11.1] — 2026-10-13

**修「高级设置里的模型名不能选」：候选目录不再请求风暴，读不到也不再只有一句「正在读取…」。**

Fixed
- **模型目录的读取风暴**（`lib/client.js` 的 `useModelCatalog`）：宿主的 `ctx.remote.session` 是**生成的 namespace**
  —— 每次读 `session.modelCatalog` 都返回一个**新的**包装函数，而旧实现把这个函数放进了 `useEffect` 的依赖数组，
  于是每次渲染都重取一次目录、取完 `setState` 又触发渲染。真机上就是请求风暴（2026-10-13 实测 console 里
  `/api/session/modelCatalog` 同一地址连出 30+ 条请求），界面永远停在「正在读取 DSH 模型目录…」、模型名选不动。
  现在函数与会话对象用 `ref` 接住，**依赖数组保持 `[ctx, unsupported, unsupportedReason, nonce]`**：自激的来源是
  「每次读属性都新生成的包装函数」，不是 `ctx` —— `ctx` 只随宿主的渲染变、不会被本组件的 `setState` 改掉，
  而且**必须留着**：子 fiber 迟到激活（设置页先渲染、`remote` 服务后到）时靠它重取一次目录，才能从兜底
  读取口换成官方读法，`test/client-smoke.mjs` 的「服务迟到」场景钉的就是这条。也不能改用 `locale` 顶替 ——
  `localeOf(ctx)` 返回的是 locale **服务对象**，本身也是对象。
  ⚠️ **更正**：本提交（`d56c87c`）当时的提交信息与本节曾写成「依赖改成了 `[locale, …]`、一个对象都不留」
  —— **代码里没有这个改动，而且那样改会破坏「服务迟到 → 官方读法优先」这条契约**。2026-10-13 的
  `ocr_review`（engine=ocr，本版真机自审）把这两条挑了出来，处理结果见 `docs/ROADMAP.md` §6。
- **读不到目录时给得出下一步**：新增 8 秒超时（文案「等待 8 秒没有响应」），并在模型名那一行渲染
  「重试读取目录」按钮（标记 `data-ocr-model-retry`），点一下立刻重取；这仍然只是候选列表的问题，
  输入框任何时候都可以直接手输模型名。
- **下拉点开「什么也看不见」**（2026-10-13 真机复现；根因是样式表里的一处**重复键**）：`S` 里 `combo` 写了两次
  —— `{ position: "relative" }` 与 `{ display: "grid", … }`，对象字面量的后一个键**静默覆盖**前一个
  ⇒ 组合框不再是定位元素 ⇒ 菜单（`position:absolute` + `top:100%`）的定位基准变成**设置面板本身**，
  `top:100%` 于是落在面板底部之下，而面板是 `overflow:hidden`，菜单就被裁掉了：DOM 里有菜单、屏幕上看不见。
  真机量化（bsk，web profile，1912×900）：修前菜单 rect `[556, 854, 800, 231]`（面板底边 850），
  `elementFromPoint` 在该处打不到任何元素；把 `position: relative` 并回**唯一**的那个 `combo` 键之后
  rect = `[981, 583, 335, 231]`（正好在输入框下方、面板内），截图里 4 条候选可见、点一条即写回模型名与提供方。
- **菜单半透明、候选文字与说明文字互相穿透**：`guessBg()` 原来是「往上找第一个非 transparent 的背景色」，
  于是取到了 `rgba(127,127,135,0.045)` 这类**叠层**色（设置卡片就是这么画的），菜单背景 alpha≈0.04。
  现在只认真正不透明的背景（`rgba` 且 alpha ≥ 0.95），找不到时退回
  `var(--dsw-alias-bg-layer-2, Canvas)` —— 令牌在本机主题里是 `#2c2c2e`，`Canvas` 是给 `color-scheme` 的兜底；
  修后实测菜单 `background: rgb(44, 44, 46)`。

Added
- **模型思考强度 `llm.effort`**（**不进设置页**，写 `config.json` 改；默认空 = 不指定）：本机桥在转发时把它当
  DSH `GenerateOptions.reasoningEffort` 交给宿主，所以「思考强度」和模型、provider、配额一样留在 DSH 里面。
  合法值由**每个模型自己声明**（模型目录里的 `reasoning.efforts`），所以插件**不做白名单、也不夹取**：填了
  不支持的值由 DSH 在真正调用上游之前拒绝、错误原样报出来（静默降级会让人以为换了档位其实没换）。
  改完不用重启（桥每次请求现读配置）。与 `ocr_review({ effort })` 不是一回事：那个是 OCR 自己的**评审力度**。

Tests
- `test/bridge-smoke.mjs` 104 项（v0.11.0 提交时 103）：新增 `llm.effort` 转发夹具 —— 第一次请求带
  `reasoningEffort: "high"`，把配置改成空之后**下一次请求不再写这个键**（证明改配置即时生效、且不塞空串）。
- `test/smoke.mjs` 291 项（v0.11.0 提交时 286）：新增 `llm.effort` 归一化断言（trim、截断 64、非字符串回默认空）；
  2026-10-13 再加 **4 条源码级守卫**（`combo` 键唯一、`combo` 带 `position: relative`、`menu` 是 `absolute` + `top: 100%`、
  背景判定排除半透明叠层且有 `Canvas` 兜底）—— 这两条缺陷是**排版层**的事实，mini-DOM 没有排版引擎量不出来，
  所以钉在源码层；真机复核用 `bsk` 量元素几何 + 截图（见 `docs/ROADMAP.md` §6）。
- `test/client-smoke.mjs` 213 项（v0.11.0 提交时 208）：新增「宿主 namespace 每次读都是新函数」的回归夹具
  （断言目录读取次数是常数级、反复渲染不再增长）与「读失败 → 出现重试入口 → 点重试恢复候选」的端到端夹具。

## [0.11.0] — 2026-10-12

**能用得下去的三件事：设置页不再问用户不关心的问题、按钮只在有改动时出现、`ocr` 档把「跑前就能知道的事」补齐。**

这一版没有新引擎、没有新能力，改的全是「用户第一次打开时会撞上的东西」：26 个配置项平铺在一个页面里
（大部分出厂值根本不用改）、按钮在每个回合尾都出现（哪怕这一回合什么都没改）、`ocr` 档跑起来要等几分钟
却什么都不知道。三条各自都有明确的判定线，写在 `docs/usability-plan-2026-10-12.md`。

Added
- **跑前规模进「开跑那一行」**：`engine = ocr` 时先做一次免费的规模预估（`ocr delegate preview`，几百毫秒），
  把「本次约 N 个文件 → 按真机历史约 lo~hi 分钟」放在 job 的第一行，而不是等 6 分钟后在结果里才看到；
  预估下限已经超过本次超时时**开跑前**再给一条告警（「很可能跑到一半被掐断，而掐断后拿不到任何结论」）。
- **预计剩余（心跳第三段）**：长评审的进度行多一句「预计还需 X 分钟起 / 已过预估下限，按上限还剩约 Y 分钟 /
  已过预估上限」—— 这不是进度条（ocr 的 stdout 只有横幅，谎报百分比比不报更糟），是拿跑前预估当尺子的三档
  诚实话术；拿不到预估就闭嘴。
- **`reviewSessionId`**（工具返回值新增字段）：结果带回 ocr 自己的会话 id，配 `ocr session show <id>`（逐文件
  结果）、`ocr session export <id>`（自包含 HTML）、`ocr viewer`（浏览器里过一遍、可标 fixed/ignored）。
- **`llm.bridgePort`**（默认 **18800**，**不进设置页**，写 `config.json` 改）：本机桥不再用随机端口，重启地址
  不变；首选端口被占用时顺延（最多试 10 个），`ocr_status.bridge` 用 `requestedPort` / `portShifted` 说明。
- **设置页只读诊断区**：被移出表单的 15 个键在页面末尾逐条列出「当前值 · 键名」，并注明「要改就写
  `config.json` 的 `<键>`；运行期实况用 `ocr_status`」。

Changed
- **设置页三分法**（`lib/client.js`）：首屏 4 项（总开关 / 默认引擎 / 按需评审 / 自动评审，且自动评审只给
  `off` 与 `adaptive` 两档）、折叠的「高级设置」3 组（模型路由 / 独立评审 agent（仅 `spawn` 时显示三项）/
  评审先于测试）、末尾只读诊断区。其余 15 个键**仍然保留 schema 与 `config.json` 约定**（行为零变化），
  只是不再作为输入控件出现。
- **回合尾按钮只在「本回合有改动」时出现**：客户端注册一个 conversation event definition
  （`kind = ocrTurnChanges`，只匹配 `turn/start` 与 `workspace/changes`），按钮读本回合落下的 `changesSeq`，
  再取宿主的 `api/changes.summary?sessionId=..&seq=..`；`total === 0` 才隐藏。**失败一律 fail-open**：
  宿主没提供事件定义能力、取不到 `turn.data`、请求失败或形状不认识，都照旧显示按钮（宁可见了没改动，
  不可有改动却看不见）。按钮的 `onDemand=false` 仍然不渲染。
- **`dsh` 模式不再静默回落静态端点**（v0.10.0 已预告，这版收口）：本机桥起不来 / 模型名缺失时，
  `ocr_review` 直接以 `OCR_LLM_MISSING` 失败并给出三种原因的 `nextStep`，**一个子进程都不起**（不出结论、
  也不产生费用）；要直连静态端点请显式把 `llm.mode` 改成 `endpoint`（这条路仍然完整保留）。
- **LLM 路由顺序 = 插件设置 → 当前会话正在用的模型 → DSH 全局默认**：第二档是新增的（读
  `Session.requestContext()`），于是「对话里切了模型」下一次评审就跟着变，不需要重启、也**没有新开关**。
- **`partial` 结果首行置顶**：`ocr` / `delegate` 两侧的摘要都以「⚠️ 部分结果（…）」开头 ——
  「这次算不算数」要先于「审了几个文件」。
- **超时 / 取消的说明补上「保住了什么」**：两者都是「没有结论」（`ocr` 只在结束时吐一次性 JSON），
  已发生的上游用量照常计费不退还；`nextStep` 也改成可执行的一步（缩小范围 / 调大 `timeoutMinutes` / 换
  `delegate`）。

Tests
- `test/smoke.mjs` 261 → **286**：`estimateMinutes` / `spendNotice` / `remainingText` / `timeoutWarning` 纯函数、
  心跳第三段（老签名不动）、`extractSessionId`（不猜字段）、开跑那一行的规模与超时告警（走 job 注册表读
  真实进度行）、会话 id 的摘要与备注、拿不到会话 id 时不编、`partial` 首行置顶、跑到一半取消的说明。
- `test/client-smoke.mjs` 195 → **208**：脏检查 6 条（有改动显示 / `total=0` 隐藏 / 读不到回合记录隐藏 /
  请求抛异常显示 / 404 显示 / 宿主没有事件定义能力时显示）+ definition 6 条（注册进 `ctx.effect`、
  `match` 只认 `turn/start` 与 `workspace/changes`、`start` 只接 `turn/start`、`update` 记录 `seq`、
  `buildLocationData` 引用稳定、step 作用域返回 null）。
- 真机验收（2026-10-12）：桥落在首选端口 18800（`requestedPort=18800`、`portShifted=false`）；
  `ocr_review(scope=commit)` 的 job 第一行带规模、结果带 `reviewSessionId`；设置页首屏 4 个控件行。

## [0.10.0] — 2026-10-12

**默认引擎反转回 `ocr`，并把「结论覆盖到哪里」变成可核对的东西。**

v0.8.0 把出厂默认从 `auto` 挪到 `delegate`，理由是「最贵的那档不该是不选就默认发生」。这个理由依然成立，
但结论反了：`auto` 的问题不是「贵」，是**在没有 LLM 时会静默降级成 delegate** —— 用户以为跑的是流水线，
拿到的却是「规则 + 清单」这种半成品。默认档该是那条会被打上「评审过」的路径：`ocr`。
钱的问题改用「跑前给一条成本预估、跑不跑你说了算」解决，而不是用「悄悄换成便宜档」解决。
`delegate` / `auto` / `reviewer.agent = spawn` 一个都没删，只是不再是出厂默认。

Added
- **跑前成本预估**（`engine = ocr`）：评审开始前先跑一次 `ocr delegate preview`（不调 LLM、几百毫秒），
  把「本次实测可审 N 个文件（另排除 M 个） → 按真机历史约 lo~hi 分钟」写进第一条备注；
  预估失败就只少这半句，不阻塞评审，也不编数字。
- **覆盖回执与部分结果**：`delegate` 的规格按片交付，每片带头部
  `[片 3/7 · lib/x.js · 本文件 hunk 1-3/6 · 4823B]`，「你的任务」里多了一节
  「覆盖回执（硬规则，必须逐片回填）」；只要存在未覆盖的片，就不得输出「未发现问题」。
  工具返回值新增 `partial` / `partialReasons` / `coverage` 三个字段（`RELEASING.md` 划的外部接口）。

Changed
- **出厂默认 `engine` 回到 `ocr`**（`lib/config.js` 的 `DEFAULTS.engine`）：五处同步（`DEFAULTS`、
  `pickEngine()` 兜底、工具描述、设置页顺序、EN/中文文案）。
- **`autoEngine` 出厂留空 = 跟随 `engine`**：以前它是独立的一档（`delegate`），于是「我设了 `ocr`，
  回合尾自动评审却拿到 `delegate`」这种事会发生；现在自动评审的结论来源与手调一致。
- **第三档不再被 `engine` 挡住**（修 v0.8.0 的连带回归）：两道门里的 `plan.engine !== "delegate"`
  写于默认还是 `auto` 的年代（2026-10-09），隔天翻默认后变成几乎恒假 ——
  「`reviewer: true` 不可用就报 `OCR_REVIEWER_UNAVAILABLE`，不回落」这句承诺在出厂配置下永远走不到。
  现在 `engine = delegate` 也能起独立评审 agent（delegate 出规格、agent 出结论）；工具路径仍是一次性单轮，
  这一点如实写进 `notes`。
- **`effort` 在 delegate 下不再静默无效**：`ocr delegate` 没有 `--effort`，现在会明说
  「effort=high 在 delegate 下不生效」。
- **`diff` 截断改成 hunk 级**（以前按字符切，可能切在 hunk 中间，且不说切掉了哪个文件的第几个 hunk）：
  现在整片丢弃并报出「收录 x/y 个 hunk、x/y 个文件片，丢弃 …」；采集与规格统一到同一个上限
  （`includeDiffMaxBytes`，默认 120000），不再有「采集 120000 / 规格 200000」两个数各说各话。
- 文档修正：`README` 与 v0.9.0 的条目以前把入口待认领窗口写成「60 秒内有效」，代码里
  （`lib/index.js` 的 `ENTRY_PENDING_TTL_MS`）一直是 **10 分钟**，注释也写明了理由（模型可能隔几轮才真的
  调用工具）。改的是文档不是代码 —— 60 秒会让「按钮到底有没有人点」这个判据本身失真。

Tests
- `test/smoke.mjs` 251 → **261**：默认引擎与 `autoEngine` 跟随、`pickEngine` 三例、成本预估三例
  （拿不到预估不阻塞、给了 `paths` 按 paths 报数）、规格分片与片头、hunk 级截断（纯函数 + 真跑一次超限
  diff）、预算装不下时任务段与回执段必须活着、`partial` 的来源、`detectPartial` 纯函数、
  「ocr 报部分结果时摘要不许写未发现问题」，以及「插件绝不传 `--max-tokens-budget`」的源码级断言。
- 新增用例全部走罐头子进程，不需要真机 `ocr`；真机那几条照旧。
- 真机验收（2026-10-12）：`engine=ocr` 审单文件提交 `4507de6`（`screenshots.json`）——9.9s、1141 tokens、
  0 条问题、留了 `session_id`；跑前成本预估按提交范围给出「本次实测可审 1 个文件 → 按真机历史约 3~10 分钟」。
- 验收当场修掉一个诚实性缺口：`detectPartial` 原先只认顶层 `partial` / `budget_exceeded` / 逐项
  `status:"failed"` 这些**推定**字段，而真机 JSON 用的是 `status`、`manifest.terminal_state`、
  `manifest.coverage.{selected,completed,reused,failed}` —— 真机出现「选中 8 项、只完成 5 项」时一个信号都
  命不中，照样会报「未发现问题」（正是本版要消灭的那类谎）。现在按真机字段判定，测试 +1。

## [0.9.0] — 2026-10-10

**按入口记账**（`ocr_status.stats`）。这条来自成熟度评估的 P1-1：判据是「连续两周按钮点击 0 次 ⇒
回合尾部按钮这个默认入口的价值假设不成立」，而插件里此前一个计数都没有，判据无从落地 ——
「能不能给别人用」这种问题不该靠体感回答。

改动动了**工具返回值 schema**（`RELEASING.md` 划的外部接口），所以单独一版，不和仓库整理混在一起。

Added
- `ocr_status.stats = { since, byEntry }`，四个桶 `tool` / `command` / `button` / `auto`，每桶
  `started` / `ok` / `failed` / `lastAt` / `lastCode`。本次进程内计数，重启清零（`since` 是起始时刻）。
- 状态文本新增一行「按入口记账（v0.9.0，本次进程内，重启清零）：…」，按钮为 0 时在同一行补
  「· 其中按钮 0 次」——不用读 JSON 就知道该看哪一条。
- 自动评审（`auto` 桶）在开跑处记一笔、每次结算（成功 / 轮次上限 / 异常）各配一笔结果，
  保证 `started === ok + failed`（否则「跑了几次」和「成/败几次」会自相矛盾）。

Changed
- 回合尾部按钮执行宿主命令时带内部标记 `/ocr-review --entry=button`；插件在 handler 里收下即**剥掉**，
  模型看到的提示词里没有它，手输不带标记 ⇒ 记成 `command`。命令与按钮本身不执行评审（只注入一句指令），
  所以入口只能在「模型真的调 `ocr_review`」那一刻认领：命令处理器留一个 10 分钟内有效的待认领标记。

Not added (and why)
- **没有 `skill` 桶**。模型自发调用与按 on-demand skill 说明调用在工具层是同一次调用，分不开；
  硬报一个数就是编数字。入口记账要么可核对，要么不做。

Tests
- `test/smoke.mjs` 236 → **243**（没装 `ocr` 时 229 → **236**）：七条断言用「必然失败的参数」
  （`scope: "commit"` 不给 hash ⇒ `OCR_INVALID_ARGS`，不 spawn 子进程）驱动，与这台机器装没装 `ocr` 无关；
  覆盖四个桶的归属、失败码留痕、标记不进提示词、schema 形状、auto 两处记账（源码级）与
  「不许造第五个桶」。
- `test/client-smoke.mjs` 里那条「点击走宿主命令」改成断言带标记的整行（208 项不变）。

## [0.8.2] — 2026-10-10

这一版**没有代码行为变更**，是把仓库收拾成「能给别人用」的样子：社区文件、发布纪律、以及 CI 上
那套以前形同虚设的回归。单独发一个补丁号，是为了让 v0.9.0 那类会动外部接口的改动不和这些混在一起
（见 `RELEASING.md` 的「一次 tag 只带一个高风险改动」）。

Added
- `CONTRIBUTING.md`（开发环境 / 怎么跑测试 / L0–L6 测试分层 / CI 等价环境 / 碰宿主扩展点之前的四条 /
  PR 期望）、`RELEASING.md`（一次 tag 一个高风险改动、出事第一步与回滚顺序、每个 tag 前的检查清单）、
  `SECURITY.md`、`.github/ISSUE_TEMPLATE/{bug.yml,config.yml}`、`.github/PULL_REQUEST_TEMPLATE.md`。
- `docs/maturity-assessment-2026-10-10.md`：一次外部产品评估（含「不成熟」的结论、八个维度打分、
  M1–M4 机制建议与 P0/P1 路线图）。留着是为了让路线图有出处，不是宣传材料。

Changed
- **CI 上的 cordis 回归不再「跳过即通过」**：工作流那一步以前容忍退出码 2（跳过），而 CI runner 上
  取不到 DSH 自带的 cordis ⇒ 这套回归在 CI 上**从来没跑过**。现在那一步临时装
  `@deepseek-ai/cordis@^4` + `@deepseek-ai/cosmokit@^1`（`npm install --no-save --no-package-lock`）
  并把 `OCR_TEST_CORDIS` 指到真 main 文件；跳过 = 失败。
- 文档同步：`README.md` / `README.zh.md` 里「CI 上这套是 best-effort、跳过不算错」的说法改掉。

Tests
- 离线八套不变（`smoke` 236 项、没装 `ocr` 时 229）。本版没有改断言，只改了 CI 怎么跑。

## [0.8.1] — 2026-10-10

这一版是 v0.8.0 的第一次真机自审（`ocr_review` 扫 `lib/review.js`，166.2s、6 条）加上那次运行里
自己暴露的一条（`delegate` 会静默忽略 `paths`）。**没有行为变更**，修的都是「本来承诺了却没做到」
的地方，所以按补丁号发。

Fixed
- **手工配置里的 `extraArgs` 不再能整轮崩掉**：以前直接 `[...config.extraArgs]` spread 进 argv，
  数字 / `null` / 嵌套数组会一路走到 `ctx.subprocess.spawn` 抛 `TypeError`，整轮评审没有一个字可用。
  现在统一过 `strList()`（非字符串丢弃）。
- **JSONL 结果解析不再「取最后一个能解析的行」**：ocr 的 JSONL 里结果在前、尾部可能有进度/摘要对象，
  旧实现倒着扫并返回第一个可解析对象 = 最后一个 ⇒ 静默取错块、报 0 条问题。现在优先取
  「像评审结果」的那个对象（含 issues/files 集合），都没有才取键最多的那个。
- **`rawCount` 不再把重复项算进去**：去重早退发生在自增之前，重复条目会让 `rawCount` 大于
  `issues.length + dropped`（`rawCount > 0 && issues.length === 0` 这个不变式只是侥幸成立）。
  现在 `rawCount === issues.length + dropped` 是硬不变量。
- **委派规格的截断不再切掉收尾栅栏与任务段**：`includeDiffMaxBytes` 以前是对拼好的整段文本做
  `slice(0, maxBytes)`，而「## 你的任务」排在 diff 之后 ⇒ 大改动时模型收到未闭合的代码围栏、
  没有任何任务说明（正好在最需要它的时候失效）。现在先算固定部分（头部 + 任务段 + 截断说明）的
  字节预算，再按**字节**截 diff，收尾围栏与任务段永远在；截断时结果里出现
  「已按 maxBytes=N 截断…」。（顺带修掉 `maxBytes` 用 `text.length` 判字符、CJK 多字节被低估的问题。）
- **三份重复的限深 JSON 遍历合并成一份 `walkJson(node, keys, onArray, maxDepth)`**：`extractFiles`、
  `extractIssuesDetailed`、`hasArrayField` 各写了一遍、细节已经不同（会静默漂移，改一处不影响另两处）。
- **`delegate` 不再静默忽略 `paths`**：`ocr delegate preview` 根本没有 `--path`（只有
  `--from/--to/--commit/--exclude/--rule`），所以它给的清单永远是整个工作区的改动 —— 用户点名
  `paths` 后拿到的却是全量。现在 `runDelegate` 把 `plan.paths` 作为 `only` 传下去，规格里先按路径
  过滤文件清单，并在头部写明「只看这些路径（paths 参数）」；一个都没命中时明确说明
  「一个都没匹配上可审文件，下面是 ocr 给的全量清单」，不假装过滤成功。
- `buildOcrArgv` / `buildDelegateArgvs` 去掉了从未使用的 `config` 形参（调用点同步），顺手删掉一个
  死的签名面。

Added
- CI 的 `Offline test suites` 以前只跑五套，`test/killswitch-smoke.mjs` 与 `test/host-contract.mjs`
  从没在 CI 里跑过（本地 `npm test` 跑八套，两套只在开发机上验证）。现在 CI 依次跑七套；
  这两套不依赖 `ocr`，在 CI 等价环境里本来就全过（44 / 37）。

Tests
- smoke 225 → **236**（+11 条 v0.8.1 断言：extraArgs 过滤、JSONL 优先结果形状、键最多兜底、
  `rawCount` 不变量、`pathMatches` 四例、30000 字符 diff + `maxBytes: 5000` 的字节/围栏/任务段断言、
  `truncateBytes` 的 CJK 按字节、`only` 过滤与未命中回落、`walkJson` 源码级统一、`only: plan.paths`
  接线）；没装 `ocr` 的同一环境 218 → **229**。
- 八套：smoke 236 / killswitch-smoke 44 / host-contract 37 / job-smoke 51 / reviewer-smoke 45 /
  bridge-smoke 103 / client-smoke 208 / cordis-inject 通过。

## [0.8.0] — 2026-10-10

这一版把「默认引擎」从最贵的那档挪到不花钱的那档，并把成本、进度与「下一步」都摆到台面上
（B1–B4）。B1 是行为变更，所以单独发一版、不掺其它改动。

Changed
- **`engine` 的出厂默认 `auto` → `delegate`**（`lib/config.js` 的 `DEFAULTS.engine`）。以前 `auto` 会先跑
  `ocr` 自己那条 LLM 流水线（真机历史 3~10 分钟/文件、按 tokens 计费），而那是插件的默认行为、
  用户不需要做任何选择就会发生。现在默认的 `delegate` 只调 `ocr delegate` 拿规格（规则 + 可审文件 +
  unified diff），**再由当前模型按规则评审**，几秒出结果、不额外烧 token；会花钱的 `ocr` 与 `auto`
  变成显式选择。
  - 同步的五处：`lib/review.js` 的 `pickEngine()` 兜底、`lib/index.js` 的 `mkResult()` / job 启动行 /
    自动评审取引擎、`ocr_review` 的参数与工具描述、`lib/client.js` 的设置页下拉顺序与文案（中英）。
  - **在配置文件里 pin 过 `engine` 的用户值不变**，移动的只是出厂默认；`ocr_status` 照旧显示
    生效值与来源。
- 设置页的「默认引擎」下拉把 `delegate` 排到第一项并标注「（v0.8.0 起默认）」。

Added
- **成本前置提示**：`ocr`/`auto` 的评审在结果 `notes` 与过程行里先说明「走 OCR 的 LLM 流水线 ——
  真机历史 176~600s/文件、按 tokens 计费（scan 单文件约 $0.16）…想省钱用 `engine=delegate`」，
  并带上本次给了几个路径。`delegate` 没有这句（它不花这笔钱）。
- **30 秒心跳**：评审超过 30 秒没有任何输出时，进度行会写「`ocr 运行中 1m35s · 还没有任何输出
  （超时 15 分钟；等不及可以改用 engine=delegate，几秒出规格）`」；有输出之后改成
  「…最近一次输出在 4.0s 前」。实现是纯 `setInterval` + `unref()`（不用宿主定时器），
  每一次子进程输出都会重置计时，`finally` 里一定停掉。
- **每个失败码的 `nextStep`**：`lib/review.js` 新增 `NEXT_STEPS`（13 个 `CODES` + 2 个 `REVIEWER_CODES`
  全覆盖）与 `nextStepForCode()`，失败的返回值与正文都带上「下一步：…」（例如
  `OCR_NOT_FOUND` → 装 ocr 的具体命令；`OCR_TIMEOUT` → 缩小范围或改 `delegate` 先确认工具链）。
  `ocr_review` 的返回值 schema 也声明了 `nextStep`（成功为空、不进 required）。

Fixed
- 两条离线断言本来就脆弱，顺手改成不依赖「本机恰好 pin 了什么」：默认引擎那条改用
  `normalizeConfig({})` 而不是读插件目录的真实 `config.json`；`auto` 降级/进度那条显式传
  `engine: "auto"`，不再靠本机配置文件里恰好写着 `auto` 才成立。

Tests
- `test/smoke.mjs` 218 → **225**（没装 ocr 时 211 → **218**）：新增 7 条 v0.8.0 断言 ——
  出厂默认与 `pickEngine` 三例、`CODES ∪ REVIEWER_CODES` 每个码都有非空 `nextStep` 且不含
  「请联系/无法解决/自行排查」这类空话、失败正文渲染「下一步：」、`costHint` 对 `delegate` 静默、
  `heartbeatLine` 区分「还没输出」与「刚有输出」、`nextStep` 进 schema 且不在 required、
  以及心跳接线的源码级断言（`startHeartbeat(job`、`clockedSink(chunkSink(job), beat)`、
  `finally { beat.stop();`、`out.notes.push(cost)`）。

## [0.7.3] — 2026-10-10

v0.7.2 的第一次真机自检。又跑了 `ocr scan`（`lib/host-contract.js` + `lib/killswitch.js`，203.6 秒、7 条），
其中 6 条修掉、1 条明确不采纳。这一版仍然只动这两个模块，行为面不变。

Fixed
- **两条标记路径各自独立解析**（第 1 条）：`markerPaths()` 以前把
  `join(dshHome(), …)` 与 `join(PLUGIN_DIR, …)` 放在同一个数组字面量里 —— 第一段抛错会让整个函数抛出，
  于是「DSH_HOME 都不知道在哪时戳插件目录」的那份兜底标记被一起丢掉，恰好是最需要它的时候没有它。
  现在走 `safePath(build)` 一条一条解析，任一条失败只记 `error`（失败的那条不进 `paths`）。
- **制动状态带出解析好的 `paths`**（第 3 条）：`killSwitchLogText` 原先自己再调一次 `resolveMarkerPaths()`，
  两次读取之间若抛错或环境变化，日志里的标记位置会与实际生效的来源不一致。现在 `killSwitchState()`
  把 `paths` 一起返回，日志与判定复用同一份结果。
- **未制动时不再打「本次只注册两个工具…」**（第 4 条）：`killSwitchLogText` 没校验 `sw.disabled`，
  未命中时 `killSwitchText` 返回空串，它却照样输出那句与事实不符的日志；现在未制动（或没传状态）直接返回空串。
- **两个文本助手不再隐式读盘**（第 2 条）：`killSwitchText(sw = killSwitchState())` 的默认参数会让
  「只想格式化一段文本」的调用方顺手重读环境变量 + `statSync` 磁盘。现在默认是 `null`，
  状态必须由调用方显式传入（未传即返回空串）。
- **行名兜底合成一个工具**（第 6 条）：`rowLabel`/`rowId` 是同一段「label/id 二选一 + 占位符」的两次实现，
  只差优先级；现在合成 `rowName(row, priority)`，避免两处兜底规则将来漂移。
- **`hostSummary` 有行数据时以行数据为准**（第 7 条）：只信入参字段时，手工拼装/写坏的对象会输出
  「宿主必需能力齐备；缺少 xxx」这种自相矛盾的句子。现在有 `capabilities` 行时由行数据推导
  `ok`/缺失项（`required === true && present !== true`），没有行数据才回落到字段。

Not changed (and why)
- **`readService` 的真值判定保留**（第 5 条发现：建议改成显式判空）。`reflect.get(name, false)` 读不到时
  返回 `undefined`（也可能是 `null`），而服务实例恒为对象 —— 「读到 falsy 值」正是**继续退让**的信号；
  改成显式判空反而会在第一种读法失败时就停下，把正当读法挡在外面。已在源码里写下这条理由。

Tests
- `test/killswitch-smoke.mjs` 40 → **44**（新增：两条路径各自独立解析的源码级断言；未传状态/未制动时
  `killSwitchText()`/`killSwitchLogText()` 必须返回空串；状态里带 `paths` 且日志逐条包含它们）。
- `test/host-contract.mjs` 35 → **37**（新增：`ok=true` 但行数据说必需能力缺失时，措辞以行数据为准；
  `rowName` 在行缺 id/label 时仍不出现字面量 `undefined`、改用「（未命名能力）」）。

## [0.7.2] — 2026-10-10

v0.7.1 的第一次真机自检。修完探针的假阴性之后，`ocr_status.host` 真的报出了「宿主能力齐备」，
紧急制动也在真机上逐条验过（写标记 → `ocr_review` 报 `OCR_DISABLED`；删标记 → 立刻恢复，无需重启）。
把这两个新模块再送进 `ocr` 审一遍，又抓出三条 —— 两条是 v0.7.1 的兜底「兜住了不抛，却把 `undefined`
当文案渲染出去」，一条是账目越界。这一版按最小改动修掉它们。

Fixed
- **探针账目按 `ctx` 取，不再越界**（真机自审第 1 条）：挂载账目是模块级单例，原先
  `hookArmed()` 一律读全局 `hookStats()`，同一进程里第二份实例（热重载/多 profile）会拿别人的账目
  回答自己 —— 新增 `hookStatsFor(ctx)`：账目主人为 `null`（还没挂过任何钩子）或就是本 ctx 时给实时账目，
  否则返回空账目；`armHook()` 在首次成功注册时记住主人。
- **`hostSummary` 不再自相矛盾**（第 2 条）：`ok` 为真只代表**必需**能力齐备，原来的「宿主能力齐备；
  缺少 llm、jobs（各有降级）」把两件事写进同一句。现在写成「宿主必需能力齐备；缺少 …（各有降级）」。
  摘要里的名字优先用能力 id（好对着清单 grep），备注里优先用中文 label。
- **兜底文案不再渲染字面量 `undefined`**（第 2、3 条）：行缺 `id`/`label`/`degrade` 时，`hostSummary` 会输出
  「缺少 undefined（各有降级）」、`hostNotes` 会输出「宿主没有「undefined」：undefined」。现在走
  `rowLabel()`/`rowId()` 回退（label → id → 「（未命名能力）」），degrade 缺失也有替代说明。
- **制动拒绝的表头不再谎报引擎**（真机复验时自己发现的）：`ocr_review` 被紧急制动拦住时，结果里
  `engine` 还是 `mkResult(null)` 的 `"auto"`，于是表头写着 `engine=auto … code=OCR_DISABLED`，
  而实际上一个引擎都没跑。现在拒绝路径把 `engine` 置空，`valueToText` 渲染成 `engine=未执行`
  （`REVIEW_TOOL_OUTPUT.engine` 是 string，空串合法，不新增字段）。

Tests
- `test/host-contract.mjs` 23 → **35**（新增：兜底文案里不许出现 `undefined`；`ok=true` 的措辞不再矛盾；
  账目按 ctx 取 —— `armHook(ctxA, …)` 之后 A 的 `events.tools/result` 为真而 B 的四条全为假）。
- `test/killswitch-smoke.mjs` 39 → **40**（新增：制动拒绝的表头必须是 `engine=未执行`）。
- 运行时行为无变化：默认引擎仍是 `auto`，默认不自动评审 —— 改默认引擎是 v0.8.0 的事（B1）。

## [0.7.1] — 2026-10-10

v0.7.0 的第一次真机自检。`ocr_status.host` 一上来就报「宿主缺少 `llm`/`jobs`/`skills`/`subagents`」，
可同一份输出里本机桥已就绪、按需 skill 已注册 —— **错的是探针**：cordis 里访问没有 inject 的服务会抛
`cannot get property "…" without inject`，`detect` 直接读 `ctx.llm` 并把那个抛错当成了「宿主没这个能力」。
这一版把假阴性修掉，并顺手处理把这版补丁拿去真机 `ocr` 审出的其余问题（3 个文件、167 秒、13 条）。

Fixed
- **服务探测改走宿主文档里的无 inject 读法**：新增 `readService(ctx, name)`，依次试
  `ctx.reflect.get(name, false)`（docblock 原文就是 *Read a service from the store without the inject
  requirement*）、`ctx.root.reflect.get(name, false)`、`ctx.get(name)`、最后 `ctx[name]`，每一步都包
  try/catch，任一步拿到真值即返回；四条 `inject.*` 能力的 `detect` 全部改用它。探针自身的异常依旧
  一律按「缺这个能力」处理，绝不抛。
- **四条事件能力不再假阳性**：以前 `detect` 只查 `hasFn(ctx, "on")`，只要宿主有 `ctx.on` 就报「能力齐备」，
  哪怕一个钩子都没挂上（与它们自己 `degrade` 里写的「不会触发」自相矛盾，紧急制动下也这样）。现在要求
  「宿主有这个事件 **且** 插件自己的挂载账目里真有它」（`hookArmed()` 读 `lib/hooks.js` 的实时账目，
  `probeHost(ctx, deps)` 支持注入）。
- **`lib/killswitch.js` 的读取路径不再吞错**：`existsSync` 会把 `EACCES`/`ENOTDIR` 和「文件不存在」一样
  返回 `false`，于是 `killSwitchState()` 那个 `error` 字段永远是空的（诊断路径是死的）；改用 `statSync` +
  `try/catch`，`ENOENT` 视为「正常没标记」，其余错误记进 `error`（只记首次，不再被后一个候选路径覆盖）。
  另外 `markerPaths()`（含 `dshHome()`/`join()`）以前在 `try` 之外，路径解析抛错会违背「读取阶段 fail-open」
  的承诺 —— 现在包进 `resolveMarkerPaths()`，状态查询与日志文案共用同一份结果。
- **`lib/hooks.js` 的六处自伤**：导出的是可变 `Set`（导入方 `.add()` 即可绕过白名单）→ 集合私有，导出冻结
  数组 `HOOK_WHITELIST` 与 `isWhitelistedHook()`；`String(event)` 在 `try` 之外（带抛错 `toString` 的对象能
  破坏「永不抛」）→ `safeEventName()` 兜住；`handler` 不做类型校验 → 非函数即拒绝并记一笔；卸载函数不回收
  自己的账目（重复 arm/unarm 让 `ocr_status.hooks` 虚高）→ 账目改成 `{event, active}`，卸载时置灰、摘除并
  幂等调用宿主 `off()`；`errors`/`blocked` 无界 → 各限 50 条；注册失败只悄悄记账 → 新增 `setHookLogger()`，
  `lib/index.js` 把它接到 `log("warn", …)`。
- **`hostSummary()`/`present` 的兜底**：`hostSummary({ok:false})` 以前直接 TypeError（假定 `missing` 一定是
  数组），现在按「入参可能是任何形状」写；`present = verdict === null ? null : verdict === true` 会把
  「服务实例」这类真值判成 `false`，现在一律 `Boolean(verdict)`，只有 `null`/`undefined` 才是 `null`。
- **`package.json` 的 `dsh.host.capabilities` 与代码清单不再各说各话**：两边的 id 词表曾经不同
  （`tools/pre-execute` vs `events.tools/pre-execute`、`jobs` vs `inject.jobs`），现在统一成清单里的 14 个 id，
  并由测试断言两份必须是同一个集合。`testedWith.ocr` 同时登记 `1.12.12 / 1.12.13`。

Tests
- `test/killswitch-smoke.mjs` 35 → **39**（标记是**目录**也算命中；源码级钉住 statSync + 容忍 `ENOENT`、
  错误只记首次、路径解析在 `try` 内、`existsSync` 不再出现）。
- `test/host-contract.mjs` 23 → **31**（服务只藏在 `ctx.reflect.get(name, false)` 后面也认；`ctx.on` 存在但
  没挂钩子时四条事件能力必须报缺失；`hostSummary`/`hostNotes` 对残缺入参不抛；`package.json` 的
  `dsh.host.capabilities` 与清单 id 集合相等）。
- `test/smoke.mjs` 212 → **218**（没装 ocr 205 → **211**）：白名单是冻结副本、卸载回收且幂等、非函数 handler
  被拒、事件名 `toString()` 抛错被拒、`setHookLogger` 让失败进日志、诊断各限 50 条。

## [0.7.0] — 2026-10-10

安全底座。这一版不加功能，只回答 CPO 成熟度评估里那三个「不是文档能补的」问题：
出事时**能不能从应用外停住**、插件到底**依赖宿主的什么**、以及一个可选功能的失败**会不会拖垮整个工具面**。

Added
- **应用外紧急制动**（`lib/killswitch.js`）：`DSH_OPEN_CODE_REVIEW_DISABLE=1`（也认 `true`/`yes`/`on`）
  或标记文件 `<DSH_HOME>/dsh-open-code-review.disabled`（插件目录下的 `.disabled` 亦可）。
  命中时 `apply()` 只注册 `ocr_review` 与 `ocr_status` 就返回：不注册斜杠命令、不挂任何事件监听
  （连 `preTest` 闸门也不挂）、不起本机 LLM 桥、不注册按需 skill、不做服务注入。两个工具仍然回答
  （`ocr_review` → `OCR_DISABLED`，`ocr_status` → `disabled`/`disabledBy`/标记路径 + 顶部横幅，
  并跳过会花钱的连通性探测）。判定只读文件系统与环境变量，不碰配置 —— 「配置读不出来」时也有效。
- **宿主契约清单与探针**（`lib/host-contract.js` + `docs/host-contract.md`）：14 条能力（必需只有
  `tools.register` 与 `subprocess.spawn`），每条写清 `required`/`detect`/`degrade`；`ocr_status.host`
  回放探测结果（`ok`/`missing`/`errors`/`capabilities`，客户端槽位报 `present: null`）。
- **`package.json` 的兼容性声明**：`dsh.host` 记下实测宿主 `0.2.0-rc.2`、Node 20/22/24、
  `ocr 1.12.12` 与用到的能力清单。诚实说明写在 `docs/host-contract.md`：宿主的清单只读
  `dsh.bundle`/`dsh.profile`/`dsh.client`，`dsh.host` 是给我们和将来的市场看的声明，**故意不做版本门**，
  权威答案永远是运行期探测。
- **`ocr_status` 新增四个字段**：`disabled`、`disabledBy`、`hooks`（`registered`/`counts`/`errors`/`blocked`）、
  `host`；`preTest` 增 `failOpen`/`lastError`/`lastDecision`。`statusText` 相应多出「禁用横幅」「事件钩子」
  「宿主能力」三行。全部进 schema 的 `required`，多一个键宿主会在调用期拒收整个返回值。

Changed
- **所有事件注册改走 `armHook()`**（`lib/hooks.js`）：事件名必须在白名单里（`tools/result`、
  `tools/pre-execute`、`agent/turn-stopping`、`loader/volatile-update`、`theme/change`），回调包 try/catch，
  注册失败或抛错都记账并按 30 秒限速记日志，永不抛。`lib/index.js` 里已无任何裸 `ctx.on(`（源码级断言钉住）。
- **服务注入改走 `safeInject()`**：宿主没有 `ctx.inject`、或注入抛错，都不再可能拖垮 `apply`。
- `preTest.mechanism` 如实报告：从「实际注册结果」读回来，只有 `pre-execute` 或 `none`。

Tests
- 新增 `test/killswitch-smoke.mjs`（35 条：两种来源 × 真值/假值 × 命中时到底注册了什么 × 两个工具的回答；
  标记只写临时 `DSH_HOME`，最后断言真实插件目录没被写脏）与 `test/host-contract.mjs`（23 条：14 条能力
  逐条「缺一」验证降级、`ctx` 为 `null`/被写坏/访问器抛错时不炸、源码级扫描 `lib/index.js` 用到的扩展点
  是否都登记在清单里）。
- `test/smoke.mjs` 205 → **212**（没装 ocr 198 → **205**）：`armHook` 白名单内外、注册抛错不冒泡并记账、
  没有 `ctx.on` 时记一笔、源码级「无裸 `ctx.on(` 且 `armHook` 出现 7 次」、`ocr_status.hooks` 四件套、
  schema 声明 `disabled`/`disabledBy`/`hooks`/`host` 并进 `required`。
- `npm test` 现在跑八套（新增的两套排在最前）。

## [0.6.2] — 2026-10-10

第二次用真机 `ocr` 审自己（这次审的是 0.6.1 的 `lib/bridge.js`，258.9s，同样走 DSH 本机桥），
审出五条，逐条修掉。一条是真正会坏事的（无 `index` 的工具调用流被拆成两个半截调用），其余是
记账/文案/可读性。

Fixed
- **上游不发 `index` 时，连续的 `tool-call-delta` 不再各建一个 slot**：旧兜底 index 是
  `state.toolCalls.length`，而它每建一个 slot 就 +1，于是同一次调用的第二个 delta 用递增后的
  index `find` 永远查不到上一个 slot —— `name` 和 `arguments` 被拆到两个 slot 上，
  `openAiMessage()` 只拼出半截（甚至把 `arguments` 填成 `"{}"`），上游会报参数错误。现在无
  `index` 的 delta 复用最近一个 slot；只有当它带着新 `name` 而最近那个已有名字时才另开 slot。
- **`messages` 不是数组时显式 400 `invalid_messages`**：以前直接交给 `toDshMessages` 抛错穿透，
  既漏记 `stats.rejected`/`lastReject`（与「到达桥但没转发出去都要计入 rejected」的设计不符），
  又让 `empty_messages` 分支永远走不到（注释与行为不符）。「是数组但没有可翻译内容」仍是
  `empty_messages`。
- **思考过程（`reasoning-delta`）真的带出去了**：`state.reasoning` 以前只累积、没有任何读取方
  （`openAiMessage()` / `openAiStreamFrames()` 都不消费），等于丢掉「模型把预算全烧在思考、
  正文为空」这种失败（真机见过 `finish_reason=length` + `reasoningTokens=16384`）唯一的线索。
  现在非流式放进 `message.reasoning_content`，流式先发一个 `delta.reasoning_content` 帧。
- **`abortedBy()` 的 `"unknown"` 不再写成「桥已关闭」**：外部用别的 reason 掐断时，状态行的
  `retrySkipReason` 会指向错误原因。现在四种取值（`timeout`/`client`/`closed`/`unknown`）各有
  自己的文案，未知原因也有一句说明，且不再是嵌套三元。

Tests
- `test/bridge-smoke.mjs` 99 → **103**（无 index 的连续 delta 合并成一个调用 / 带新 name 的 delta
  另开 slot / `messages` 非数组 → 400 且计入 rejected / 思考帧与 `reasoning_content` /
  `ABORT_SKIP_REASONS` 四取值齐全）。
- `test/smoke.mjs` 仍 **205**（没装 ocr **198**）：这五条都在桥内部，schema 与键集合没有变化。

## [0.6.1] — 2026-10-10

第一次用真机 `ocr` 审自己的 0.6.0 改动（`ocr_review{scope:"scan",paths:["lib/bridge.js"]}`，393.5s，
走 DSH 本机桥），审出四条桥缺陷，逐条修掉。没有行为变更，只有记账与文案更诚实。

Fixed
- **删掉累积器里没人读的 `state.chunks`**（只有 `+= 1`，生产代码与测试都不消费）——留着会让人
  以为有「chunk 数」这层统计；新增断言禁止它回来。
- **请求体超过上限时先释放已收缓冲再 reject**：以前只 `req.pause()`，已 push 进 `chunks` 的部分
  仍被那个 pending Promise 持有，直到外层写完 413、`req.destroy()` 才释放（注释里担心过
  「悬着的请求钉住缓冲」，这正是同一类小窗口）。413 的行为不变（仍有「客户端收到 413 而不是
  ECONNRESET」的断言）。
- **「到达桥但没转发出去」的请求不再算 `failed`**：鉴权失败 / 请求体不合法 / 空 `messages` /
  路由缺失以前都 `stats.failed += 1` 而 `requests` 不加，于是诊断里出现「已转发 0 次 · 失败 1 次」
  这种自相矛盾的数字，而且一次 401 会把真正的上游失败盖掉。现在拆出 `rejected` + `lastReject`
  （进 `ocr_status.bridge` 与 schema 的 `required`），`failed` 只表示「转发出去但失败」；
  `bridgeFailureNote()` 与状态行都会写「未转发即被拒 N 次 · 最近被拒：…」。
- **`retrySkipReason` 每次转发前清空**：以前只写不重置，上一次请求的原因会挂到下一次；若后一次是
  「重试过仍失败」（不写这条原因），同一行诊断里就会出现「最近错误：A · 未重试原因：B」的错配。
  `retrySkips` 仍是累计值。

Tests
- `test/bridge-smoke.mjs` 95 → **99**（死字段、rejected/lastReject 记账、`bridgeFailureNote` 的新片段、
  retrySkipReason 逐请求重置）。
- `test/smoke.mjs` 204 → **205**（没装 ocr 197 → **198**）：`bridge` 键集合 13 → 15、schema 里
  `rejected`/`lastReject` 进 `required`、以及那条「探测请求打错 token」的断言改成记进 `rejected`。

## [0.6.0] — 2026-10-10

`preTest` 按 `docs/pretest-gate-safety-design.md` 的方案 B 重构：**不再注册全局单调 guard**，
闸门只挂在限定范围的 `tools/pre-execute` waterfall 上，并补上「出错放行」的可观测性。默认仍是
`preTest: "off"`（行为不变）。

Changed
- **`preTest` 的唯一注册面变成 `ctx.on("tools/pre-execute", …)`**：非 shell 工具一次 `SHELL_TOOLS`
  Set 查找后立即 `next()`（连配置都不读），非测试命令同样直接 `next()`，`off` 档直接 `next()`，
  `remind` 只记 pending；只有 `gate` 档 + 没有评审覆盖才返回 `{kind:"deny",reason}`。
  `ocr_status.preTest.mechanism` 因此收敛为 `pre-execute`（挂上了）或 `none`（宿主没有这个事件、
  或插件被 `enabled=false` 关掉）——不再出现 `guard`。
- **闸门自身异常一律 fail-open，并被计数**：新增 `preTest.failOpen` / `lastError` /
  `lastDecision { tool, kind, at }` 进 `ocr_status`（日志按错误文本变化或 30 秒限速，避免刷屏）。
  `statusText` 也会在 `failOpen > 0` 时点名「闸门自身出错放行 N 次」。
- 源码级事故回归测试：读 `lib/index.js`（剥掉注释后）断言**代码里不再出现 `ctx.tools.guard(`**，
  比行为断言更难绕过 —— 这条缺陷的防线就是「压根不注册它」。
- 测试断言 201 → 204（没装 ocr 时 194 → 197）；[0.5.10] 的「宿主契约回归」用例改成按真实
  waterfall 语义驱动（`next()` = 继续、`{kind:"deny",reason}` = 拒绝），旧 `off`/`enabled=false`/
  端到端 flip 三个用例同步改写为不碰 guard 的版本。

## [0.5.10] — 2026-10-10

**事故版。** v0.5.7 ~ v0.5.9 的 `preTest` 闸门会让**整个工具面不可用**：`pwsh`、`read`、`glob`、
浏览器、状态查询……每一次工具调用都返回内容为空的 `Error: `。升级到 0.5.10 即可恢复。默认
`preTest` 本来就是 `off`，所以只有把 `preTest` 设成 `remind`/`gate`（或设置页勾选后写入）的
用户会撞上；但闸门在 `off` 档也挂着，所以**装了 0.5.7 ~ 0.5.9 的机器随时可能中招**。

Fixed
- **preTest 的全局 guard 用空字符串表示放行，导致所有工具被拒**：`createPreTest()` 注册了
  **全局** `ctx.tools.guard()`（单调、对所有工具生效），放行时 `return ""`。而宿主的契约是
  「a returned string denies the execution」，实现是
  `guardReason(exec) { for (const guard of this.guards.values()) { const reason = guard(exec); if (reason !== void 0) return reason; } }`
  —— **空字符串同样被当成拒绝理由**，随后管线渲染成 `content: [{ type: "text", text: \`Error: ${denialReason}\` }]`
  ⇒ 每次工具调用都变成 `Error: `（理由为空）。这是我们自己的边界错误（`""` vs `undefined`），
  不是宿主升级导致的。现在放行统一返回 `undefined`。
- **闸门异常一律 fail-open**：`tools.guard()` 与 `tools/pre-execute` 两条路径都包了 try/catch，
  插件内部出错时放行（宁可漏拦一次测试，也不能让整个工具面挂掉）。
- 新增「宿主契约回归」测试：直接复刻宿主 `reason !== undefined` 的判定，断言非测试工具放行、
  `gate` 档 + 无评审覆盖的测试命令被拒 —— 防止再犯同一个边界错误。

Added
- `docs/pretest-gate-safety-design.md`：事故复盘 + v0.6.0 重构方案（把 preTest 从**全局 monotonic
  guard** 迁到限定范围的 `tools/pre-execute` waterfall，非 shell 工具一次 Set 查找后立即 `next()`，
  并补 `failOpen` / `lastDecision` / `lastError` 可观测性）。核心原则：**可选功能不能拥有
  「让全部工具不可用」的失败模式。**

## [0.5.9] — 2026-10-10

第七轮自审（`ocr scan lib/config.js,lib/index.js` → 9 条）逐条处置；其中三条是「会让 v0.5.8 修好的
分层再次失效」或「用户看不到关键信息」的真实缺陷。

Fixed
- **设置页 schema 里还剩 6 个字面量默认值**（`enabled` / `engine` / `audience` / `autoScope` /
  `progress` / `verbose`）：`schemaOverrides()` 的规则是「取值等于出厂默认 ⇒ 不算覆盖项」，
  这些字面量一旦与 `DEFAULTS` 漂移，Host 实例化出来的默认值就不再等于 `DEFAULTS`，
  没动过的字段会重新被当成覆盖项、把 `config.json` 整层遮住（正是 0.5.8 修掉的 bug）。
  现在全部引用 `DEFAULTS`，并有断言逐个比对 15 个字段。
- **`runDelegate` 的内部诊断备注被静默丢弃**：规则 JSON 解析失败、「没有可审文件」、「git diff
  不可用/为空」这四条以前推进调用方传进来的数组，而 `runReview` 直连 `engine: "delegate"` 那条
  链路没人合并 —— 用户看不到规格为什么不完整。现在它们进 `out.notes`（手动、自动、评审 agent
  三条链路都能看到）。
- **`catch` 里回滚签名会把有效签名清空**：`prevSignature` 初值是空串、只在算出新签名后才赋值，
  失败发生在更早（`resolveLlmRoute` / `resolveOcr` / preview）时，回滚等于清空上一批已评审的签名
   —— 同一批改动下次写入又被重评一次，白花一次 LLM。初值改成当前签名，早失败时回滚是空操作。
- **`autoEngine` 没有归一**：`engine` 走白名单小写化，`autoEngine` 原样透传 ⇒ `"Delegate "` 会
  静默退化。现在同样收敛（非法值回落空串 = 跟随 `engine`）。
- **`includeDiffMaxBytes` / `maxIssuesInText` 没有上界**：手误写成 `120000000000` 会让插件按
  「几乎不限制」的字节数拼 diff / 渲染问题列表。现在各夹到 10 MiB / 2000 条；显式 `0` 仍然合法。
- **`externalConfigPath()` 成了死代码**（`ocr_status` 的备注改用 `homeConfigPath()` 之后没人调）：
  它正是「告诉用户该把覆盖项写到哪儿」的语义（env 优先，否则 `DSH_HOME`），现在备注真的用它。
- `preTestCountedCalls` 超过 200 条时整体 `clear()` 会连「仍在处理中的调用」一起去重，同一次调用
  再被问一次就重复计数 → 改成按插入顺序丢最旧一条。
- `runOcrOnce` 里局部 `const num = ...` 遮蔽了从 `./review.js` 导入的 `num(value, fallback)` → 改名 `toFinite`。
- 结果前缀的 5 层嵌套三元 → 查表。

测试：smoke 197 → **200**（没装 ocr 193）、bridge-smoke 95、job-smoke 51、reviewer-smoke 45、
client-smoke 208、cordis-inject 26 全过。

## [0.5.8] — 2026-10-10

### Fixed

- **`config.json` was effectively dead for every settings-page field** (the real root cause behind
  the symptom below). The Host instantiates the plugin's schema, so fields the user never touched
  still carry the schema default (`true`, `3`, `"off"`, `15`, …), and `schemaOverrides()` only
  skipped *empty* values — so booleans, numbers and enums were always treated as "set on the
  settings page" and shadowed the whole file layer. Real-host proof: with `"timeoutMinutes": 7` in
  `config.json`, the bridge still printed `ocr review … --timeout 15`. The rule is now: **a value
  that equals the factory default is not an override**, so untouched fields fall through to
  `config.json` (≈20 keys were affected: `enabled`, `engine`, `audience`, `auto`, `onDemand`,
  `auto*`, `preTest`, `timeoutMinutes`, `progress`, `verbose`, `llm.mode/baseUrl/protocol/apiKeyRef`,
  `reviewer.agent/provider/rounds`). Known trade-off, now documented: if you explicitly set a field
  back to its factory default in the settings page while `config.json` holds a different value, the
  file wins — the two cases are indistinguishable on a schema instance.
- **A `config.json` (file-layer) edit did not start or stop anything** — found on a real host right
  after 0.5.7: writing `"preTest": "gate"` left the gate unarmed (a test command ran straight
  through) while `ocr_status` still reported `preTest: off`. Independent second bug: the three
  "install/uninstall a listener" decisions (`auto`, `onDemand`, `preTest`) were only re-evaluated in
  `syncAutoReviewer()`, which ran on `apply` and on the settings-page hot channel
  (`loader/volatile-update`) — value-level reads were hot, but nothing told the plugin the *file* had
  changed. Two changes:
  - the preTest gate is installed whenever the plugin is enabled (`off` simply allows everything,
    because `preTestVerdict()` re-reads the current config on every call), so `off` → `gate` in
    `config.json` takes effect immediately without re-arming;
  - `auto` / `onDemand` / `preTest` are re-synced from a file-layer fingerprint (`__configStamp`),
    compared on the events that already flow every turn (`tools/result`, `agent/turn-stopping`) — no
    timers, and a no-op when the file is unchanged (`configFileStamp()` only stats).
- `ocr_status.preTest.mode` is now computed from the current config rather than from the last sync,
  so the status line can no longer disagree with `config.json`; when the gate is not armed yet the
  state line says so instead of quietly showing `none`.
- A `config.json` saved with a **UTF-8 BOM** (Notepad, PowerShell `Set-Content`) used to fail
  `JSON.parse` and be silently replaced by factory defaults; the BOM is now stripped.
- `test/smoke.mjs`'s preTest "factory default + normalisation" assertion no longer reads the plugin
  directory's real `config.json`, so pinning `preTest` in your own checkout no longer turns the
  offline suite red (assertions 185 → 197; 190 without a local `ocr`).

## [0.5.7] — 2026-10-10

### Added

- **Review before tests (`preTest`).** Answering the request "can the review be wired into the
  standard flow — e.g. start it before the agent runs unit tests?" there are now three modes:
  `off` (factory default: don't touch test commands), `remind` (let the test run, then remind the
  model that this batch has not been reviewed), and `gate` (a test command is refused until one
  **successful** `ocr_review` covers the current changes). The gate is installed with the host's
  supported `ctx.tools.guard()` — the documented "a denial that must hold regardless of order is a
  guard; a guard is synchronous" API — and falls back to the `tools/pre-execute` waterfall on hosts
  that do not expose `guard`. Coverage is tracked per agent (a `WeakMap` keyed by the agent object):
  a successful `ocr_review` sets it, a successful write tool clears it, and a *failed* review never
  counts as reviewed (fail-closed). Detection only inspects shell-ish tools
  (`pwsh`/`powershell`/`bash`/`sh`/`zsh`/`shell`/`cmd`/`run_command`/`terminal`) and matches common
  test entry points (npm/pnpm/yarn/bun test, node --test, vitest/jest/pytest/phpunit/ctest/rspec/tox,
  python -m pytest|unittest, go/cargo/dotnet/gradle/mvn/make test|verify); nothing is executed by the
  plugin itself, and `preTest` is also selectable in the settings page (Advanced → Tuning).
- `ocr_status` reports `preTest: { mode, mechanism, denials, reminders }`, so you can tell whether
  the gate is actually armed (`mechanism` is `guard` / `pre-execute` / `none`) and how many times it
  fired; the on-demand skill text now tells the model to review before running tests.

### Fixed

- **`remind` never actually did anything** (found by reviewing this very patch with `ocr_review`).
  The pending flag is set by the same verdict function the gate calls, but the hook was only armed
  when the mode was exactly `gate` — so in `remind` mode nothing was ever registered, `pending` stayed
  false and the reminder (and the `reminders` counter) were unreachable. Both `gate` and `remind` now
  arm the hook; `remind` just never returns a denial. The smoke test asserts this through the hook the
  plugin really registers, so an un-armed `remind` fails the suite.
- **A `preview: true` review could satisfy the gate.** `preview` only lists the files to review and
  never calls the LLM, yet its result has `ok === true`, so one preview run was enough to pass the
  gate. Coverage now requires `value.ok === true && value.preview !== true`; `ocr_review`'s result and
  schema declare the new `preview` field (an undeclared field would be rejected by the host's
  `additionalProperties: false` check at call time).
- **The test-command pattern matched anywhere in the line.** `git commit -m "fix jest tests"`,
  `grep -r pytest src/` or `cat vitest.config.js` were all treated as test runs — noisy denials and
  inflated counters in `gate` mode. Detection now splits the command on `&&` / `||` / `;` / `|` /
  newlines and anchors each segment at its start (so `cd lib && npm test` counts), and denials are
  counted once per tool call (`callId`) instead of once per question. `test/smoke.mjs` carries the
  false-positive cases as assertions.
- Denial and reminder texts pointed at "设置 → 代码审核" instead of the real name 「代码评审」; the
  unused per-agent `denials` counter and the never-read `preTestStats()` export were cleaned up
  (`runStatus` now reads the shared totals).
- Docblock and schema descriptions said the gate lives in `tools/pre-execute` and that `remind` would
  "run one review for you" — it prefers `ctx.tools.guard()`, and it only reminds the model to review.

## [0.5.6] — 2026-10-10

### Fixed

- **The real-credential end-to-end test could not run at all.** `test/e2e-llm.mjs` builds its own
  minimal host context, and that stub had fallen behind `apply()`: it never provided `ctx.effect`,
  so the plugin threw `TypeError: ctx.effect is not a function` before registering a single tool
  (which is why the "real credentials" regression was only ever assumed, never executed). The stub
  now provides `effect`/`inject`/`get`, and `inject` deliberately never calls back — this harness
  has no host services, so cordis' rule ("a missing dependency means the callback never runs") gives
  the intended static-endpoint path.
- **The harness could not reach the LLM at all.** With no `agentDefaultModel` service, `OCR_LLM_MODEL`
  was empty and ocr refused with `no valid LLM endpoint configured …`. The script now injects an
  explicit model (`E2E_LLM_MODEL`, default `deepseek/deepseek-v4.1-flash-fast`) and logs it.
- **`status-only` could report success while the self-test failed.** The exit code used
  `/可用/.test(status.llmTest)`, and the failure text `不可用（exit=1）…` contains `可用` as a
  substring — so the free connectivity check exited 0 on a broken LLM configuration. It now checks
  `ok === true` and the *absence* of `不可用`.
- **No way to review real files on a clean tree.** `E2E_SCOPE` / `E2E_PATHS` were added, so
  `E2E_SCOPE=scan E2E_PATHS=lib/bridge.js node test/e2e-llm.mjs` exercises the full
  "files in, findings out" path (the default `scope=workspace` finds nothing when the working tree
  is clean).
- **A truncated stream that had already sent half an answer was reported as a success.**
  `truncated()` required *both* a missing `finish` event *and* zero content, so
  `stream ended before a terminal response event` was only caught when nothing had arrived —
  ocr happily took half a review as a completed one. The adapter contract (`dsh-llm-pi-ai`'s
  `toStreamChunks`) always emits `usage` → `finish` on a normal end, emits `finish` for in-band
  errors too, and throws `STREAM_CLOSED` when the stream dies mid-flight; so a missing terminal
  event *is* the truncation, content or not. `truncated()` is now simply `!state.finish`, and the
  error message says whether half the content had already arrived.
- **A bridge timeout looked exactly like "the client is gone".** One `clientGone()` predicate mixed
  three different situations (client really left / the bridge's own upstream timeout / the bridge
  being closed), so when the bridge timed out while ocr was still waiting, the handler wrote no
  response *and* counted no failure — ocr could only sit until its own `--timeout`, and the stats
  showed nothing had happened. The predicates are now separate (`abortedBy()` /
  `socketDead()` / `clientReallyGone()`), writes only check the socket, and our own aborts surface
  as `upstream_timeout` / `bridge_closed` with `stats.failed` incremented and a precise
  `retrySkipReason` ("we cut it ourselves, so there is nothing to retry").
- **A structurally invalid JSON body could crash the bridge.** `JSON.parse` accepts `null`, `123`
  and `[]`; the old code went straight to `body.messages` and threw
  `TypeError: Cannot read properties of null` on `null`. The bridge now rejects a non-object body
  with `400 invalid_body` (a missing `messages` still yields the existing `empty_messages`).

### Added

- **Job ownership is now asserted, not assumed.** `jobs.start` refuses work whose `owner` has no
  attached job controller, and `list`/`get`/`wait`/`kill` are fenced by that session id — an
  owner-less job is visible to every caller. `test/smoke.mjs` previously only asserted the
  "no `agent.id` → no owner" direction; it now also asserts that a real `agent.id` reaches both
  `jobs.start` and `jobs.wait` (166 checks with `ocr`, 159 without). `test/bridge-smoke.mjs` grew
  from 89 to 95 checks (half-answer truncation, timeout semantics, malformed bodies), and the
  never-read `stats.lastUsage` field was dropped from the bridge's `describe()` surface.

## [0.5.5] — 2026-10-10

### Fixed

Four defects the plugin found in the local bridge **by reviewing its own diff with `ocr_review`**
(`ocr scan lib/bridge.js`) after 0.5.4:

- **Upstream errors that arrive by throwing were never retried.** The retry loop is
  `for await (const chunk of await stream(options))`, and that call sat outside any `try`. A thrown
  network failure (`fetch failed`, `ECONNRESET`, `socket hang up`, `ETIMEDOUT`, `premature close`) —
  all of them listed in `RETRYABLE_UPSTREAM_RE` — propagated past the whole loop, so the classifier
  was never consulted; and with the SSE headers already sent the outer catch could only `res.end()`,
  leaving the client with a `200` and a half-written stream (no error frame, no `[DONE]`). A throw is
  now normalised into the same `failure` the finish-chunk path produces (`code: "upstream_error"`),
  so it is classified, counted and retried exactly like any other upstream failure.
- **A stream that ended without a terminal event was reported as an empty success.** If the upstream
  closed without a `finish` chunk and without any content, `failure()` returned `null` and the bridge
  answered `content: ""` with `finish_reason: "stop"` — silently losing the review while ocr counted
  it as a completed request. The accumulator now exposes `truncated()` and such a stream fails with
  `code: "upstream_truncated"` (`OpenAI Responses stream ended before a terminal response event…`,
  which the retry classifier treats as transient, so the retry path finally covers this case too).
- **Streaming dropped the assistant text whenever the model also called a tool.** `openAiStreamFrames`
  emitted only the tool frames (the plain-text frame lived in the `else` branch), while
  `openAiMessage()` puts that text into `message.content` for non-streaming requests. The content
  frame is now emitted first, in both branches.
- **`openAiMessage(model)` took an unused `model` parameter**, which made it look like the model was
  part of the response contract. Dropped.
- **A response was still written after the client was gone.** `controller.abort()` only *asks* the
  upstream to stop; an upstream that ignores the signal (or reuses one stream) finishes normally,
  and the bridge then wrote into a destroyed socket — `res.write` throws `ERR_STREAM_DESTROYED`
  synchronously, and `res.on("error")` only swallows the `'error'` **event**, so the throw escaped
  the request callback as an unhandled exception (enough to kill the host). Every write now goes
  through a `clientGone()` gate plus `try`/`catch` (and `sendJson` is defensive too), and a result
  that arrives after we already aborted is dropped instead of being counted as an upstream failure.
- **The three "we aborted it ourselves" messages were duplicated between the abort sites and
  `SELF_ABORT_RE`.** They only matched by substring luck: editing the abort text (e.g. to
  「客户端已断开」) would silently reclassify our own cancellation as a retryable upstream glitch —
  and the retry would burn quota for a client that had already left. The messages now live in
  `SELF_ABORT_MESSAGES` and the regex is generated from them.

`test/bridge-smoke.mjs` grew from 84 to 89 assertions: the old "a throwing stream → 500" expectation
became "→ 502 + `upstream_error`" (plus its retry bookkeeping), and new cases cover a thrown
retryable error that recovers on the second attempt (`socket hang up` → 200, `retries: 1`), a
silent truncation (`fakeStream([])` → `upstream_truncated`, `failed: 1`, `retries: 1`), an upstream
that ignores the abort and finishes anyway (no write to a dead socket, no bogus failure count), and
the abort-message/`SELF_ABORT_RE` drift guard. Test hygiene from the same review: the completions
path is derived from `BRIDGE_COMPLETIONS_PATH` instead of a literal, the assistant-`source`
assertion no longer accepts `null`, a dead helper was removed, and two bridges that were never
closed now are. No behaviour change on the happy path.

## [0.5.4] — 2026-10-09

### Fixed

- **The token counter on the status line added up wrong.** `ocr_status` reported
  `累计 tokens 452422（输入 41305 / 输出 73581）` — a 337 536-token gap. DSH's `TokenUsage.inputTokens`
  already has the cache hits subtracted (`input = prompt - cacheRead - cacheWrite`, while
  `total = input + output + cacheRead + cacheWrite`), and the bridge only forwarded
  `prompt_tokens`/`completion_tokens`. The bridge now also reads `cacheReadTokens`/`cacheWriteTokens`
  (plus the OpenAI spellings `cache_read_tokens` / `cachedTokens` / `prompt_cache_hit_tokens`), exposes
  them as `cache_read_tokens` / `cache_write_tokens` (+ `prompt_tokens_details.cached_tokens`), and the
  shared `describeTokens()` formatter prints `累计 tokens T（输入 P（其中缓存命中 C · 缓存写入 W） / 输出 O）`
  — plus `另有 U tokens 未分类` when an upstream only reported a total. Same numbers in the job log and
  in the per-review `usage`.
- **`/ocr-review` registration is no longer assumed to have succeeded.** The command is what the
  turn-tail button and a typed command both go through, yet a `register()` failure (host change, a
  `definitionId` clash) was silent. The plugin now remembers the outcome and `ocr_status` reports
  `command: { name, registered, reason }`, with a note that names the button when it failed.

## [0.5.3] — 2026-10-09

### Fixed

- **CI is green on a bare clone again (and the suites now cover a machine without `ocr`).** CI runs on
  a fresh clone with `node` only: `@alibaba-group/open-code-review` is a global npm package and is not
  there, so every check that shells out to the real `ocr` failed and dragged the job/progress, `render`
  and auto-review assertions down with it (24 failures, all 6 matrix jobs). `test/smoke.mjs` now probes
  once (`HAS_OCR`) and swaps expectations per environment: with `ocr` it exercises the real chain, without
  it exercises the diagnostics you get on a fresh machine (`OCR_NOT_FOUND` + the install guide, no fake
  success, no job left in `running`). Item counts: 161 with `ocr`, 155 without.
- **`ocr_status` no longer contradicts itself when `ocr` is missing.** The check for the executable used
  to `return` early, so `bridge` stayed `null`, `llmEnv` stayed empty and the on-demand note was skipped —
  while the route line already named the local bridge. The fields that do not depend on `ocr`
  (`bridge`, `llmEnv`, `onDemand`/`skill` notes) are now computed before that early return, and the
  bridge snapshot is refreshed at the end so the numbers include the `ocr llm test` probe.
- **The first thing a new user hits: installing `ocr`.** On `OCR_NOT_FOUND`, the review result, the
  auto-review delivery and `ocr_status.notes` now all carry the same `installHint(platform)` text
  (npm package name, the Windows “use the real `.exe`, not the `.cmd` shim” warning, `OCR_EXECUTABLE`
  / `OPENCODEREVIEW_BIN`) instead of only “set `ocrPath`”.

## [0.5.2] — 2026-10-09

### Fixed

- **`ocr_status` / `ocr_review` no longer report a missing bridge just because it is still starting.**
  The local bridge listens asynchronously, so a status call made right after the plugin loaded could
  see `bridge: null` and silently fall back to the static `llm.baseUrl` endpoint (the note in `notes`
  explained it, but the route was already the fallback). `resolveLlmRoute()` now waits for the
  in-flight bridge start (at most 2 s) before computing the route, so the first call already routes
  through the bridge. This also removes a real race for users on slow machines and for the CI runner,
  where the bridge took longer to listen than the fixed 150 ms the test used to wait.
- The test that covered this no longer gambles on a `setTimeout`: it asserts the bridge is available
  on an **immediate** status call (the ports are still checked for a stray 401 / a closed listener),
  and the two raw `bridge.url` fetches are guarded so a missing bridge fails the assertions instead
  of crashing the suite mid-run. `test/smoke.mjs` is 161 assertions with `ocr` on `PATH` and 155
  without it (checks that need the real binary swap to the “not installed” diagnostics path).

## [0.5.1] — 2026-10-09

### Fixed

- **CI is green on a bare clone.** The offline suites used to require `@deepseek-ai/schemastery`, a
  DSH-internal package that only exists inside a real install — on GitHub Actions the first suite
  crashed (`TypeError: cfgMod.Config is not a function`, `test/smoke.mjs:537`) and the remaining
  suites never ran. `test/smoke.mjs` now detects the package and either exercises the real schema
  (`Config(patch)`, volatile refs) or falls back to a plain patch — the same shape the plugin's own
  config path takes (`apply` → `schemaOverrides`) — asserting the documented degradation in that
  branch. The assertion count is identical in both environments (160).
- `@deepseek-ai/schemastery` is declared as an **optional peer dependency** (what the other DSH
  client plugins do), so a real install links it instead of relying on a developer-local junction.
  No runtime behaviour change: without the package `Config` stays `undefined`, the settings page is
  simply not generated, and every tool / command / job keeps working.

## [0.5.0] — 2026-10-09

**Behaviour change: the plugin no longer reviews on its own.** The factory default for `auto`
(the settings-page `autoReview`) is now `off`. Reviews start when you ask for one — the button at
the end of a completed turn, the runtime skill the model can call, the `/ocr-review` command, or
`ocr_review` directly. Set `autoReview` back to `adaptive` / `inject` / `followup` if you want the
old behaviour. The **Step 3 default-off check** in `test/smoke.mjs` pins this down.

### Added

- **On-demand review** (`onDemand`, default `true`). Two entry points that cost nothing until used:
  - a **Start code review** button at the end of every completed turn
    (`conversation.chat.turnTail`, `lib/client.js`). It executes `/ocr-review` for that session
    through the host's remote-command service, shows **Reviewing…** and disables itself while a
    review for that session is running, and prints the failure reason inline on error. If the host
    does not expose `remote.commands`, the button is simply absent.
  - the runtime skill **`ocr-on-demand-review`**: when you say “review this” / “verify the change”,
    the model can run `ocr_review` and report findings itself. `ocr_status` reports `onDemand` and
    `skill.registered` so you can confirm the registration.
- **Findings are listed line by line.** `ocr_review`'s text result, the job log and the delivered
  message now group findings per file and print `- <line|line range> [severity] message (rule)`,
  including `endLine` / `column` / `rule` / `suggestion` from ocr when it provides them.
- **Token accounting is honest.** `bridge.tokens.partial` counts upstream calls that reported only
  a total, and the status/job lines add “其中 N 次上游只报了总数” instead of showing a `total` that
  does not equal input + output.
- **Configuration is validated in depth.** `normalizeConfig` now also normalises the nested
  `llm` / `reviewer` / `env` blocks (enum values, trimmed strings, `reviewer.rounds` 1–10) and
  clamps the numeric keys to the same bounds the settings schema uses — values above the maximum are
  clamped, values below the minimum fall back to the default. `mergeLayers` deep-merges **before**
  normalising and guards every nested block with `Array.isArray`.

### Fixed

- **`0 file(s) reviewed, N issue(s) found`.** The file count now falls back to
  `total_files` / `reviewable_count`, and then to the distinct files mentioned by the findings, so a
  summary without a file list can no longer contradict the findings next to it.
- **Settings-page dropdowns were unreadable** on the light theme and on dark themes: `<select>` and
  `<option>` now use host theme tokens (`--dsw-alias-label-primary`, `--dsw-alias-bg-layer-2`,
  `--dsw-alias-bg-overlay`) and declare `color-scheme` from the live theme, refreshed on
  `theme/change`.
- **`DSH_OPEN_CODE_REVIEW_CONFIG` pointing at a missing file** used to stop resolution silently (the
  plugin kept running on defaults). It now falls back to `<DSH_HOME>/dsh-open-code-review.json`,
  then the plugin directory, and `ocr_status` spells out what happened
  (`__configSourceHint`, “指向的 … 不存在，已回落到 …”). `externalConfigPath()` was shadowing the
  home candidate with the env path; the fallback now uses `homeConfigPath()`.
- **Hot-reload cache** now keys on `mtimeMs + ctimeMs + size`, so a file that changes while keeping
  its timestamp and size is picked up. A blank `DSH_OPEN_CODE_REVIEW_CONFIG` no longer counts as set.
- `envConfigPath()` is the single place that reads the environment variable (it was implemented
  twice, in `externalConfigPath()` and `resolveConfigFile()`).

## [0.4.0] — 2026-10-09

> Internal release: the settings-page rebuild, cost visibility and the publishing material.
> Superseded by 0.5.0, which is the first version published for general use.

First release prepared for public use. Two themes: **a first-time user can get it working and
understand the cost**, and **every failure says what actually happened**.

### Added

- **Settings page rebuilt around decisions.** The main page shows six rows — `enabled`,
  `engine`, `autoReview`, `reviewerAgent`, `llmMode`, `llmModel`. Rows that only make sense
  when a switch is on (`reviewerProvider` / `reviewerModel` / `reviewerRounds` under
  `reviewerAgent=spawn`; `llmBaseUrl` / `llmProtocol` / `llmApiKeyRef` under `llmMode=endpoint`)
  appear with it. The 12 low-frequency parameters moved into a collapsed **Advanced settings**
  section — Tuning (`autoScope`, `autoMaxPerSession`, `autoMinReviewableFiles`,
  `autoMinIntervalMs`, `autoSkipSubagents`, `autoIncludeDiff`) and Runtime & diagnostics
  (`audience`, `ocrPath`, `timeoutMinutes`, `progress`, `llmProvider`, `verbose`).
  While collapsed, unsaved advanced edits still surface as an “N unsaved” badge on the header.
- **Preset dropdown for the cool-down** (`autoMinIntervalMs`): 30 s / 1 min / 5 min / 10 min /
  custom. The stored value is still milliseconds.
- **Plugin card de-duplicated.** The marketplace card now renders a read-only summary of the six
  basics plus a pointer to *Settings → Code review*, instead of a second editable copy of the form.
- **Token cost is visible.** The local bridge accumulates upstream usage (`prompt_tokens`,
  `completion_tokens`, `total_tokens`); `ocr_review` returns this run's delta as `usage`; the job
  log appends “本轮 ≈ N tokens”; `ocr_status` reports the running totals.
- **Retry diagnostics.** Upstream failures are classified before retrying
  (`classifyUpstreamFailure`): a stream cut by the provider is retried, our own aborts (client
  disconnect, bridge timeout, shutdown) are not. `ocr_status` exposes `retries`, `retrySkips` and
  `retrySkipReason`, and a failed review's `notes` carry the bridge's real cause next to ocr's
  generic “check your LLM configuration and API key”.
- **One-shot install hints.** When `ocr` cannot be located, `ocr_status` prints per-platform
  instructions (npm package `@alibaba-group/open-code-review`, Windows must point at the real
  `opencodereview.exe` rather than a `.cmd` shim, PATH / `OCR_EXECUTABLE` / `OPENCODEREVIEW_BIN`).
- **External config file.** Resolution order is `DSH_OPEN_CODE_REVIEW_CONFIG` →
  `<DSH_HOME>/dsh-open-code-review.json` → plugin directory `config.json`. `ocr_status` reports
  `configPath` / `configSource` / `fileValues`, and warns when the active file lives inside
  `node_modules` (it is replaced on upgrade). `config.example.json` documents the keys that only
  a file can set.
- **Docs and packaging**: English README (Chinese kept in `README.zh.md`), `CHANGELOG.md`,
  `LICENSE`, `config.example.json`, GitHub Actions CI (Node 20/22/24 on Linux and Windows running
  the six offline suites), and `package.json` metadata (`repository`, `engines`, `scripts.test`).

### Fixed

- A row is “dirty” only when its draft differs from the stored value, so **Undo** clears the row
  and the pending-changes badge instead of leaving a phantom unsaved change.
- `bridgeFailureNote` no longer prints “上游重试 N 次” twice.
- `config.json` is no longer tracked by git or shipped in the package: it belongs to one machine
  and may contain an API key. Use `<DSH_HOME>/dsh-open-code-review.json` (see
  `config.example.json`).
- Personal absolute paths removed from test defaults and the bundle patch comment.

## [0.3.7]

- Transient upstream failures (`stream ended before a terminal response event`, 429/5xx) are
  retried once by the bridge (`MAX_UPSTREAM_ATTEMPTS = 2`) instead of failing the whole review.
- Bridge stats gained `retries`; failed reviews append the bridge's real cause to their notes.

## [0.3.6]

- One source of truth for timeouts: `timeoutMsOf()` clamps `timeoutMinutes` under
  `maxTimeoutMinutes` (24 h hard cap), the Jobs row deadline is derived from the same value, and
  the schema defaults reference `DEFAULTS` instead of duplicated literals.
- Numeric strings in `config.json` are honoured (`"5"` means 5 minutes).
- `endpointDisplay()` points out when the endpoint is still the factory default (credentials
  would go to the old vendor).

## [0.3.5]

Findings from the first real end-to-end reviews:

- `config.json` no longer advertises writing plaintext keys into a version-controlled file.
- Config merging is uniform: `llm.*`, `env.*`, `extraArgs` and `ocrCandidates` all merge across
  layers (previously `patch.env` / `extraArgs` / `ocrCandidates` were silently dropped).
- Explicit `0` is a value, not “unset” (`includeDiffMaxBytes`, `maxIssuesInText`).
- A broken `config.json` now logs one warning per change instead of silently running on defaults.

## [0.3.4]

Hardening pass driven by an audit of the whole lifecycle:

- Fail-closed output parsing: an unrecognised `ocr` payload is reported as
  `OCR_OUTPUT_SHAPE_UNKNOWN` instead of “no issues found”.
- Auto-review round limit now settles its job (`OCR_REVIEWER_UNCERTAIN`) instead of leaving a job
  running forever; the signature only advances after a review actually ran.
- Cancellation works end to end: the client aborting a review aborts the upstream bridge call, the
  reviewer sub-agent is aborted (not just interrupted) on timeout, and the HTTP layer no longer
  swallows 413/abort errors or hangs on close.
- Config values are type-normalised (`"false"`, negative numbers, unknown modes); `.cmd` / `.bat` /
  `.ps1` shims are rejected (the host spawns without `cmd.exe`).
- `from` / `to` / `commit` starting with `-` are rejected (`OCR_INVALID_ARGS`) instead of being
  passed to git as options.
- `test/schema-subset.mjs` reproduces the host's three gates (declared schema → lossless JSON →
  payload) so a bad tool contract fails offline.

## [0.3.3]

- Fixed the bridge crash `Cannot read properties of undefined (reading 'replayState')`: forwarded
  messages now always carry `source` (`{kind:"model",…}` for assistant, `{kind:"tool",callId}` for
  tool results), and the HTTP route is resolved before the messages are converted.

## [0.3.2]

- Fixed the host rejecting tool results:
  `"ocr_review.value.aborted" is not a declared property (additionalProperties: false)`.

## [0.3.0]

- **Review progress is visible**: every review is registered as a background job
  (`ocr-review-N` in the Jobs panel, with expandable ocr output) and a progress line above the
  composer that can stop a running review.

---

Versions 0.1.x–0.3.1 predate this changelog; see `git log`.
