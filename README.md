[English](README.md) · [中文](README.zh.md)

# dsh-open-code-review

Code review for DSH (DeepSeek Harness), powered by Alibaba **OpenCodeReview** (`ocr`).

The plugin registers two model tools — `ocr_review` (run a review) and `ocr_status` (diagnostics) — plus the `/ocr-review` command, and it can review **automatically** at the end of a turn that wrote files. The review spec (rules + file list + unified diff) always comes from `ocr`; what changes is **who executes it**:

- `ocr` — ocr's own LLM pipeline (with `llm.mode = dsh`, DSH lends it the models, keys and quota);
- `delegate` — the plugin hands the current model the ocr-parsed rules + file list + diff and the model reviews against those rules (no LLM call inside ocr, no extra cost);
- `reviewer.agent = spawn` — each round spawns an **independent read-only reviewer subagent** (its own context and model, only `read` / `grep` / `glob`); it returns structured findings, the coding agent fixes them or explains why not, and the next round starts automatically.

## Requirements

| What | Detail |
| --- | --- |
| DSH host | The plugin is loaded by `dsh plugin ... add` (or from the plugin manager in the GUI) and runs inside the host process. |
| Node.js ≥ 20 | `package.json` `engines`; CI exercises 20 / 22 / 24 on Ubuntu and Windows. |
| Alibaba `ocr` CLI | `npm i -g @alibaba-group/open-code-review`. It is an **external prerequisite** — the plugin cannot install it for you. |
| Windows: a real `opencodereview.exe` | Point `ocrPath` at the native executable, e.g. Volta `%LOCALAPPDATA%\Volta\tools\image\node\<version>\node_modules\@alibaba-group\open-code-review\node_modules\@alibaba-group\ocr-win32-x64\bin\opencodereview.exe`, or the global npm location `%APPDATA%\npm\node_modules\...`. **Never** `.cmd` / `.bat` / `.ps1`: those are script shims, and the host spawns without `cmd.exe`, which fails with `EINVAL`. |
| macOS / Linux | Point `ocrPath` at the real path from `which opencodereview` (not at a wrapper script). |
| Or no config at all | Leave `ocrPath` empty and put `opencodereview` on `PATH`, or set `OCR_EXECUTABLE` / `OPENCODEREVIEW_BIN`. |

Executable lookup order (`lib/ocr-cli.js`): `ocrPath` → `ocrCandidates` → `OCR_EXECUTABLE` → `OPENCODEREVIEW_BIN` → well-known Volta / global-npm locations (native `.exe` first) → `PATH` (`opencodereview`, `opencodereview.exe`). Script shims are rejected with the reason spelled out.

## Install

```powershell
dsh plugin --profile <profile> add github:xinyangGL/dsh-open-code-review
# the https form is equivalent
dsh plugin --profile <profile> add https://github.com/xinyangGL/dsh-open-code-review
```

Restart the DSH host afterwards, then verify:

```
ocr_status
```

It reports the resolved executable and its version, the LLM route in force, and where the configuration came from (`configSource` / `configPath`). When `ocr` cannot be found it prints platform-specific install steps (global npm install, Node ≥ 20, and the Windows “real `.exe`, not the shim” warning) — you do not need this README for that.

## Changing config / taking effect

| What you changed | How it takes effect |
| --- | --- |
| Any field in the settings page | **Immediately.** The host writes the value into the current profile’s patch YAML and broadcasts it; the plugin re-reads the config — no restart. |
| An external config file | **Immediately.** Re-read by mtime. |
| `lib/*.js` (host side) | Restart the DSH host (ESM module cache). |
| `lib/client.js`, or `dsh.client` in `package.json` | Restart the host **and** reload the page (the client bundle is built and served by the host). |
| `cordis.patch.yml` / `package.json` | Re-run `dsh plugin --profile <profile> add ...` (or disable → enable it in the plugin manager), then restart. |

## Configuration

### Settings page

Two entries lead to the same form:

- **Settings → Code review** — the plugin’s own settings page (the nav title is 「代码评审」).
- **Settings → Plugins → dsh-open-code-review** — the plugin card shows a **read-only summary** plus a pointer to the settings page; values are edited on the settings page, not on the card.

Layout of the page:

- **Basics — 6 rows**, expanded: `enabled` (master switch), `engine`, `autoReview`, `reviewerAgent`, `llmMode`, `llmModel`.
- **Dependent rows** appear with their parent: `reviewerProvider` / `reviewerModel` / `reviewerRounds` when `reviewerAgent = spawn`; `llmBaseUrl` / `llmProtocol` / `llmApiKeyRef` when `llmMode = endpoint`; `llmProvider` (an advanced row) only in `dsh` mode.
- **「Advanced settings」— 12 items, folded by default.** *Tuning*: `autoScope`, `autoMaxPerSession`, `autoMinReviewableFiles`, `autoMinIntervalMs`, `autoSkipSubagents`, `autoIncludeDiff`. *Runtime & diagnostics*: `audience`, `ocrPath`, `timeoutMinutes`, `progress`, `llmProvider`, `verbose`. The fold title reads 「高级设置（12 项）」; if it holds edited-but-unsaved rows it also shows 「N 项待保存」.
- `autoMinIntervalMs` is a preset dropdown (30 seconds / 1 minute / 5 minutes / 10 minutes / Custom…) but is stored in **milliseconds** — pick 「自定义…」 to type a millisecond value (default `60000`).
- Rows the settings page has touched carry a 「设置页已改」 badge.
- Values are stored per profile (they do not follow you to another profile or machine). `ocr_status` shows where each key actually came from.

![Settings page — basics](docs/settings-basic.png)

![Settings page — advanced section expanded](docs/settings-advanced.png)

*Real screenshots (DSH on Windows, sidebar cropped out): the basics group, and the advanced section after expanding it.*

### Config sources

`resolveConfigFile()` (`lib/config.js`) reads **one** file — the first that exists:

1. the path in `DSH_OPEN_CODE_REVIEW_CONFIG`;
2. `<DSH_HOME>/dsh-open-code-review.json` — **recommended** (`DSH_HOME` defaults to `~/.dsh`);
3. `<plugin dir>/config.json` — only meaningful for a source / local checkout: a GitHub (git) install lives under `node_modules` and is overwritten on upgrade.

That file layer holds the keys the settings page does not have (`ocrCandidates`, `extraArgs`, `env`, `llm.apiKey`, a larger `maxTimeoutMinutes`, …). Precedence is **settings page > config file > factory defaults**, and `ocr_status.fileValues` lists the keys the file actually provided.

`ocr`’s own configuration (`~/.opencodereview/config.json`) is separate; `ocr_status.ocrHomeConfig` reports what was found there.

### Key reference

`Where` says which settings-page row exposes the key (or `file only`). Defaults are the factory values in `lib/config.js`.

| Key | Default | Where | Notes |
| --- | --- | --- | --- |
| `enabled` | `true` | Basics | Master switch. `false` stops automatic review and makes `ocr_review` / `/ocr-review` refuse to run (`ocr_status` still works). |
| `engine` | `"auto"` | Basics | Default engine: `auto` / `ocr` / `delegate`. A tool call can override it. |
| `auto` | `"adaptive"` | Basics (`autoReview`) | Settings-page key `autoReview` writes here. `adaptive` / `inject` / `followup` / `off`. |
| `reviewer.agent` | `"off"` | Basics (`reviewerAgent`) | `off` / `spawn` — run reviews through an independent read-only reviewer subagent. |
| `llm.mode` | `"dsh"` | Basics (`llmMode`) | `dsh` / `endpoint` — see [LLM routing](#llm-routing). |
| `llm.model` | `""` | Basics (`llmModel`) | → `OCR_LLM_MODEL`; empty = follow DSH’s default model. |
| `reviewer.provider` | `"spawn"` | dependent (`spawn`) | Subagent provider. A wrong name fails with `OCR_REVIEWER_UNAVAILABLE` and lists the available ones. |
| `reviewer.model` | `""` | dependent (`spawn`) | Empty = that provider’s default model. |
| `reviewer.rounds` | `3` | dependent (`spawn`) | 1–10 round trips before automatic re-review stops. |
| `llm.baseUrl` | `"https://api.commandcode.ai/provider/v1"` | dependent (`endpoint`) | → `OCR_LLM_URL`. |
| `llm.protocol` | `"openai"` | dependent (`endpoint`) | `openai` / `anthropic` → `OCR_LLM_PROTOCOL`. |
| `llm.apiKeyRef` | `"COMMANDCODE_API_KEY"` | dependent (`endpoint`) | → `OCR_LLM_TOKEN`, resolved from the DSH credential store (no plaintext on disk). |
| `autoScope` | `"workspace"` | Advanced · tuning | Scope used by automatic reviews: `workspace` / `range` / `commit` / `scan`. |
| `autoMaxPerSession` | `3` | Advanced · tuning | Max automatic reviews per session (`0` = none; manual reviews still work). |
| `autoMinReviewableFiles` | `1` | Advanced · tuning | Skip the automatic review when fewer files are reviewable. |
| `autoMinIntervalMs` | `60000` | Advanced · tuning | Cooldown between two automatic reviews, in ms. |
| `autoSkipSubagents` | `true` | Advanced · tuning | Turns of subagents (`delegationDepth > 0`) do not trigger automatic review. |
| `autoIncludeDiff` | `true` | Advanced · tuning | Include the unified diff when an automatic review falls back to `delegate`. |
| `audience` | `"agent"` | Advanced · runtime | → `ocr --audience`; `agent` = summary only, `human` = the fuller report. |
| `ocrPath` | `""` | Advanced · runtime | Absolute path to the real `ocr` executable; empty = auto-discovery. |
| `timeoutMinutes` | `15` | Advanced · runtime | → `ocr --timeout` and the plugin-side hard timeout. The settings page caps it at the factory 60. |
| `progress` | `true` | Advanced · runtime | Register each review as a background job (Jobs panel) and show the in-session progress row. |
| `llm.provider` | `""` | Advanced · runtime (`dsh`) | Provider id the bridge forwards to; empty = follow DSH’s default model. |
| `verbose` | `false` | Advanced · runtime | Log the ocr command line, env and timings to the DSH log. |
| `autoEngine` | `""` | file only | Engine used by automatic reviews; empty = follow `engine`. |
| `ocrCandidates` | `[]` | file only | Extra candidate paths tried after `ocrPath` (`[]` clears the layer). |
| `extraArgs` | `[]` | file only | Raw extra arguments appended to the ocr command line. |
| `env` | `{}` | file only | Extra environment variables for the ocr child process (`""` deletes one). |
| `includeDiffMaxBytes` | `120000` | file only | Cap (characters) on the diff embedded in the generated spec. |
| `maxIssuesInText` | `40` | file only | Max issues listed in the text summary (the full data stays in `issues` / `rawJson`). |
| `maxTimeoutMinutes` | `60` | file only | Hard upper bound for `timeoutMinutes`; itself clamped to 24 h (1440 min) in code. |
| `llm.apiKey` | `""` | file only | Literal key for the `endpoint` route. Prefer `llm.apiKeyRef`: a literal ends up on disk in a config file — and keep that file out of any repository (this repo ships only `config.example.json`). |
| `reviewer.persona` | `""` | file only | Extra persona / instructions for the reviewer subagent. |

### Choosing an engine

The spec always comes from `ocr`, so all three engines review against the same rules; you can switch per call.

| Engine | What actually runs | Cost | Pick it when |
| --- | --- | --- | --- |
| `ocr` | ocr’s own pipeline: deterministic engineering + its LLM reviewer, parsed back into `issues` | Needs an LLM for ocr — with `llm.mode = dsh` that is DSH’s model, key and quota | You want the most hands-off setup and OCR’s own review pipeline. |
| `delegate` | No LLM call inside ocr: the plugin returns the ocr-parsed rules + file list + unified diff, and **the current model** reviews by those rules | Uses the current session’s model/quota only | You have no LLM key/quota to spare, or ocr’s LLM is not configured. `engine = auto` falls back to this automatically. |
| `reviewer.agent = spawn` | Each round spawns an independent read-only subagent (own context + model, tools limited to `read`/`grep`/`glob`) that returns structured findings; the coding agent fixes them or explains why not, then the next round starts automatically until clean or the round limit | The most expensive, and the closest to a human review | High-risk changes where “the author reviews their own work” is not enough. |

**Which one?** Start with `ocr` (or `delegate` if you want reviews without spending anything extra), and switch on `reviewer.agent = spawn` for the changes that really matter.

### LLM routing

| Mode | Behaviour |
| --- | --- |
| `dsh` (default, recommended) | `ocr` is a separate subprocess and cannot reach cordis, so the plugin starts a small OpenAI-compatible bridge on `127.0.0.1` that accepts only a random per-run token and forwards requests to DSH’s `ctx.llm.stream`. Models, provider, keys, account rotation and quota stay inside DSH — nothing to configure beyond optionally pinning `llm.provider` / `llm.model`. |
| `endpoint` | ocr talks straight to a static endpoint: `llm.baseUrl` + `llm.protocol` (`openai` / `anthropic`) + a key — `llm.apiKeyRef` names a DSH credential (recommended), or `llm.apiKey` holds a literal key in the config file. |

The plugin maps these onto the environment ocr understands: `OCR_LLM_URL`, `OCR_LLM_PROTOCOL`, `OCR_LLM_TOKEN`, `OCR_LLM_MODEL` (`config.env` can override or add more).

`ocr_status.bridge` shows the `dsh` bridge live: `url`, the masked `token`, `requests`, `failed`, `retries`, `retrySkips` + `retrySkipReason` (why a request was not retried automatically), cumulative `tokens` (prompt / completion / total), `lastError`, `lastProvider`, `lastModel`, `inflight` and `uptimeMs`. If the host has no `llm` service, the plugin still works and the `dsh` route falls back to the static endpoint.

## Usage

### Tool `ocr_review`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `scope` | `workspace` \| `range` \| `commit` \| `scan` | `workspace` (default) = uncommitted changes, equivalent to `ocr review`; `range` uses `from`/`to`; `commit` uses `commit`; `scan` scans `paths` and needs no diff. |
| `from` / `to` | string | Start / end ref of `scope = range`, e.g. `main`, `feature-x` (`to` omitted = up to the working tree). |
| `commit` | string | Commit hash or tag for `scope = commit`. |
| `paths` | string[] | Files/directories to scan for `scope = scan`; also filters the `git diff` in `delegate` mode. |
| `engine` | `auto` \| `ocr` \| `delegate` | Defaults to the configured `engine`. `auto` = try ocr, fall back to delegate when ocr has no LLM. |
| `reviewer` | boolean | `true` = force the independent reviewer subagent (fails with `OCR_REVIEWER_UNAVAILABLE` instead of falling back); `false` = force `ocr`/`delegate`; omitted = follow `reviewer.agent`. |
| `preview` | boolean | Only list the files that would be reviewed and the exclusions; no LLM call (like `ocr review -p`). |
| `effort` | `low` \| `medium` \| `high` | Review effort preset (ocr’s `--effort`). |
| `model` / `provider` | string | Override the model / provider for this run. |
| `exclude` | string[] | gitignore-style exclusion patterns (joined with commas for `--exclude`). |
| `rulePath` | string | Path to a custom system-rule JSON file (ocr’s `--rule`). |
| `timeoutMinutes` | number | Timeout for this run; defaults to the plugin config. |
| `repo` | string | Git repository root; defaults to the session working directory. |
| `includeDiff` | boolean | `delegate` mode only: embed the unified diff in the spec (default `true`). |
| `extraArgs` | string[] | Raw extra arguments for ocr (advanced). |

Unknown parameters are rejected (`additionalProperties: false`), so a typo fails loudly instead of silently doing nothing.

The result carries: `ok`, `code` (empty on success), `engine` (the one that actually ran: `ocr` / `delegate` / `agent`), `reviewer` (`provider`, `model`, `round`, `rounds`, `childId`, `stopReason`, `verdict` = `clean` / `issues` / `uncertain`), `scope`, `repository`, `command` (the ocr command line that ran), `exitCode`, `durationMs`, `reviewableFiles[]` (`path`, `status`, `insertions`, `deletions`), `excludedFiles[]`, `issues[]` (`file`, `line`, `severity`, `message`), `summary`, `reviewSpec` (the `delegate` payload), `configHint`, `notes[]`, `rawJson` (ocr’s stdout, up to 100 000 characters), `stderr`, `lostOutput`, `spillPath`, `llmMissing`, `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`, `requests` — accumulated through the bridge on the `dsh` route), `timedOut`, `aborted`.

### Tool `ocr_status`

Diagnostics for one call: resolved `executable` + `version`, `configPath` / `configSource` / `fileValues[]`, `installHint`, `settingsPage`, the effective `enabled` / `engine` / `auto` / `llmMode` / `llmRoute` / `llmEndpoint`, the bridge counters (above), `reviewer` availability (`providers[]`, `ready`, `error`), `credentialRef` / `credentialSource`, `ocrHomeConfig`, `llmEnv[]`, a minimal `llmTest`, and `notes[]`. Start here whenever a review fails.

### Command `/ocr-review`

Runs a review from the input box: it injects a follow-up instruction into the current session, which then calls `ocr_review` (default `scope = workspace`) and works through the findings one by one. It accepts optional free text after the command — extra requirements such as “only review changes under `src/`, focus on concurrency and error handling”. If the plugin is switched off (`enabled = false`), the command returns an error pointing at the settings page; `ocr_status` still works.

### Automatic review

Trigger: **the end of a turn** *and* that turn wrote at least one file. Before running, the plugin checks, in order:

- `enabled` is not `false` and `auto` (the settings-page `autoReview`) is not `off`;
- the session has had fewer than `autoMaxPerSession` automatic reviews (`0` = never);
- at least `autoMinReviewableFiles` files are reviewable in the chosen `autoScope`;
- at least `autoMinIntervalMs` has passed since the last automatic review in this session;
- with `autoSkipSubagents`, turns of subagents (`delegationDepth > 0`) are skipped.

The mode decides how the result arrives: `adaptive` injects while the model is still running and opens a new turn when it is idle, `inject` only injects into the current context, `followup` always opens a new turn. `autoScope` picks what is reviewed (`workspace` by default), `autoEngine` (file only) or `engine` picks the engine, and `autoIncludeDiff` controls whether the `delegate` fallback carries the unified diff. Failed automatic reviews are retried automatically, capped by `AUTO_RETRY_LIMIT = 2` in `lib/index.js`; after that the session is left alone until you ask again.

### Progress visibility

With `progress = true` (default) every review is registered as a background job named `ocr-review-N`: the Jobs panel (session title bar) shows a live progress line and the expandable ocr output, and a progress row above the input box can stop the run. Turning `progress` off hides all of it; reviews still run.

### Result codes (fail-closed)

`code` is a stable string on failure and empty on success. From `lib/review.js` (`CODES`):

| Code | Meaning |
| --- | --- |
| `OCR_INVALID_ARGS` | Invalid scope/ref combination, or a ref that starts with `-`, or whitespace/shell characters in `commit`. |
| `OCR_DISABLED` | `enabled = false`: the tool, the command and automatic review refuse to run. |
| `OCR_NOT_GIT_REPO` | The target is not a git repository (`workspace` / `range` / `commit` scopes). |
| `OCR_NOT_FOUND` | No `ocr` executable found; the result carries `installHint` and the list of paths tried. |
| `OCR_TIMEOUT` | The review exceeded `timeoutMinutes` (plugin-side hard timeout); `timedOut = true`. |
| `OCR_ABORTED` | The run was cancelled — tool call interrupted, stop button, or plugin unload. |
| `OCR_RUN_FAILED` | ocr exited non-zero, or the spawn itself failed. |
| `OCR_LLM_MISSING` | ocr has no LLM endpoint/key configured (`llmMissing = true`); with `engine = auto` the plugin falls back to `delegate`. |
| `OCR_OUTPUT_UNPARSABLE` | ocr’s stdout is not valid JSON. |
| `OCR_OUTPUT_SHAPE_UNKNOWN` | The JSON parsed but its shape is not one the plugin recognises: fail-closed — it never pretends “no issues”. |
| `OCR_DELEGATE_PREVIEW_FAILED` | The file list could not be obtained for the `delegate` payload. |
| `OCR_DELEGATE_RULE_UNPARSABLE` | The rules ocr emitted could not be parsed. |
| `OCR_REVIEWER_UNAVAILABLE` | The reviewer subagent could not start (e.g. a wrong provider name; the error lists the available ones). `reviewer = false` does not fall back. |
| `OCR_REVIEWER_FAILED` | The reviewer subagent run failed. |
| `OCR_REVIEWER_UNCERTAIN` | The round limit was reached while findings were still unconfirmed. |

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `ocr` not found / `OCR_NOT_FOUND` | Run `ocr_status`: it prints the resolved executable (or none), the version, and platform-specific install steps. On Windows do **not** point `ocrPath` at a `.cmd`/`.bat`/`.ps1` shim — the host spawns without `cmd.exe` and fails with `EINVAL`; use the real `.exe`. |
| `check your LLM configuration and API key` | That is ocr’s generic message. Read `notes[]` for the real cause (including 「未自动重试 N 次」 and its reason) and `ocr_status.bridge` (`lastError`, `failed`, `retrySkips`, `retrySkipReason`). If the host has no `llm` service, configure `llm.mode = endpoint`, or review with `engine: "delegate"`. |
| A long review is cut off upstream | Pin a fixed `llm.model` (a stable, long-context model), narrow the range (`paths`, `exclude`, `commit` scope) or raise `timeoutMinutes` (the file layer’s `maxTimeoutMinutes` goes up to 24 h). ocr’s stdout kept in `rawJson` is capped at 100 000 characters — `lostOutput` / `spillPath` tell you when output was dropped. |
| `OCR_INVALID_ARGS` | `from` / `to` / `commit` must not start with `-` (that would look like a flag), and `commit` must not contain whitespace or shell metacharacters. |
| `OCR_OUTPUT_SHAPE_UNKNOWN` | The plugin does not recognise this ocr output shape and fails closed on purpose rather than reporting “no issues”. Report `ocr_status.version` together with `rawJson`. |
| `OCR_REVIEWER_UNCERTAIN` | The round limit was reached with findings still open: raise `reviewer.rounds` (max 10) or review the leftovers manually. |
| A field seems ignored | `ocr_status` reports `configSource`, `configPath` and `fileValues`; precedence is settings page > config file > defaults, and only one config file is read (the first that exists). |
| The plugin is missing entirely (`ocr_review` becomes an unknown tool) | The host fiber failed to load — most often an unsupported JSON-Schema construct in a tool schema, or a `lib/*.js` edit without a host restart. Check the DSH log, then restart. |

## Hardening history

The v0.3.0 → v0.4.0 hardening work — per-version fixes, the reliability contract and the failure codes above — is recorded version by version in [CHANGELOG.md](CHANGELOG.md).

## Development & tests

Six dependency-free suites (`node test/<name>.mjs`), item counts as actually run:

| Suite | Items | Covers |
| --- | --- | --- |
| `node test/smoke.mjs` | 137 | Offline smoke: tool schemas, result codes, fail-closed shapes, cancellation, lifecycle, reviewer path, progress, config layering. |
| `node test/job-smoke.mjs` | 51 | Review progress: registration, progress line, output stream, stop → cancel, idempotent settlement. |
| `node test/reviewer-smoke.mjs` | 45 | Reviewer subagent logic: prompt, structured parsing, rounds, failure/timeout (aborts the in-flight child). |
| `node test/bridge-smoke.mjs` | 74 | The local bridge against a real ocr subprocess, including regressions for truncated upstream streams and client disconnects. |
| `node test/client-smoke.mjs` | 178 | Browser half with a mini React: settings form, card summary, in-session progress row. |
| `node test/cordis-inject.mjs` | 26 | Real-cordis regression across three host shapes (all services / remote.session missing / no remote). |

`node test/cordis-inject.mjs` exits **2 (skipped)** when `OCR_TEST_CORDIS` points at no cordis checkout — a skip is not a pass. There are no runtime dependencies, and the tests need no install either.

## Known limitations

- `ocr` must be installed separately; the plugin never installs or upgrades it.
- Windows script shims (`.cmd`/`.bat`/`.ps1`) cannot be spawned directly — use the native executable.
- `timeoutMinutes` in the settings page is capped at the factory value (60); larger values only via the file layer, up to the 24 h hard bound.
- `reviewer.persona`, `ocrCandidates`, `extraArgs`, `env`, `llm.apiKey`, `maxTimeoutMinutes` and the other `file only` keys have no settings-page row.

## License

MIT — see [LICENSE](LICENSE). Author: xinyangGL.
