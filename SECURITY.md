# Security

## 这个插件会碰什么

| 面 | 具体行为 | 风险与默认姿态 |
| --- | --- | --- |
| 子进程 | 只用 `ctx.subprocess.spawn/resolveExecutable` 调 `ocr`（`ocr review` / `ocr scan` / `ocr delegate` / `ocr llm test` / `ocr --version`）。参数是数组，不拼 shell 字符串 | 不执行用户输入拼出来的命令；工具参数里的路径只作为 `--path` 的值传递 |
| 本机 LLM 桥 | `llm.mode = dsh`（默认）时在 `127.0.0.1` 起一个只认**随机 per-run token** 的 OpenAI 兼容桥，把请求转给宿主的 `ctx.llm.stream` | 只监听回环地址；token 不落盘、只出现在 `ocr_status` 的脱敏输出与进程环境里；`ocr_status.bridge.rejected` 单独统计「到了桥但没转发出去」的请求 |
| 凭据 | `llm.apiKeyRef` 存的是 DSH 凭据的**名字**（推荐），由宿主解析；`llm.apiKey` 会把明文写进配置文件 | 默认留空 `apiKey`；文档与 `config.example.json` 都提示优先用 `apiKeyRef` |
| 配置文件 | 三层：`DSH_OPEN_CODE_REVIEW_CONFIG`（环境变量）→ `<DSH_HOME>/dsh-open-code-review.json` → 插件目录 `config.json` | 仓库里**不跟踪** `config.json`（`.gitignore`），发布包里也没有它；改设置页写的是当前 profile 的配置层 |
| 审查内容 | 评审把**待审文件的 diff/内容**发给模型（DSH 的模型或你自己配的端点） | 这是功能本身；不想让内容离开本机就配本机端点，或只用 `engine=delegate` 并由你当前的 DSH 模型来审 |
| 报告写入 | 只有 `ocr_status.stats` 的**可选**落盘（`<DSH_HOME>/dsh-open-code-review-stats.json`，默认关闭） | 记的是入口计数与耗时/token，不含文件内容 |

## 紧急制动（出事第一步）

放一个标记文件，插件就不注册任何钩子/命令/桥/skill，只留 `ocr_status` 供诊断：

```powershell
New-Item -ItemType File "$env:USERPROFILE\.dsh\dsh-open-code-review.disabled"
# 或插件目录下的 .disabled；或启动 DSH 前设 DSH_OPEN_CODE_REVIEW_DISABLE=1
```

`ocr_status` 会显示 `disabled` / `disabledBy`（来源与路径）；`ocr_review` 返回 `OCR_DISABLED`
并说明怎么恢复（删掉标记即热恢复）。

## 报告漏洞

请不要开公开 issue。用 GitHub 的 **private vulnerability reporting**（仓库 Security 页 →
Report a vulnerability）或邮件联系仓库作者。请附：复现步骤、影响面（是否能执行任意命令 /
是否能读到本机文件 / 是否能外发内容）、插件与 DSH 版本、平台。

我们会在确认后尽快修复并在 `CHANGELOG.md` 里写明影响范围与自救方式；
如果问题影响「所有工具不可用」这类面，会同时更新 `RELEASING.md` 的止血步骤。
