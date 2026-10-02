# klient Agent Guide

Package-local rules for `packages/klient`.

## Architecture

The package is layered; keep the layers strict when changing code:

- **Facade** (`src/core/facade/`, `src/core/klient.ts`) — the only public API:
  aggregated `global.*` / `session(id).*` / `session(id).agent(id).*` methods
  and their `events.*` hubs. No engine service tokens, no `onDid*`/`onWill*`
  names, and **no escape hatch to raw services** — do not reintroduce a
  service locator (`core()`/`service()`/`makeProxy`).
- **Contract** (`src/contract/`) — zod input/output schemas for every wire
  method plus event payload schemas. Schemas are hand-mirrored from
  agent-core-v2 types and pinned by the compile-time parity assertions in
  `test/contract-parity.ts`; when the engine types change, tsc fails here
  first. `maybe()`/`noResult()` in `src/contract/helpers.ts` encode the HTTP
  wire's `null`-vs-`undefined` semantics — use them for every
  `X | undefined` / `void` result.
- **Transports** (`src/transports/{ipc,memory}`) — each implements the
  `KlientChannel` SPI (`src/core/channel.ts`) and nothing else. ipc frames
  the same dispatcher traffic as NDJSON over a unix socket and shares the
  in-process dispatcher with memory; memory JSON round-trips every value so
  both transports return byte-identical data.

The facade only covers services that behave identically on both transports
(the in-process dispatcher mirrors the server's scope resolution, including
`main`-agent materialization via `ensureMainAgent`). onWill/hook-style
interception is not wire-exposable
(engine hooks are in-process `OrderedHookSlot`s); file upload and the
terminal surface are v1-only and live in the legacy suites.

## Testing

- One shared conformance suite (`test/helpers/conformance.ts`) runs unchanged
  against every transport — one test file per transport under `test/`. Add
  new **global** facade coverage there, not per-transport.
- `test/e2e/legacy/` + `test/e2e/harness/` — the legacy `/api/v1` live
  suites (moved from server-e2e). They skip unless `KIMI_SERVER_URL` points
  at a running server and **must keep running unchanged**; the v1 surface
  has no in-memory equivalent, so these stay live-server-only — do not try
  to run them against the in-process transports.
- The retired `scenarios/` scripts were rewritten as suites: image-upload
  and terminal (v1-only surfaces) live in `test/e2e/legacy/`.

## Observability (inherited from server-e2e)

- Keep observability inside each e2e case; every live case prints structured,
  case-scoped details (requests, envelopes, WS handshakes, terminal frames,
  error envelopes) through the shared logger in `test/e2e/legacy/log.ts`,
  not ad hoc `console.log`.
- Logs must stay visible for passing Vitest cases — write through stdout.
- When adding or changing an e2e case, update its observability at the same
  time; do not add a scenario solely to print data an existing case should
  already expose.

## Command reference

- `pnpm --filter @moonshot-ai/klient bench:gpt-capability -- --dry-run --split all`
  plans the separate 24-task capability matrix (six categories, six procedural
  acceptance tasks). See `examples/gpt-capability-bench.md` for selftest, stub,
  smoke, variants and reporting. Baseline/catalog share `apply_patch=true` and
  one frozen engine/dependency snapshot. `--live` requires explicit batch run,
  request and time ceilings; all requests use a durable host-only ledger.
  Missing/corrupt resume ledgers and existing locks fail closed. `--report`
  reconstructs committed and interrupted observations without model calls.
  All output paths are repository-relative and scratch belongs under
  `.tmp/hakimi-benchmark-v2/`. Old benchmark tasks/results remain frozen.

  Task suites are versioned through `gpt-capability-bench.suites.ts`:
  `--suite v3` is the default; `--suite v1|v2` selects historical corpora but
  never bypasses frozen-source resume checks. Missing suite fields in old
  observations mean v1; do not rewrite those files. v2 clarifies P02/R03;
  v3 only revises L02's first/second-stage visible contract under a new id,
  keeping the original third prompt, grader, fixtures and other 23 v2 tasks.
  Reports isolate all three suite versions; keep different engine
  snapshots in separate reports, with no cross-suite pairing or pooling.
  The six acceptance tasks observed in v1/v2 are not a fresh v3 holdout.
  MCP checks here are benchmark measurement safeguards, not a claim that the
  underlying product runtime registration/readiness race has been repaired.
  v3 F02 uses the same local fixture via a public new-session MCP overlay.
  Its asserted fresh-session/single-prompt/no-compaction contract lets the
  host check the initial main provider request before quota/auth/fetch.
  A failed check stays latched and rejects later attempts; success allows
  later restricted-child requests without imposing the main MCP tool set.
  The scorer still requires a real successful MCP call. A readiness failure
  is independently `invalid`, retained, and stops the batch without rerunning;
  initial names/hashes/reasons are stored in `mcpReadiness`. F02 has no restore
  step; do not describe this as fixing restored-session MCP readiness.
  `manifest.config.mcpReadinessPolicy` binds this v3-only guard; keep the
  optional policy/measurements absent from v1/v2 historical output.
  New paid batches require new explicit finite authorization. New executable
  batches preserve host-only `control-source/` with controls, selected tasks,
  dependency lock and noncredential model catalog; never mount this archive
  into an agent workspace. `--report` remains read-only for historical runs.

- `pnpm --filter @moonshot-ai/klient bench:gpt-harness -- --dry-run` plans the
  separate Codex / production Hakimi / opt-in `apply_patch` comparison. Unlike
  the adapter benchmark below, it uses the normal tool sets and prompt profiles.
  All arms run in Linux with Node >=24.15, `bwrap`, `socat`, and `rg` available.
  Install a pinned Linux Codex CLI into an isolated directory and pass its npm
  prefix with `--codex-root`. `--selftest` validates hidden graders offline.
  `--live --auth-file /path/to/codex/auth.json --out /path/to/new-run` explicitly
  enables remote calls; the host-only login authenticates a shared Responses
  proxy, never the agent sandbox. The official model catalog and engine source
  are frozen; model/effort are checked on every request. Request and wall-clock
  limits are hard, while token usage is observed after each response (not an
  in-flight token cap). Future prompts and hidden graders stay outside the
  agent's filesystem. Both harnesses restart/resume for each follow-up.
  Infrastructure/measurement failures are invalid results and stop the batch;
  budget exhaustion is recorded separately. Results are synthetic diagnostics,
  not evidence of general parity with Codex. Scratch and reports belong in `.tmp/`.
  `--arms hakimi-patch,hakimi-catalog` compares the same patch-enabled engine
  with `tool_catalog` off/on; use `--repeats 2` for paired AB/BA ordering.
  `H01-catalog-discovery` additionally requires the real TodoList tool and is
  restricted to Hakimi arms. It reuses the queue task's unchanged hidden grader;
  both correctness and the requested tool use must pass. This probe tests tool
  availability, not broad coding capability.

- `pnpm --filter @moonshot-ai/klient test` — all Vitest suites (unit +
  conformance + e2e; live cases skip without their env).
- `KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm --filter @moonshot-ai/klient test`
  — include the live legacy cases against a running server.
- `pnpm --filter @moonshot-ai/klient docker:e2e` — docker e2e; the run
  derives its runner name/namespace from the current workspace to avoid
  cross-workspace conflicts.
- `pnpm --filter @moonshot-ai/klient typecheck` / `pnpm smoke` (in-process
  smoke over the memory transport; see `examples/smoke.ts`).
- `pnpm --filter @moonshot-ai/klient smoke:boundary` — ModelRequester boundary
  probe: pings every model configured in the real `~/.kimi-code/config.toml`
  through the in-process engine, then drives deterministic failure modes
  against a local stub to show which errors the ChatProvider layer wraps and
  which the requester owns (see `examples/model-requester-boundary.ts`).
- `pnpm --filter @moonshot-ai/klient smoke:select-tools` — select_tools
  (progressive tool disclosure) probe for kimi-type providers: stub-verifies
  the kimi-only wire encoding of dynamic tool declarations, then runs a live
  two-step select→use flow per real kimi model (see
  `examples/kimi-select-tools.ts`).
- `pnpm --filter @moonshot-ai/klient bench:gpt-adaptation -- <args>` — the GPT
  adaptation paired benchmark (see `examples/gpt-adaptation-bench.ts` and
  `test/gpt-adaptation-bench.test.ts`). Freeze once per run id
  (`--freeze --freeze-mode live|offline`), then run 12 synthetic TypeScript
  tasks on 2 arms × 2 repeats in task-pair blocks (rep 0 AB, rep 1 BA, adjacent),
  8 cache-affinity session pairs, and the deterministic replay/fidelity scripts.
  **Default is `--dry-run`: no network, no credentials, no auth.** `--stub`
  serves each arm its own deterministic Responses fixture on loopback, so the
  real engine loop, tools, persistence and grader run with no HTTP leaving the
  process; those artifacts are `offline` and are only evidence, never an
  official score (a run directory that mixes modes is flagged). Only `--live`
  leaves the machine: it uses the engine's own managed OAuth on a separate
  `--auth-home` (the benchmark's home, sessions, index and logs stay per-run),
  never falls back to another model, and every request is ticketed before
  dispatch against a per-run cap and an output-directory-wide durable ledger
  (`ledger.jsonl`) that a restart cannot refund. `--report <run-dir>` rebuilds a
  report read-only.
- Both `bench_run_tests` and the hidden grader execute in a fresh chroot with
  unprivileged user/mount/PID/network namespaces, private `/proc`, dropped
  capabilities and `no_new_privs` (`examples/gpt-adaptation-bench.sandbox.ts`).
  Only the staged workspace and required runtime files are available; host
  files and network access are unavailable. The grader is staged only after
  the agent finishes and its output is not returned to the model. This is not
  proof against arbitrary grader-aware cheating. If isolation cannot be
  established, tests and live runs fail closed. `--selftest` runs scorer
  positive/negative controls and sandbox escape probes; scratch stays in the
  repository's `.tmp/gpt-adaptation-bench/` directory.
- Each arm uses the frozen baseline source and dependencies. The candidate
  overlays only `src/kosong/contract/{message,generate}.ts`,
  `src/kosong/provider/bases/openai/openai-responses.ts`,
  its model-family helper `openai-common.ts` and the companion
  `openai-legacy.ts` importer (v3 keeps this dependency closure consistent),
  `src/agent/contextProjector/contextProjectorService.ts` and
  `src/agent/loop/loopService.ts`. Workspace-source and overlay hashes are
  checked before execution, and the arm loader pins workspace dependencies.
  Cache ablation uses identical candidate code and removes only `session-id`
  at the fetch boundary. The observer must preserve streaming and distinguish
  first-byte latency from the first visible text delta.
- Live model/effort and the request cap are frozen. Use `--live --preflight`
  before formal runs (at most four preflight requests within the 356-request
  total). Missing measurement, authentication or quota failures stop the run;
  ordinary graded failures remain results. Replay scripts always run offline,
  including inside a live invocation. Reports never score offline tasks or
  caches as live results, and include failed contracts and missing observations.
