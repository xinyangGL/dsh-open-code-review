# dsh-open-code-review

把 **阿里 OpenCodeReview（`ocr`，npm 包 `@alibaba-group/open-code-review`）** 接入 DeepSeek Harness 的第三方插件。

提供三条入口，全部走本机已安装的 `ocr` 可执行文件：

| 入口 | 形态 | 触发方式 |
| --- | --- | --- |
| `ocr_review` / `ocr_status` | 模型工具 | 你让模型评审时模型调用；或模型自己在改完代码后调用 |
| `/ocr-review` | 斜杠命令 | 你在输入框敲 `/ocr-review`（可带附加要求） |
| 自动评审 | 回合钩子 | 本回合有 `write`/`edit` 等文件写入，且回合即将关闭（`agent/turn-stopping`）时自动跑一次并把结果交给模型 |

引擎两档：

- **`ocr`**：跑 OpenCodeReview 自己的「确定性工程 × LLM」流水线（需要 provider/model/key，见下文配置）。
- **`delegate`**：**不需要 key**。插件用 `ocr delegate preview` + `ocr delegate rule` 拿到「可审文件 + 按内容分组的审查规则」，再附上 `git diff`，拼成一份审查规格交给当前模型自己审（OpenCodeReview 官方为宿主 Agent 设计的 Delegation Mode）。
- **`auto`（默认）**：先试 `ocr`，如果报 `no valid LLM endpoint configured` 就自动降级为 `delegate`，所以**开箱即用**（本机默认已指向 CommandCode 的 DeepSeek v4.1 且凭据引用已配好，实测会直接跑 `ocr` 流水线）。

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
| `llm.baseUrl` | `https://api.commandcode.ai/provider/v1` | ✅ | → `OCR_LLM_URL`（CommandCode 的 OpenAI 兼容路由，本机实测可用） |
| `llm.protocol` | `"openai"` | ✅ | → `OCR_LLM_PROTOCOL`。CommandCode 的 DeepSeek v4.1 **只能**走 `openai`；Anthropic 协议端点用 `anthropic` |
| `llm.model` | `deepseek/deepseek-v4.1-flash` | ✅ | → `OCR_LLM_MODEL` |
| `llm.apiKeyRef` | `COMMANDCODE_API_KEY` | ✅ | → `OCR_LLM_TOKEN`。**这里是「凭据引用」不是密钥本身**：运行时用 `ctx.credentials.resolve()` 从 DSH 凭据库/环境变量取值 |
| `llm.apiKey` | `""` | — | 字面密钥（优先级高于上面的引用；不想把密钥放进 DSH 凭据库时才用，只建议写在 `config.json`） |
| `auto` | `"adaptive"` | ✅ | 自动评审开关：`off` 关闭；`adaptive` 模型在跑就 `inject`、空闲就 `followup`；`inject` 只注入上下文；`followup` 直接开新回合 |
| `autoScope` | `"workspace"` | ✅ | 自动评审的范围 |
| `autoSkipSubagents` | `true` | ✅ | 子代理会话不触发自动评审 |
| `autoMaxPerSession` | `3` | ✅ | 每个会话最多自动评审几次（防「改—评—改」死循环） |
| `autoMinReviewableFiles` | `1` | ✅ | 可审文件数低于该值就跳过 |
| `autoMinIntervalMs` | `60000` | ✅ | 两次自动评审最小间隔（毫秒） |
| `autoIncludeDiff` | `true` | ✅ | 自动（delegate）评审时带不带 `git diff` |
| `includeDiffMaxBytes` | `120000` | — | 单次带出的 diff 上限（字符） |
| `maxIssuesInText` | `40` | — | 文本渲染最多列多少条问题（完整数据仍在 `issues`/`rawJson`） |
| `verbose` | `false` | ✅ | 打印调试日志 |

### LLM 端点（`ocr` 引擎）

**开箱即用**：默认指向 CommandCode 的 DeepSeek v4.1，密钥走 DSH 凭据库里的 `COMMANDCODE_API_KEY` 引用（本机已配置），所以 `engine: "auto"` 现在真的会跑 `ocr` 流水线，而不是降级。

实测确认过的组合（`ocr llm test` 与真实评审都通过）：

```
OCR_LLM_URL      = https://api.commandcode.ai/provider/v1
OCR_LLM_PROTOCOL = openai
OCR_LLM_MODEL    = deepseek/deepseek-v4.1-flash
OCR_LLM_TOKEN    = <COMMANDCODE_API_KEY>
```

要点与备选：

- `OCR_LLM_URL` 默认按 **Anthropic** 协议拼 `/v1/messages`；CommandCode 的 DeepSeek 系列是 OSS 模型，走 `/v1/chat/completions`，所以必须配 `OCR_LLM_PROTOCOL=openai`，否则报 `Model "…" is not supported on this endpoint`。
- 想换成 DeepSeek 官方：`llmBaseUrl = https://api.deepseek.com/anthropic`、`llmProtocol = anthropic`、`llmModel = deepseek-chat`（该端点只认 Anthropic 协议）。
- 想换成阿里云百炼：`https://dashscope.aliyuncs.com/compatible-mode/v1` + `openai` + `qwen3-coder-plus` 之类。
- 也可以完全不动插件配置，改用 OCR 自己的全局配置（`~/.opencodereview/config.json`）：`ocr config set provider deepseek` / `ocr config set model …` / `ocr config set providers.deepseek.api_key …`；或设全局环境变量 `OCR_LLM_URL`/`OCR_LLM_TOKEN`/`OCR_LLM_MODEL`（插件里配的值优先于这些环境变量）。
- `ocr llm providers` 可列出全部内置 provider；`ocr_status` 会替你跑 `ocr llm test`。

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
  "includeDiff": true     // delegate 模式是否附 diff
}
```

返回：`reviewableFiles` / `excludedFiles` / `issues[]` / `reviewSpec`（delegate 的规格正文）/ `summary` / `rawJson`（原始 JSON，最多 10 万字符）等。
`ocr_status` 用来体检：可执行文件、版本、OCR 全局配置、环境变量、`ocr llm test` 连通性。

### 命令 `/ocr-review`

在输入框敲 `/ocr-review`（可在后面跟要求，例如 `/ocr-review 只审 src/ 下的改动`）→ 插件立刻给当前会话注入一段指令，让模型调用 `ocr_review` 并按结果逐条处理（真实缺陷就改，误报说明理由）。

### 自动评审

只要有文件写入工具成功执行（`write`/`edit`/`apply_patch` 等），且回合即将结束，插件就会：

1. 先跑一次 `ocr review -p`（便宜、不调 LLM）确认「确实有可审改动」且改动签名与上次不同；
2. 再按 `autoEngine`/`engine` 跑正式评审；
3. 把结果交给模型——模型仍在跑就用 `inject`（下个 step 作为上下文），已空闲就用 `followup`（开新回合处理）。

每个会话最多 `autoMaxPerSession` 次，两次之间至少隔 `autoMinIntervalMs`，同样的改动签名不会重复触发。不想要就把 `auto` 设为 `"off"`。

---

## 排障

| 现象 | 处理 |
| --- | --- |
| 设置页里找不到 `dsh-open-code-review` / 表单是空的 | 多半是**改了 `lib\*.js` 但没重启 DSH**（宿主仍缓存旧模块，`Config` 没被导出）。完全退出并重开 DSH 后再看；判据：`ocr_status` 的第一行「设置页」 |
| 插件卡片能打开，但没有配置表单 | 浏览器半侧没被加载：确认 `package.json` 里有 `dsh.client` 与 `exports["./client"]`、`lib\client.js` 存在且语法可解析（`node --check lib\client.js`），然后**重启一次 DSH** 并刷新页面（包扫描结果缓存到重启）；页面里若显示「浏览器侧没有这个条目的表单」说明 cell 已加载但条目 id 对不上 |
| 设置导航里没有「代码评审」 | 同一个表单的独立入口（`settings.section`）。它没出现说明浏览器半侧没加载；只改了 `lib\client.js` 内容时**刷新页面**即可（bundle 的 rev 取文件 mtime），但**第一次**加上/移动客户端文件要重启 DSH 才会重新扫描 |
| `无法定位 ocr 可执行文件` | 在 `config.json` 里写 `ocrPath` 指向 `opencodereview.exe`（原生 exe 优先于 `ocr.cmd`） |
| `credential "COMMANDCODE_API_KEY" 未配置` / `llm test` 报缺 key | 在设置页把「LLM 凭据引用」改成你 DSH 凭据库里已有的名字，或往 `config.json` 的 `llm.apiKey` 写一个字面密钥 |
| `OCR 未配置 LLM 端点` | 预期行为之一：`engine: "auto"` 会自动降级 `delegate`；想用 `ocr` 流水线就在设置页填好端点/协议/模型/凭据引用 |
| `Model "…" is not supported on this endpoint` | `llmProtocol` 配错了：CommandCode 的 DeepSeek 系要 `openai`；走 `/v1/messages` 的 Anthropic 端点才用 `anthropic` |
| 结果里 `issues` 为空但评审成功 | 不同 OCR 版本的 JSON 结构可能变化，看 `rawJson` 原始输出；`extractIssues` 已兼容 `issues/findings/comments/…` 多种字段名 |
| 输出被截断 | 看 `lostOutput`/`spillPath`（子进程输出超缓冲会落盘） |
| 自动评审太频繁 | 设置页调小「每会话最多自动评审次数」、调大「最小间隔」，或把「自动评审」设为 `off` |

## 目录结构

```
dsh-open-code-review/
├─ package.json          # dsh.bundle.patch 指向 cordis.patch.yml；dsh.client 声明浏览器半侧
├─ cordis.patch.yml      # 插入 profile（本机为 desktop）插件树的条目
├─ config.json           # 第 2 层配置（可选；默认值全列在此，含 _readme 说明）
├─ lib/
│  ├─ index.js           # 插件入口：schemastery Config + 工具/命令注册 + 自动评审钩子
│  ├─ client.js          # 浏览器半侧：注册 plugins.bundle.config + settings.section，渲染 17 字段设置表单
│  ├─ config.js          # 三层配置合并、schemaOverrides（读 volatile 引用）
│  ├─ ocr-cli.js         # 可执行文件探测、受管子进程、LLM 环境变量映射、git diff
│  └─ review.js          # 参数规范化、命令行拼装、JSON 解析、文本渲染
└─ test/
   ├─ smoke.mjs          # 离线冒烟（假 ctx + 真 ocr，23 项断言）：node test/smoke.mjs
   ├─ client-smoke.mjs   # 浏览器半侧冒烟（迷你 React + 假 configForms，51 项断言）：node test/client-smoke.mjs
   ├─ zprobe3.mjs        # schema 预检：17 个字段是否都带 volatile/description/default
   └─ e2e-llm.mjs        # 端到端（真凭据 + 真 LLM，会花钱/耗时）：node test/e2e-llm.mjs
```

## 已知限制

- 自动评审依赖 `agent/turn-stopping` 事件；若宿主未加载提供该事件的插件则自动档不触发（工具与命令不受影响）。
- `ocr review` 的 JSON 结构在不同版本间可能变化，插件对 `issues[]` 做了宽松提取，但**永远保留 `rawJson`** 供核对。
- 自动评审与「模型自己调用 `ocr_review`」可能重复；签名判重只针对自动档。
- 非 git 仓库 / 空仓库下 `workspace` 范围没有可审改动（`preview` 会给出 0 个文件）。
