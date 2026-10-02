# Task suite v3 — staged contract and initial MCP readiness

Status (2026-10-01): the authorized real-model batch
`suite-v3/live-repair-8-01` has completed: **8/8 passed**, 70 requests and
1,288,235 observed tokens in **15 minutes 6.116 seconds** from ledger opening
to the final completed observation. All 70 responses have usage records.
The earlier formal v2 matrix remains
192 observations: 186 passed, two failed, three budget-exhausted and one invalid.
Its original outcomes and post hoc analyses remain in the
[v2 record](gpt-capability-bench.suite-v2.md).

New invocations default to `--suite v3`, version
`capability-v3-2026-10-01`. Explicit v1/v2 selection remains available. Reports
never pair or pool observations across suites. Historical defaults described
in the archived v2 record apply to that earlier revision.

## Changes and limits

Only `L02-durable-budget-v3` replaces a task identity. Its first prompt defines
start-only reservations, zero tokens and all started IDs pending. The second
defines the full `{type:"usage",id,input,output}` contract, including ordered
eligibility, invalid usage and first-valid completion. The third prompt still
introduces the journal artifact requirement at the original time. Fixtures,
graders, reference/wrong implementations and lifecycle settings are unchanged;
the other 23 v2 task objects are reused unchanged. This is a correction after
observing a contract defect, not a new holdout or evidence of model improvement.

F02 keeps its original prompt and grading. In v3 only, the adapter passes the
same isolated-home MCP fixture through the existing public session overlay API,
which seeds the server name before the agent is created. Connection metadata
alone still cannot prove model-visible tool readiness.

The host therefore checks the first actual Responses body before reserving an
upstream request, reading authentication or dispatching network traffic:

- Baseline must expose the valid fixed `mcp__bench__lookup` function schema.
- Catalog must expose that schema, or a valid `select_tools` schema plus the
  exact MCP name in the current runtime catalog. Catalog announcements are
  folded in order; removals, malformed schemas and unsupported history fail.
- Failure latches rejection, records `invalid` and stops the batch without an
  automatic retry. The observation reservation remains charged; a rejected
  request does not consume an upstream ticket. Evidence retains tool names,
  hashes and fixed reasons, not request bodies or credential headers.
- Success releases later requests, which may belong to legitimate restricted
  subagents. Final scoring still requires a successful, nonsynthetic MCP call;
  an announcement or readiness proof alone cannot pass F02.

The frozen configuration records `mcpReadinessPolicy.version=1`,
`check=initial-main-request-before-quota-and-auth` and
`failure=latched-invalid-stop-no-automatic-retry`. F02 starts a fresh session,
has one prompt and no scheduled compaction. The initial-main inference was
verified with the default empty prompt prefix and frozen 272,000-token model
window; it is not general request-to-agent identification for arbitrary custom
prefixes or tiny context windows. The public facade has no effective-tool
readiness interface.

This change does not modify the product runtime or establish that its MCP
initialization race is fixed. A separate local restore probe observed a catalog
session advertising the MCP name while missing `select_tools`; the guard
rejected it. F02's fresh-session scope does not exercise that restore issue.
Its evidence and the source-based race explanation are preserved in
`.tmp/hakimi-benchmark-v2/suite-v3/mcp-readiness/summary.md` and
`restore-selector-gap.json` in that directory.

## Validation

- Six benchmark/proxy test files: **115 passed**, three gated controls skipped.
  The v3-specific gated run was executed separately: its five final scoring
  controls and seven stage controls all matched expectations.
- Full klient and examples TypeScript checks passed. Ordinary lint on the
  changed runner/config/proxy tests passed; focused type-aware checks passed
  on the runner, adapter, inspector and suite changes.
- Six local real-engine MCP cold starts passed: baseline/catalog, three
  startup timings each. Every run executed the actual fixture MCP tool.
- Full sandbox matrix `suite-v3/stub-repair-8-01`: **8/8 passed**, F02 and L02
  on two arms with two repeats. All four F02 observations have one successful
  initial readiness proof and an actual MCP success. All four L02 observations
  complete three turns with persistence/restoration. The 38 provider requests
  went only to local deterministic fixtures; their fabricated usage is not
  model-performance or paid-token evidence. L02's first two fixture responses
  are no-ops; stage implementation correctness is tested by the separate
  controls, while this matrix verifies prompt delivery, restore and final
  grading. Later prompts and hidden controls were absent from the mounted
  engine/workspace and were not released early.
- Preservation audit: v1/v2's 24 task hashes each and **1,264 historical file
  hashes** unchanged. Four historical batches' eight JSON/Markdown reports
  rebuild byte-for-byte. See `before-preservation.json` and
  `after-preservation.json` under the v3 scratch directory.

The sandbox run froze:

| Identity | SHA-256 |
| --- | --- |
| Engine and dependency snapshot | `097b395a6c29e1fc6ab5cf5d677da31d9e6404bda0b259eeff3600bcf4dd8ace` |
| Benchmark control source | `b79f32f708189e66fc07b98a5f5e69e40f4463c8bd5e720a8f031a5b916313cd` |
| Host-only control archive | `162d97b7035111c9db4edf77f33d0553da99acff3e643547adfce190c0d65e3d` |

## Authorized live batch

`suite-v3/live-repair-8-plan.json` is a dry-run plan for GPT-6 Astra/high,
F02 and L02-v3, two repeats on baseline/catalog. Its proposed batch caps are
**8 runs, 160 requests and 60 minutes**. Tokens are accounted after responses;
this is not a hard in-flight token cap. The user subsequently replied `授权`
to this concrete proposal. The authorization record is
`suite-v3/live-repair-8-authorization.json`; it does not carry over any previous
batch's allowance.

The normal `--live` runner ran with these exact task/repeat/cap settings,
the existing host-only auth file, the frozen model catalog and fresh output
directory `suite-v3/live-repair-8-01`. Its control/engine snapshot and all raw
outcomes are preserved separately from v2. The process exited 0 with empty
stderr, no remaining batch lock and no batch resume or automatic rerun.

## Real-model results

| Task | Baseline outcomes | Catalog outcomes | Baseline requests (r0/r1) | Catalog requests (r0/r1) |
| --- | --- | --- | --- | --- |
| F02 MCP calibration | 2/2 passed | 2/2 passed | 5 / 4 | 5 / 7 |
| L02-v3 durable budget | 2/2 passed | 2/2 passed | 12 / 12 | 12 / 13 |

All four F02 observations have exactly one successful initial readiness proof
and a real successful MCP lookup. Baseline exposes the schema; catalog exposes
the exact loadable name and selector. No readiness request was rejected. All
four L02 observations completed the three staged turns and same-session
restoration with zero structured manual interventions. The final artifacts and
required capability checks passed in every observation.

Four genuine tool errors remain in the raw evidence: an unavailable `python`
command in F02 catalog r1, a missing `journal.json` read in L02 baseline r0,
and a missing journal read plus an empty patch hunk in L02 catalog r1. The
models recovered and completed the tasks; these errors were not suppressed or
reclassified as setup failures.

Total observed usage is 1,274,059 input tokens and 14,176 output tokens. Of the
input, 979,968 tokens were cached and 294,091 were noncached. These are response
usage measurements, not dollar billing estimates. The batch used 8/8 authorized
observations and 70/160 authorized requests, within its 60-minute limit.

The live engine hash is
`3dd082ca3fef06f8dc9fdf8dc5ce3620c83d8575d753b5c8a56c00ea3c62e8bd`.
Source hash and control-archive hash equal the validated stub's hashes above.
The engine-tree difference is exactly one package-local Vitest result-cache
file containing six changed test-duration values; all product source, actual
dependency code and 5,496 symlink targets match. See
`suite-v3/engine-snapshot-diff-stub-live-repair-8-01.json`. Both live arms used
the same frozen live tree; no frozen file or hash was rewritten to hide the
cache difference.

This targeted batch supports the benchmark fixes for these two tasks under
the recorded configuration. It contains only two independent task clusters,
not eight independent tasks, and is neither a full-suite rerun nor evidence
that product-wide MCP startup/restoration is fixed. Resource differences are
descriptive small-sample observations. Preserve v2's original failures and
timeouts; do not merge or relabel these v3 successes as v2 outcomes.

The independent read-only audit is saved under the live batch's
`offline-final-audit/` directory (`summary.json`, `summary.md`, `integrity.json`
and rebuilt reports). It verified 88 original files unchanged and exact report
reconstruction, with no additional model requests or rerun of submitted code.

## Why catalog used four more model requests

The observed difference is 37 versus 33 requests. A model request can return
several tool calls together; counting tools or errors alone cannot explain it.
The provider request metrics were checked against the actual tool sequence.

| Paired observation | Baseline | Catalog | Observed sequence difference |
| --- | ---: | ---: | --- |
| F02 r0 | 5 | 5 | Catalog first loads the MCP tool, then groups MCP lookup and file reads into one model response; baseline separates lookup and input reading. The extra selection round is offset by this grouping. |
| F02 r1 | 4 | 7 | Catalog has an initial selection round, a separate existence check for calibrated.json, and a failed Python verification before switching to Node. |
| L02 r0 | 12 | 12 | Both use four requests in each of the three turns. |
| L02 r1 | 12 | 13 | Catalog's third turn needs five requests because an empty patch hunk is rejected, then a corrected patch succeeds. No select_tools call occurs in L02. |

F02 r1 baseline is `Read+lookup → Write → Read result → final`; catalog is
`select_tools → lookup+Read+Glob → Glob result → Write → failed Python check
→ Node check → final`. This directly accounts for the three-request gap.
L02 catalog r1's third turn is `parallel reads → failed patch → corrected
patch → tests → final`, while the other third turns have one successful patch
round. The missing-journal read shares a response with the other reads and
does not itself create the extra round; baseline r0 also has that read error
while retaining four requests for the turn.

Loading a deferred tool is part of the catalog mechanism. The file-check choice,
verification command and patch-format error are execution-path differences in
these samples, not demonstrated fixed overheads of catalog mode. Fewer input
tokens per request can coexist with more requests; this batch does not establish
a general request-count penalty or efficiency benefit.
