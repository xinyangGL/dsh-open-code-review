# Changelog

All notable changes to **dsh-open-code-review**. Versions follow SemVer; the plugin is
distributed as a DSH bundle (`dsh plugin --profile <profile> add github:xinyangGL/dsh-open-code-review`).

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
