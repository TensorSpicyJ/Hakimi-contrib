import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import {
  buildReport, renderReport, type BenchSuite, type Observation, type PlannedObservation, type ReportGroup,
} from '../examples/gpt-capability-bench.report.js';

function observation(id: string, overrides: Partial<Observation> = {}): Observation {
  return {
    id, taskId: 'task-a', category: 'simple', split: 'development', variant: 'baseline', repeat: 0,
    budgetProfile: 'generous', mode: 'live', outcome: 'passed', artifactCorrect: true, completeDelivery: true,
    durationMs: 1000, requests: 2, inputTokens: 100, cachedInputTokens: 40, nonCachedInputTokens: 60,
    outputTokens: 20, toolErrors: 0, repeatedAttempts: 0, manualInterventions: 0,
    ...overrides,
  };
}

function aggregate(rows: readonly Observation[], planned: readonly PlannedObservation[] = rows): ReportGroup {
  return buildReport(rows, planned, 20260927).groups.find((group) => group.category === null && group.split === null)!;
}

describe('capability benchmark report', () => {
  test('preserves legacy v1 JSON and Markdown bytes when suite was never recorded', () => {
    const rows = [observation('base'), observation('catalog', { variant: 'catalog', outcome: 'failed', artifactCorrect: false, completeDelivery: false })];
    const report = buildReport(rows, rows, 42);
    const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
    // Frozen before suite isolation was introduced. These protect historical report reconstruction.
    expect(digest(JSON.stringify(report))).toBe('292b996dddc90ccbebf1dd53141a2dc0d1a6a882297d5dc224f28983baaa0a37');
    expect(digest(renderReport(report))).toBe('6b66226506127ef52a239620b9e81193b74b56938a83be42f0ab37d90c825796');
    expect(JSON.stringify(report)).not.toContain('"suite"');
    expect(report.sourceObservations).toBe(rows);
  });

  test('preserves explicit v2 JSON and Markdown bytes when adding v3 support', () => {
    const rows = [observation('base', { suite: 'v2' }), observation('catalog', { suite: 'v2', variant: 'catalog', outcome: 'failed', artifactCorrect: false, completeDelivery: false })];
    const report = buildReport(rows, rows, 42);
    const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
    expect(digest(JSON.stringify(report))).toBe('a1623076b57e113eb79d4e0b3ae8505c9b3e5173ab356326d45cacb998b75b6b');
    expect(digest(renderReport(report))).toBe('c32d36286b5888edbf5d273ef9a6d3ac0c493c6bb43b991844ceac208f5b29ab');
  });

  test('isolates v3 from both legacy v1 and explicit v2 even with reused ids', () => {
    const rows = [
      observation('base'), observation('catalog', { variant: 'catalog' }),
      observation('base', { suite: 'v2', outcome: 'failed', artifactCorrect: false, completeDelivery: false }),
      observation('catalog', { suite: 'v2', variant: 'catalog' }),
      observation('base', { suite: 'v3' }),
      observation('catalog', { suite: 'v3', variant: 'catalog', outcome: 'failed', artifactCorrect: false, completeDelivery: false }),
    ];
    const report = buildReport(rows, rows, 42);
    const overall = report.groups.filter((group) => group.category === null && group.split === null && group.discovery === null);
    expect(overall.map((group) => group.suite)).toEqual(['v1', 'v2', 'v3']);
    expect(overall.map((group) => group.comparisons[0]?.metrics.passed.meanDifference)).toEqual([0, 1, -1]);
    expect(overall.every((group) => group.comparisons[0]?.metrics.passed.independentTasks === 1)).toBe(true);
    expect(overall.every((group) => group.variants.every((variant) => variant.observations === 1))).toBe(true);
    expect(report.observations.filter((row) => row.outcome === 'invalid')).toHaveLength(0);
    expect(renderReport(report)).toContain('Suites: v1, v2, v3.');
    expect(renderReport(report)).toContain('## v3 / live');
  });

  test('does not fill a missing v3 counterpart from an otherwise matching v2 observation', () => {
    const v2Base = observation('base', { suite: 'v2' });
    const v2Catalog = observation('catalog', { suite: 'v2', variant: 'catalog' });
    const v3Base = observation('base', { suite: 'v3' });
    const v3Catalog = observation('catalog', { suite: 'v3', variant: 'catalog' });
    const report = buildReport([v2Base, v3Catalog], [v2Base, v2Catalog, v3Base, v3Catalog], 42);
    expect(report.observations.filter((row) => row.outcome === 'not_run')).toHaveLength(2);
    const overall = report.groups.filter((group) => group.category === null && group.split === null && group.discovery === null);
    expect(overall).toHaveLength(2);
    for (const group of overall) {
      expect(group.comparisons[0]?.eligiblePairs).toBe(0);
      expect(group.comparisons[0]?.winsTiesLosses).toEqual({ wins: 0, ties: 0, losses: 0, tasks: 0 });
      expect(group.comparisons[0]?.metrics.requests.meanDifference).toBeNull();
    }
  });

  test('separates identical task and observation ids across suites instead of pooling differences', () => {
    const legacy = [observation('base'), observation('catalog', { variant: 'catalog' })];
    const current = [observation('base', { suite: 'v2' }), observation('catalog', { suite: 'v2', variant: 'catalog', outcome: 'failed', artifactCorrect: false, completeDelivery: false })];
    const report = buildReport([...legacy, ...current], [...legacy, ...current], 42);
    const overall = report.groups.filter((group) => group.category === null && group.split === null && group.discovery === null);
    expect(overall).toHaveLength(2);
    expect(overall.find((group) => group.suite === 'v1')!.comparisons[0]!.metrics.passed.meanDifference).toBe(0);
    expect(overall.find((group) => group.suite === 'v2')!.comparisons[0]!.metrics.passed.meanDifference).toBe(-1);
    expect(overall.every((group) => group.comparisons[0]!.metrics.passed.independentTasks === 1)).toBe(true);
    expect(report.observations.filter((row) => row.outcome === 'invalid')).toHaveLength(0);
    expect(report.warnings.join(' ')).toContain('different suite versions');
    expect(renderReport(report)).toContain('## v1 / live');
    expect(renderReport(report)).toContain('## v2 / live');
    expect(renderReport(report)).toContain('| Suite | Observation |');
  });

  test('never fills missing counterparts with the other suite even when ids and task ids match', () => {
    const oldBase = observation('base');
    const oldCatalog = observation('catalog', { variant: 'catalog' });
    const newBase = observation('base', { suite: 'v2' });
    const newCatalog = observation('catalog', { suite: 'v2', variant: 'catalog' });
    const report = buildReport([oldBase, newCatalog], [oldBase, oldCatalog, newBase, newCatalog], 42);
    const overall = report.groups.filter((group) => group.category === null && group.split === null && group.discovery === null);
    expect(report.observations.filter((row) => row.outcome === 'not_run')).toHaveLength(2);
    for (const group of overall) {
      expect(group.comparisons[0]!.eligiblePairs).toBe(0);
      expect(group.comparisons[0]!.winsTiesLosses).toEqual({ wins: 0, ties: 0, losses: 0, tasks: 0 });
      expect(group.comparisons[0]!.metrics.requests.meanDifference).toBeNull();
    }
  });

  test('interprets absent suite as v1 without mutating source rows and rejects duplicate aliases', () => {
    const base = observation('base');
    const catalog = observation('catalog', { variant: 'catalog', suite: 'v1' });
    const plan = [{ ...base, suite: 'v1' as const }, catalog];
    const report = buildReport([base, catalog], plan, 42);
    expect(report.groups[0]!.suite).toBe('v1');
    expect(report.groups[0]!.comparisons[0]!.eligiblePairs).toBe(1);
    expect(report.sourceObservations[0]).toBe(base);
    expect(Object.hasOwn(base, 'suite')).toBe(false);
    expect(() => buildReport([], [base, { ...base, suite: 'v1' }], 42)).toThrow('Duplicate planned observation');
  });

  test('rejects unknown suites and does not count an observation as a different planned version', () => {
    const base = observation('base');
    expect(() => buildReport([], [{ ...base, suite: 'v4' as BenchSuite }], 42)).toThrow('Unknown benchmark suite');
    expect(() => buildReport([{ ...base, suite: 'v4' as BenchSuite }], [], 42)).toThrow('Unknown benchmark suite');
    const report = buildReport([{ ...base, suite: 'v2' }], [base], 42);
    expect(report.observations.map((row) => row.outcome)).toEqual(['invalid', 'not_run']);
    expect(report.observations[0]!.reason).toContain('Unplanned observation');
    expect(report.groups[0]!.variants[0]!.capabilityEligible).toBe(0);
  });

  test('keeps failures, budgets, invalid observations, unsupported and missing rows with explicit denominators', () => {
    const rows = [
      observation('success'),
      observation('failure', { taskId: 'task-b', outcome: 'failed', artifactCorrect: false, completeDelivery: false, toolErrors: 2 }),
      observation('budget', { taskId: 'task-c', outcome: 'budget_exhausted', artifactCorrect: true, completeDelivery: false, repeatedAttempts: 3 }),
      observation('invalid', { taskId: 'task-d', outcome: 'invalid', reason: 'proxy disconnected', artifactCorrect: null, completeDelivery: null, manualInterventions: 1 }),
      observation('unsupported', { taskId: 'task-e', outcome: 'unsupported', artifactCorrect: null, completeDelivery: null }),
    ];
    const planned = [...rows, observation('missing', { taskId: 'task-f' })];
    const report = buildReport(rows, planned, 42);
    const variant = aggregate(rows, planned).variants[0]!;
    expect(report.sourceObservations).toEqual(rows);
    expect(report.observations).toHaveLength(6);
    expect(variant.planned).toBe(6);
    expect(variant.capabilityEligible).toBe(3);
    expect(variant.artifactCorrect).toEqual({ numerator: 2, denominator: 3, unknown: 0, rate: 2 / 3 });
    expect(variant.completeDelivery.rate).toBe(1 / 3);
    expect(variant.outcomes).toEqual({ passed: 1, failed: 1, budget_exhausted: 1, invalid: 1, not_run: 1, unsupported: 1 });
    expect(variant.resources.requests).toEqual({ total: 8, mean: 2, known: 4, unknown: 0 });
    expect(variant.resources.toolErrors.total).toBe(2);
    expect(variant.resources.repeatedAttempts.total).toBe(3);
    expect(variant.resources.manualInterventions.total).toBe(1);
    expect(report.estimatedUsd).toBeNull();
    expect(report.costNote).toContain('not a dollar bill');
  });

  test('averages repeats within tasks before estimating paired differences and uncertainty', () => {
    const rows: Observation[] = [];
    for (let repeat = 0; repeat < 4; repeat += 1) {
      rows.push(observation(`a-base-${repeat}`, { repeat, outcome: 'failed', artifactCorrect: false, completeDelivery: false }));
      rows.push(observation(`a-cat-${repeat}`, { repeat, variant: 'catalog', requests: 1 }));
    }
    rows.push(observation('b-base', { taskId: 'task-b' }));
    rows.push(observation('b-cat', { taskId: 'task-b', variant: 'catalog', outcome: 'failed', artifactCorrect: false, completeDelivery: false, requests: 5 }));
    const comparison = aggregate(rows).comparisons[0]!;
    expect(comparison.eligiblePairs).toBe(5);
    expect(comparison.metrics.passed).toMatchObject({ independentTasks: 2, pairedRepeats: 5, meanDifference: 0, ci95: [-1, 1] });
    expect(comparison.metrics.requests.meanDifference).toBe(1); // mean(-1, +3), not mean over five repeats
    expect(comparison.winsTiesLosses).toEqual({ wins: 1, ties: 0, losses: 1, tasks: 2 });
    expect(comparison.tasks[0]!.pairedRepeats.passed).toBe(4);
    expect(comparison.metrics.passed.note).toContain('Few independent tasks');
    expect(buildReport(rows, rows, 20260927).groups).toEqual(buildReport(rows.toReversed(), rows, 20260927).groups);
  });

  test('does not turn missing or invalid pairs into ties or capability failures', () => {
    const base = observation('base');
    const catalog = observation('catalog', { variant: 'catalog' });
    const missing = aggregate([base], [base, catalog]).comparisons[0]!;
    expect(missing.winsTiesLosses).toEqual({ wins: 0, ties: 0, losses: 0, tasks: 0 });
    expect(missing.metrics.passed.meanDifference).toBeNull();
    expect(missing.metrics.passed.ci95).toBeNull();
    expect(missing.pairs[0]!.exclusion).toContain('not_run');
    const invalid = aggregate([base, { ...catalog, outcome: 'invalid', reason: 'measurement lost' }]).comparisons[0]!;
    expect(invalid.eligiblePairs).toBe(0);
    expect(invalid.excludedPairs).toBe(1);
  });

  test('records correct artifact and incomplete delivery independently for budget exhaustion', () => {
    const rows = [
      observation('base', { outcome: 'budget_exhausted', artifactCorrect: true, completeDelivery: false }),
      observation('catalog', { variant: 'catalog' }),
    ];
    const comparison = aggregate(rows).comparisons[0]!;
    expect(comparison.metrics.artifactCorrect.meanDifference).toBe(0);
    expect(comparison.metrics.completeDelivery.meanDifference).toBe(1);
    expect(comparison.metrics.passed.meanDifference).toBe(1);
    expect(comparison.metrics.passed.ci95).toBeNull();
  });

  test('unknown metrics remain null with coverage; valid zeros remain zero', () => {
    const rows = [
      observation('base', { inputTokens: null, cachedInputTokens: null, nonCachedInputTokens: null, outputTokens: null, toolErrors: null }),
      observation('catalog', { variant: 'catalog', inputTokens: 0, cachedInputTokens: 0, nonCachedInputTokens: 0, outputTokens: 0 }),
    ];
    const group = aggregate(rows);
    expect(group.variants[0]!.resources.inputTokens).toEqual({ total: null, known: 0, unknown: 1, mean: null });
    expect(group.variants[1]!.resources.inputTokens).toEqual({ total: 0, known: 1, unknown: 0, mean: 0 });
    expect(group.comparisons[0]!.metrics.inputTokens).toMatchObject({ independentTasks: 0, pairedRepeats: 0, meanDifference: null });
    expect(group.comparisons[0]!.metrics.passed.pairedRepeats).toBe(1);
    expect(JSON.stringify(buildReport(rows, rows, 1))).not.toContain('NaN');
  });

  test('retains duplicate attempts and disqualifies all copies instead of choosing a favorable one', () => {
    const base = observation('base');
    const catalog = observation('catalog', { variant: 'catalog' });
    const rows = [base, catalog, { ...catalog, outcome: 'failed' as const, artifactCorrect: false }];
    const report = buildReport(rows, [base, catalog], 1);
    expect(report.sourceObservations).toHaveLength(3);
    expect(report.observations.filter((row) => row.outcome === 'invalid')).toHaveLength(2);
    expect(report.warnings).toHaveLength(2);
    expect(report.groups[0]!.comparisons[0]!.eligiblePairs).toBe(0);
    expect(report.groups[0]!.variants.find((row) => row.variant === 'catalog')!.resources.requests.total).toBe(4);
  });

  test('validates metadata and measurements without discarding the source rows', () => {
    const plan = observation('base');
    for (const change of [
      { inputTokens: -1 }, { durationMs: Number.NaN }, { cachedInputTokens: 101 },
      { nonCachedInputTokens: 2 }, { split: 'acceptance' as const }, { artifactCorrect: false },
    ]) {
      const row = { ...plan, ...change };
      const report = buildReport([row], [plan], 1);
      expect(report.sourceObservations[0]).toBe(row);
      expect(report.observations[0]!.outcome).toBe('invalid');
      expect(report.warnings.length).toBeGreaterThan(0);
    }
    const unplanned = buildReport([plan], [], 1);
    expect(unplanned.observations[0]!.reason).toContain('Unplanned');
  });

  test('separates all six categories, development/acceptance, modes and budgets', () => {
    const categories = ['simple', 'project', 'features', 'long', 'research', 'recovery'];
    const rows = categories.flatMap((category, i) => ['baseline', 'catalog'].map((variant) => observation(`${category}-${variant}`, {
      taskId: `task-${i}`, category, variant, split: i % 2 ? 'acceptance' : 'development',
    })));
    rows.push(observation('offline-base', { mode: 'offline' }));
    rows.push(observation('offline-catalog', { mode: 'offline', variant: 'catalog' }));
    rows.push(observation('tight-base', { budgetProfile: 'tight' }));
    rows.push(observation('tight-catalog', { budgetProfile: 'tight', variant: 'catalog' }));
    const report = buildReport(rows, rows, 1);
    expect(report.groups.filter((group) => group.mode === 'live' && group.budgetProfile === 'generous' && group.category !== null && group.split === null)).toHaveLength(6);
    const acceptance = report.groups.find((group) => group.mode === 'live' && group.budgetProfile === 'generous' && group.category === null && group.split === 'acceptance')!;
    expect(acceptance.comparisons[0]!.metrics.passed.independentTasks).toBe(3);
    expect(report.groups.filter((group) => group.mode === 'offline').every((group) => !group.official)).toBe(true);
    expect(report.groups.find((group) => group.mode === 'live' && group.budgetProfile === 'tight')!.comparisons[0]!.eligiblePairs).toBe(1);
    expect(report.warnings.join(' ')).toContain('reported separately');
  });

  test('Pi unsupported probes are outside shared-task scores', () => {
    const rows = [observation('base'), observation('pi', { variant: 'pi', outcome: 'unsupported', artifactCorrect: null, completeDelivery: null })];
    const report = buildReport(rows, rows, 1);
    const comparison = report.groups[0]!.comparisons[0]!;
    expect(comparison.eligiblePairs).toBe(0);
    expect(comparison.winsTiesLosses.losses).toBe(0);
    expect(report.warnings.join(' ')).toContain('extension point only');
  });

  test('keeps protocol probes and natural discovery separately interpretable', () => {
    const rows = [
      observation('natural-base', { discovery: 'natural' }),
      observation('natural-cat', { discovery: 'natural', variant: 'catalog' }),
      observation('probe-base', { taskId: 'probe', discovery: 'protocol' }),
      observation('probe-cat', { taskId: 'probe', discovery: 'protocol', variant: 'catalog', outcome: 'failed', artifactCorrect: false, completeDelivery: false }),
    ];
    const report = buildReport(rows, rows, 1);
    expect(report.groups.find((group) => group.discovery === 'natural')!.comparisons[0]!.metrics.passed.meanDifference).toBe(0);
    expect(report.groups.find((group) => group.discovery === 'protocol')!.comparisons[0]!.metrics.passed.meanDifference).toBe(-1);
    expect(renderReport(report)).toContain('all splits / protocol');
  });

  test('rejects ambiguous plans instead of silently changing the paired experiment', () => {
    const row = observation('base');
    expect(() => buildReport([], [row, row], 1)).toThrow('Duplicate planned');
    expect(() => buildReport([], [row, { ...row, id: 'other' }], 1)).toThrow('Duplicate planned');
    expect(() => buildReport([], [row, { ...row, id: 'other', repeat: 1, split: 'acceptance' }], 1)).toThrow('Inconsistent task metadata');
    expect(() => buildReport([], [{ ...row, repeat: -1 }], 1)).toThrow('Invalid repeat');
    expect(() => buildReport([], [], Number.NaN)).toThrow('seed');
  });

  test('renders failure inventory, costs, measurement coverage and cautions', () => {
    const rows = [observation('base', { outcome: 'invalid', reason: 'a|b\nc' })];
    const report = buildReport(rows, rows, 1);
    const markdown = renderReport(report);
    expect(markdown).toContain('a\\|b c');
    expect(markdown).toContain('Known / attempted');
    expect(markdown).toContain('Subscription/OAuth');
    expect(markdown).toContain('Task authors can inspect');
    expect(markdown).toContain('Non-success and invalid observation inventory');
    expect(JSON.parse(JSON.stringify(report)).sourceObservations).toEqual(rows);
  });
});
