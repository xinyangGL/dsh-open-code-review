# Contributing

欢迎提 issue / PR。这个插件的可用性建立在几条**可验证**的纪律上，改动前请先读这一页。

## 开发环境

- Node ≥ 20（CI 跑 20 / 22 / 24 × ubuntu / windows）。
- 插件**没有运行时依赖**：`lib/*.js` 只用 Node 内置模块（`node:fs`、`node:path`、`node:http`、…）。
  **不要新增 npm 依赖**；一个例外是 `@deepseek-ai/schemastery`，它声明为 `peerDependencies` 里的
  *optional*（宿主提供；拿不到时插件降级成「设置页不可用」而不是崩掉）。
- `ocr`（阿里 OpenCodeReview CLI）是**外部前置依赖**，测试不要求它：离线套件会在缺 `ocr` 时
  把「真端到端」的断言换成验「定位失败」的诊断路径（所以裸 clone 的 CI 也能全绿）。

## 跑测试

```bash
npm test          # 八套：smoke / killswitch-smoke / host-contract / job-smoke / reviewer-smoke /
                  #        bridge-smoke / client-smoke / cordis-inject
node test/smoke.mjs   # 只跑某一套
```

分层（改动要落在对应层，别只靠 L1）：

| 层 | 内容 | 在哪 |
| --- | --- | --- |
| L0 | 语法与 schema 形状 | `node --check lib/*.js`、smoke 里的 schema 子集断言 |
| L1 | 离线八套（假 ctx / 罐头 / 真 `ocr` 两环境） | `test/*.mjs` |
| L2 | 宿主契约探针：能力清单、降级、紧急制动 | `test/host-contract.mjs`、`test/killswitch-smoke.mjs` |
| L3 | 真机 Windows：重启加载、真评审、preTest 双向、制动决定性 | 手动，见 `RELEASING.md` |
| L4 | 真 GUI 点击（回合尾部按钮） | 手动 + 人手一次 |
| L5 | 付费端到端 `test/e2e-llm.mjs` | 手动（会花钱，默认不进 CI） |
| L6 | CI 矩阵（三版本 × 两平台） | `.github/workflows/ci.yml` |

**CI 等价环境**（验证「没装 `ocr` 也全绿」这一条，改测试前先自己跑一遍）：

```powershell
$env:LOCALAPPDATA = "$env:USERPROFILE\.dsh\tmp-ci-home"
$env:APPDATA      = $env:LOCALAPPDATA
$env:PATH         = "C:\Program Files\Git\cmd;C:\Windows\System32;C:\Windows"
Remove-Item Env:OCR_EXECUTABLE, Env:OPENCODEREVIEW_BIN -ErrorAction SilentlyContinue
node test/smoke.mjs        # 期望：没装 ocr 时的断言数
```

## 碰宿主扩展点之前

宿主契约是**我们的假设**，不是文档保证。以前就吃过一次亏：`tools.guard` 的回调返回空字符串
被宿主当成「拒绝理由」，于是应用里每个工具都渲染成空的 `Error:`（v0.5.7~v0.5.9，约 5 小时，
应用内无法自救）。

所以：

1. **先写探针，再挂扩展点。** 用 `cordis_inspect_*` 或直接从宿主的 `app.asar` 里抽源码，
   把契约（参数形状、返回值语义、生命周期）写进 `docs/host-contract.md` 并在
   `lib/host-contract.js` 的 `HOST_CONTRACT` 里登记一条（`required` / `surface` / `detect` / `degrade`）。
2. **注册一律走 `lib/hooks.js` 的 `armHook(ctx, event, handler)`**：事件名要在白名单里，
   注册失败只记账不抛，handler 自己包 try/catch，**异常一律 fail-open**。
   源码级断言会拒绝裸 `ctx.on(`。
3. **问自己爆炸半径**：这个钩子出错时，影响范围是它自己，还是整个工具面？
   可选功能**不允许**拥有「让所有工具不可用」的失败模式（`docs/pretest-gate-safety-design.md`）。
4. **给逃生通道**：新增常驻行为时想好「用户怎么在不重装的情况下关掉它」
   （`enabled=false` / `preTest=off` / `.disabled` 标记文件 / 环境变量）。

## PR 期望

- 一个 PR 只做一件事；标题写清「改了什么 + 为什么」，正文带**证据**（测试输出、`ocr_status` 片段、
  真机截图）。没有证据的「已修复」不接受 —— 这一条来自本仓库自己的红线：闭环意识。
- 改了行为 ⇒ 同步 `CHANGELOG.md`、`README.md`、`README.zh.md`（英文与中文都有），
  以及 `package.json` 的 `version`（高风险改动单独发版，见 `RELEASING.md`）。
- 改了断言数量 ⇒ 三个地方的计数一起改（`README.md` 的测试表、`README.zh.md` 的目录树、`CHANGELOG.md`）。
- 不要为了过测试去放宽断言、删需求或改评分资产；测试是契约，不是障碍。
- 提交信息用中文或英文都行，但要具体（「修 X」而不是「update」）。

## 报 issue

请附上：

- `ocr_status` 的完整输出（脱敏后的桥 token 不影响诊断）。
- 插件版本（`ocr_status` 顶部 / `package.json`）与 DSH 版本、平台（Windows/macOS/Linux）。
- 复现步骤与期望/实际结果；如果是「工具全坏」这类症状，先说清 `ocr_status` 还能不能调用 ——
  完全不可用时按 `RELEASING.md` 的止血步骤先加 `.disabled` 标记。
- 涉及付费评审（`engine=ocr`/`auto`）时，注明是否已配 LLM、`timeoutMinutes` 与耗时。
