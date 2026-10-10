# Changelog

All notable changes to **dsh-open-code-review**. Versions follow SemVer; the plugin is
distributed as a DSH bundle (`dsh plugin --profile <profile> add github:xinyangGL/dsh-open-code-review`).

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
