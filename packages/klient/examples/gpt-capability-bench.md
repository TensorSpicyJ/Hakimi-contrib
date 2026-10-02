# Hakimi capability benchmark v2

This is a separate, reproducible evaluation of input reduction and retained functionality. It reuses the existing sandbox, production-engine adapter patterns and hidden-grader infrastructure. It does not replace or retune the frozen adaptation/harness tasks or their historical results.

See [task suite v2 validation](gpt-capability-bench.suite-v2.md) for the versioned P02/R03 contract clarifications, offline checks, and preservation of v1 results.

New work uses task suite v3 to clarify L02's staged contract. See the [v3 validation and real-model results](gpt-capability-bench.suite-v3.md) for the completed local checks, 8/8 live passes and remaining limits. The suite revision itself neither repairs nor certifies the production MCP registration/readiness behavior. MCP exposure checks in this benchmark are measurement safeguards whose evidence must be recorded separately; their presence is not proof that the underlying runtime race is resolved.

The same record now includes the completed **192-observation formal v2 matrix** (2026-10-01): original scores and all consumption are retained, with separate diagnostics for MCP tool exposure, staged-schema clarification waits and a transport interruption. Its post hoc sensitivity view is not a replacement primary score or proof of lossless efficiency.

The [first validation record](gpt-capability-bench.validation.md) lists executed offline checks and the explicitly authorized four-run real-model smoke, including its limits and retained failures.

The subsequent [48-run real-model coverage](gpt-capability-bench.coverage-2026-09-27.md) covers all 24 tasks and records two prompt/grader contract defects, one transport-invalid observation, complete resource accounting, and a separately labelled post hoc quality sensitivity analysis. Preserve its original results; version the defective tasks before further formal repeats.

The primary contrast is GPT-6 Astra at `high`, the same frozen engine and dependency snapshot, and `apply_patch` enabled in both variants. `baseline` disables `tool_catalog`; `catalog` enables it. Model, effort, task, repeat, budget and other settings must match within each pair. The eight earlier tool-catalog observations from two synthetic tasks are preliminary diagnostics, not evidence of broad capability improvement or a halved bill.

## Corpus and evaluation policy

The corpus targets 24 independent tasks, four in each category: simple operations, project development, rich features, long tasks, research, and recovery/constraints. Project tasks use fixed, reduced reproductions of real implementation problems; they are not representative samples of all software engineering. Research tasks use fixed local sources and deterministic numerical or citation checks. An explicit tool protocol probe tests that requested feature; a natural-discovery task gives the goal without naming the tool. They must remain distinguishable in task metadata and interpretation.

Each task specifies the initial workspace, prompts and follow-ups, hidden acceptance checks, a reference solution, and controls. A visible test reporting success is insufficient. Hidden checks are staged only for grading, outside the model's workspace during execution; positive, wrong-output and visible-test-tampering controls exercise the grader independently. Feature probes also require execution evidence, rather than a model statement that a tool ran. Tool-call errors and synthetic results are distinct evidence.

Development tasks are the default. Acceptance tasks are held out by process: do not tune prompts or implementations against their outcomes, and do not silently move them into development. Authors can see the task and grader source, so this is not a secret external benchmark. Freeze tasks, graders, configuration and code hashes before a paid batch; keep unsuccessful and invalid runs in the archive. Changed questions require a new corpus/run identity and do not retroactively change old scores.

## Task-suite versions and historical results

The framework name “benchmark v2” is distinct from the task-suite version. New invocations select `--suite v3` by default. `--suite v1` and `--suite v2` select their historical task corpora. The selection API is `getSuite('v1' | 'v2' | 'v3')` in `gpt-capability-bench.suites.ts`, returning `{id, version, tasks, notes}`. Newly planned observations always carry an explicit `suite`, and new run ids carry the corresponding `v1-`, `v2-` or `v3-` prefix. Historical observations without a suite field are interpreted as v1 without adding fields to the stored files.

Suite v2 (`capability-v2-2026-09-28`) changes only two task identities and their visible prompts:

| Original v1 task | New v2 task | Clarified visible contract |
| --- | --- | --- |
| `P02-reset-priority` | `P02-reset-priority-v2` | `id` is a string identifier; validate the four numeric row fields plus the separate `now` argument. Name the timestamp/duration distinction and valid policy domain. |
| `R03-enumerate-spin` | `R03-enumerate-spin-v2` | Expose the required `sources` array of bare source-ID strings and the existing numerical tolerance. Richer citation metadata may be placed in other fields. |

The remaining 22 task objects, all workspace fixtures, hidden graders, reference/wrong solutions, provenance, category/discovery assignments and development/acceptance assignments remain unchanged. The hidden acceptance criteria have not been relaxed. This is a contract clarification motivated by observed benchmark defects, not evidence that the model improved. A v2 result must never replace a v1 failure or be pooled with v1 scores.

Suite v3 (`capability-v3-2026-10-01`) starts from v2 and changes only `L02-durable-budget` to `L02-durable-budget-v3`, with clarified first and second prompts. Stage 1 is explicitly start-only: count distinct `{type:"start",id}` reservations, return `tokens: 0`, and list all distinct started IDs in first-start order. Usage/completion events are deferred to the next user turn and are unnecessary to finish stage 1. Stage 2 supplies the full ordered `{type:"usage",id,input,output}` contract: nonnegative safe-integer counts, no usage before its start, invalid usage leaves the request pending, and only the first valid completion counts. Replayed starts neither refund reservations nor reopen completed requests. The original third prompt, including its journal-artifact requirement, is delivered only at its original later turn.

All L02 fixtures, hidden grader, reference/wrong solutions, lifecycle settings and category/split remain unchanged; the other 23 v3 tasks are the same v2 task objects. The v1 and v2 task definitions and results remain frozen. The v3 contract clarification follows observed unanswered schema requests and is not an improvement score, an independent holdout, or permission to overwrite those original waits and budget-aborted observations. New measurement safeguards and any future runtime changes require their own frozen source/engine identities even when a historical task suite is selected.

The completed `live-coverage-48-01` batch belongs to v1: 24 tasks, one repeat per arm, 48 observations. It retains 43 original `passed`, four `failed` (P02/R03 in both arms), and one `invalid` (L01 baseline transport failure). The P02/R03 errata and post hoc sensitivity reports are separate artifacts; they do not rewrite any original task, result or evidence. This batch is not the planned 192-observation, four-repeat matrix.

All six acceptance tasks were observed in that v1 coverage batch and subsequent v2 evaluation; they remain unchanged in v3. Their `acceptance` label remains useful for reporting and provenance, but they are **not a fresh, unseen holdout**. Do not use their outcomes to tune product behavior, prompts or task content while continuing to call them held out. A subsequent tuning study needs separately frozen, genuinely unseen acceptance tasks. Versioned contract fixes and author-visible fixtures cannot establish contamination-free evaluation.

New live work, including corrected v3 tasks, requires a separate explicit finite authorization. Previously consumed v1/v2 run limits do not carry permission to v3, and changing suites does not reset an existing ledger. Selecting a historical suite does not bypass source/configuration/snapshot checks on `--resume`; a changed source hash still refuses resume. `--report <run-dir>` reads the saved manifest and observations, infers legacy v1 where necessary, and prints the reconstruction without model calls or writes to the old run directory. Implementing v3 and running offline controls does not authorize or constitute another 192-observation real-model batch.

New executable batches also create a host-only `control-source/` archive outside `engine/` and all task workspaces. The manifest's `controlArchive` points to its `index.json`. The archive retains every source file participating in `sourceHash`, the complete selected tasks in `selected-suite.json`, the dependency lock and the noncredential frozen model catalog when supplied. It contains graders/reference answers and must never be exposed to the model. This records the actual controls needed to audit a future batch even when the working checkout changes; it does not retrofit archives or relabel old runs.

## v3 MCP fixture and request measurement safeguards

The new guard applies only to `F02-mcp-calibration` when the selected suite is v3. F02 starts a fresh session, has exactly one prompt and no scheduled compaction; the runner asserts that contract. The adapter passes the existing local `bench` fixture configuration through the public `sessions.create({mcpServers})` input. The overlay is read from the same host-prepared fixture configuration, so it does not introduce a different calibration source. This avoids relying on the initial workspace MCP baseline capture for the fixture; it does not modify the product runtime or establish that its underlying race has been fixed. F02 does not restore a session, so this evaluation makes no claim about MCP readiness after restoration. The adapter still records server connection status, explicitly as connection-only evidence.

The host proxy's `validateRequest` hook uses `createMcpReadinessCheck` to inspect **the first actual provider request of the fresh F02 main session**, before reserving request quota, reading authentication or fetching upstream. Under this single-turn initial-session contract, that request precedes any tool-driven delegation. A baseline request must expose a valid `mcp__bench__lookup` schema. A catalog request may expose that same valid schema, or a valid `select_tools` schema plus a complete runtime loadable-tool reminder history that currently lists the exact MCP name. `inspectMcpRequest` processes removals and additions in order; a removed entry, malformed schema, incomplete history, arbitrary prose mention or assistant/tool-output claim is not readiness evidence. The initial check has no empty-tool/compaction exemption.

The first decision is latched. After a successful initial check, later requests proceed through the normal model/effort/quota checks without repeating the main agent's MCP-schema requirement: a legitimately restricted child such as `Agent(explore)` may have no MCP tools. After a failed initial check, every later attempt remains rejected even if its body changes; retrying cannot bypass the failure. This establishes initial main-request exposure only. Final task success still requires the scorer's real, successful MCP call and calibration-result evidence in addition to the artifact checks.

An unready initial request and any attempt after its latched failure receive HTTP 503 locally and increment `requestValidationFailures`; they are never sent upstream. A nonzero count independently takes precedence in run classification: the observation is `invalid`, is retained, and stops the batch without automatically rerunning that observation. Its run reservation and already consumed batch requests remain charged. This distinguishes measurement/setup failure from a model failure to discover a genuinely exposed tool. `evidence.json` stores the initial `mcpReadiness` inspection as tool names, hashes, readiness reasons and catalog add/remove evidence, without credentials or raw prompt text.

`manifest.config.mcpReadinessPolicy` version 1 binds the fixture overlay and required tool with `check: "initial-main-request-before-quota-and-auth"` and `failure: "latched-invalid-stop-no-automatic-retry"`. v1/v2 leave this optional policy and measurement field absent, preserving their historical JSON layout and original observations. Selecting a historical suite does not waive the frozen-source checks or recreate an old runtime from the current checkout.

## Offline commands

Run inside the Hakimi repository on Linux with the repository's supported Node and pnpm versions. The real-engine sandbox additionally requires its existing `bwrap`, `socat`, `rg`, namespace and filesystem prerequisites. Temporary output belongs in `.tmp/hakimi-benchmark-v2/`.

```sh
# Default: plan only. No remote model call or credential read.
pnpm --filter @moonshot-ai/klient bench:gpt-capability -- --dry-run --suite v3

# Hidden-grader reference/wrong/tampering controls; no model calls.
pnpm --filter @moonshot-ai/klient bench:gpt-capability -- --selftest --suite v3 --split all

# Inspect the legacy task selection without executing or rewriting old results.
pnpm --filter @moonshot-ai/klient bench:gpt-capability -- --dry-run --suite v1
pnpm --filter @moonshot-ai/klient bench:gpt-capability -- --dry-run --suite v2

# Deterministic local model fixture through the real engine/tools.
# Feature requirements can fail: a scripted fixture is not a model capability score.
pnpm --filter @moonshot-ai/klient bench:gpt-capability -- \
  --stub --smoke --out "$PWD/.tmp/hakimi-benchmark-v2/stub-smoke"

# Complete matrix plan, not authorization to execute it: 24 × 4 × 2 = 192 rows.
pnpm --filter @moonshot-ai/klient bench:gpt-capability -- \
  --dry-run --split all --repeats 4 --seed 20260927 \
  --profiles generous --out "$PWD/.tmp/hakimi-benchmark-v2/matrix-plan"

# Include the two restricted budgets as separate experiments (576 rows total).
pnpm --filter @moonshot-ai/klient bench:gpt-capability -- \
  --dry-run --split all --repeats 4 --profiles generous,balanced,tight

# Rebuild a report from retained artifacts.
pnpm --filter @moonshot-ai/klient bench:gpt-capability -- \
  --report "$PWD/.tmp/hakimi-benchmark-v2/stub-smoke"

# Fast report-only offline controls.
pnpm --filter @moonshot-ai/klient exec vitest run test/gpt-capability-bench.report.test.ts
```

These examples use `$PWD` from the repository-root shell so pnpm's package working directory cannot redirect the output path. Dry-run prints its plan to stdout without writing the `--out` directory. `--tasks` accepts comma-separated task ids. `--split` is `development`, `acceptance`, or `all`. `--smoke` selects a small simple/features sample and forces one repeat; the default two variants yield four rows. The seeded ordering keeps same-task comparisons adjacent and rotates variant order over repeats. A repeat is a new isolated session, while the turns of a long task resume that task's own session.

## Budgets and live execution

The initial per-observation profiles are defined in `gpt-capability-bench.config.ts`:

| Profile | Requests | Observed input + output tokens | Wall-clock timeout |
| --- | ---: | ---: | ---: |
| generous | 60 | 1,200,000 | 15 minutes |
| balanced | 24 | 300,000 | 8 minutes |
| tight | 8 | 80,000 | 3 minutes |

These are finite ceilings, not predictions of use or guarantees that every task will finish. Wall time and requests are independent controls. Token usage is available after a response, so the observed-token ceiling can be crossed by the final in-flight response. Cached input is part of input, not extra tokens. The benchmark does not use cumulative input tokens as its only efficiency measure.

A live batch requires all three explicit batch controls: `--batch-max-runs`, `--batch-max-requests`, and `--batch-timeout-ms`. `--batch-max-observed-tokens` can tighten the derived total-token ceiling. A task request or a dry-run plan is not authorization to spend on a formal matrix. First review the concrete plan and agree a finite batch ceiling with the operator. The program enforces the ceiling; it cannot establish consent on the operator's behalf.

The following is a **bounded invocation template**, not an executed or authorized run: four tight-profile smoke observations, at most 32 requests, 30 minutes of batch time and 320,000 observed tokens. Substitute the host-only authentication path and frozen model-catalog path only after the batch is authorized. Do not print credential contents or mount them into the task sandbox.

```sh
pnpm --filter @moonshot-ai/klient bench:gpt-capability -- \
  --live --smoke --profiles tight \
  --batch-max-runs 4 --batch-max-requests 32 \
  --batch-timeout-ms 1800000 --batch-max-observed-tokens 320000 \
  --auth-file /host/path/to/auth.json \
  --model-catalog /host/path/to/frozen-model-catalog.json \
  --out "$PWD/.tmp/hakimi-benchmark-v2/authorized-smoke"
```

The batch ledger is append-only and durable before request dispatch. Reservations, including interrupted requests, cannot be refunded by restarting. `--resume` must reuse the same frozen configuration and overall ledger; the batch deadline continues from its initial start. Recovery validates event sequence, run/request/usage lifecycle and nonnegative usage. A missing, truncated or inconsistent ledger fails closed instead of creating a new budget. Do not delete or regenerate the ledger to make recovery pass; preserve the original artifacts for diagnosis.

The batch lock excludes concurrent writers. A pre-existing lock, including a stale lock left by a terminated process, stops execution; it is not automatically removed. Verify the recorded owner has stopped, preserve the stale lock under a different name, and then explicitly resume. Resume also checks the engine/dependency-tree digest, benchmark source/configuration and model-catalog hashes, Node version and Node binary hash. OS binaries remain shared and are a reproducibility limitation. Interrupted observations remain visible instead of being silently retried until they succeed. A new paid batch requires a new explicit finite authorization.

A 192-row generous plan has a theoretical per-row sum of 11,520 requests and 230.4 million observed tokens. Those sums are not a recommended authorization; use a much smaller capped smoke batch to validate infrastructure first. The chosen batch cap may be smaller than the planned matrix, in which case unexecuted rows must remain `not_run`.

## Independent ablations and adapter limits

`--variants /path/to/variants.json` freezes variant configuration. The default is:

```json
[
  { "id": "baseline", "adapter": "hakimi", "toolCatalog": false, "promptPrefix": "", "contextPolicy": "production" },
  { "id": "catalog", "adapter": "hakimi", "toolCatalog": true, "promptPrefix": "", "contextPolicy": "production" }
]
```

`promptPrefix` is an explicit user-prompt intervention, not a replacement system prompt. `contextPolicy: "compact-before-followup"` requests a compaction before resumed follow-ups through the available facade. Use separate variants for catalog-only, prompt-only, context-only and combined interventions; record each change instead of attributing a combination to the catalog. Unsupported variant fields and adapters are rejected, not labelled as implemented. Product `promptProfile` and `contextStrategy` remain `production` in the adapter.

Pi is an extension point; there is no runnable Pi adapter in this version. A future adapter must pin its actual version/configuration and declare task support before execution. Compare on common tasks. Missing built-in Skills/MCP/subagents/background functionality is `unsupported`, not a failed task or a baseline win. Do not pool Pi results with Hakimi A/B results without a named comparison and matching task scope.

## Report interpretation

The JSON report retains the entire source observation set, normalized observations and every planned row. Read-only `--report` merges committed per-observation results with the aggregate results and the existing ledger. A reserved run interrupted before writing a result becomes `invalid` with its charged request count; an unreserved plan row becomes `not_run`. This also recovers the crash window between writing a single observation and updating the aggregate file, without starting a model request. Duplicate ids within a suite remain present and are invalidated rather than selecting the better result. Duplicate resource rows can double count an execution, so the durable budget ledger remains authoritative for requests consumed.

Suite is part of observation identity, grouping and pairing. A combined report may contain v1, v2 and v3 in separately labelled groups, but never a cross-suite counterpart, pooled success rate or pooled resource statistic. Missing counterparts remain missing in their own suite even if another suite has the same task/repeat/id. Unknown suite names are rejected. Explicitly versioned reports display their suites; v1 and v2 JSON/Markdown layouts are preserved for historical reconstruction, including wholly unversioned v1 records. Source observations are not mutated. Independently of suite version, different engine snapshots must remain separate experiments.

| Outcome | Capability denominator | Paired comparison |
| --- | --- | --- |
| passed | included | included if counterpart is eligible |
| failed | included | included if counterpart is eligible |
| budget_exhausted | included | included if counterpart is eligible |
| invalid (infrastructure/measurement) | excluded and counted explicitly | excluded |
| not_run | excluded and counted explicitly | excluded |
| unsupported | excluded and counted explicitly | excluded |

Artifact correctness and technical completion are separate recorded verdicts. `artifactCorrect` comes from hidden artifact checks. The historical field `completeDelivery` means that the requested sequence ended with `reason: completed` and nonempty final text; it does **not** independently establish semantic task completeness. A final response requesting unavailable data can satisfy that field. Overall `passed` additionally requires artifact correctness, mandatory real-tool/feature checks and the normal validity/budget rules. Correct files can coexist with a budget-aborted run. Unknown verdicts have explicit denominator coverage; contradictory passed claims become invalid.

Reports separately expose duration, requests, total input, cached input, noncached input, output, actual tool errors, repeated attempts and required manual interventions. `manualInterventions` counts structured runtime interaction requests, deduplicated within each turn; it counts neither actual human replies nor requests written only in final-answer prose. Zero must not be described as no human input needed. The aggregate sums these per-turn counts, so the same request appearing after restoration may be counted again. Missing interaction measurements remain unknown. The unattended benchmark does not fabricate human answers. `repeatedAttempts` counts repeated tool-name/argument signatures within a turn, including legitimate repeated reads or polling; it is not limited to error retries.

A missing measurement is `null`, not zero. Cache and noncache input are unknown when cache-partition telemetry is absent, even if total input is known. Incomplete tool/event recording leaves aggregate tool errors, repeats and intervention counts unknown; partial event evidence is still retained. Resource totals include failures, invalid attempts and budget exhaustion, with measurement coverage. Paired resource comparisons include all eligible outcomes; they are not restricted to successful samples.

Within each suite, mode and budget, match observations by task and repeat. Compute candidate-minus-baseline differences per pair, then average those differences within a task. The reported mean weights each independent task equally. Wins/ties/losses refer to task-level mean success-rate differences, not individual repeats. A missing or invalid pair contributes neither a loss nor a tie. The report includes category, development/acceptance and their intersections; different suites, live/offline evidence and different engine snapshots do not share a score.

The 95% interval uses 4,000 deterministic percentile bootstrap draws over independent task means, with the saved seed. Fewer than two task clusters produce no interval; fewer than eight produce an instability note. Intervals are conditional on eligible observed pairs and do not correct for task selection, excluded pairs, author visibility or multiple comparisons. Four repeats of one task are still one task, not four independent demonstrations. Differences in token use alone do not establish capability parity or user cost savings.

Dollar estimates are `null` because this version has no verified pricing table. Subscription/OAuth token accounting is not a dollar bill. Never convert these token totals to billed cost without a separately frozen, reliable applicable price source.

## Evidence boundaries

The selftest validates graders and controls; the stub validates parts of the execution/reporting pipeline with scripted answers; dry-run validates planning. None measures a live model's capabilities. Engine smoke is distinct from a full 24-task live experiment. Reports must name the commands actually run, remaining interface limitations and unexecuted batches. No formal live matrix has been established merely by implementing this benchmark.
