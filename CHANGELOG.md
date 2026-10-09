# Changelog

All notable changes to **dsh-open-code-review**. Versions follow SemVer; the plugin is
distributed as a DSH bundle (`dsh plugin --profile <profile> add github:xinyangGL/dsh-open-code-review`).

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
  of crashing the suite mid-run. `test/smoke.mjs` is 161 assertions in both environments
  (with and without `@deepseek-ai/schemastery`, with and without `ocr` on `PATH`).

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
