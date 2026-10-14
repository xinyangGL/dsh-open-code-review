# 市场上架 PR 草稿（等 `awesome-dsh-plugin#7328` 的答复）

> 状态：**未提交**。投稿目标是 `awesome-dsh-plugin/awesome-dsh-plugin` 的
> `data/plugins/<owner>__<repo>.yml`（目录数据由它生成 `https://awesome-dsh-plugin.com/plugins.json`）。
> 之所以停在草稿：目录里已经有一个**同名**条目（`mocilukalbj/dsh-open-code-review`，`name` 与 npm 包名都相同，
> 2026-10-09 收录），所以先发 issue 问「同名不同 owner 是否接受 / 要不要改名」——
> [awesome-dsh-plugin#7328](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/issues/7328)
> （2026-10-14 发出，截至写稿时 0 条回复）。等答复再决定下面 A/B 哪条路。

## 提交前必须先做（本文件不替代模板）

1. **抄一遍真模板**：`data/plugins/` 下挑一个条目，按它的字段名与缩进组织本文附录的 YAML；
   下面那份 YAML 只是**内容清单**，字段名以仓库模板为准（我还没逐字核对模板，别直接照抄）。
2. 版本与素材对齐：条目里的版本写 `0.12.0`；截图用仓库里的 `docs/settings-basic.png` /
   `docs/settings-advanced.png`（已按 v0.12.0 版式重拍）。
3. 外部依赖要写明：需要 `ocr` CLI（阿里 OpenCodeReview），**Windows 上必须是真 `.exe`**（`.cmd` shim 不算）；
   并且它是**计费的**（实测每文件 176~600 秒、scan 单文件约 $0.16）。
4. `category`：`git`（与现有同名条目一致，便于用户对照）。

## 两位命名方案的取舍

| 方案 | 条目 `name` | 好处 | 代价 |
| --- | --- | --- | --- |
| **A（默认）** | `dsh-open-code-review` | 与仓库名、README、安装命令一致 | 目录里出现两个同名条目；`dsh plugin add dsh-open-code-review` 会解析到 npm 上那个（不是我的） |
| B | `dsh-ocr-review` | 一眼看出与既有条目的区别 | 与仓库名/README 不一致，需要同时说明「它其实就是 dsh-open-code-review」 |

**倾向 A，但服从策展人的规则**：如果答复是「同名不接受」，就改 B，并把仓库 README 第一句加上别名。

## PR 标题与正文（正文可直接用）

标题：

```
Add dsh-open-code-review: run Alibaba OpenCodeReview (ocr) on demand inside a DSH session
```

正文：

```markdown
## What it is

A DSH plugin that wires the `ocr` CLI (Alibaba OpenCodeReview) into a session:

- two tools — `ocr_review` (run a review: workspace / commit / range / scan) and `ocr_status`
  (routing, bridge, hooks, per-entry accounting);
- a `/ocr-review` command and a **"启动代码审核" button on the turn tail that only appears when the
  turn actually changed files** (fail-open: if the dirty check cannot read the turn, the button shows);
- three engines: `ocr` (the real pipeline, billed by tokens — a cost estimate is printed before it runs),
  `delegate` (no LLM: the plugin emits rules + the reviewable files + a unified diff, and the **current
  session model** reviews them), and an independent read-only reviewer subagent;
- a local bridge on a fixed loopback port so DSH's own model routing can be used without putting a key
  anywhere: the plugin forwards to `ctx.llm.stream`, and **never** silently falls back to a static
  endpoint (`OCR_LLM_MISSING` with three concrete next steps instead).

## Why it is worth listing

- **It refuses to lie about coverage.** Results carry `partial` / `partialReasons` / `coverage`
  (hunks kept vs dropped, slices, whether the diff was truncated); when something was dropped the
  summary may not say "no issues found". A single-flight guard (`OCR_ALREADY_RUNNING`) prevents two
  concurrent runs from double-charging and interleaving conclusions.
- **Every failure has an actionable next step** (16 stable result codes, each with a `nextStep`).
- **It is honest about cost before spending**: `scope=workspace` + `paths` is refused
  (`OCR_INVALID_ARGS`) instead of being silently ignored, and the estimate names the measured scale.

## Install / prerequisites

```bash
dsh plugin --profile <profile> add github:xinyangGL/dsh-open-code-review
```

- requires the `ocr` CLI on `PATH` (Windows: a real `ocr.exe`);
- works without it too: `engine=delegate` needs no LLM endpoint and no `ocr` invocation.

## Verification

- `npm test` green locally: 8 offline suites + a pack audit (`smoke 319 / killswitch 44 /
  host-contract 37 / job 51 / reviewer 45 / bridge 104 / client-smoke 213 / cordis-inject`) and
  the CI matrix (node 20/22/24 × ubuntu/windows) is green on `v0.12.0`
  (run #27, sha 575de1a).
- The offline branch is reproducible locally: `OCR_TEST_FORCE_NO_OCR=1 node test/smoke.mjs` → 319 pass.

## Note on the duplicate name

There is already an entry named `dsh-open-code-review` (owner `mocilukalbj`). Mine is **not** a fork of
it — different implementation and a different engine model. I opened issue #7328 to ask how the catalog
wants to handle the collision before filing this PR.
```

## 附录：条目内容清单（字段名以仓库模板为准）

```yaml
name: dsh-open-code-review          # 方案 B 则改成 dsh-ocr-review
owner: xinyangGL
repo: https://github.com/xinyangGL/dsh-open-code-review
npm: (未发布到 npm —— 只能通过 github: 安装)
version: 0.12.0
category: git
tags: [code-review, open-code-review, ocr, alibaba, review]
install: dsh plugin --profile <profile> add github:xinyangGL/dsh-open-code-review
requires: ocr CLI (real .exe on Windows); optional LLM endpoint for engine=ocr
screenshots:
  - docs/settings-basic.png
  - docs/settings-advanced.png
```

## 备忘：这条线上仍挂着的两件事（与本 PR 无关，但别忘）

- **CPO 的 P0-C「真人点击 12 用例」仍未做**（`v0.12.0` 越过了这道自设发布门就发布了，见 `ROADMAP.md` §2/§6）。
  建议补一个可执行的清单脚本：把 12 条用例写成「在已鉴权实例里用 bsk 点击 + 断言」，跑完留档。
- `docs/interaction-spec-2026-10-13.md`（UX 架构师越界写的 454 行）目前是跟踪状态、也随 `v0.12.0` 发布，
  去留等用户一句话。
