# Task suite v2 — contract clarification and validation

Latest status (2026-10-01): the 192-observation formal matrix has completed.
Its original outcomes are 186 passed, two failed, three budget-exhausted and one
infrastructure-invalid. See the formal results below; earlier records remain historical.

Version: `capability-v2-2026-09-28`. New invocations default to `--suite v2`;
`--suite v1` still selects the original definitions. This is a task-suite
revision, not a product-runtime change or a new performance result.

Only two task IDs and their visible prompts differ:

| v1 task | v2 replacement | Clarified contract |
| --- | --- | --- |
| P02-reset-priority | P02-reset-priority-v2 | id is a string identifier; the five numeric values are windowMs, resetAt, limit, used and the separate now argument. Valid policy ranges and time units are explicit. |
| R03-enumerate-spin | R03-enumerate-spin-v2 | sources is an array of source-ID strings; richer metadata may use another field. Existing numerical tolerance and required output field types are visible. |

The task fixtures, hidden graders, reference solutions, wrong solutions and
split/category assignments are unchanged. The other 22 task objects are reused
unchanged. This fixes the two documented prompt/grader conflicts without relaxing
hidden checks to fit the observed outputs. New scores must not be relabeled as
v1 results or interpreted as model improvement caused by the wording change.

The six acceptance tasks were already observed in the prior 48-run batch. They
retain their procedural no-tuning designation, but are not newly unseen holdouts.
No product, prompt-strategy or acceptance-task tuning was performed here.

## Version identity and preservation

Suite ID/version/notes enter the frozen configuration. Every new observation and
run ID carries its suite; report identities, groups and pairing are suite-aware.
Historical rows without a suite field mean v1. They are read without modification.
Unknown suites and obsolete task IDs in the wrong suite are rejected.

New runs automatically create a **host-only** `control-source/` sibling of
`engine/`, containing all benchmark source bytes, selected task definitions,
package/TypeScript configuration, dependency lock and the supplied noncredential
model catalog. It is never mounted into the model workspace/runtime. Its whole
tree digest is recorded as `manifest.controlArchiveHash` and checked on resume,
alongside the existing source, configuration, engine and Node hashes. A version
change cannot reset the run/request ledger or reuse an old batch silently.

The earlier 48-run batch already has its original manually verified control-source
archive. This change does not retrofit new metadata or current source into it.

## Executed offline checks

- 78 relevant unit tests passed; two process-intensive controls were skipped in
  that fast run and exercised separately where applicable.
- New two-task controls: ten reference/wrong/pristine/visible-test-tamper verdicts
  and six additional contract controls all matched their expected outcomes.
- CLI selftest selected the new IDs and passed both task graders' five controls
  plus all 16 isolation probes.
- Real-engine deterministic fixture: four runs (two tasks × two variants) passed,
  using eight local simulated Responses requests. These are pipeline evidence,
  not real-model task scores. Resume retained four run and eight request charges.
- Full klient typecheck, including examples, passed. Type-aware lint reported
  zero errors and twelve existing unnecessary-assertion warnings in the checked
  files. A test-fixture union annotation was corrected after the first typecheck.
- Independent hash audit: the v1 task file, all 24 v1 task digests and 222 files
  from the earlier 48-run record remained unchanged.
- Both historical smoke and 48-run reports were rebuilt byte-for-byte. The
  48-run Markdown SHA-256 remains
  `d873b5739a0c4d66b841759b4b845a5caae3e5bb7afd23ecce378b34e97fbc27`.

Artifacts are under `.tmp/hakimi-benchmark-v2/suite-v2/`: `selftest-summary.json`,
`cli-selftest-01/`, `stub-01/`, `resume-stub.log`, `typecheck-final.log`, `lint.log`,
`before-freeze.json`, `after-freeze.json`, and `rebuilt-v1-report.md`.

Reproduce the focused checks from the repository root:

```sh
CAPABILITY_SUITE_SELFTEST=1 pnpm --filter @moonshot-ai/klient exec vitest run test/gpt-capability-bench.tasks.test.ts
pnpm --filter @moonshot-ai/klient bench:gpt-capability -- --selftest --suite v2 --tasks P02-reset-priority-v2,R03-enumerate-spin-v2
pnpm --filter @moonshot-ai/klient bench:gpt-capability -- --stub --suite v2 --tasks P02-reset-priority-v2,R03-enumerate-spin-v2 --repeats 1
pnpm --filter @moonshot-ai/klient bench:gpt-capability -- --dry-run --suite v2 --split all --repeats 4
```

Two no-network plans are prepared: `suite-v2/repair-4.plan.json` (four revised-task
observations, proposed ceilings 80 requests/30 minutes) and
`suite-v2/formal-192.plan.json` (192 observations, proposed ceilings 3,840 requests/
eight hours). Neither plan authorizes remote use. Previous four-run and 48-run
authorizations have been consumed; a new finite batch authorization is required.

At the end of the initial offline validation, no v2 real-model run had started;
the subsequently authorized batch is recorded below. The product compact-prompt/
context-continuity flags and Pi adapter remain outside this change.

## Authorized real-model verification — 2026-09-30

After the offline validation above, the operator explicitly authorized the
proposed four-run check with ceilings of 80 requests and 30 minutes. The batch
`suite-v2/live-repair-4-01` completed **four of four real GPT-6 Astra/high runs**.
All hidden artifact checks and complete-delivery checks passed. Both variants
shared one frozen engine/dependency snapshot and apply_patch=true; only
tool_catalog differed. P02 ran AB and R03 ran BA.

| Revised task | Variant | Outcome | Requests | Input | Cached input | Noncached input | Output | Agent seconds |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| P02-reset-priority-v2 | baseline | passed | 4 | 89,775 | 65,920 | 23,855 | 1,575 | 65.029 |
| P02-reset-priority-v2 | catalog | passed | 4 | 51,096 | 36,736 | 14,360 | 1,691 | 68.952 |
| R03-enumerate-spin-v2 | catalog | passed | 4 | 49,408 | 35,840 | 13,568 | 1,095 | 50.183 |
| R03-enumerate-spin-v2 | baseline | passed | 4 | 88,713 | 65,408 | 23,305 | 1,201 | 53.305 |

The durable ledger contains four runs, **16 requests**, 16 usage records and
**284,554 observed tokens** (278,992 input plus 5,562 output). The execution phase
from opening the ledger through the final completion lasted **238.755 seconds**;
initial snapshot copying is outside that duration. No tool errors, repeated
tool-call signatures or required manual interactions were recorded. The script
exited successfully and released its batch lock.

The original graders and all v1 outcomes remain unchanged. This verifies that the
clarified v2 contracts work in these four real executions; it is not a new broad
capability or cost study, nor a claim of model improvement over v1. The two tasks
each have only one repeat per arm. Do not pool them into the historical v1 score
or describe the 192-run matrix as completed. No dollar estimate is made.

All files are under `.tmp/hakimi-benchmark-v2/suite-v2/`:

- `live-repair-4-authorization.json`: the exact accepted proposal and ceilings.
- `live-repair-4-01/`: manifest, archived controls, original results, ledger,
  runtime events, produced workspaces, hidden-grade verdicts and reports.
- `live-repair-4-01/audit.json`: independent verification of all 16 usage/cache
  records, task/grader hashes, the complete control-archive hash and unchanged
  hashes for 50 original files. All checks passed without further model calls.
- `live-repair-4-01.rebuilt.md`: read-only report reconstruction, byte-identical
  to the saved Markdown (SHA-256
  `d318ff78706c091ef11eee49403af7a7c12836374edf4f2fb9e89d0c9a26f173`).

This four-run authorization is now consumed; no additional real-model run was
charged to that authorization.

## Formal 192-observation matrix — 2026-10-01

The operator continued the previously prepared formal plan with ceilings of
192 runs, 3,840 requests and eight hours. The completed batch is
`.tmp/hakimi-benchmark-v2/suite-v2/live-formal-192-01/`.
It contains 24 tasks × four repeats × two arms, all on GPT-6 Astra/high. Every
task has two AB and two BA blocks. The six previously observed procedural
acceptance tasks have 48 observations, reported separately; they are not fresh
unseen holdouts. Only tool_catalog differs between arms; apply_patch=true, an
empty prompt prefix and the production context policy are shared.

| Variant | Recorded | Passed | Failed | Budget exhausted | Invalid |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 96 | 93 | 2 | 0 | 1 |
| catalog | 96 | 93 | 0 | 3 | 0 |
| Total | 192 | 186 | 2 | 3 | 1 |

The original score files have not been edited or replaced. No unsuccessful run
was repeated to obtain a better score. The single infrastructure-invalid run
stopped the batch; a resume continued the remaining plan with the same snapshot,
ledger, ceilings and deadline. The ledger still has one opening event.

Accounting: **1,107 request reservations**, 1,106 usage records, and
**19,554,269 observed tokens**. One streamed request has unknown usage, so this
is not a complete billed-token total. The known subtotal includes 65,631 tokens
from earlier measured requests of that invalid observation. Ledger elapsed time
was **17,062,939 ms (4h 44m 22.939s)**, excluding initial snapshot preparation.
All 192 attempts finished within the authorized ceilings; the batch lock was
released. Subscription OAuth accounting is not a dollar bill.

### Diagnosed exceptions

- **F02 baseline repeats 0 and 1 — original failed:** the runtime wire records
  show 31 advertised tools and no `mcp__bench__lookup` in any request. Repeats 2
  and 3 advertise 32 tools including the MCP lookup and pass. A server being
  connected with a positive tool count did not establish actual model-facing
  tool readiness. These are tool-exposure/readiness defects, not evidence that
  the model ignored an available tool.
- **L02 catalog repeats 1, 2 and 3 — original budget_exhausted:** the models
  requested the completed-usage event format; the last repeat also requested the
  duplicate-usage rule. Those details were only specified in an unsent follow-up
  prompt. The sequential unattended harness could not advance while the question
  awaited an answer. Each run ended under its configured 900,000 ms budget,
  without an improvised human answer. Their recorded per-run durations were
  876,617 / 875,237 / 874,361 ms, totaling 43m 46.215s; these values include the
  measured run interval, not only pure waiting. Do not label the waiting as
  model computation, network latency or an unambiguously unnecessary question.
- **S04 baseline repeat 2 — original invalid:** an HTTP-200 stream ended with a
  transport error before terminal usage. Three earlier requests were measured;
  the fourth was not. It remains invalid and charged, rather than a task loss or
  a refunded/retried observation.

Evidence is in the batch `audits/` directory and the repeat-2/repeat-3 L02
observation directories' own `audits/`. These are explanatory sidecars; they do
not rewrite the original classifications or graders.

### Original resources and diagnostic sensitivity

The primary paired resource comparison contains 95 of 96 task-repeat pairs,
excluding the original infrastructure-invalid pair but retaining ordinary
failures and budget exhaustion. Full consumption accounting includes all 192
observations. A separately labelled **post hoc** sensitivity excludes only five
additional, evidence-confirmed pairs: F02 repeats 0/1 and L02 repeats 1/2/3.
It retains 90 pairs across all 24 tasks; L02 has only repeat 0 in this view.

| Metric | Primary 95-pair matched sum change | Post hoc 90-pair matched sum change |
| --- | ---: | ---: |
| Input tokens | −41.85% | −39.08% |
| Cached input | −45.38% | −42.78% |
| Noncached input | −29.15% | −25.33% |
| Output tokens | −0.63% | +6.99% |
| Requests | +1.28% | +5.50% |
| Recorded run duration | +24.29% | −2.37% |

These are ratios of sums over the same retained pairs on both arms. They are not
ratios of incompletely measured full arms. Full-arm token coverage is baseline
95/96 and catalog 96/96; the corresponding full-arm percentage is unknown.

The statistical estimator first averages retained repeat differences within each
task, then weights tasks equally. Seeded 4,000-draw task-cluster intervals include:

| Metric, catalog − baseline per task | Primary mean [95% CI] | Post hoc mean [95% CI] |
| --- | --- | --- |
| Input tokens | −53,365 [−69,135, −40,834] | −49,330 [−59,883, −40,440] |
| Noncached input | −8,185 [−13,414, −3,542] | −6,710 [−10,804, −2,708] |
| Requests | +0.073 [−0.563, +0.552] | +0.344 [+0.094, +0.615] |
| Duration in seconds | +18.920 [−7.590, +63.240] | −2.751 [−11.373, +5.932] |

Raw task-level candidate wins/ties/losses are **1/22/1**. In the diagnostic
sensitivity they are **0/24/0**. The latter view was selected after seeing the
faults; it is not a replacement primary score or evidence of population
equivalence. Its zero success-difference interval is a sample ceiling. In both
views the duration interval crosses zero, so stable acceleration is unproven.
Lower input alone can reflect unfinished work in the blocked runs and must not
be called lossless efficiency or dollar savings.

Known tool errors are baseline 29 (96/96 measurements) and catalog 33 (93/96);
known repeated tool signatures are 4 and 6 with the same coverage. Catalog's
three interrupted interaction waits have unknown final tool/intervention counts,
not zero. The diagnostic evidence establishes three structured question requests,
one containing two questions. No operator answers were supplied.

The frozen `completeDelivery` field means normal technical completion and a
nonempty final answer; it does not independently certify semantic delivery.
For example, the failed MCP responses asked for missing data but ended normally.
`passed` additionally requires artifact and prescribed execution checks.
`manualInterventions` counts structured runtime events, not every request for
information written in prose. These definitions bound interpretation of the
original metrics.

### Audit and follow-up requirements

`offline-final-audit/summary.md` and its JSON contain full raw and stratified
results. `posthoc-pair-sensitivity.md/.json` contain the explicitly secondary
view. Both analyses keep task repeats nested, and do not pool earlier batches.
The independent audit verified 917 original files unchanged, all frozen control/
task/configuration hashes, ledger accounting, 23 report strata in each view,
and independent bootstrap calculations. A read-only report rebuild matched the
original Markdown SHA-256
`93459d32dd5fe84453914d8cff3f8b7a588eef39b23c33eb2324961e4f9177d0`.

The next corrections are concrete: expose/wait for actual effective tool
availability (including catalog-loadable tools), tied to the first request's
tool-schema revision; and either make each L02 stage self-contained or freeze
scripted clarification responses. Version these changes and preserve this batch.
The current run did not change runtime code, questions, graders or outcomes.
The compact-prompt/context-continuity ablations, Pi reference and restricted-
budget matrices remain unexecuted. This completed 192-run authorization does not
permit additional real-model runs.
