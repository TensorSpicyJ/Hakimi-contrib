import { describe, expect, it } from 'vitest';
import {
  projectSubagentPresetEvaluatedPayload,
  projectSubagentPresetStatus,
  subagentPresetStatusSchema,
} from '../src/protocol/rest-config';
import { aggregatePresetStatus, softPeakPresetStatus } from './helpers/autoSubagentPreset';
import { toAppAutoSubagentPresetStatus, toAppEvent } from '../../../apps/kimi-web/src/api/daemon/mappers';

describe('automatic preset safe projection', () => {
  it.each([aggregatePresetStatus, softPeakPresetStatus])('round-trips the typed core contract through REST and Web/WS mappers without losing fields (%#)', (fixture) => {
    const core = fixture();
    const wire = projectSubagentPresetStatus(core)!;
    expect(toAppAutoSubagentPresetStatus(wire)).toEqual(core);
    expect(toAppEvent({
      type: 'event.subagent.preset_evaluated', session_id: 'session-a',
      seq: 1, timestamp: new Date(core.evaluatedAt).toISOString(), payload: wire,
    })).toMatchObject({ type: 'subagentPresetEvaluated', sessionId: 'session-a', status: core });
  });
  it('projects the complete core aggregate contract without inventing quota or cost', () => {
    const core = aggregatePresetStatus();
    const result = projectSubagentPresetStatus(core)!;
    expect(subagentPresetStatusSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      evaluation_scope: 'preset',
      candidates: [{
        participating: true, native_score: 40, score: 75, role_count: 2,
        native_available_role_count: 1, fallback_role_count: 1, unavailable_role_count: 0,
        total_role_weight: 2,
        coverage: { resource_provider_count: 2, total_provider_count: 2, local_evidence_role_count: 2, total_role_count: 2 },
        role_scores: [
          { key: 'custom_role', original: { source: 'preset', availability: 'time_restricted',
            resource: { kind: 'metered', balance_cny: '12.34567890123456789', resource_score: 100,
              resource_score_basis: 'funded_account', blocked_until: 1_750_003_600_000,
              metered_usage: { source: 'local', cost_source: 'estimated', timezone: 'Asia/Shanghai',
                tracking_started_at: null, degraded: true, today: { estimated_cost: null },
                month: { estimated_cost: '0.0000123456789' } } } },
            effective: { source: 'auto-fallback', model_source: 'auto-fallback', thinking_source: 'auto-fallback',
              resource: { kind: 'subscription', quota_remaining_percent: 80,
                reset_priority: { window: { duration: 1, unit: 'week' }, reset_at: 1_750_003_600_000,
                  remaining_percent: 12, horizon_ms: 43_200_000, bonus: 117.5, floor_relaxed: true } } },
            effective_score: 70, fallback_penalty: 10,
            fallback: { source_preset: 'peak-safe', source_role: 'tower_worker', reason: 'time_restricted' } },
          { key: 'tower_worker', route: 'tower_worker', fallback_penalty: 0 },
        ],
      }],
      policy: { role_weights: { custom_role: 1, tower_worker: 1, zero_weight: 0 },
        deepseek_avoid_peak_hours: true, fallback_penalty: 10, metered_funded_resource_score: 100,
        reset_priority_window_ms: 259_200_000, reset_priority_exponent: 3, reset_priority_max_bonus: 200 },
    });
    expect(result.candidates[0]?.quota_remaining_percent).toBeUndefined();
    expect(result.candidates[0]?.role_scores?.[0]?.original.resource).not.toHaveProperty('quota_remaining_percent');
    expect(projectSubagentPresetEvaluatedPayload({ ...core, sessionId: 'session-a' }))
      .toEqual({ sessionId: 'session-a', status: result });
  });

  it('strips arbitrary extra fields at every object boundary, including WS payloads', () => {
    function taint(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(taint);
      if (typeof value !== 'object' || value === null) return value;
      return { ...Object.fromEntries(Object.entries(value).map(([key, child]) =>
        [key, key === 'roleWeights' ? child : taint(child)])),
      apiKey: 'SECRET_SENTINEL', endpoint: 'https://example.test/private', rawError: 'SECRET_SENTINEL' };
    }
    for (const fixture of [aggregatePresetStatus, softPeakPresetStatus]) {
      const tainted = taint({ ...fixture(), sessionId: 'session-a' });
      const projected = projectSubagentPresetEvaluatedPayload(tainted);
      expect(projected).toBeDefined();
      expect(JSON.stringify(projected)).not.toMatch(/SECRET_SENTINEL|apiKey|endpoint|rawError/);
    }
  });

  it('retains legacy single-route snapshots without labelling them aggregate', () => {
    const core = aggregatePresetStatus();
    const legacy = {
      evaluatedAt: core.evaluatedAt, route: core.route, profileName: 'coder', reasonCode: core.reasonCode,
      candidates: [{ preset: 'balanced', availability: 'healthy', selectable: true,
        contributions: core.candidates[0]!.contributions, localEvidence: core.candidates[0]!.localEvidence }],
      policy: core.policy,
    };
    const result = projectSubagentPresetStatus(legacy)!;
    expect(result).toBeDefined();
    expect(result.evaluation_scope).toBeUndefined();
    expect(result.candidates[0]?.role_scores).toBeUndefined();
  });

  it.each(['query_failed', 'invalid', 'missing'] as const)('preserves unknown monetary evidence: %s', (balanceStatus) => {
    const core = aggregatePresetStatus();
    const role = core.candidates[0]!.roleScores![0]!;
    const result = projectSubagentPresetStatus({ ...core, candidates: [{ ...core.candidates[0], roleScores: [{
      ...role, original: { ...role.original, resource: {
        kind: 'metered', currency: 'CNY', balanceStatus, resourceScoreBasis: 'funded_account',
      } },
      effective: { ...role.effective, resource: { kind: 'unknown', reason: 'unsupported' } },
    }] }] })!;
    expect(result.candidates[0]?.role_scores?.[0]?.original.resource).toEqual({
      kind: 'metered', currency: 'CNY', balance_status: balanceStatus, resource_score_basis: 'funded_account',
    });
  });

  it('strictly projects soft peak evidence and preserves historical hard blocks', () => {
    const core = softPeakPresetStatus();
    const candidate = core.candidates[0]!;
    const role = candidate.roleScores![1]!;
    const resource = role.effective.resource;
    const wire = projectSubagentPresetStatus(core)!;
    expect(wire).toMatchObject({ policy: { deepseek_peak_policy: 'penalize', deepseek_peak_penalty: 60 },
      candidates: [{ deepseek_role_share: 0.25, contributions: { peak_penalty: 15 }, role_scores: [
        { effective: { resource: { kind: 'subscription' } } },
        { effective: { availability: 'healthy', contributions: { peak_penalty: 60 }, resource: {
          kind: 'metered', peak_penalty: { points: 60, until: 1_750_003_600_000 } } } },
      ] }] });
    expect(subagentPresetStatusSchema.safeParse(wire).success).toBe(true);
    expect(wire.candidates[0]?.role_scores?.[1]?.effective.resource.blocked_until).toBeUndefined();
    const old = projectSubagentPresetStatus(aggregatePresetStatus())!;
    expect(old.policy.deepseek_peak_policy).toBeUndefined();
    expect(old.candidates[0]?.deepseek_role_share).toBeUndefined();
    expect(old.candidates[0]?.role_scores?.[0]?.original).toMatchObject({ availability: 'time_restricted',
      resource: { blocked_until: 1_750_003_600_000 } });
    const invalid = [
      ...[-0.1, 1.1, NaN, Infinity, null, '0.25'].map((deepseekRoleShare) => ({ ...core, candidates: [{ ...candidate, deepseekRoleShare }] })),
      ...[-1, NaN, Infinity, null, '60'].flatMap((points) => [
        { ...core, policy: { ...core.policy, deepseekPeakPenalty: points } },
        { ...core, candidates: [{ ...candidate, contributions: { ...candidate.contributions, peakPenalty: points } }] },
        { ...core, candidates: [{ ...candidate, roleScores: [{ ...role, effective: { ...role.effective,
          contributions: { ...role.effective.contributions, peakPenalty: points } } }] }] },
      ]),
      ...['allow', null, 0].map((deepseekPeakPolicy) => ({ ...core, policy: { ...core.policy, deepseekPeakPolicy } })),
      ...[null, {}, { points: -1, until: 0 }, { points: NaN, until: 0 }, { points: Infinity, until: 0 },
        ...[-1, 1.5, Infinity, NaN, 9e15, 'later', null].map((until) => ({ points: 60, until }))]
        .map((peakPenalty) => ({ ...core, candidates: [{ ...candidate, roleScores: [{ ...role,
          effective: { ...role.effective, resource: { ...resource, peakPenalty } } }] }] })),
    ];
    for (const value of invalid) {
      expect(projectSubagentPresetStatus(value)).toBeUndefined();
      expect(projectSubagentPresetEvaluatedPayload({ ...value, sessionId: 'session-a' })).toBeUndefined();
    }
    for (const mode of ['block', 'penalize', 'off'] as const) {
      const projected = projectSubagentPresetStatus({ ...core, policy: { ...core.policy, deepseekPeakPolicy: mode } })!;
      expect(toAppAutoSubagentPresetStatus(projected)?.policy.deepseekPeakPolicy).toBe(mode);
    }
  });

  it('keeps reset-priority evidence optional and rejects malformed expiring-window data', () => {
    const core = aggregatePresetStatus();
    const role = core.candidates[0]!.roleScores![0]!;
    const resource = role.effective.resource;
    if (resource.kind !== 'subscription' || resource.resetPriority === undefined) {
      throw new Error('fixture must carry subscription reset priority');
    }
    const without = projectSubagentPresetStatus({ ...core, candidates: [{ ...core.candidates[0], roleScores: [
      { ...role, effective: { ...role.effective, resource: { kind: 'subscription', quotaRemainingPercent: 80 } } },
      core.candidates[0]!.roleScores![1]!] }] })!;
    expect(without.candidates[0]?.role_scores?.[0]?.effective.resource)
      .toMatchObject({ kind: 'subscription', reset_priority: undefined });
    expect(JSON.stringify(without.candidates[0]?.role_scores?.[0]?.effective.resource))
      .not.toContain('reset_priority');
    const invalid = [
      { ...resource.resetPriority, window: { duration: 1, unit: 'month' } },
      { ...resource.resetPriority, window: { duration: 0, unit: 'week' } },
      { ...resource.resetPriority, window: { duration: 'week', unit: 'week' } },
      { ...resource.resetPriority, resetAt: Infinity },
      { ...resource.resetPriority, resetAt: 1.5 },
      { ...resource.resetPriority, remainingPercent: 101 },
      { ...resource.resetPriority, remainingPercent: '12' },
      { ...resource.resetPriority, horizonMs: -1 },
      { ...resource.resetPriority, bonus: NaN },
      { ...resource.resetPriority, bonus: -0.5 },
      { ...resource.resetPriority, floorRelaxed: 'yes' },
    ];
    for (const resetPriority of invalid) {
      const value = { ...core, candidates: [{ ...core.candidates[0], roleScores: [{ ...role,
        effective: { ...role.effective, resource: { ...resource, resetPriority } } }] }] };
      expect(projectSubagentPresetStatus(value)).toBeUndefined();
      expect(projectSubagentPresetEvaluatedPayload({ ...value, sessionId: 'session-a' })).toBeUndefined();
    }
    // Malformed policy knobs are likewise rejected instead of silently dropped.
    for (const patch of [{ resetPriorityWindowMs: -1 }, { resetPriorityExponent: NaN },
      { resetPriorityMaxBonus: Infinity }, { resetPriorityWindowMs: '72h' }]) {
      expect(projectSubagentPresetStatus({ ...core, policy: { ...core.policy, ...patch } })).toBeUndefined();
    }
    // Absent policy knobs stay absent (legacy snapshots), never fabricated.
    const legacy = projectSubagentPresetStatus({ ...core, policy: { quotaFloorPercent: 25,
      switchMarginPercent: 10, localUsageWindowMs: 3_600_000, localUsageWeightPercent: 10,
      priorityWeightPercent: 20, reliabilityWeightPercent: 20, latencyWeightPercent: 10,
      switchCooldownMs: 600_000, circuitBreakerFailureThreshold: 3, circuitBreakerCooldownMs: 900_000 } })!;
    expect(legacy.policy.reset_priority_window_ms).toBeUndefined();
    expect(legacy.policy.reset_priority_exponent).toBeUndefined();
    expect(legacy.policy.reset_priority_max_bonus).toBeUndefined();
    expect(JSON.stringify(legacy.policy)).not.toContain('reset_priority');
  });

  it('rejects malformed nested values instead of downgrading to a legacy snapshot', () => {
    const core = aggregatePresetStatus();
    const candidate = core.candidates[0]!;
    const role = candidate.roleScores![0]!;
    const resource = role.original.resource;
    if (resource.kind !== 'metered') throw new Error('fixture must be metered');
    const invalidResources = [
      { ...resource, balanceCny: 12 }, { ...resource, balanceCny: '-1' },
      { ...resource, balanceCny: 'NaN' }, { ...resource, balanceCny: '1e3' },
      { ...resource, resourceScore: 50 }, { ...resource, balanceStatus: 'raw_error' },
      { ...resource, blockedUntil: Infinity }, { ...resource, blockedUntil: -1 },
      { ...resource, blockedUntil: 1.5 }, { ...resource, blockedUntil: 9e15 },
      { ...resource, meteredUsage: { ...resource.meteredUsage, source: 'remote' } },
      { ...resource, meteredUsage: { ...resource.meteredUsage, today: {
        ...resource.meteredUsage!.today, estimatedCost: 0 } } },
      { ...resource, meteredUsage: { ...resource.meteredUsage, today: {
        ...resource.meteredUsage!.today, startAt: '2025-02-30T00:00:00Z' } } },
    ];
    const invalid = [
      ...invalidResources.map((resource) => ({ ...core, candidates: [{ ...candidate,
        roleScores: [{ ...role, original: { ...role.original, resource } }] }] })),
      ...['source', 'modelSource', 'thinkingSource'].map((key) => ({ ...core, candidates: [{ ...candidate,
        roleScores: [{ ...role, effective: { ...role.effective, [key]: 'raw-secret' } }] }] })),
      { ...core, evaluationScope: 'route' },
      { ...core, candidates: [{ ...candidate, roleScores: null }] },
      { ...core, candidates: [{ ...candidate, roleCount: 1.2 }] },
      { ...core, candidates: [{ ...candidate, coverage: { ...candidate.coverage, totalRoleCount: -1 } }] },
      { ...core, candidates: [{ ...candidate, roleScores: [{ ...role, fallback: { ...role.fallback, reason: 'healthy' } }] }] },
      { ...core, policy: { ...core.policy, roleWeights: { custom_role: NaN } } },
      { ...core, policy: { ...core.policy, roleWeights: { custom_role: { apiKey: 'SECRET' } } } },
    ];
    for (const value of invalid) {
      expect(projectSubagentPresetStatus(value)).toBeUndefined();
      expect(projectSubagentPresetEvaluatedPayload({ ...value, sessionId: 'session-a' })).toBeUndefined();
    }
  });
});
