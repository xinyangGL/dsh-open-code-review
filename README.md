# dsh-open-code-review

把 **阿里 OpenCodeReview（`ocr`，npm 包 `@alibaba-group/open-code-review`）** 接入 DeepSeek Harness 的第三方插件。

提供三条入口，全部走本机已安装的 `ocr` 可执行文件：

| 入口 | 形态 | 触发方式 |
| --- | --- | --- |
| `ocr_review` / `ocr_status` | 模型工具 | 你让模型评审时模型调用；或模型自己在改完代码后调用 |
| `/ocr-review` | 斜杠命令 | 你在输入框敲 `/ocr-review`（可带附加要求） |
| 自动评审 | 回合钩子 | 本回合有 `write`/`edit` 等文件写入，且回合即将关闭（`agent/turn-stopping`）时自动跑一次并把结果交给模型 |

引擎两档：

- **`ocr`**：跑 OpenCodeReview 自己的「确定性工程 × LLM」流水线。**默认 LLM 路由是 `dsh`**：插件在本机起一个只监听 `127.0.0.1` 的小桥（随机端口 + 随机 token），把 ocr 的 `/chat/completions` 翻译成 DSH 的 `ctx.llm.stream` —— 模型、provider、密钥、账号轮换与配额全由 DSH 决定，插件配置里不用填地址和 key（见下文「LLM 路由」）。
- **`delegate`**：**不需要 key**。插件用 `ocr delegate preview` + `ocr delegate rule` 拿到「可审文件 + 按内容分组的审查规则」，再附上 `git diff`，拼成一份审查规格交给当前模型自己审（OpenCodeReview 官方为宿主 Agent 设计的 Delegation Mode）。
- **`auto`（默认）**：先试 `ocr`，如果报 `no valid LLM endpoint configured` 就自动降级为 `delegate`，所以**开箱即用**（`dsh` 路由下宿主有 `llm` 服务、设置页选好模型就直接跑 `ocr` 流水线；`endpoint` 路由则还要端点 + 凭据引用）。

---

## 安装

插件目录：`C:\Users\吴礼凯\.dsh\plugins\dsh-open-code-review`

```powershell
# 本地目录（开发态）
dsh plugin --profile desktop add link:C:\Users\吴礼凯\.dsh\plugins\dsh-open-code-review

# 卸载
dsh plugin --profile desktop remove dsh-open-code-review
```

> 本机活动 profile 是 **`desktop`**（不是 `web`）；也可以在 GUI 的插件管理里安装/启停，条目 id 为 `include:dsh-open-code-review`。

装好后 profile 会把 `cordis.patch.yml` 里声明的条目插入插件树，**工具/命令立即出现，无需重启**（profile 是热加载的）。用 `/ocr-review` 或让模型调用 `ocr_review` 验证。

### 改动后如何生效

| 改了什么 | 生效方式 |
| --- | --- |
| **设置页**里的表单值（`enabled`/`engine`/`llm.*`/`auto*`…） | **立即生效**：宿主把新值写进 `volatile` 引用并广播 `loader/volatile-update`，插件据此重读配置并启停自动评审，无需重启 |
| `config.json`（第 2 层） | **立即生效**：每次调用按文件 mtime 重读，无需重启 |
| `lib\*.js` 代码 | **需要重启 DSH**：Node 的 ESM 模块缓存会保留旧实例，实测在运行中的 profile 里禁用/启用该插件条目也不会重新导入模块；已装的 `link:` 依赖不用重装 |
| `lib\client.js`（浏览器半侧）或 `package.json` 的 `dsh.client` | **需要重启一次 DSH + 刷新页面**：客户端包是宿主启动时按包扫描的，而且「这个包不是客户端包」的判定会按包名缓存到重启为止（`dsh-client-modules` 的模块注释：*cached … until restart*），热加载不会重新扫描 |
| `cordis.patch.yml` / `package.json` | 重新执行上面的 `dsh plugin --profile desktop add`（或在 GUI 插件管理里禁用→启用） |
| `icon.svg` / `locale\*.json`（插件卡片与清单的图标/标题/描述） | **需要重启一次 DSH**：清单展示信息在启动扫描时读取 |

> 判断「设置页有没有生效」：让模型调 `ocr_status`，第一行会写设置页可用/不可用；Host 侧也可以看 `listConfigs` 里 `include:dsh-open-code-review` 的 `status` 是否从 `absent` 变成 `schema`（`absent` = 跑的还是加 `Config` 之前的旧代码，重启即可）。

前置条件：本机已有 `ocr`（`npm i -g @alibaba-group/open-code-review`）。插件按以下顺序定位可执行文件：
`config.json` 的 `ocrPath` → `ocrCandidates` → 环境变量 `OCR_EXECUTABLE`/`OPENCODEREVIEW_BIN` → Volta/npm 常见安装位置的 `opencodereview.exe`（**优先原生 exe，避开 Windows 的 `.cmd` shim**）→ PATH 上的 `opencodereview`。

---

## 配置

**推荐用 DSH 的设置页改**，不用碰文件。配置表单有两个入口（同一个组件、同一份宿主数据）：

- **设置 → 代码评审**：浏览器半侧往 `settings.section` 注册的独立设置页，左侧设置导航里直接可见；
- **设置 → 插件 → `dsh-open-code-review`**：打开这个 bundle 的页面，表单渲染在**描述与行列表之间**。

插件导出了一个 schemastery `Config`，宿主把里面标了 `volatile()` 的字段投影成表单；改完立即生效，不用重启。

> **页面从哪来**：DSH 的插件页**不会**由宿主 schema 自动生成页面 —— 插件管理页的配置账本只从三个席位读取注册：`plugins.item`（官方插件）、`plugins.bundle.config`（bundle 自带配置）和 `plugins.row.config`（某一行自带页面）。本插件的浏览器半侧 `lib\client.js` 注册了 `plugins.bundle.config`，key = npm 包名 `dsh-open-code-review`，于是表单渲染在该 bundle 页面的**描述与行列表之间**；表单数据由宿主的 `configForms` 服务提供（`ctx.configForms.get("include:dsh-open-code-review")`，取不到时会回退试包名 id 并给出诊断）。另外它还往 `settings.section`（一个打开的 list 席位）注册了独立设置页：id `open-code-review`、order 17、label「代码评审」，渲染同一个表单组件（standalone 模式多一段标题）—— 这样用户不必先记住去插件页里翻卡片。**首次加上客户端半侧后必须重启一次 DSH 再刷新页面**（见上表）。

配置分三层，优先级从高到低：

| 层 | 位置 | 适合放什么 | 生效方式 |
| --- | --- | --- | --- |
| ① 设置页 | profile 的 patch YAML（由设置表单写入） | 表单里有的键（开关、引擎、LLM 端点/模型/凭据引用、自动评审参数…） | **立即生效**（宿主把新值写进 `volatile` 引用并广播 `loader/volatile-update`） |
| ② `config.json` | `<插件目录>\config.json`（可删） | 表单没有的键：`ocrCandidates`、`autoEngine`、`maxTimeoutMinutes`、`extraArgs`、`env`、字面密钥 `llm.apiKey`… | **立即生效**（按 mtime 热读） |
| ③ 内置默认值 | `lib/config.js` 的 `DEFAULTS` | 出厂值（全部字段都有默认值，所以 ①② 不存在也能用） | 改代码后需重启 DSH |

字段一览（`设置页` 列 = 该键是否出现在表单里）：

| 字段 | 默认 | 设置页 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `true` | ✅ | 总开关：关掉后停自动评审，`ocr_review`/`/ocr-review` 拒绝执行（`ocr_status` 仍可用于诊断） |
| `ocrPath` | `""` | ✅ | `ocr` 可执行文件绝对路径；留空=自动探测 |
| `ocrCandidates` | `[]` | — | 额外候选路径 |
| `engine` | `"auto"` | ✅ | `auto` \| `ocr` \| `delegate` |
| `autoEngine` | `""` | — | 自动评审用的引擎；留空=跟随 `engine` |
| `audience` | `"agent"` | ✅ | 传给 `ocr --audience`：`agent`（仅摘要）/`human`（进度条） |
| `timeoutMinutes` | `15` | ✅ | 单次评审超时，传给 `ocr --timeout`，同时作为插件侧硬超时 |
| `maxTimeoutMinutes` | `60` | — | `timeoutMinutes` 的上限保护 |
| `extraArgs` | `[]` | — | 追加给 `ocr` 的原始参数 |
| `env` | `{}` | — | 追加/覆盖子进程环境变量（空串=删除该变量） |
| `llm.mode` | `"dsh"` | ✅ | LLM 路由：`dsh`=走 DSH（本机桥 → `ctx.llm.stream`，模型/密钥/配额都由 DSH 决定）；`endpoint`=ocr 直连下面的静态端点（老行为）。选 `endpoint` 时设置页才显示地址/协议/凭据引用三行 |
| `llm.provider` | `""` | ✅ | `dsh` 路由转发到哪个 DSH provider（如 `commandcode`）。在「模型名」下拉里选中模型时自动写入；**留空 = 跟随 DSH 默认模型**的 provider |
| `llm.model` | `""` | ✅ | → `OCR_LLM_MODEL`。**留空 = 跟随 DSH 的默认模型**（`agent-default-model`，即官方读全局默认路由的同一来源）；想固定某个模型就在「模型名」下拉里从 DSH 模型目录选（会连 provider 一起写上）。`endpoint` 路由下留空则不给 ocr 传 `OCR_LLM_MODEL`（用 ocr 自己那份全局配置） |
| `llm.baseUrl` | `https://api.commandcode.ai/provider/v1` | ✅ | `endpoint` 路由才用：→ `OCR_LLM_URL`（CommandCode 的 OpenAI 兼容路由，本机实测可用） |
| `llm.protocol` | `"openai"` | ✅ | `endpoint` 路由才用：→ `OCR_LLM_PROTOCOL`。CommandCode 的 DeepSeek v4.1 **只能**走 `openai`；Anthropic 协议端点用 `anthropic` |
| `llm.apiKeyRef` | `COMMANDCODE_API_KEY` | ✅ | `endpoint` 路由才用：→ `OCR_LLM_TOKEN`。**这里是「凭据引用」不是密钥本身**：运行时用 `ctx.credentials.resolve()` 从 DSH 凭据库/环境变量取值 |
| `llm.apiKey` | `""` | — | 字面密钥（优先级高于上面的引用；不想把密钥放进 DSH 凭据库时才用，只建议写在 `config.json`） |
| `auto` | `"adaptive"` | ✅ | 自动评审开关：`off` 关闭；`adaptive` 模型在跑就 `inject`、空闲就 `followup`；`inject` 只注入上下文；`followup` 直接开新回合 |
| `autoScope` | `"workspace"` | ✅ | 自动评审的范围 |
| `autoSkipSubagents` | `true` | ✅ | 子代理会话不触发自动评审 |
| `autoMaxPerSession` | `3` | ✅ | 每个会话最多自动评审几次（防「改—评—改」死循环） |
| `autoMinReviewableFiles` | `1` | ✅ | 可审文件数低于该值就跳过 |
| `autoMinIntervalMs` | `60000` | ✅ | 两次自动评审最小间隔（毫秒） |
| `autoIncludeDiff` | `true` | ✅ | 自动（delegate）评审时带不带 `git diff` |
| `reviewer.agent` | `"off"` | ✅ | 独立评审 agent：`off`=不启用（评审走 ocr/delegate）；`spawn`=每轮起一个**只读**子 agent 评审（需要宿主提供 `subagents` 服务） |
| `reviewer.provider` | `"spawn"` | ✅ | 子 agent 用的 provider 名（DSH 内置的是 `spawn`）；名字不存在时报 `OCR_REVIEWER_UNAVAILABLE` 并在 `notes` 里列出可用名 |
| `reviewer.model` | `""` | ✅ | 评审子 agent 的模型（设置页的「子 agent 模型」下拉同样来自 DSH 模型目录）；留空=跟随 provider 默认 |
| `reviewer.rounds` | `3` | ✅ | 一次往返最多几轮（1–10，每轮 = 一个新子会话）；到上限就交付当前结论 |
| `reviewer.persona` | `""` | ✅ | 评审人格/纪律（留空=插件内置 `DEFAULT_REVIEWER_PERSONA`） |
| `includeDiffMaxBytes` | `120000` | — | 单次带出的 diff 上限（字符） |
| `maxIssuesInText` | `40` | — | 文本渲染最多列多少条问题（完整数据仍在 `issues`/`rawJson`） |
| `progress` | `true` | ✅ | 评审进度：每次评审登记成宿主后台任务（kind `ocr-review`），Jobs 面板与会话内各有一条实时进度；关掉后评审照跑，只是不可见（见「评审进度」） |
| `verbose` | `false` | ✅ | 打印调试日志（本机桥的日志也走它） |

### LLM 路由（`ocr` 引擎）

`ocr` 是独立 CLI 子进程，只认 `OCR_LLM_URL` / `OCR_LLM_PROTOCOL` / `OCR_LLM_MODEL` / `OCR_LLM_TOKEN` 四个环境变量（`lib\ocr-cli.js` 的 `buildEnv`）—— 它进不了 cordis，看不到 DSH 的 provider 目录、凭据库、模型目录与账号轮换。所以默认路由（`llm.mode = "dsh"`）是：

```
ocr 子进程 ──POST http://127.0.0.1:<随机端口>/v1/chat/completions──▶ 本机桥（Bearer <随机 token>）
                                                                      └─▶ ctx.llm.stream({ provider, model, … })
```

- 桥只监听 `127.0.0.1`（`BIND_HOST`）、端口随机、token 每次启动随机生成且**不落任何配置文件**；请求/响应按 OpenAI 兼容形状翻译（含 `tools` 往返与 `stream: true` 的 SSE），实现在 `lib\bridge.js`（471 行）。
- 模型与 provider 优先取设置页：`llm.model`（「模型名」下拉可搜索、候选取自 DSH 模型目录）+ `llm.provider`（选中模型时自动写入）。**两者留空就跟随 DSH 的默认模型** —— `agentDefaultModel.currentSelection()` 的 `provider` + `model`（desktop profile 里 `agent-default-model` 配的是 `commandcode / deepseek/deepseek-v4.1-flash-fast`），于是设置页一个字段都不用填。密钥、配额、429 重试与账号轮换全由 DSH 的 provider 插件负责 —— **插件里不再需要地址与 key**。
- 桥的生命周期挂在 `ctx.inject(["llm"], …)` + `ctx.effect(...)` 上（`lib\index.js:970-1005`）：宿主没有 `llm` 服务时插件照常工作，只是 `dsh` 路由回落成静态端点，`ocr_status` 会写明原因（不静默）。

#### 官方插件是怎么用 DSH 的模型的（为什么这里能不再填地址与 key）

对着 `@deepseek-ai` 自带插件逐处核对过（`app.asar` 抽取树 + `profiles\store-demo\node_modules`）：

- **DSH 没有给外部进程用的 OpenAI 兼容端点**：全树搜 `chat/completions` 零命中，它的 HTTP 面是 `/api` 上的 RPC（`dsh-api-gateway` 的 `/api/remote.mux`）。所以本机桥不是重复造轮子，而是给「只认 `OCR_LLM_*` 环境变量的独立 CLI（`ocr`）」做的一层翻译。
- 官方插件都在**进程内**直接调 `ctx.llm.stream({ provider, model, system, messages, signal })`：`dsh-agent-loop`（`preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)`）、`dsh-compaction-basic`（`for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)`）、`dsh-experimental-auto-review`（`readDecision(ctx.llm.stream(options))`）—— 桥的末端就是同一个调用。
- **可选服务**用 `ctx.get("llm")` 读、不写进插件级 `inject`（官方 `dsh-tool-subagent` / `dsh-tool-fs` / `dsh-session-reference` 都这么做），与本插件的 `ctx.inject(["llm"], …)` 一致：没有 `llm` 的 profile 里插件照常工作，只是回落静态端点。
- **路由来源**也是官方的两处：会话头 `requestHeader().config` → agent options（`dsh-tool-fs`），全局默认 = `agentDefaultModel.currentSelection()`（`dsh-agent-default-model` 服务，`buildModelCatalog` 的默认参数就是它）。本插件按「设置页 → DSH 默认模型」取值。
- 流式契约（`BlockAssembler`：`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`，`finish.reason.kind ∈ stop | max-tokens | error | aborted`）与官方的 `readDecision` 一致，桥负责把它翻成 OpenAI 的 SSE 与 `tools` 往返。

`endpoint` 路由是保留的老行为：把「LLM 路由」切成 `endpoint`，设置页才显示地址 / 协议 / 凭据引用三行，`ocr` 直连静态端点。

实测确认过的静态端点组合（`ocr llm test` 与真实评审都通过）：

```
OCR_LLM_URL      = https://api.commandcode.ai/provider/v1
OCR_LLM_PROTOCOL = openai
OCR_LLM_MODEL    = deepseek/deepseek-v4.1-flash
OCR_LLM_TOKEN    = <COMMANDCODE_API_KEY>
```

要点与备选：

- `OCR_LLM_URL` 默认按 **Anthropic** 协议拼 `/v1/messages`；CommandCode 的 DeepSeek 系列是 OSS 模型，走 `/v1/chat/completions`，所以 `endpoint` 路由必须配 `OCR_LLM_PROTOCOL=openai`，否则报 `Model "…" is not supported on this endpoint`（`dsh` 路由由桥统一提供 `/v1/chat/completions`，不用管这条）。
- 想换成 DeepSeek 官方：`llmBaseUrl = https://api.deepseek.com/anthropic`、`llmProtocol = anthropic`、`llmModel = deepseek-chat`（该端点只认 Anthropic 协议）。
- 想换成阿里云百炼：`https://dashscope.aliyuncs.com/compatible-mode/v1` + `openai` + `qwen3-coder-plus` 之类。
- 也可以完全不动插件配置，改用 OCR 自己的全局配置（`~/.opencodereview/config.json`）：`ocr config set provider deepseek` / `ocr config set model …` / `ocr config set providers.deepseek.api_key …`；或设全局环境变量 `OCR_LLM_URL`/`OCR_LLM_TOKEN`/`OCR_LLM_MODEL`（插件里配的值优先于这些环境变量）。
- `ocr_status` 会报「LLM 路由模式」以及本地桥的 URL、请求/失败次数、最近模型与最近错误；`ocr llm providers` 可列出 ocr 内置 provider（只对 `endpoint` 路由有意义），`ocr llm test` 也由 `ocr_status` 代跑。

#### 「模型名」是可搜索下拉

配置页里的「模型名」不是死文本框：候选列表直接取自 **DSH 自己的模型目录** —— 浏览器半侧调 `ctx.remote.session.modelCatalog()`（宿主服务 `sessionController` 生成的 `session` namespace，返回 `RemoteResult` 信封 `{ ok, value: ModelCatalog }`，按提供方分组），所以候选里就有 Command Code 的整套模型（Command Code / GLM-5.3 FlashX / GPT-5.6 Luna / GPT-6 Luna / Grok 4.5 / Inkling / Inkling Small / Kimi K2.5 / K2.6 / K2.7 Code…）。

- 点输入框展开全部候选；输入即按 **名称 / id / 提供方** 过滤（空格分词，如 `kimi code`）；支持 ↑↓ 选择、回车确认、Esc 收起。
- 也允许**完全手输**任意模型名（例如换成别的端点后目录里没有的模型），选中只是帮你填。
- `dsh` 路由下输入框下方还会显示 **DSH 默认模型：provider / model**（就是目录里的 `default`），提示"模型名与提供方留空就跟着它走"。
- 目录读不出来时（旧版 DSH 没暴露该方法、`peer` 不可用等）自动退化成普通文本输入，并在下方说明原因，不会挡住配置。
- 模型目录是**运行期**事实（取决于当前有哪些提供方可路由），所以它只当候选，不当作白名单。
- 读目录要用的 `remote` / `remote.session` 声明在 `apply` 内部的**子 fiber** 上，插件本身只 `inject: ["slots"]`：cordis 的注入是全有全无（`Fiber._refresh()` 里缺任何一个服务就 INACTIVE、`apply` 根本不跑），把这两个名字写进插件级 inject，会把「没有候选列表」升级成「设置页整块消失」。子 fiber 没激活时退回不要求注入的 `ctx.get("remote")`。`test/cordis-inject.mjs` 用真 cordis 守住三种宿主形态：服务齐全（官方 `ctx.remote` 读法）/ 只差 `remote.session`（子 fiber 不激活、兜底读取口生效）/ 完全没有 `remote`（插件照常激活，只剩手输降级）。

---

## 用法

### 模型工具 `ocr_review`

```jsonc
{
  "scope": "workspace",   // workspace(默认，未提交改动) | range(from/to) | commit(commit) | scan(paths)
  "engine": "auto",       // auto | ocr | delegate
  "preview": false,       // true = 只列会审哪些文件，不调 LLM
  "effort": "high",       // low | medium | high（ocr 引擎）
  "exclude": ["**/dist/**"],
  "rulePath": "D:\\rules\\review.json",  // 自定义系统规则
  "timeoutMinutes": 15,
  "repo": "D:\\my-repo",  // 默认取当前会话工作目录
  "reviewer": true,       // true=强制独立评审 agent；false=强制 ocr/delegate；缺省按 reviewer.agent 设置
  "includeDiff": true     // delegate 模式是否附 diff
}
```

返回：`ok` / `code`（失败原因码，见下文「失败结果码」）/ `reviewableFiles` / `excludedFiles` / `issues[]` / `reviewSpec`（delegate 的规格正文）/ `reviewer`（独立评审 agent 的 provider/model/round/rounds/childId/stopReason/verdict）/ `summary` / `rawJson`（原始 JSON，最多 10 万字符）等。
`ocr_status` 用来体检：可执行文件、版本、OCR 全局配置、环境变量、`llm test` 连通性，外加 LLM 路由模式与本机桥的 URL / 请求次数 / 失败次数 / 最近模型 / 最近错误，以及独立评审 agent 的 `enabled` / `available` / `providers` / `ready` / `error` 段。

### 命令 `/ocr-review`

在输入框敲 `/ocr-review`（可在后面跟要求，例如 `/ocr-review 只审 src/ 下的改动`）→ 插件立刻给当前会话注入一段指令，让模型调用 `ocr_review` 并按结果逐条处理（真实缺陷就改，误报说明理由）。

### 自动评审

只要有文件写入工具成功执行（`write`/`edit`/`apply_patch` 等），且回合即将结束，插件就会：

1. 先跑一次 `ocr review -p`（便宜、不调 LLM）确认「确实有可审改动」且改动签名与上次不同；
2. 再按 `autoEngine`/`engine` 跑正式评审；
3. 把结果交给模型——模型仍在跑就用 `inject`（下个 step 作为上下文），已空闲就用 `followup`（开新回合处理）。

每个会话最多 `autoMaxPerSession` 次，两次之间至少隔 `autoMinIntervalMs`，同样的改动签名不会重复触发。不想要就把 `auto` 设为 `"off"`。

### 独立评审 agent（opt-in）

默认 `off`：评审仍走 ocr 流水线或 delegate。把设置页的「独立评审 agent」设为 `spawn` 后，评审交给**第二个 agent** —— 它有自己的会话、上下文、人格与模型，只有只读工具：

1. 回合结束、确认有可审改动后，插件先向 ocr 要一份规格（`delegate preview` 的文件清单 + 规则正文 + `git diff`）；**范围与规则仍来自 ocr**，评审 agent 不自己决定审什么；
2. `ctx.subagents.start(provider, { prompt: 规格, outputSchema: FINDINGS_SCHEMA, toolFilter: { allow: ["read","grep","glob"] }, persona, parent: 编码 agent })` 起一个**只读**子 agent（禁止代改代码：两个 agent 抢写文件是灾难）；
3. 子 agent 按 schema 返回 `verdict`（`clean` / `issues` / `uncertain`）+ `findings[]`（`file` / `line` / `severity` = `blocker|major|minor|nit` / `message` / `evidence?` / `suggestion?` / 第 2 轮起 `stillOpen?`）；
4. 插件把 findings 注入编码 agent：「请逐条修复或说明理由（误报也要说明）；本回合结束后会自动开下一轮复审（最多 N 轮）」；
5. 编码 agent 改完 → 下一轮（新子会话，prompt 里带上上一轮 findings 要求逐条判定是修复了还是仍存在）→ 直到 `clean`、到 `reviewer.rounds` 上限、或连续 2 次失败。

安全阀：每轮都计入 `autoMaxPerSession` 与 `autoMinIntervalMs`（复用现有计数），线程闲置超过 `timeoutMinutes` 自动关闭；`clean` 关线程；同样改动签名不会重复开轮。想临时指定某一次评审，用 `ocr_review` 的 `reviewer` 参数（`true` 强制 agent，`false` 强制 ocr/delegate）。

引擎三档的选择：`ocr`（阿里流水线，最省心）→ `delegate`（当前 agent 拿 ocr 规则自审，不花钱）→ `reviewer.agent = spawn`（第二双眼睛，最贵但最像人审）。规格始终来自 ocr，所以三档可以随时切换、互不冲突。

### 评审进度（Jobs 面板 + 会话内进度行）

`progress`（默认开）把**每一次评审**（`ocr_review`、`/ocr-review`、自动评审、独立评审 agent 的各轮）在宿主里登记成一个后台任务，kind 统一是 `ocr-review`，于是同一次评审在两个地方同时可见：

| 位置 | 看到什么 |
| --- | --- |
| 会话标题栏的 **Jobs 面板**（后台任务） | 一行一条评审。标题形如 `评审 · 工作区改动 · my-repo`（自动评审是 `自动评审 · …`，区间/单提交/整文件扫描各有对应措辞）；副行是当前阶段（`运行 ocr review（超时 15 分钟；…）`、`delegate：采集 git diff…`、`独立评审 agent 第 1/3 轮…`）；展开是实时输出流（ocr 的 stderr 原样、stdout 里 JSON 之前的诊断行，外加 `[HH:MM:SS]` 阶段日志）与停止按钮 |
| 输入框上方的**会话内进度行** | 最近两条：状态词（运行中/已完成/失败/已停止/停止中…）、标题、当前阶段、已用时长；运行中的那条右侧有「停止」，**点两次**才真的停（防误触） |

细节：

- **停止**：面板或进度行的停止 → `jobs.kill()` → 插件的 `AbortController` 中止本次评审（与调用方的 `signal` 合并）→ 评审以 `OCR_ABORTED` 结束，**绝不当作通过**；20 秒内没停下就按「已停止」结算，不会一直挂在「停止中…」。
- **不刷屏**：任务挂了 `jobs.wait`，所以结算**不会**往会话里灌「后台任务完成」的唤醒消息 —— 进度是旁路，不打扰模型。
- **结算之后**：面板里的行保留（可回看阶段、输出与耗时），会话内进度行再留 60 秒后消失。
- **降级**：宿主没有 `jobs` 服务时不注册进度行（插件的 `jobs` 子 fiber 保持 pending），评审本身照跑；关掉 `progress` 只是不可见，不改变任何评审行为。
- **输出流**：完整的 `--json` 结果不进流（那一行会被跳过，否则会灌满环形缓冲），只在工具结果/自动评审载荷里（`rawJson`，最多 10 万字符）。

### 失败结果码（fail-closed）

工具结果里的 `code` 是稳定的失败原因码（`lib\review.js` 的 `CODES`，全部 `OCR_` 前缀 —— 直接搜这个词就能在测试里定位对应断言）：

| `code` | 含义 |
| --- | --- |
| `OCR_INVALID_ARGS` | 参数不合法：范围 = `workspace`/`range`/`commit`/`scan`，后三种各自缺 `from`+`to`/`commit`/`paths`；或 `from`/`to`/`commit` 以 `-` 开头（它们会被原样交给 `git`，等于让调用方注入命令行选项） |
| `OCR_DISABLED` | `enabled = false`，插件被关掉 |
| `OCR_NOT_GIT_REPO` | 目标不是 git 仓库（`range`/`commit` 范围不可用） |
| `OCR_NOT_FOUND` | 找不到 `ocr` 可执行文件 |
| `OCR_TIMEOUT` | 超过 `timeoutMinutes` |
| `OCR_ABORTED` | 调用被取消（工具调用中断、插件卸载/重载） |
| `OCR_RUN_FAILED` | `ocr` 退出码非 0 |
| `OCR_LLM_MISSING` | `ocr` 报「没有可用的 LLM 端点」（`auto` 引擎会先降级 `delegate`，只有显式 `engine: "ocr"` 才以失败告终） |
| `OCR_OUTPUT_UNPARSABLE` | `exit=0`，但输出不是 JSON / 是空串 |
| `OCR_OUTPUT_SHAPE_UNKNOWN` | `exit=0` 且是 JSON，但没有可识别的问题清单字段 |
| `OCR_DELEGATE_PREVIEW_FAILED` | `delegate` 的 `ocr delegate preview` 失败 |
| `OCR_DELEGATE_RULE_UNPARSABLE` | `delegate` 的规则 JSON 解析不出来（`reviewSpec` 仍会返回，文件清单与 diff 还能用） |
| `OCR_REVIEWER_UNAVAILABLE` | `reviewer.agent = spawn` 但拿不到评审 agent：宿主没有 `subagents` 服务、provider 名不存在、`start()` 抛错。自动档回落静态引擎并在 `notes` 里说明；显式 `reviewer: true` 直接失败（不偷偷回落） |
| `OCR_REVIEWER_FAILED` | 评审 agent 没给出可用结论：`stopReason` 不是 `completed`、`structured` 缺失或形状不合法 —— fail-closed，绝不当作通过 |
| `OCR_REVIEWER_UNCERTAIN` | 评审 agent 自己说「信息不足，无法确认」（`verdict = uncertain`）—— `ok: false`，不算通过，线程保持打开等下一轮 |

后四条（`OUTPUT_UNPARSABLE` / `OUTPUT_SHAPE_UNKNOWN` / `REVIEWER_FAILED` / `REVIEWER_UNCERTAIN`）是 **fail-closed**：退出码 0 不再等于「评审通过」。「没发现问题」必须由**带问题清单字段且为空**的 JSON 证明（`issues` / `findings` / `comments` / `problems` / `annotations` / `warnings` / `errors` / `review_comments` 任一）—— `exit=0` 但字段缺失、输出不是 JSON、或 stdout 是空的，都算失败（`ok: false`），并在 `notes` 里说清是哪一种、建议改用 `engine: "delegate"` 或复核 `rawJson`。真的没问题时结果仍是 `ok: true`、`code: ""`（`test/smoke.mjs` 有一条专门的「不误报」断言）。

`ocr_status` 的 `code` 目前只会是 `OCR_NOT_FOUND`（本地桥/端点这类原因写在 `notes` 与状态行里）。状态行首行末尾也会带上码，例如 `阿里 OpenCodeReview · engine=ocr · scope=workspace · 失败（exit=1，0s，code=OCR_RUN_FAILED）`。

插件卸载/重载是**等**在飞的评审收尾的：`dispose` 先 abort（子进程被 `terminate()`，结果标 `OCR_ABORTED`），再等这些评审真的 settle 才 resolve（`apply` 里的 effect `"在飞 ocr 评审的收尾（abort + 等待）"`），不会把半截结果当成功投递给模型。

结果码与「取消」都按**真机契约**做了硬校验（v0.3.4 一轮审计加固，见下表「加固」几条）：`signal` 已经 abort 时连子进程都不开（宿主自己会在 `spawn` 抛 `aborted before spawn`）；跑到一半才取消时子进程必须被 `terminate()`；`ocr_status.bridge` 的键集合与工具 schema 一致（多一个键宿主会在**调用期**拒收整个返回值）。这些都有断言（`test/smoke.mjs` 113 项）。

---

## 排障

| 现象 | 处理 |
| --- | --- |
| 插件整个不见了：`ocr_review` / `ocr_status` 变成 unknown tool，或设置页里没有这个条目 | host fiber 加载失败。`ctx.tools.register` 会用宿主自己的 JSON Schema 子集校验 `output.schema`，违规（最常见的是 `type: ["object","null"]` 这类 **type 数组**，`anyOf` 也不支持）就抛 `JsonSchemaError`，整个插件不加载。日志里搜 `assertSupportedJsonSchema`；`node test/smoke.mjs` 现在跑同一套规则（`test/schema-subset.mjs`），改完 schema 先跑它 |
| 调用报 `tool "ocr_review" returned invalid output: "value.xxx" is not a declared property`（或 `is required` / `must be a boolean`） | **调用期**宿主还会拿 `output.schema` 校验 execute 的返回值：payload 里多了没声明的字段或少了必填字段。把字段补进 `lib\index.js` 的 `REVIEW_TOOL_OUTPUT`。`test/smoke.mjs` 的假 register 已把 execute 包住，每次工具调用的返回值都会被同一套规则检查 |
| 真实引擎跑评审时 `all N file review(s) failed`，而 `ocr_status` 的桥那行写着 `最近错误：Cannot read properties of undefined (reading 'replayState')` | 桥翻译历史消息时漏了宿主的**硬契约**：转给 `ctx.llm.stream` 的每条 `assistant` 消息都必须带 `source`（`{kind:"model",provider,model}`，`lib\bridge.js` 的 `toDshMessages` 负责补）。缺了它，宿主 `dsh-llm` 的 `forAdapter()` 一读 `message.source.replayState` 就 TypeError，且异常被吞成「上游 error」502 —— 症状是**每个文件的第 2 次请求（带 assistant 历史／工具往返）才失败**，单看桥的 stats 只有失败计数。`role: "tool"` 同理要 `source: {kind:"tool",callId}`。`test\bridge-smoke.mjs` 现在按 `hostAssistantSourceProblems()` 逐条复刻这条读取路径 |
| 设置页里找不到 `dsh-open-code-review` / 表单是空的 | 多半是**改了 `lib\*.js` 但没重启 DSH**（宿主仍缓存旧模块，`Config` 没被导出）。完全退出并重开 DSH 后再看；判据：`ocr_status` 的第一行「设置页」 |
| 插件卡片能打开，但没有配置表单 | 浏览器半侧没被加载：确认 `package.json` 里有 `dsh.client` 与 `exports["./client"]`、`lib\client.js` 存在且语法可解析（`node --check lib\client.js`），然后**重启一次 DSH** 并刷新页面（包扫描结果缓存到重启）；页面里若显示「浏览器侧没有这个条目的表单」说明 cell 已加载但条目 id 对不上 |
| 设置导航里没有「代码评审」 | 同一个表单的独立入口（`settings.section`）。它没出现说明浏览器半侧没加载；只改了 `lib\client.js` 内容时**刷新页面**即可（bundle 的 rev 取文件 mtime），但**第一次**加上/移动客户端文件要重启 DSH 才会重新扫描 |
| `无法定位 ocr 可执行文件` | 在 `config.json` 里写 `ocrPath` 指向 `opencodereview.exe`（原生 exe 优先于 `ocr.cmd`） |
| `credential "COMMANDCODE_API_KEY" 未配置` / `llm test` 报缺 key | 这是 `endpoint` 路由的问题：在设置页把「LLM 凭据引用」改成你 DSH 凭据库里已有的名字，或往 `config.json` 的 `llm.apiKey` 写一个字面密钥。若切回 `dsh` 路由，密钥由 DSH 的 provider 配置提供，不用在这里填 |
| `OCR 未配置 LLM 端点` | 预期行为之一：`engine: "auto"` 会自动降级 `delegate`；想用 `ocr` 流水线就修好路由（`dsh` 路由看下一条，或切成 `endpoint` 填好端点/协议/模型/凭据引用）。显式 `engine: "ocr"` 时结果是失败：`code: OCR_LLM_MISSING` |
| `Model "…" is not supported on this endpoint` | `llmProtocol` 配错了：CommandCode 的 DeepSeek 系要 `openai`；走 `/v1/messages` 的 Anthropic 端点才用 `anthropic` |
| 结果里 `issues` 为空但评审成功 | 这表示返回的 JSON **确有**问题清单字段且为空（`code: ""`）= 真「未发现问题」。要核对 OCR 原始字段名与内容就读 `rawJson`；`extractIssues` 已兼容 `issues/findings/comments/…` 多种字段名 |
| `ok: false` + `code: OCR_OUTPUT_UNPARSABLE` / `OCR_OUTPUT_SHAPE_UNKNOWN` | fail-closed：`ocr` 退出码 0，但输出无法证明「评审跑过且没有问题清单」。先看 `notes` 里的原始输出摘要，必要时手工跑 `ocr review --format json`；若是新版 `ocr` 换了字段名，把新名字加进 `lib\review.js` 的 `ISSUE_KEYS`（`test/smoke.mjs` 的 `hasIssueCollection` 断言会跟着扩展），或临时用 `engine: "delegate"`（不依赖这份 JSON） |
| `ok: false` + `code: OCR_REVIEWER_UNAVAILABLE` | 先看 `ocr_status` 的 reviewer 段（`available`/`providers`/`ready`/`error`）：宿主没有 `subagents` 服务或没装 provider（本机是 `dsh-tool-subagent` 的 `spawn`）时起不了评审 agent。把「独立评审 agent」设回 `off`，或装上提供方插件；显式传 `reviewer: true` 时这是硬失败 |
| `code: OCR_REVIEWER_FAILED` | 评审 agent 没按 schema 返回（`stopReason` 是 `error`/`refusal`/`max-tokens`，或 `structured` 缺失）。诊断在 `notes`；连续 2 次会关掉这轮往返。临时绕开：`reviewer: false` 或 `engine: "ocr"` |
| `code: OCR_REVIEWER_UNCERTAIN` | 评审 agent 说信息不足：把范围/规则说清楚，或在 `reviewer.persona` 里补要求。这条**不算通过**（`ok: false`） |
| 输出被截断 | 看 `lostOutput`/`spillPath`（子进程输出超缓冲会落盘） |
| 自动评审太频繁 | 设置页调小「每会话最多自动评审次数」、调大「最小间隔」，或把「自动评审」设为 `off` |
| `ocr_status` 说「本机桥没有就绪」，状态行也显示回落 | `dsh` 路由需要宿主加载了提供 `llm` 服务的插件（本机是 `llm-commandcode` / `llm-pi-ai` 之类）。缺它就自动回落 `endpoint` 路由：要么修好 profile 里的提供方插件，要么把「LLM 路由」切成 `endpoint` 填好地址与凭据引用 |
| 设置页文案变成英文 | 界面文案走 Client locale 服务（跟随 DSH 语言）：`locale/*.json` 只放卡片标题与描述，界面文案在 `lib\client.js` 的 `TEXT_ZH`/`TEXT_EN`；没有 locale 服务或词典缺键时自动回落中文 |
| 插件卡片没有图标 / 标题显示成包名 | 清单读取失败：确认 `package.json` 的 `icon` 是相对路径且文件存在、`exports` 含 `"./locale/*.json"`、`locale/{zh,en}.json` 有 `meta.title/description`（`node test/smoke.mjs` 会校验这几条） |

### 加固（v0.3.4：一轮针对「稳定性/健壮性」的审计与修复）

| 现象（升级前的旧行为） | 现在 |
| --- | --- |
| `ocr_status` 说 `ocrPath` 指向 `.cmd`/`.bat`/`.ps1` 被拒绝 | 硬拒并说明原因：Node 24 起 `spawn` 对批处理 shim 直接抛 `EINVAL`（子进程起不来还会被当成「执行失败」）。请指向原生的 `opencodereview.exe`（第 50 行那条探测顺序也是这个道理） |
| 明明改了代码却不再自动评审 | 旧实现把「上次评审的签名」在评审**前**就推进了，一次瞬时失败（超时/网络/桥没起来）之后就认为这批改动已评过，且失败是静默的。现在签名在评审**成功**后才推进，同批改动失败会重试（`AUTO_RETRY_LIMIT = 2`） |
| Jobs 面板里有一条评审一直转圈不结束 | 旧实现「打满轮次上限」的分支先登记 job 再 `return`，从不结算。现在会结算成 `failed` + `code: OCR_REVIEWER_UNCERTAIN`，摘要写明「已达轮次上限（N 轮），仍有 M 条未确认的问题」 |
| 点了「停止」之后上游模型还在烧配额 | 旧桥不监听客户端断连。现在请求 `aborted`/连接被关会中止上游 `ctx.llm.stream`（`req.aborted` / `res` 的 `close` 两条路径）；桥的 `close()` 最多等 2s 宽限，然后关闭所有在飞连接 |
| 设置页/`config.json` 里把开关写成 `"false"`、次数写成负数 | 旧实现把 `"false"` 当**真**（真值判断只看存在性），负数直接变成负超时（等于关掉硬超时、评审能挂到天荒地老）。现在 `loadConfig` 会归一：`"false"/"0"/"off"` → `false`，非法数字/负数回落到默认值（`timeoutMinutes` 默认 15，也夹在 `maxTimeoutMinutes` 之内） |
| 评审结果形状不认识却报「未发现问题」 | fail-closed 补齐：`exit=0` 但没有可识别的问题清单字段 → `OCR_OUTPUT_SHAPE_UNKNOWN`（`test/smoke.mjs` 有 7 种坏形状的回归表）；混合清单（一部分解析不出来）也会在 `notes` 里写明「N 条无法解析」 |

```
dsh-open-code-review/
├─ package.json          # dsh.bundle.patch 指向 cordis.patch.yml；dsh.client 声明浏览器半侧；icon 指向 icon.svg
├─ icon.svg              # 插件管理卡片/详情里的图标（相对路径，≤256KiB）
├─ locale/
│  ├─ zh.json            # 卡片标题与描述（meta.title/description）：不加载插件也要可读
│  └─ en.json            # 同上，英文
├─ cordis.patch.yml      # 插入 profile（本机为 desktop）插件树的条目
├─ config.json           # 第 2 层配置（可选；默认值全列在此，含 _readme 说明）
├─ lib/
│  ├─ index.js           # 插件入口：schemastery Config + 工具/命令注册 + 自动评审钩子 + 本机桥接线 + 独立评审 agent 编排（runReviewerReview / 轮次往返 / subagents 子注入）+ 评审进度接线（openReviewJob / finishReviewJob / chunkSink）
│  ├─ reviewer.js        # 评审 agent：规格提示词、findings schema 与解析、线程与轮次（纯逻辑；subagents 运行时由调用方注入）
│  ├─ bridge.js          # 本机 LLM 桥：OpenAI 兼容 /v1/chat/completions ⇄ ctx.llm.stream（含宿主硬契约：assistant 消息补 source{kind:"model",provider,model}、tool 消息补 source{kind:"tool",callId}）
│  ├─ client.js          # 浏览器半侧：注册 plugins.bundle.config + settings.section + 会话内进度行（conversation.input.dock），渲染 24 字段设置表单（dsh 模式 18 个控件行 / 带静态端点的 endpoint 模式 20 行；评审 agent=spawn 时 21 行），文案走 Client locale
│  ├─ config.js          # 三层配置合并、schemaOverrides（读 volatile 引用）
│  ├─ job.js             # 评审进度：把每次评审登记成 background job（进度行/输出流/停止/结算），宿主没有 jobs 服务时整条链路降级成空操作
│  ├─ ocr-cli.js         # 可执行文件探测、受管子进程（含实时输出回调）、LLM 环境变量映射（本机桥或静态端点）、git diff
│  └─ review.js          # 参数规范化、命令行拼装、JSON 解析、文本渲染
└─ test/
   ├─ smoke.mjs          # 离线冒烟（假 ctx + 罐头/真 ocr，113 项断言，含工具 schema 子集 + 返回值校验、结果码、fail-closed（7 种坏形状）、取消（abort 前不 spawn / 跑到一半必 terminate）、生命周期收尾、独立评审 agent 全路径、评审进度、清单/图标/locale/DSH 默认模型校验）：node test/smoke.mjs
   ├─ schema-subset.mjs  # 宿主 schema 子集与返回值的校验器（smoke.mjs 共用；register 时查 schema、调用时查 execute 的返回值 —— 这两处都曾让真机炸过）
   ├─ job-smoke.mjs      # 评审进度冒烟（假 jobs registry，51 项断言：登记/进度行/输出流/停止→取消/结算幂等/轮次上限也会结算/没有 jobs 时降级）：node test/job-smoke.mjs
   ├─ reviewer-smoke.mjs # 评审 agent 纯逻辑冒烟（罐头 subagents，45 项断言：提示词/结构化解析/线程轮次/失败与超时/超时会 abort 掉在飞的子 agent）：node test/reviewer-smoke.mjs
   ├─ bridge-smoke.mjs   # 本机桥冒烟（假 llm 流 + 真 ocr 子进程，65 项断言，含「assistant 消息必须带 model source」「tool 消息必须带 tool_call_id」「客户端断连要中止上游」这三条真机事故回归）：node test/bridge-smoke.mjs
   ├─ client-smoke.mjs   # 浏览器半侧冒烟（迷你 React + 假 configForms/remote/locale，127 项断言，含会话内进度行）：node test/client-smoke.mjs
   ├─ cordis-inject.mjs  # 真 cordis 回归（26 项断言，守住「服务齐全（含 jobs）/只差 remote.session/完全没有 remote」三种宿主形态）：node test/cordis-inject.mjs
   │                     #   取不到 DSH 自带的 cordis 就跳过：不打印"全部通过"、退出码 2（跳过 ≠ 通过）；OCR_TEST_CORDIS 可指 main 文件或目录
   ├─ zprobe3.mjs        # schema 预检：24 个字段是否都带 volatile/description/default
   └─ e2e-llm.mjs        # 端到端（真凭据 + 真 LLM，会花钱/耗时）：node test/e2e-llm.mjs
```

## 已知限制

- 自动评审依赖 `agent/turn-stopping` 事件；若宿主未加载提供该事件的插件则自动档不触发（工具与命令不受影响）。
- `ocr review` 的 JSON 结构在不同版本间可能变化，插件对 `issues[]` 做了宽松提取，但**永远保留 `rawJson`** 供核对。
- 自动评审与「模型自己调用 `ocr_review`」可能重复；签名判重只针对自动档。
- 非 git 仓库 / 空仓库下 `workspace` 范围没有可审改动（`preview` 会给出 0 个文件）。
- `dsh` 路由要求宿主加载了提供 `llm` 服务的插件（本机是 `llm-commandcode` / `llm-pi-ai` 之类）；缺它时自动回落 `endpoint` 路由，行为与老版本一致。
- 本机桥是明文 HTTP + Bearer 随机 token，只绑定 `127.0.0.1`、只活在本进程内，token 通过子进程环境变量交给 `ocr`（同机信任模型，不做 TLS/签名；断言见 `test/smoke.mjs` 的「只监听 127.0.0.1」与 `test/bridge-smoke.mjs`）。
- `ocr` 退出码 0 **不等于**评审通过：输出 JSON 里缺少可识别的问题清单字段（或不是 JSON / 是空串）时结果算失败（`OCR_OUTPUT_UNPARSABLE` / `OCR_OUTPUT_SHAPE_UNKNOWN`），免得「评审其实没跑成」被当成「没问题」。
- 插件卸载/重载会先 abort 在飞的评审（子进程 `terminate()`，结果标 `OCR_ABORTED`）并等它们 settle，所以 `dispose` 可能要等子进程收尾。
- 结果码是稳定契约（`OCR_*`）：`REVIEW_TOOL_OUTPUT` / `STATUS_TOOL_OUTPUT` 的枚举说明、`lib\review.js` 的 `CODES`、`lib\reviewer.js` 的 `REVIEWER_CODES` 与 `test/smoke.mjs` 的码表断言四处同步。
- 独立评审 agent 需要宿主加载提供 `subagents` 服务的插件（本机是 `dsh-tool-subagent` 带的内置 `spawn` provider）。缺它时自动档回落静态引擎并在 `notes` 说明，显式 `reviewer: true` 以 `OCR_REVIEWER_UNAVAILABLE` 失败。
- 结构化输出（`outputSchema`）只在一次性的 `ctx.subagents.start()` 上可用，所以**每轮都是一个新的子会话**：线程记忆（上一轮 findings / `stillOpen`）由插件写进 prompt。子会话会出现在子代理侧栏，并计入 `autoMaxPerSession`。
- 评审子会话自己的回合结束不会再触发自动评审（`autoSkipSubagents` 挡住递归）；`uncertain` 不算通过，`clean` 才关线程。
