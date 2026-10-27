[English](README.md) · [中文](README.zh.md)

# Code Review (Alibaba OpenCodeReview) · DSH plugin

Run a real review of the changes you just made with [Alibaba OpenCodeReview](https://github.com/alibaba/open-code-review), and get the result back **as it is** — what was covered, which model answered, and why it failed.

- **No separate `ocr` install.** The binary ships with the plugin (Windows x64).
- **No API key to configure.** The review uses the model **your current conversation is already using**, forwarded through a loopback-only bridge inside DSH (your key never enters the `ocr` child process).
- **Verifiable conclusions.** Every review carries a coverage receipt: which hunks were included, which files were excluded, and which parts have no conclusion.

## 30-second start

1. Install (skip if already installed):
   ```bash
   dsh plugin --profile <your profile> add github:xinyangGL/dsh-open-code-review
   ```
2. After you change code, click **“启动代码审核”** at the end of the turn. Its sub-line states the cost first: `N files changed this turn · ocr tier: ~3–10 min/file, billed by tokens`.
3. Read the result. Other entry points:

| Entry | When |
| --- | --- |
| Turn-tail button | The common one; appears only when this turn changed code |
| `/ocr-review` | Trigger from the composer |
| Say “review this” in chat | The model calls it on demand |

## What you see

**Before it runs** — the button's sub-line states the files changed, rough duration, and whether it will be billed.

**While it runs** — there is **no progress bar and no stop button** (ocr emits no incremental progress); the tool-call row shows elapsed time. To stop, stop the turn (usage already incurred is not refunded).

**When it finishes** — six fixed layers, top to bottom:

1. **Conclusion** — success/failure and the number of findings; a dry run (`preview`) says plainly that it reached no conclusion.
2. **Coverage and cost** — `x/y hunks included`, excluded files, truncated parts.
3. **Findings** — `file:line [severity]`, severity `[high]/[medium]/[low]/[ungraded]` (unknown severities stay ungraded, never downgraded to low).
4. **Next step** — how to recover after a failure, or what else you can do after success.
5. **Provenance** — engine and route (model provider/model; whether it came from the current session or the DSH default).
6. **Appendix** — truncated output, raw JSON, spill paths. This layer always exists.

**On failure** — a result code, a next step, and what it cost. E.g. `OCR_LLM_MISSING`: no usable model route, **zero calls, zero cost**.

## Two engines

| Engine | Behaviour | Cost |
| --- | --- | --- |
| `ocr` (default) | Runs the full OCR pipeline (deterministic engineering × LLM agent pipeline) | Billed by tokens; 3–10 min/file; estimate given before it starts |
| `delegate` | No LLM call; produces a review spec in seconds (files + rules + diff) for the current model to audit | Free (uses the current conversation's model) |

Both engines resolve the `ocr` executable first: `delegate` needs it to produce the spec, `ocr` needs it to run the pipeline.

## Where the model comes from

The plugin opens a loopback-only bridge with a random token; `ocr`'s requests are forwarded to DSH's `llm.stream`:

1. A model selected in the settings page → use it;
2. Otherwise the model **the current conversation is using**;
3. Otherwise the DSH default model;
4. Otherwise `OCR_LLM_MISSING` (nothing runs, nothing is billed).

Provider and model are always taken as **one route**; they are never mixed across providers.

## Settings

The settings page exposes four fields: **enabled / default engine / on-demand review**, plus **model name / provider** under “Advanced”.

Model name, provider and the ocr path live in `config.json` (empty = automatic, see above). Changes apply immediately; no restart needed.

## Common failures

| Code | Meaning | What to do |
| --- | --- | --- |
| `OCR_NOT_FOUND` | `ocr` executable not found | It ships with the plugin; on other platforms provide one or set `ocrPath` |
| `OCR_LLM_MISSING` | No usable model route | Pick a model, or make sure DSH has a default; zero calls, zero cost |
| `OCR_NOT_GIT_REPO` | Not a git repository | `git init`, or run elsewhere |
| `OCR_TIMEOUT` | Killed by the timeout | Narrow the scope (`scope=commit`) or raise `timeoutMinutes` |
| `OCR_ABORTED` | Cancelled | Re-run; usage already incurred is not refunded |
| `OCR_ALREADY_RUNNING` | A review is already running | Wait for it (one at a time) |
| `OCR_INVALID_ARGS` | Unsupported argument combination | Follow the suggested usage in the message |

## Troubleshooting

- `ocr_status` in one shot: where `ocr` came from (bundled/local), the effective model route, whether event hooks are attached, and why the last review failed.
- No button? This turn changed no code. The only exception is when the host cannot report the change list — then the button is always shown (fail-open).
- Want faster feedback? Switch the engine to `delegate` in settings.

## Development

```bash
npm install     # also installs the platform ocr binary (~55MB, node_modules only, not committed)
npm test        # smoke / client-smoke / bridge-smoke / host-contract / killswitch / cordis-inject / pack check
```

- `npm run test:pack` asserts the published tarball contains only what it should.
- CI: `.github/workflows/ci.yml`, Node 20 / 22 / 24 × ubuntu / windows.

## Known limitations

- The bundled binary covers Windows x64 (a macOS arm64 package exists but is unverified).
- Real-machine acceptance was done on Windows x64 only (macOS / Linux unverified).
- No progress bar (ocr emits no incremental progress), so “how much longer” is a range.
- Reviews cover the **change set** (git diff); historical issues elsewhere in the repo are out of scope.
