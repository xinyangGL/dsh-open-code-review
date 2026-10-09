# Changelog

All notable changes to **dsh-open-code-review**. Versions follow SemVer; the plugin is
distributed as a DSH bundle (`dsh plugin --profile <profile> add github:xinyangGL/dsh-open-code-review`).

## [0.4.0] — 2026-10-09

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
