# v1.0 重构工作清单（分支 `v1-slim`，发版前删除本文件）

已批准的方案见会话记录；这里只留**可执行的执行序**与落点。

## 目标（v1.0）
- 零前置：ocr 随包（`@alibaba-group/open-code-review@1.12.13`），三级解析：`config.ocrPath` → **包内**（`createRequire.resolve('@alibaba-group/ocr-win32-x64/package.json')`）→ 全局（Volta/%APPDATA%\npm）→ PATH。
- 单一路由：本机桥 + 当前会话模型 → DSH 默认模型 → `OCR_LLM_MISSING`（零调用零费用）。删 endpoint 直连与第三方默认。
- 6 键（可见 3：enabled / engine / timeoutMinutes；仅文件层 3：llm.model / llm.provider / ocrPath）。
- 删除：preTest、独立评审 agent、自动评审、skill、killswitch、ETA 动态估算、ModelPicker。
- 结果 = 结论 / 覆盖 / 问题 / 下一步 / 出处 / 附录；结果码 16 → 10。
- 测试 8 套 → 5 套（smoke / client-smoke / bridge-smoke / host-contract / pack-check），断言 822 → ~300。

## 执行序（每步跑 `node --check` + 相关套件，绿了再提交）
1. ✅ ocr 依赖 + 三级解析 + `source` 披露（`lib/ocr-cli.js` 的 `bundledCandidates()` / `resolveOcr()`）。
2. ⬜ 删 preTest：`lib/hooks.js` 整文件、`lib/index.js:128-320`（TEST_SEGMENT_RES→preTestVerdict）、`:3077-3090`（tools/pre-execute 分支）、`:149-188`（文案/统计）、`config.preTest`、`docs/pretest-gate-safety-design.md`、相关断言。
3. ⬜ 删独立评审 agent：`lib/reviewer.js`、`lib/index.js:1149-1304`（runReviewerReview）、`:1389-1400`（reviewerTimeoutMs）、`:3404-3424`（safeInject subagents）、工具参数/输出里的 `reviewer`、`reviewer.*` 5 键、3 个 `REVIEWER_*` 码、`test/reviewer-smoke.mjs`。
4. ⬜ 删自动评审：`lib/index.js:2643-2940`（createAutoReviewer）、`:2888-2916`（tools/result、agent/turn-stopping 钩子）、`auto*` ~10 键、客户端「自动评审」组。
5. ⬜ 删 skill（`skills/` + `lib/index.js:1234-1281` syncOnDemandSkill）。
6. ⬜ 删 killswitch（`lib/killswitch.js` + 测试），`enabled` 即总开关。
7. ⬜ 删 endpoint 直连：`lib/index.js:428-448`（resolveLlmKey）、`:1556-1633` endpoint 分支、`llmMissingNextStep` 逃生门、`lib/config.js:61/69`（`DEFAULT_LLM_BASE_URL` / `DEFAULT_LLM_KEY_REF`）、`llmMode/llmBaseUrl/llmProtocol/llmApiKeyRef` 键、`lib/client.js` 的 `ModelPicker`。
8. ⬜ 配置收敛到 6 键（`lib/config.js` DEFAULTS + schema），旧键容忍并忽略（启动一句「已忽略 N 个旧键」）。
9. ⬜ 结果披露：结论行带 `模型 provider/model（来源 当前会话|DSH默认）`；覆盖行统一走 `coverageSummary`。
10. ⬜ 结果码 16 → 10（保留 `NEXT_STEPS` 机制）。
11. ⬜ 客户端重写：`lib/client.js` 设置页 = 3 字段 + 只读诊断折叠；删 `ModelPicker`/`ConfigSummary`；按钮副行保留「N 个文件改动 · ocr 档：约 3~10 分钟/文件、按 tokens 计费」；进度行保留 阶段/已用时长/停止。
12. ⬜ 测试重写（5 套）+ `package.json` scripts.files + `dsh.host.capabilities` 14 → 7。
13. ⬜ 文档：README 双语重写（≤30KB 首屏 5 分钟上手）、CHANGELOG 只留 3 版、`docs/` 只留 `host-contract.md`。
14. ⬜ 发版：`1.0.0`、独立 profile 跑 A1–A10、主 profile 切换、npm 发布（`@xinyanggl/dsh-ocr-review`，待 npm 账号验证）、市场条目。

## 关键约束（不许丢）
- 不写 `~/.opencodereview/config.json`（B 方案只读）。
- provider/model 只允许同路由配对，绝不跨 provider 补全（v0.12.3 事故根因）。
- partial/coverage 必披露；失败必带 code + 下一步；空改动 ≠ 没问题。
- `resolveOcr()` 在 engine 分支之前（`lib/index.js:1780`），delegate 也要 exe 跑 `--preview`。
