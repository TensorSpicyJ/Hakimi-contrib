/**
 * `gpt-adaptation-bench` artifacts, statistics and reporting.
 *
 * Every artifact carries the mode it was produced in. `live` artifacts are the
 * only ones that may be scored officially; `offline` artifacts are pipeline
 * evidence and are reported separately — a run directory containing both is
 * flagged instead of silently mixing them.
 *
 * Missing measurements are never written as zero: a metric that was not
 * observed is `null` and is counted as censored in the report.
 */

import { existsSync } from 'node:fs';
import { appendFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { BENCH_TASKS } from './gpt-adaptation-bench.tasks.js';
import { BENCH_ABLATION_ARM_ID, type BenchArmId, type BenchRunKind, type RunResult } from './gpt-adaptation-bench.arm.js';
import { REPLAY_SCRIPTS, expectedMetadataBefore, type ReplayScript } from './gpt-adaptation-bench.events.js';

export type BenchMode = 'live' | 'offline';

export interface GradeSummary {
  readonly passed: boolean;
  readonly tests: number;
  readonly pass: number;
  readonly fail: number;
  readonly exactOk: boolean;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly graderDigest: string;
  readonly failures: readonly string[];
}

export interface ReplaySummary {
  readonly scriptId: string;
  readonly requestsObserved: number;
  readonly extraRequests: number | null;
  readonly misreportedSuccess: boolean | null;
  readonly incompleteToolExecutions: number | null;
  readonly terminalEventExpected: boolean;
  /** Per request index (1-based): metadata coverage against outputs completed before it. */
  readonly coverage: readonly {
    readonly requestIndex: number;
    readonly phases: number | null;
    readonly itemIds: number | null;
    readonly encrypted: number | null;
    readonly toolCallIds: number | null;
    readonly expectedPhases: number;
    readonly expectedItemIds: number;
    readonly expectedEncrypted: number;
    readonly expectedToolCallIds: number;
  }[];
  /** Requests that had no replay opportunity at all (first request of a run). */
  readonly noReplayOpportunity: number;
}

export interface RunArtifact {
  readonly runId: string;
  readonly mode: BenchMode;
  readonly kind: BenchRunKind;
  readonly arm: BenchArmId;
  readonly taskId?: string;
  readonly repeat?: number;
  readonly scriptId?: string;
  readonly pairIndex?: number;
  readonly child?: RunResult;
  readonly childExitCode: number;
  readonly childTimedOut: boolean;
  readonly grade?: GradeSummary;
  /** Resume / multi-turn contract verdict (null when not applicable). */
  readonly contractSatisfied: boolean | null;
  readonly replay?: ReplaySummary;
  readonly requestsObserved: number;
  readonly requestsObservedSource: 'guard' | 'fixture' | 'none';
  /** Requests the fetch guard itself observed (every mode is ticketed + captured). */
  readonly guardObservedRequests?: number | null;
  /** The model the engine actually resolved/bound for this run (no secrets). */
  readonly modelObserved?: { readonly id: string; readonly effort: string };
  /**
   * Live guard-observed presence of replay metadata on the requests the engine
   * actually sent (item id / phase / encrypted reasoning counts).
   */
  readonly replayMetadata?: {
    readonly requests: number;
    readonly messageItems: number;
    readonly messageItemsWithId: number;
    readonly messageItemsWithPhase: number;
    readonly reasoningItems: number;
    readonly reasoningWithEncrypted: number;
  };
  /**
   * Live guard observation verdict: `null` when measurement was complete,
   * otherwise why the run's HTTP measurement cannot be trusted (the run may
   * still be archived, but it can never be scored).
   */
  readonly measurementFailed?: string | null;
  readonly toolCalls: number;
  readonly toolFailures: number;
  /**
   * Summed guard usage. Each field sums only the requests that reported it;
   * the optional `requestsWithUsage` / `*Known` coverage fields make a partial
   * total explicit (absent means the producer did not record coverage).
   * `null` means no request reported any usage.
   */
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedTokens: number;
    readonly requests?: number;
    readonly requestsWithUsage?: number;
    readonly inputTokensKnown?: number;
    readonly outputTokensKnown?: number;
    readonly cachedTokensKnown?: number;
  } | null;
  /** First turn's first visible token, plus every turn's own value (null = not observed). */
  readonly firstVisibleTokenMs: number | null;
  readonly ttftByTurn?: readonly (number | null)[];
  readonly durationMs: number | null;
  readonly note?: string;
  readonly testsSandboxed: boolean | null;
  /** Live mode only: how the engine reached the managed auth source. */
  readonly authBridge?: {
    readonly authHome: string;
    readonly credentialsLinked: boolean;
    readonly configDigest: string;
    readonly configUnchanged: boolean;
  };
  readonly startedAt: string;
  readonly endedAt: string;
}

export interface ArmRootEvidence {
  readonly arm: BenchArmId;
  readonly root: string;
  readonly engineIndex: string;
  readonly engineResetExpected: boolean;
}

export interface BenchRunManifestExtra {
  readonly mode: BenchMode;
  readonly engineTrees: Readonly<Record<string, string>>;
  readonly resolvedPackages: readonly { readonly arm: BenchArmId; readonly specifier: string; readonly resolved: string }[];
  readonly armRoots: readonly ArmRootEvidence[];
}

export interface ReportSummary {
  readonly runRoot: string;
  readonly modes: readonly BenchMode[];
  readonly mixedModes: boolean;
  readonly artifacts: readonly RunArtifact[];
  readonly liveArtifacts: readonly RunArtifact[];
  readonly offlineArtifacts: readonly RunArtifact[];
  readonly ledgerConsumed: number;
  readonly officialScores: boolean;
  readonly failures: readonly { readonly runId: string; readonly reason: string }[];
  readonly lines: readonly string[];
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ClusterInterval {
  readonly label: string;
  readonly clusters: number;
  readonly mean: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  readonly note?: string;
}

/** Cluster bootstrap over the per-cluster differences (task or session clusters). */
export function clusterBootstrap(
  label: string,
  differences: readonly number[],
  seed: number,
  iterations = 4000,
): ClusterInterval {
  if (differences.length === 0) {
    return { label, clusters: 0, mean: 0, ciLow: 0, ciHigh: 0, note: 'no completed clusters' };
  }
  const mean = differences.reduce((total, value) => total + value, 0) / differences.length;
  const random = mulberry32(seed);
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let draw = 0; draw < differences.length; draw += 1) {
      total += differences[Math.floor(random() * differences.length)] as number;
    }
    samples.push(total / differences.length);
  }
  samples.sort((left, right) => left - right);
  const at = (quantile: number): number =>
    samples[Math.min(samples.length - 1, Math.max(0, Math.floor(quantile * samples.length)))] as number;
  return {
    label,
    clusters: differences.length,
    mean,
    ciLow: at(0.025),
    ciHigh: at(0.975),
    note:
      differences.length < 8
        ? `only ${String(differences.length)} clusters — a small regression cannot be excluded`
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export async function loadArtifacts(runRoot: string): Promise<readonly RunArtifact[]> {
  const runsDir = join(runRoot, 'runs');
  if (!existsSync(runsDir)) return [];
  const artifacts: RunArtifact[] = [];
  for (const name of (await readdir(runsDir)).sort()) {
    if (!name.endsWith('.json')) continue;
    artifacts.push(JSON.parse(await readFile(join(runsDir, name), 'utf8')) as RunArtifact);
  }
  return artifacts;
}

export interface LedgerEntry {
  readonly ts: string;
  readonly kind: 'reserve' | 'settle';
  readonly runId: string;
  readonly arm: string;
  readonly runKind: BenchRunKind | 'preflight';
  readonly reserved?: number;
  readonly consumed?: number;
  readonly status?: string;
  readonly note?: string;
}

/**
 * Append-only, durable request ledger for a whole output directory.
 *
 * Budgets are global (one file for every `--run-id` under the same `--out`),
 * and a `reserve` that never settled counts as consumed: restarting the
 * process, or starting a new run id, can never refund spent requests.
 */
export class Ledger {
  private readonly path: string;
  private entries: LedgerEntry[] = [];

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<void> {
    this.entries = [];
    if (!existsSync(this.path)) return;
    const text = await readFile(this.path, 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        this.entries.push(JSON.parse(line) as LedgerEntry);
      } catch {
        // A torn last line never counts as a settled run.
      }
    }
  }

  async append(entry: LedgerEntry): Promise<void> {
    this.entries.push(entry);
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** Live model requests charged so far (reserved-but-unsettled counts in full). */
  consumed(): number {
    let total = 0;
    for (const entry of this.entries) {
      if (entry.kind !== 'reserve' || entry.runKind === 'replay') continue;
      const settled = this.entries.find(
        (candidate) => candidate.kind === 'settle' && candidate.runId === entry.runId,
      );
      total += settled?.consumed ?? entry.reserved ?? 0;
    }
    return total;
  }

  preflightRuns(): number {
    return new Set(
      this.entries
        .filter((entry) => entry.kind === 'reserve' && entry.runKind === 'preflight')
        .map((entry) => entry.runId),
    ).size;
  }

  settledRunIds(): Set<string> {
    return new Set(this.entries.filter((entry) => entry.kind === 'settle').map((entry) => entry.runId));
  }

  count(kind: BenchRunKind | 'preflight'): number {
    return new Set(
      this.entries.filter((entry) => entry.runKind === kind).map((entry) => entry.runId),
    ).size;
  }
}

export interface LedgerLike {
  consumed(): number;
}

/**
 * Build the summary. `ledgerConsumed` is the durable request count for the
 * whole output directory (live requests only).
 */
export function summarize(
  runRoot: string,
  artifacts: readonly RunArtifact[],
  ledgerConsumed: number,
): ReportSummary {
  const modes = [...new Set(artifacts.map((artifact) => artifact.mode))];
  const live = artifacts.filter((artifact) => artifact.mode === 'live');
  const offline = artifacts.filter((artifact) => artifact.mode !== 'live');
  const failures = artifacts.flatMap((artifact) => {
    const reasons: string[] = [];
    if (artifact.childTimedOut) reasons.push('timeout');
    if (artifact.child === undefined) reasons.push('no-result-file');
    else if (artifact.child.status !== 'ok') {
      reasons.push(`${artifact.child.status}: ${artifact.child.errorText ?? artifact.note ?? ''}`);
    }
    if (artifact.childExitCode !== 0) reasons.push(`exit=${String(artifact.childExitCode)}`);
    if ((artifact.measurementFailed ?? null) !== null) {
      reasons.push(`measurement: ${artifact.measurementFailed}`);
    }
    if (artifact.contractSatisfied === false) reasons.push('contract-violation');
    if (artifact.kind === 'task' && artifact.grade === undefined) reasons.push('not-graded');
    if (artifact.kind === 'task' && artifact.grade !== undefined && !artifact.grade.passed) {
      reasons.push('graded-fail');
    }
    return reasons.length === 0 ? [] : [{ runId: artifact.runId, reason: reasons.join('; ') }];
  });
  const summary: ReportSummary = {
    runRoot,
    modes,
    mixedModes: modes.length > 1,
    artifacts,
    liveArtifacts: live,
    offlineArtifacts: offline,
    ledgerConsumed,
    officialScores: live.length > 0,
    failures,
    lines: [],
  };
  return { ...summary, lines: formatReport(summary) };
}

export function taskPassed(artifact: RunArtifact): boolean {
  return artifact.kind === 'task' && artifact.grade?.passed === true &&
    artifact.child?.status === 'ok' && artifact.childExitCode === 0 &&
    !artifact.childTimedOut && artifact.contractSatisfied === true &&
    (artifact.measurementFailed ?? null) === null &&
    (artifact.mode !== 'live' || artifact.requestsObservedSource === 'guard');
}

function countCensored(artifacts: readonly RunArtifact[]): number {
  return artifacts.filter(
    (artifact) => artifact.child === undefined || artifact.child.status !== 'ok' ||
      artifact.childTimedOut || artifact.childExitCode !== 0 ||
      artifact.contractSatisfied !== true || (artifact.measurementFailed ?? null) !== null ||
      (artifact.mode === 'live' && artifact.requestsObservedSource !== 'guard'),
  ).length;
}

export function formatReport(summary: ReportSummary): readonly string[] {
  const lines: string[] = [];
  const push = (line = ''): void => {
    lines.push(line);
  };
  push(`benchmark report: ${summary.runRoot}`);
  push(
    `modes: ${summary.modes.join(', ') || 'none'}${summary.mixedModes ? '  [MIXED — stub/offline runs are evidence only, never official scores]' : ''}`,
  );
  push(`live requests consumed (durable, whole output dir): ${String(summary.ledgerConsumed)}`);
  push(
    `artifacts: ${String(summary.artifacts.length)} (live ${String(summary.liveArtifacts.length)}, offline ${String(summary.offlineArtifacts.length)})`,
  );
  push(
    `official score: ${summary.officialScores ? 'live artifacts only' : 'none (no live artifact in this directory)'} → ${String(summary.liveArtifacts.length)} scored runs`,
  );
  if (summary.offlineArtifacts.length > 0) {
    const kinds = ['task', 'cache', 'replay', 'preflight']
      .map((kind) => {
        const count = summary.offlineArtifacts.filter((artifact) => artifact.kind === kind).length;
        return count === 0 ? null : `${kind}=${String(count)}`;
      })
      .filter((value): value is string => value !== null)
      .join(' ');
    push(
      `offline artifacts (pipeline evidence only, never scored): ${String(summary.offlineArtifacts.length)} (${kinds})`,
    );
  }
  push();

  const scored = summary.liveArtifacts;
  // Without a live artifact the same table is still useful as pipeline
  // evidence, but it is labelled so it can never be mistaken for a score.
  const evidenceOnly = scored.length === 0;
  const tableArtifacts = evidenceOnly ? summary.offlineArtifacts : scored;
  const taskIds = [...new Set(tableArtifacts.filter((a) => a.kind === 'task').map((a) => a.taskId ?? '-'))].sort();
  if (taskIds.length > 0) {
    push(
      evidenceOnly
        ? 'offline task evidence (fixture-driven, NOT a score): graded by the hidden suite; censored runs are counted as failures'
        : 'task results (graded by the hidden suite; censored runs are counted as failures)',
    );
    push(
      `  ${'task'.padEnd(30)} ${'baseline'.padEnd(14)} candidate${'  censored(B/C)'.padEnd(16)}`,
    );
    const perTaskBaseline: number[] = [];
    const perTaskCandidate: number[] = [];
    const successfulPairs: [RunArtifact, RunArtifact][] = [];
    let wins = 0;
    let losses = 0;
    let ties = 0;
    for (const taskId of taskIds) {
      const rows = tableArtifacts.filter((artifact) => artifact.taskId === taskId);
      const cell = (arm: BenchArmId): { passed: number; total: number; censored: number } => {
        const armRows = rows.filter((row) => row.arm === arm);
        return { passed: armRows.filter(taskPassed).length, total: armRows.length, censored: countCensored(armRows) };
      };
      const baseline = cell('baseline');
      const candidate = cell('candidate');
      const pairs = [0, 1].map((repeat) => ({
        baseline: rows.find((row) => row.arm === 'baseline' && row.repeat === repeat),
        candidate: rows.find((row) => row.arm === 'candidate' && row.repeat === repeat),
      }));
      if (pairs.every((pair) => pair.baseline !== undefined && pair.candidate !== undefined)) {
        perTaskBaseline.push(baseline.passed / 2);
        perTaskCandidate.push(candidate.passed / 2);
      }
      for (const pair of pairs) {
        if (pair.baseline === undefined || pair.candidate === undefined) continue;
        const before = taskPassed(pair.baseline);
        const after = taskPassed(pair.candidate);
        if (before === after) ties += 1;
        else if (after) wins += 1;
        else losses += 1;
        if (before && after) successfulPairs.push([pair.baseline, pair.candidate]);
      }
      push(
        `  ${taskId.padEnd(30)} ${`${String(baseline.passed)}/${String(baseline.total)}`.padEnd(14)} ${`${String(candidate.passed)}/${String(candidate.total)}`.padEnd(9)} ${String(baseline.censored)}/${String(candidate.censored)} missing=${String(Math.max(0, 2 - baseline.total))}/${String(Math.max(0, 2 - candidate.total))}`,
      );
    }
    const differences = perTaskCandidate.map((value, index) => value - (perTaskBaseline[index] as number));
    const interval = clusterBootstrap('task-cluster', differences, 20260915);
    push();
    push(`paired outcomes: wins=${String(wins)} losses=${String(losses)} ties=${String(ties)}; complete task clusters=${String(interval.clusters)}/12`);
    if (interval.clusters > 0) {
      push(
        `paired task-cluster: baseline=${(perTaskBaseline.reduce((a, b) => a + b, 0) / interval.clusters).toFixed(3)} ` +
          `candidate=${(perTaskCandidate.reduce((a, b) => a + b, 0) / interval.clusters).toFixed(3)} ` +
          `diff=${interval.mean.toFixed(3)} 95%CI=[${interval.ciLow.toFixed(3)}, ${interval.ciHigh.toFixed(3)}] clusters=${String(interval.clusters)}`,
      );
    } else push('paired task-cluster: n/a (no task has both repeats in both arms)');
    if (interval.note !== undefined) push(`  note: ${interval.note}`);
    const pairedMetric = (key: 'durationMs' | 'firstVisibleTokenMs'): string => {
      const differences = successfulPairs.flatMap(([before, after]) =>
        before[key] === null || after[key] === null ? [] : [after[key] - before[key]]);
      return differences.length === 0 ? 'n/a' : `${(differences.reduce((a, b) => a + b, 0) / differences.length).toFixed(1)}ms (n=${String(differences.length)})`;
    };
    push(`paired-success subset (both arms passed): pairs=${String(successfulPairs.length)}; candidate-minus-baseline wall=${pairedMetric('durationMs')}, ttft=${pairedMetric('firstVisibleTokenMs')}`);
  } else if (scored.some((artifact) => artifact.kind === 'task')) {
    push('task results: only offline artifacts present — not an official score');
  }

  const taskRuns = scored.filter((artifact) => artifact.kind === 'task').length;
  if (taskRuns === 0 && !evidenceOnly && summary.offlineArtifacts.some((artifact) => artifact.kind === 'task')) {
    push();
    push('offline task runs are omitted from the cost table: fixture usage/latency is synthetic');
  }
  if (taskRuns > 0) {
    push();
    push('task-run cost/observability (live only, reported per arm — never pooled across arms)');
    for (const arm of ['baseline', 'candidate'] as const) {
      const armRows = scored.filter((artifact) => artifact.kind === 'task' && artifact.arm === arm);
      if (armRows.length === 0) continue;
      const totals = armRows.reduce(
        (total, artifact) => ({
          observed: total.observed + artifact.requestsObserved,
          tools: total.tools + artifact.toolCalls,
          toolFailures: total.toolFailures + artifact.toolFailures,
          inputTokens: total.inputTokens + (artifact.usage?.inputTokens ?? 0),
          outputTokens: total.outputTokens + (artifact.usage?.outputTokens ?? 0),
          cachedTokens: total.cachedTokens + (artifact.usage?.cachedTokens ?? 0),
          usageRuns: total.usageRuns + (artifact.usage === null ? 0 : 1),
          usageRequests: total.usageRequests + (artifact.usage?.requests ?? 0),
          usageRequestsKnown: total.usageRequestsKnown + (artifact.usage?.requestsWithUsage ?? 0),
          latency: total.latency + (artifact.firstVisibleTokenMs ?? 0),
          latencyKnown: total.latencyKnown + (artifact.firstVisibleTokenMs === null ? 0 : 1),
          duration: total.duration + (artifact.durationMs ?? 0),
          passed: total.passed + (taskPassed(artifact) ? 1 : 0),
        }),
        {
          observed: 0,
          tools: 0,
          toolFailures: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          usageRuns: 0,
          usageRequests: 0,
          usageRequestsKnown: 0,
          latency: 0,
          latencyKnown: 0,
          duration: 0,
          passed: 0,
        },
      );
      push(`  ${arm} (n=${String(armRows.length)}, passed=${String(totals.passed)}/${String(armRows.length)})`);
      push(
        `    requests observed=${String(totals.observed)} (source: ${[...new Set(armRows.map((a) => a.requestsObservedSource))].join('/')}) ` +
          `tool calls=${String(totals.tools)} (failed ${String(totals.toolFailures)})`,
      );
      const usageCoverage =
        totals.usageRequests === 0
          ? 'per-request coverage not recorded'
          : `${String(totals.usageRequestsKnown)}/${String(totals.usageRequests)} requests reported usage`;
      push(
        `    usage tokens (summed over requests that reported them): input=${String(totals.inputTokens)} output=${String(totals.outputTokens)} cached=${String(totals.cachedTokens)} ` +
          `(${String(totals.usageRuns)}/${String(armRows.length)} runs; ${usageCoverage})`,
      );
      push(
        `    ttft first-turn mean=${totals.latencyKnown === 0 ? 'n/a' : `${(totals.latency / totals.latencyKnown).toFixed(0)}ms`} ` +
          `(${String(totals.latencyKnown)}/${String(armRows.length)} runs reported a first token), wall=${(totals.duration / 1000).toFixed(1)}s total`,
      );
      const metadata = armRows.filter((artifact) => artifact.replayMetadata !== undefined);
      if (metadata.length > 0) {
        const observed = metadata.reduce(
          (total, artifact) => {
            const value = artifact.replayMetadata;
            if (value === undefined) return total;
            return {
              requests: total.requests + value.requests,
              messageItems: total.messageItems + value.messageItems,
              messageItemsWithId: total.messageItemsWithId + value.messageItemsWithId,
              messageItemsWithPhase: total.messageItemsWithPhase + value.messageItemsWithPhase,
              reasoningItems: total.reasoningItems + value.reasoningItems,
              reasoningWithEncrypted: total.reasoningWithEncrypted + value.reasoningWithEncrypted,
            };
          },
          {
            requests: 0,
            messageItems: 0,
            messageItemsWithId: 0,
            messageItemsWithPhase: 0,
            reasoningItems: 0,
            reasoningWithEncrypted: 0,
          },
        );
        push(
          `    replay metadata sent back (guard-observed over ${String(observed.requests)} requests): ` +
            `message items with id=${String(observed.messageItemsWithId)}/${String(observed.messageItems)}, ` +
            `with phase=${String(observed.messageItemsWithPhase)}/${String(observed.messageItems)}, ` +
            `reasoning with encrypted=${String(observed.reasoningWithEncrypted)}/${String(observed.reasoningItems)}`,
        );
      }
    }
  }

  const anyReplay = summary.artifacts.filter((artifact) => artifact.kind === 'replay');
  if (anyReplay.length > 0) {
    push();
    push(
      `deterministic replay/fidelity (${anyReplay[0]?.mode === 'live' ? 'live' : 'offline'} artifacts; coverage is measured per request against outputs completed before it)`,
    );
    const byScript = new Map<string, RunArtifact[]>();
    for (const artifact of summary.artifacts.filter((candidate) => candidate.kind === 'replay')) {
      const list = byScript.get(artifact.scriptId ?? '-') ?? [];
      list.push(artifact);
      byScript.set(artifact.scriptId ?? '-', list);
    }
    // Explicit default-order comparator over the script ids (identical to the
    // implicit UTF-16 lexicographic order; presentation order only).
    const scriptRows = [...byScript.entries()].sort((left, right) =>
      left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
    );
    for (const [scriptId, rows] of scriptRows) {
      for (const arm of ['baseline', 'candidate'] as const) {
        const row = rows.find((candidate) => candidate.arm === arm);
        if (row === undefined) continue;
        const coverage = row.replay?.coverage ?? [];
        const last = coverage
          .toReversed()
          .find(
            (entry) =>
              entry.phases !== null ||
              entry.itemIds !== null ||
              entry.toolCallIds !== null ||
              entry.encrypted !== null,
          );
        push(
          `  ${scriptId.padEnd(26)} ${arm.padEnd(10)} requests=${String(row.requestsObserved)} extra=${String(row.replay?.extraRequests ?? 'null')} ` +
            `misreportedSuccess=${String(row.replay?.misreportedSuccess ?? 'null')} incompleteToolExecutions=${String(row.replay?.incompleteToolExecutions ?? 'null')} ` +
            `fidelity[last replayable request]=${last === undefined ? 'N/A' : `phase ${String(last.phases)}/${String(last.expectedPhases)}, id ${String(last.itemIds)}/${String(last.expectedItemIds)}, toolCallId ${String(last.toolCallIds)}/${String(last.expectedToolCallIds)}, encrypted ${String(last.encrypted)}/${String(last.expectedEncrypted)}`}`,
        );
      }
    }
    const noOpportunity = anyReplay.reduce((total, artifact) => total + (artifact.replay?.noReplayOpportunity ?? 0), 0);
    push(`  requests with no replay opportunity (denominator N/A): ${String(noOpportunity)}`);
  }

  const cacheArtifacts = tableArtifacts.filter((artifact) => artifact.kind === 'cache');
  if (cacheArtifacts.length > 0) {
    push();
    push('cache affinity (backend-reported cached tokens; null = not observed, counted as censored)');
    const pairing: { pair: number; values: Partial<Record<BenchArmId, number>> }[] = [];
    for (const arm of ['candidate', BENCH_ABLATION_ARM_ID] as const) {
      const rows = cacheArtifacts.filter((artifact) => artifact.arm === arm);
      const cold: (number | null)[] = [];
      const warm: (number | null)[] = [];
      const ttfts: number[] = [];
      for (const row of rows) {
        const requests = row.child?.cacheRequests ?? [];
        for (const request of requests) {
          const hit =
            request.inputTokens === null || request.inputTokens === 0 || request.cachedTokens === null
              ? null
              : request.cachedTokens / request.inputTokens;
          if (request.index === 0) cold.push(hit);
          else warm.push(hit);
          if (request.firstTokenLatencyMs !== null) ttfts.push(request.firstTokenLatencyMs);
        }
      }
      const known = (values: readonly (number | null)[]): number[] =>
        values.filter((value): value is number => value !== null);
      const mean = (values: readonly number[]): number =>
        values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
      push(
        `  ${arm.padEnd(26)} sessions=${String(rows.length)} cold=${known(cold).length === 0 ? 'null' : mean(known(cold)).toFixed(3)} (n=${String(known(cold).length)}/${String(cold.length)}) ` +
          `warm=${known(warm).length === 0 ? 'null' : mean(known(warm)).toFixed(3)} (n=${String(known(warm).length)}/${String(warm.length)}) ` +
          `ttft=${ttfts.length === 0 ? 'null' : `${mean(ttfts).toFixed(0)}ms`}`,
      );
      for (const row of rows) {
        if (row.pairIndex === undefined) continue;
        const requests = row.child?.cacheRequests ?? [];
        const warmKnown = requests
          .filter((request) => request.index > 0 && request.inputTokens !== null && request.inputTokens > 0 && request.cachedTokens !== null)
          .map((request) => (request.cachedTokens as number) / (request.inputTokens as number));
        if (warmKnown.length === 0) continue;
        const entry =
          pairing.find((candidate) => candidate.pair === row.pairIndex) ??
          ({ pair: row.pairIndex, values: {} } as { pair: number; values: Partial<Record<BenchArmId, number>> });
        if (row.arm === 'candidate') entry.values.candidate = mean(warmKnown);
        else entry.values[BENCH_ABLATION_ARM_ID] = mean(warmKnown);
        if (!pairing.includes(entry)) pairing.push(entry);
      }
    }
    const pairDiffs = pairing
      .map((entry) => {
        const left = entry.values['candidate'];
        const right = entry.values[BENCH_ABLATION_ARM_ID];
        return left === undefined || right === undefined ? null : left - right;
      })
      .filter((value): value is number => value !== null);
    const interval = clusterBootstrap('cache-session-cluster', pairDiffs, 20260915);
    push(
      `  paired session-cluster diff (candidate − ablation): mean=${interval.mean.toFixed(3)} ` +
        `95%CI=[${interval.ciLow.toFixed(3)}, ${interval.ciHigh.toFixed(3)}] clusters=${String(interval.clusters)}${interval.note === undefined ? '' : ` (${interval.note})`}`,
    );
    if (interval.clusters === 0) push('  conclusion: cache benefit NOT demonstrated (no paired observation)');
  }

  if (summary.failures.length > 0) {
    push();
    push('failures / timeouts (already counted as failures in every rate above)');
    for (const failure of summary.failures) push(`  ${failure.runId}: ${failure.reason.slice(0, 300)}`);
  }
  const censoredContracts = summary.artifacts.filter((artifact) => artifact.contractSatisfied === false);
  if (censoredContracts.length > 0) {
    push();
    push('contract violations (resume/multi-turn) — these runs are not counted as passes');
    for (const artifact of censoredContracts) push(`  ${artifact.runId}`);
  }
  return lines;
}

/** Replay coverage row for one captured request, or null when not replayable. */
export function replayCoverageRow(
  script: ReplayScript,
  requests: readonly {
    readonly index: number;
    readonly messageItemsWithId: number;
    readonly messageItemsWithPhase: number;
    readonly reasoningWithEncrypted: number;
    readonly toolCallItemsWithId?: number;
  }[],
): ReplaySummary['coverage'] {
  return requests.map((request, position) => {
    const expected = expectedMetadataBefore(script, position);
    const replayable = position > 0;
    const ratio = (got: number, want: number): number | null =>
      !replayable || want === 0 ? null : Math.min(1, got / want);
    return {
      requestIndex: request.index,
      phases: ratio(request.messageItemsWithPhase, expected.phases),
      itemIds: ratio(request.messageItemsWithId, expected.itemIds),
      encrypted: ratio(request.reasoningWithEncrypted, expected.encrypted),
      toolCallIds: ratio(request.toolCallItemsWithId ?? 0, expected.toolCallIds),
      expectedPhases: expected.phases,
      expectedItemIds: expected.itemIds,
      expectedEncrypted: expected.encrypted,
      expectedToolCallIds: expected.toolCallIds,
    };
  });
}

export function taskCount(): number {
  return BENCH_TASKS.length;
}

export function replayScriptCount(): number {
  return REPLAY_SCRIPTS.length;
}
