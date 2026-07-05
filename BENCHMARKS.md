# Kairos SDK — Benchmark Methodology and Results

This is a record of how Kairos's reliability has actually been measured, including the parts that didn't go well. Every number here is pulled directly from a committed result file or a real commit in this repository — nothing is estimated or rounded up.

## Why this document exists

Most AI coding tools show you a demo. Very few publish their own failure analysis. This one does, on the theory that "we measured this rigorously, including where it broke, and fixed what we found" is a more credible claim than "it works" — and it's a genuinely different kind of evidence than a cherry-picked example.

## Methodology

`scripts/benchmark.ts` runs a fixed prompt suite through `Kairos.build()` in dry-run mode (generates and validates, never deploys) and measures structural validation pass rate — whether the generated workflow passes the [131-rule validator](README.md#validator-rules), not end-to-end runtime correctness. Three things make this more rigorous than a single pass/fail run:

- **`--repeat N`**: runs each selected prompt N times and reports a per-prompt pass rate instead of one outcome. LLM generation isn't fully deterministic — a single sample can't distinguish "this reliably works" from "this got lucky once." Added specifically because a benchmark result looked like a regression on a 3-sample re-check and turned out to need an 8-sample re-check to tell noise from a real signal (see below).
- **`--isolated`**: scopes telemetry/patterns to a temporary directory for the run. Without it, a benchmark run reads *and writes* the same global state that real usage also writes to — an earlier prompt's results in a long run can shift the system-prompt guidance injected into that same run's later prompts. Found this mattered directly: a `patterns.json` regenerated mid-way through an 8-run single-prompt test.
- **`--tier <name>`**: 94 prompts across 8 difficulty tiers (simple, medium, complex, edge, real-world, stress, additional, and a `backendApi` tier specifically testing CRUD/API-contract-shaped tasks — consistent response shapes, auth gating, pagination, idempotency, not just automation-style triggers).

## Result 1 — the original 20-prompt suite hit a ceiling

| Metric | Baseline (no library) | Current library (292 entries) | + 14 imported fixtures |
|---|---|---|---|
| First-try pass rate | 100% (20/20) | 100% (20/20) | 100% (20/20) |
| Avg attempts | 1.00 | 1.00 | 1.00 |
| Avg generation time | 21.0s | 20.7s | 20.6s |

Accumulated system-prompt improvements plus the validator's growth from 34 to 129 rules closed the gap this suite was originally built to measure — even the no-library baseline now passes every prompt first-try. That's a real result, but it also means this 20-prompt suite stopped discriminating anything. Full detail and the honest read on why: [README § Benchmark Results](README.md#benchmark-results).

## Result 2 — the 282-run backend-viability benchmark (94 prompts × `--repeat 3`)

Run specifically to answer a harder question than "does it pass once": can Kairos serve as a real application's backend, not just handle automation-style tasks, and does it pass *reliably*.

| | |
|---|---|
| Total runs | 282 |
| Passed | 270 (95.7%) |
| First-try pass rate (of all runs) | 94.7% |
| Needed correction | 3 runs (1.1%) |
| Avg generation time | 39.0s |
| Failures | 12 |

**The new `backendApi` tier — 9 prompts stressing consistent response contracts, lookup-by-ID with a not-found path, batch operations with per-item status, auth gating, pagination, and an idempotency-key pattern — passed 27/27 (100%), zero inconsistency.** At this complexity level, no special backend-mode prompt engineering was needed; the existing system transferred cleanly.

The 12 failures were concentrated in 6 prompts, all from the pre-existing "real-world"/"stress" tiers (5+ integration, multi-branch workflows):

| Prompt (truncated) | Pass rate |
|---|---|
| Invoice processing system | 0/3 |
| Multi-channel customer support router | 0/3 |
| Employee onboarding automation | 1/3 |
| Customer feedback loop | 1/3 |
| Form submission + blocklist | 2/3 |
| Automated content pipeline (RSS) | 2/3 |

Full raw data: [`backend-viability-results.json`](backend-viability-results.json).

## What this run found — three real bugs, not benchmark noise

Investigating those 12 failures (not just re-running until they passed) surfaced three distinct, root-caused reliability gaps, all fixed in this repository:

1. **`max_tokens: 8192`, hardcoded since the very first release, never once tuned.** Accounted for the majority of the failures — all on the largest, most complex prompts, which legitimately need more output budget. Raised to 16000, made configurable (`KAIROS_MAX_TOKENS`).
2. **The retry/correction loop only ever told Claude about ERROR-severity validation issues, never WARN-severity ones** — meaning most of the 129 rules never got a chance to be corrected during a retry, even when a build was already retrying for an unrelated real error. Fixed by widening what gets fed back on retry, without changing what counts as a passing build.
3. **A parse-failure class where large responses arrived with the workflow serialized as a JSON *string* instead of an object.** The error message said "missing workflow field" — actually misleading; an instrumented repro proved the field was present and the string contained complete, valid workflow JSON the whole time. Now recovered inline via a parse shim, retried with targeted feedback if the shim can't recover it, and — previously invisible — now fully telemetry-visible instead of failing instantly and silently.

A fourth finding, caught by the same discipline: after fix #1 raised token output, one prompt's pass rate appeared to *drop* (2/3 → 1/3 in a fresh 3-sample check). Before treating that as a regression, a quick calculation showed even a completely unchanged failure rate has a ~26% chance of producing that exact swing in 3 samples by pure chance. An 8-sample re-check confirmed it was real (2/8, well past the noise threshold) — which is exactly why `--repeat` exists: a single re-run either direction would have been the wrong answer.

## What this benchmark does not prove

Same caveat as the original suite: these results confirm generated workflows are **structurally valid and pass the validator** — they do not verify runtime execution correctness, credential configuration, or that the workflow's actual behavior matches what the description asked for. "Passes validation" and "does what you wanted" are different claims.

## Reproducing this yourself

```bash
# Full 94-prompt suite, once each
npm run benchmark -- --tier all --output results.json

# Real per-prompt reliability data (costs 3x the API calls)
npm run benchmark -- --tier all --repeat 3 --output results.json

# Isolated from your real ~/.kairos telemetry/patterns state
npm run benchmark -- --tier all --repeat 3 --isolated --output results.json

# Just the backend-API-shaped prompts
npm run benchmark -- --tier backendApi --repeat 3 --output results.json
```

Requires `ANTHROPIC_API_KEY` and `N8N_API_KEY`/`N8N_BASE_URL` (dry-run mode still needs a client but never deploys). Real API cost — a 282-run pass cost roughly $15 in Anthropic API spend.
