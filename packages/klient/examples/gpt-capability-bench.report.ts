/** Pure, offline reporting. Repeats are nested within tasks, never independent samples. */
export type Outcome = 'passed' | 'failed' | 'budget_exhausted' | 'invalid' | 'not_run' | 'unsupported';
export type BenchMode = 'live' | 'offline' | 'dry-run';
export type BenchSplit = 'development' | 'acceptance';
export type BenchSuite = 'v1' | 'v2' | 'v3';

export interface PlannedObservation {
  /** Absent in historical artifacts; absence means v1. */
  readonly suite?: BenchSuite;
  readonly id: string;
  readonly taskId: string;
  readonly category: string;
  readonly split: BenchSplit;
  readonly variant: string;
  readonly repeat: number;
  readonly budgetProfile: string;
  readonly mode: BenchMode;
  readonly discovery?: 'natural' | 'protocol';
}

export const METRICS = [
  'durationMs', 'requests', 'inputTokens', 'cachedInputTokens', 'nonCachedInputTokens',
  'outputTokens', 'toolErrors', 'repeatedAttempts', 'manualInterventions',
] as const;
export type Metric = typeof METRICS[number];
export type Measurements = Readonly<Record<Metric, number | null>>;

export interface Observation extends PlannedObservation, Measurements {
  readonly outcome: Outcome;
  readonly artifactCorrect: boolean | null;
  readonly completeDelivery: boolean | null;
  readonly reason?: string;
  readonly evidence?: readonly string[];
}

export interface Rate {
  readonly numerator: number;
  readonly denominator: number;
  readonly unknown: number;
  readonly rate: number | null;
}

export interface MetricSummary {
  /** Partial sums are labelled with their coverage; an entirely unknown sum is null. */
  readonly total: number | null;
  readonly known: number;
  readonly unknown: number;
  readonly mean: number | null;
}

export interface VariantSummary {
  readonly variant: string;
  readonly planned: number;
  readonly observations: number;
  readonly independentTasks: number;
  readonly outcomes: Readonly<Record<Outcome, number>>;
  readonly capabilityEligible: number;
  readonly artifactCorrect: Rate;
  readonly completeDelivery: Rate;
  /** Includes ordinary failures and budget exhaustion; excludes invalid/missing/unsupported. */
  readonly passed: Rate;
  /** Includes failed, invalid and budget-aborted attempts, not only successful attempts. */
  readonly resources: Readonly<Record<Metric, MetricSummary>>;
  readonly estimatedUsd: null;
}

export type PairedMetric = Metric | 'artifactCorrect' | 'completeDelivery' | 'passed';
const PAIRED_METRICS: readonly PairedMetric[] = ['passed', 'artifactCorrect', 'completeDelivery', ...METRICS];
export interface Interval {
  readonly independentTasks: number;
  readonly pairedRepeats: number;
  readonly meanDifference: number | null;
  readonly ci95: readonly [number, number] | null;
  readonly note: string;
}
export interface TaskDifference {
  readonly taskId: string;
  readonly differences: Readonly<Record<PairedMetric, number | null>>;
  readonly pairedRepeats: Readonly<Record<PairedMetric, number>>;
}
export interface PairRow {
  readonly taskId: string;
  readonly repeat: number;
  readonly baselineId: string | null;
  readonly candidateId: string | null;
  readonly eligible: boolean;
  readonly exclusion: string | null;
  readonly differences: Readonly<Record<PairedMetric, number | null>>;
}
export interface Comparison {
  readonly baseline: string;
  readonly candidate: string;
  readonly plannedPairs: number;
  readonly eligiblePairs: number;
  readonly excludedPairs: number;
  readonly pairs: readonly PairRow[];
  readonly tasks: readonly TaskDifference[];
  readonly metrics: Readonly<Record<PairedMetric, Interval>>;
  /** On each task's mean success-rate difference. Positive is a candidate win. */
  readonly winsTiesLosses: { readonly wins: number; readonly ties: number; readonly losses: number; readonly tasks: number };
}
export interface ReportGroup {
  /** Omitted from serialized legacy reports to preserve their historical bytes. */
  readonly suite?: BenchSuite;
  readonly mode: BenchMode;
  readonly budgetProfile: string;
  readonly category: string | null;
  readonly split: BenchSplit | null;
  readonly discovery: 'natural' | 'protocol' | null;
  readonly official: boolean;
  readonly variants: readonly VariantSummary[];
  readonly comparisons: readonly Comparison[];
}
export interface CapabilityReport {
  readonly schemaVersion: 1;
  readonly seed: number;
  readonly bootstrapIterations: 4000;
  readonly planned: readonly PlannedObservation[];
  /** Exact caller input, including every duplicate and invalid observation. */
  readonly sourceObservations: readonly Observation[];
  /** Missing plan rows are explicit not_run; malformed/duplicate rows are invalid. */
  readonly observations: readonly Observation[];
  readonly groups: readonly ReportGroup[];
  readonly warnings: readonly string[];
  readonly estimatedUsd: null;
  readonly costNote: string;
  readonly limitations: readonly string[];
}

const OUTCOMES: readonly Outcome[] = ['passed', 'failed', 'budget_exhausted', 'invalid', 'not_run', 'unsupported'];
const ELIGIBLE = new Set<Outcome>(['passed', 'failed', 'budget_exhausted']);
const NULL_MEASUREMENTS: Measurements = Object.fromEntries(METRICS.map((key) => [key, null])) as unknown as Measurements;
const mean = (values: readonly number[]): number | null => values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
function suiteOf(row: PlannedObservation): BenchSuite {
  if (row.suite === undefined || row.suite === 'v1') return 'v1';
  if (row.suite === 'v2' || row.suite === 'v3') return row.suite;
  throw new Error(`Unknown benchmark suite: ${String(row.suite)}`);
}
const identityKey = (row: PlannedObservation): string => JSON.stringify([suiteOf(row), row.id]);
const keyFor = (row: PlannedObservation): string => JSON.stringify([suiteOf(row), row.mode, row.budgetProfile, row.taskId, row.repeat, row.variant]);
const pairKey = (row: PlannedObservation): string => JSON.stringify([suiteOf(row), row.taskId, row.repeat]);
const sortedUnique = (items: readonly string[]): string[] => [...new Set(items)].toSorted();

// Uint32 wrapping is part of Mulberry32; Math.trunc would change the seeded stream.
/* eslint-disable unicorn/prefer-math-trunc */
function randomGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
/* eslint-enable unicorn/prefer-math-trunc */

function interval(values: readonly number[], pairedRepeats: number, seed: number): Interval {
  const base = { independentTasks: values.length, pairedRepeats, meanDifference: mean(values) };
  if (values.length < 2) return { ...base, ci95: null, note: 'At least two independent tasks are required for an uncertainty interval.' };
  const random = randomGenerator(seed);
  const draws: number[] = [];
  for (let i = 0; i < 4000; i += 1) {
    let sum = 0;
    for (let j = 0; j < values.length; j += 1) sum += values[Math.floor(random() * values.length)]!;
    draws.push(sum / values.length);
  }
  draws.sort((a, b) => a - b);
  return {
    ...base,
    ci95: [draws[99]!, draws[3899]!],
    note: `${values.length < 8 ? 'Few independent tasks; interval is unstable. ' : ''}Seeded percentile task-cluster bootstrap; equal task weights. Conditional on eligible observed pairs; it does not account for excluded pairs, task selection or author visibility.`,
  };
}

function rate(values: readonly (boolean | null)[]): Rate {
  const known = values.filter((value): value is boolean => value !== null);
  const numerator = known.filter(Boolean).length;
  return { numerator, denominator: known.length, unknown: values.length - known.length, rate: known.length > 0 ? numerator / known.length : null };
}

function summary(variant: string, observations: readonly Observation[], planned: readonly PlannedObservation[]): VariantSummary {
  const rows = observations.filter((row) => row.variant === variant);
  const eligible = rows.filter((row) => ELIGIBLE.has(row.outcome));
  const attempted = rows.filter((row) => row.outcome !== 'not_run' && row.outcome !== 'unsupported');
  const outcomes = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, rows.filter((row) => row.outcome === outcome).length])) as Record<Outcome, number>;
  const resources = Object.fromEntries(METRICS.map((metric) => {
    const values = attempted.map((row) => row[metric]).filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0);
    return [metric, { total: values.length > 0 ? values.reduce((a, b) => a + b, 0) : null, known: values.length, unknown: attempted.length - values.length, mean: mean(values) }];
  })) as Record<Metric, MetricSummary>;
  return {
    variant, planned: planned.filter((row) => row.variant === variant).length,
    observations: rows.length, independentTasks: new Set(eligible.map((row) => row.taskId)).size,
    outcomes, capabilityEligible: eligible.length,
    artifactCorrect: rate(eligible.map((row) => row.artifactCorrect)),
    completeDelivery: rate(eligible.map((row) => row.completeDelivery)),
    passed: rate(eligible.map((row) => row.outcome === 'passed')),
    resources, estimatedUsd: null,
  };
}

function metricValue(row: Observation, metric: PairedMetric): number | null {
  if (metric === 'passed') return Number(row.outcome === 'passed');
  if (metric === 'artifactCorrect' || metric === 'completeDelivery') return row[metric] === null ? null : Number(row[metric]);
  return row[metric];
}

function compare(baseline: string, candidate: string, rows: readonly Observation[], planned: readonly PlannedObservation[], seed: number): Comparison {
  const relevant = planned.filter((row) => row.variant === baseline || row.variant === candidate);
  const pairKeys = sortedUnique(relevant.map(pairKey));
  const pairs: PairRow[] = pairKeys.map((key) => {
    const [suite, taskId, repeat] = JSON.parse(key) as [BenchSuite, string, number];
    const baselineRows = rows.filter((row) => suiteOf(row) === suite && row.taskId === taskId && row.repeat === repeat && row.variant === baseline);
    const candidateRows = rows.filter((row) => suiteOf(row) === suite && row.taskId === taskId && row.repeat === repeat && row.variant === candidate);
    const a = baselineRows[0];
    const b = candidateRows[0];
    let exclusion: string | null = null;
    if (baselineRows.length !== 1 || candidateRows.length !== 1) exclusion = 'Missing or duplicate observation';
    else if (!ELIGIBLE.has(a!.outcome) || !ELIGIBLE.has(b!.outcome)) exclusion = `Excluded outcomes: ${a!.outcome}/${b!.outcome}`;
    const differences = Object.fromEntries(PAIRED_METRICS.map((metric) => {
      const av = a && exclusion === null ? metricValue(a, metric) : null;
      const bv = b && exclusion === null ? metricValue(b, metric) : null;
      return [metric, av === null || bv === null ? null : bv - av];
    })) as Record<PairedMetric, number | null>;
    return { taskId, repeat, baselineId: a?.id ?? null, candidateId: b?.id ?? null, eligible: exclusion === null, exclusion, differences };
  });
  const tasks = sortedUnique(pairs.map((pair) => pair.taskId)).map((taskId): TaskDifference => {
    const taskPairs = pairs.filter((pair) => pair.taskId === taskId);
    const values = (metric: PairedMetric): number[] => taskPairs.map((pair) => pair.differences[metric]).filter((value): value is number => value !== null);
    return {
      taskId,
      differences: Object.fromEntries(PAIRED_METRICS.map((metric) => [metric, mean(values(metric))])) as Record<PairedMetric, number | null>,
      pairedRepeats: Object.fromEntries(PAIRED_METRICS.map((metric) => [metric, values(metric).length])) as Record<PairedMetric, number>,
    };
  });
  const metrics = Object.fromEntries(PAIRED_METRICS.map((metric, index) => {
    const differences = tasks.map((task) => task.differences[metric]).filter((value): value is number => value !== null);
    return [metric, interval(differences, tasks.reduce((sum, task) => sum + task.pairedRepeats[metric], 0), seed + index)];
  })) as Record<PairedMetric, Interval>;
  const differences = tasks.map((task) => task.differences.passed).filter((value): value is number => value !== null);
  return {
    baseline, candidate, plannedPairs: pairs.length, eligiblePairs: pairs.filter((pair) => pair.eligible).length,
    excludedPairs: pairs.filter((pair) => !pair.eligible).length, pairs, tasks, metrics,
    winsTiesLosses: { wins: differences.filter((value) => value > 0).length, ties: differences.filter((value) => value === 0).length, losses: differences.filter((value) => value < 0).length, tasks: differences.length },
  };
}

/** No I/O, credential loading, live calls, repricing or selective failure deletion. */
export function buildReport(observations: readonly Observation[], planned: readonly PlannedObservation[], seed: number): CapabilityReport {
  if (!Number.isInteger(seed)) throw new Error('Report seed must be an integer');
  const planIds = new Map<string, PlannedObservation>();
  const planKeys = new Set<string>();
  const taskMetadata = new Map<string, string>();
  for (const row of planned) {
    const identity = identityKey(row);
    const taskIdentity = JSON.stringify([suiteOf(row), row.taskId]);
    if (planIds.has(identity) || planKeys.has(keyFor(row))) throw new Error(`Duplicate planned observation: ${row.id}`);
    if (!Number.isInteger(row.repeat) || row.repeat < 0) throw new Error(`Invalid repeat: ${row.id}`);
    const metadata = JSON.stringify([row.category, row.split, row.discovery]);
    if (taskMetadata.has(taskIdentity) && taskMetadata.get(taskIdentity) !== metadata) throw new Error(`Inconsistent task metadata: ${row.taskId}`);
    taskMetadata.set(taskIdentity, metadata);
    planIds.set(identity, row);
    planKeys.add(keyFor(row));
  }
  const warnings: string[] = [];
  const counts = new Map<string, number>();
  for (const row of observations) counts.set(identityKey(row), (counts.get(identityKey(row)) ?? 0) + 1);
  const normalized = observations.map((row): Observation => {
    const plan = planIds.get(identityKey(row));
    const issues: string[] = [];
    if (!OUTCOMES.includes(row.outcome)) issues.push('Unknown outcome');
    for (const verdict of ['artifactCorrect', 'completeDelivery'] as const) if (row[verdict] !== null && typeof row[verdict] !== 'boolean') issues.push(`Invalid verdict: ${verdict}`);
    if (!plan) issues.push('Unplanned observation');
    else if (keyFor(row) !== keyFor(plan) || row.category !== plan.category || row.split !== plan.split || row.discovery !== plan.discovery) issues.push('Observation metadata does not match the frozen plan');
    if ((counts.get(identityKey(row)) ?? 0) > 1) issues.push('Duplicate observation id; no attempt selected');
    for (const metric of METRICS) if (row[metric] !== null && (!Number.isFinite(row[metric]) || row[metric]! < 0)) issues.push(`Invalid measurement: ${metric}`);
    if (row.inputTokens !== null && row.cachedInputTokens !== null && row.cachedInputTokens > row.inputTokens) issues.push('Cached input exceeds total input');
    if (row.inputTokens !== null && row.cachedInputTokens !== null && row.nonCachedInputTokens !== null && row.inputTokens !== row.cachedInputTokens + row.nonCachedInputTokens) issues.push('Input partition does not match total input');
    if (row.outcome === 'passed' && (row.artifactCorrect !== true || row.completeDelivery !== true)) issues.push('Passed outcome lacks correct artifact or complete delivery');
    if (issues.length === 0) return row;
    warnings.push(`${row.id}: ${issues.join('; ')}`);
    return { ...row, outcome: 'invalid', reason: [row.reason, ...issues].filter(Boolean).join('; ') };
  });
  for (const row of planned) if (!counts.has(identityKey(row))) normalized.push({ ...row, ...NULL_MEASUREMENTS, outcome: 'not_run', artifactCorrect: null, completeDelivery: null, reason: 'No observation was recorded' });
  const groups: ReportGroup[] = [];
  const labelSuites = [...planned, ...observations].some((row) => row.suite !== undefined);
  const suites = sortedUnique(planned.map(suiteOf)) as BenchSuite[];
  const modes = sortedUnique(planned.map((row) => row.mode)) as BenchMode[];
  for (const suite of suites) for (const mode of modes) for (const budgetProfile of sortedUnique(planned.filter((row) => suiteOf(row) === suite && row.mode === mode).map((row) => row.budgetProfile))) {
    const basePlan = planned.filter((row) => suiteOf(row) === suite && row.mode === mode && row.budgetProfile === budgetProfile);
    const categories: (string | null)[] = [null, ...sortedUnique(basePlan.map((row) => row.category))];
    const splits: (BenchSplit | null)[] = [null, ...sortedUnique(basePlan.map((row) => row.split)) as BenchSplit[]];
    for (const category of categories) for (const split of splits) {
      const discoveries: ('natural' | 'protocol' | null)[] = category === null && split === null
        ? [null, ...sortedUnique(basePlan.flatMap((row) => row.discovery === undefined ? [] : [row.discovery])) as ('natural' | 'protocol')[]]
        : [null];
      for (const discovery of discoveries) {
        const matches = (row: PlannedObservation): boolean => suiteOf(row) === suite && row.mode === mode && row.budgetProfile === budgetProfile && (category === null || row.category === category) && (split === null || row.split === split) && (discovery === null || row.discovery === discovery);
        const subsetPlan = basePlan.filter(matches);
        if (subsetPlan.length === 0) continue;
        const subsetRows = normalized.filter(matches);
        const variants = sortedUnique(subsetPlan.map((row) => row.variant));
        const baseline = variants.includes('baseline') ? 'baseline' : variants.includes('hakimi-patch') ? 'hakimi-patch' : null;
        groups.push({
          suite: labelSuites ? suite : undefined,
          mode, budgetProfile, category, split, discovery, official: mode === 'live',
          variants: variants.map((variant) => summary(variant, subsetRows, subsetPlan)),
          comparisons: baseline === null ? [] : variants.filter((variant) => variant !== baseline).map((candidate) => compare(baseline, candidate, subsetRows, subsetPlan, seed)),
        });
      }
    }
  }
  if (new Set([...planned, ...observations].map(suiteOf)).size > 1) warnings.push('Multiple benchmark suites are retained in separate groups. No pairing, capability rate or resource statistic pools different suite versions.');
  if (new Set(observations.map((row) => row.mode)).size > 1) warnings.push('Multiple modes are retained but reported separately; offline results are not live capability evidence.');
  if (planned.some((row) => row.variant === 'pi')) warnings.push('Pi is an extension point only. Unsupported functionality is excluded; use only a pinned implemented adapter on shared tasks.');
  return {
    schemaVersion: 1, seed, bootstrapIterations: 4000, planned, sourceObservations: observations,
    observations: normalized, groups, warnings, estimatedUsd: null,
    costNote: 'No verified pricing table is attached. Subscription/OAuth token usage is not a dollar bill; no USD cost is inferred.',
    limitations: [
      'Task authors can inspect the corpus and hidden checkers. Acceptance tasks are held out from tuning by process, not cryptographic secrecy.',
      'Repeats measure within-task variation; independent sample size is the number of tasks. The task corpus does not represent all real-world work.',
      'Invalid, unsupported and missing observations are excluded from capability rates and pairing, with explicit denominators. Exclusion can bias estimates.',
      'Resource totals include failed, invalid and budget-aborted attempts with coverage. Paired efficiency differences require both valid observations and both measurements; they are not success-conditioned.',
      'Resource totals sum reported observation rows. Duplicate ids are retained and disqualified; their resource entries may double count the same execution. The durable request ledger is authoritative for budget accounting.',
      'Input-token totals, wall time and requests are separate observations. Token usage is observed after responses and is not an in-flight hard cap.',
    ],
  };
}

const cell = (value: string): string => value.replaceAll('|', '\\|').replaceAll('\n', ' ');
const number = (value: number | null): string => value === null ? 'unknown' : Number.isInteger(value) ? String(value) : value.toFixed(4);
const rateText = (value: Rate): string => `${value.numerator}/${value.denominator}${value.unknown ? ` (+${value.unknown} unknown)` : ''}`;

/** Markdown rendering; serialize buildReport's result directly for lossless JSON. */
export function renderReport(report: CapabilityReport): string {
  const labelSuites = [...report.planned, ...report.observations].some((row) => row.suite !== undefined);
  const lines = [
    '# Hakimi capability benchmark v2', '',
    `Seed: ${report.seed}. Planned rows: ${report.planned.length}. Recorded rows: ${report.sourceObservations.length}.`, '',
    'Live and offline results are separate. Differences below are candidate minus baseline; lower resource use and higher correctness/delivery are favorable. Repeats are averaged within each task before the task-cluster bootstrap.', '',
    report.costNote, '',
  ];
  if (labelSuites) lines.push(`Suites: ${sortedUnique([...report.planned, ...report.observations].map(suiteOf)).join(', ')}. Historical rows without a suite field are v1. Different suites are never pooled.`, '');
  for (const group of report.groups) {
    lines.push(`## ${group.suite === undefined ? '' : `${group.suite} / `}${group.mode} / ${cell(group.budgetProfile)} / ${cell(group.category ?? 'all categories')} / ${group.split ?? 'all splits'} / ${group.discovery ?? 'all discovery styles'}`, '',
      `${group.official ? 'Live observations' : 'Pipeline evidence only; not a live capability score'}.`, '',
      '| Variant | Planned | Eligible | Tasks | Correct artifact | Complete delivery | Passed | Failed | Budget | Invalid | Missing | Unsupported |',
      '| --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const variant of group.variants) lines.push(`| ${cell(variant.variant)} | ${variant.planned} | ${variant.capabilityEligible} | ${variant.independentTasks} | ${rateText(variant.artifactCorrect)} | ${rateText(variant.completeDelivery)} | ${variant.outcomes.passed} | ${variant.outcomes.failed} | ${variant.outcomes.budget_exhausted} | ${variant.outcomes.invalid} | ${variant.outcomes.not_run} | ${variant.outcomes.unsupported} |`);
    // Detailed resource rows are shown once per mode/budget; all slices remain in JSON.
    if (group.category === null && group.split === null) {
      lines.push('', '| Variant | Resource | Total | Known / attempted |', '| --- | --- | ---: | ---: |');
      for (const variant of group.variants) for (const metric of METRICS) {
        const resource = variant.resources[metric];
        lines.push(`| ${cell(variant.variant)} | ${metric} | ${number(resource.total)} | ${resource.known}/${resource.known + resource.unknown} |`);
      }
    }
    for (const comparison of group.comparisons) {
      const wtl = comparison.winsTiesLosses;
      lines.push('', `${cell(comparison.candidate)} vs ${cell(comparison.baseline)}: ${comparison.eligiblePairs}/${comparison.plannedPairs} eligible repeat pairs; ${comparison.excludedPairs} excluded. Task success-rate wins/ties/losses: ${wtl.wins}/${wtl.ties}/${wtl.losses} (${wtl.tasks} tasks).`, '',
        '| Paired metric | Mean difference | 95% task bootstrap interval | Independent tasks | Repeat pairs |', '| --- | ---: | --- | ---: | ---: |');
      for (const metric of PAIRED_METRICS) {
        const stat = comparison.metrics[metric];
        lines.push(`| ${metric} | ${number(stat.meanDifference)} | ${stat.ci95 === null ? 'unavailable' : stat.ci95.map(number).join(' to ')} | ${stat.independentTasks} | ${stat.pairedRepeats} |`);
      }
      if (group.category === null && group.split === null) {
        lines.push('', '| Task | Paired repeats | Success difference | Artifact difference | Delivery difference |', '| --- | ---: | ---: | ---: | ---: |');
        for (const task of comparison.tasks) lines.push(`| ${cell(task.taskId)} | ${task.pairedRepeats.passed} | ${number(task.differences.passed)} | ${number(task.differences.artifactCorrect)} | ${number(task.differences.completeDelivery)} |`);
      }
    }
    lines.push('');
  }
  lines.push('## Non-success and invalid observation inventory', '', labelSuites ? '| Suite | Observation | Task | Variant | Outcome | Reason |' : '| Observation | Task | Variant | Outcome | Reason |', labelSuites ? '| --- | --- | --- | --- | --- | --- |' : '| --- | --- | --- | --- | --- |');
  for (const row of report.observations.filter((row) => row.outcome !== 'passed')) lines.push(`| ${labelSuites ? `${suiteOf(row)} | ` : ''}${cell(row.id)} | ${cell(row.taskId)} | ${cell(row.variant)} | ${row.outcome} | ${cell(row.reason ?? 'not supplied')} |`);
  lines.push('', '## Interpretation limits', '');
  for (const warning of report.warnings) lines.push(`- ${warning}`);
  for (const limitation of report.limitations) lines.push(`- ${limitation}`);
  lines.push('- The 95% intervals are percentile bootstrap intervals over tasks; fewer than eight tasks give unstable intervals, and fewer than two give none. Read them with missing-pair and measurement coverage counts.', '');
  return lines.join('\n');
}
