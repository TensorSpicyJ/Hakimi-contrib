import type {
  AutoSubagentPresetRouteScore,
  AutoSubagentPresetStatus,
} from '@moonshot-ai/agent-core-v2';

/** A typed domain snapshot: names and nesting must follow the real core contract. */
export function aggregatePresetStatus(): AutoSubagentPresetStatus {
  const original: AutoSubagentPresetRouteScore = {
    model: 'deepseek-flash', thinking: 'low', provider: 'deepseek',
    source: 'preset', modelSource: 'preset', thinkingSource: 'preset',
    availability: 'time_restricted', score: 100,
    contributions: {
      resourceScore: 100, priorityBonus: 0, resetBonus: 0, routeFitBonus: 0,
      tokenPenalty: 0, reliabilityPenalty: 0, latencyPenalty: 0,
    },
    localEvidence: {
      scope: 'profile', sampleCount: 1, failureCount: 0, adjustedFailureRate: 0,
      tokenCount: 100, firstTokenLatencySampleCount: 0, llmRequestCount: 1,
    },
    resource: {
      kind: 'metered', currency: 'CNY', balanceCny: '12.34567890123456789',
      isAvailable: true, balanceStatus: 'known', resourceScore: 100,
      resourceScoreBasis: 'funded_account', blockedUntil: 1_750_003_600_000,
      meteredUsage: {
        source: 'local', costSource: 'estimated', currency: 'CNY', timezone: 'Asia/Shanghai',
        trackingStartedAt: null, degraded: true,
        today: {
          startAt: '2025-06-15T16:00:00.000Z', endAt: '2025-06-16T16:00:00.000Z',
          requestCount: 1, measuredRequestCount: 1, pendingRequestCount: 0,
          missingUsageRequestCount: 0, unpricedRequestCount: 1,
          inputTokens: 90, outputTokens: 10, cacheReadTokens: 20, totalTokens: 100,
          estimatedCost: null, isPartial: true,
        },
        month: {
          startAt: '2025-05-31T16:00:00.000Z', endAt: '2025-06-30T16:00:00.000Z',
          requestCount: 2, measuredRequestCount: 2, pendingRequestCount: 0,
          missingUsageRequestCount: 0, unpricedRequestCount: 1,
          inputTokens: 180, outputTokens: 20, cacheReadTokens: 40, totalTokens: 200,
          estimatedCost: '0.0000123456789', isPartial: true,
        },
      },
    },
  };
  const effective: AutoSubagentPresetRouteScore = {
    ...original,
    model: 'subscription-model', thinking: 'high', provider: 'subscription',
    source: 'auto-fallback', modelSource: 'auto-fallback', thinkingSource: 'auto-fallback',
    availability: 'healthy', score: 80,
    contributions: { ...original.contributions, resourceScore: 80 },
    resource: {
      kind: 'subscription', resourceScore: 80, quotaRemainingPercent: 80, quotaResetAt: 1_750_003_600_000,
      resetPriority: {
        window: { duration: 1, unit: 'week' },
        resetAt: 1_750_003_600_000,
        remainingPercent: 12,
        horizonMs: 43_200_000,
        bonus: 117.5,
        floorRelaxed: true,
      },
    },
  };
  return {
    evaluationScope: 'preset', evaluatedAt: 1_750_000_000_000, route: 'agent',
    reasonCode: 'current_optimal', currentPreset: 'balanced', selectedPreset: 'balanced',
    currentScore: 75, selectedScore: 75,
    candidates: [{
      preset: 'balanced', availability: 'healthy', selectable: true, participating: true,
      score: 75, nativeScore: 40, roleCount: 2, nativeAvailableRoleCount: 1,
      fallbackRoleCount: 1, unavailableRoleCount: 0, totalRoleWeight: 2,
      contributions: { ...effective.contributions, resourceScore: 80 },
      localEvidence: original.localEvidence,
      coverage: { resourceProviderCount: 2, totalProviderCount: 2, localEvidenceRoleCount: 2, totalRoleCount: 2 },
      roleScores: [
        { key: 'custom_role', route: 'agent', profileName: 'custom_role', weight: 1,
          original, effective, effectiveScore: 70, fallbackPenalty: 10,
          fallback: { sourcePreset: 'peak-safe', sourceRole: 'tower_worker', reason: 'time_restricted' } },
        { key: 'tower_worker', route: 'tower_worker', weight: 1,
          original: { ...effective, source: 'preset', modelSource: 'preset', thinkingSource: 'preset' },
          effective: { ...effective, source: 'preset', modelSource: 'preset', thinkingSource: 'preset' },
          effectiveScore: 80, fallbackPenalty: 0 },
      ],
    }],
    policy: {
      roleWeights: { custom_role: 1, tower_worker: 1, zero_weight: 0 },
      deepseekAvoidPeakHours: true, fallbackPenalty: 10, meteredFundedResourceScore: 100,
      resetPriorityWindowMs: 259_200_000, resetPriorityExponent: 3, resetPriorityMaxBonus: 200,
      quotaFloorPercent: 25, switchMarginPercent: 10, localUsageWindowMs: 3_600_000,
      localUsageWeightPercent: 10, priorityWeightPercent: 20, reliabilityWeightPercent: 20,
      latencyWeightPercent: 10, switchCooldownMs: 600_000,
      circuitBreakerFailureThreshold: 3, circuitBreakerCooldownMs: 900_000,
    },
  };
}

/** Effective bindings, not original providers or role counts, determine the share. */
export function softPeakPresetStatus(): AutoSubagentPresetStatus {
  const status = aggregatePresetStatus();
  const candidate = status.candidates[0]!;
  const role = candidate.roleScores![0]!;
  if (role.original.resource.kind !== 'metered') throw new Error('expected metered fixture');
  const deepseek: AutoSubagentPresetRouteScore = {
    ...role.original, availability: 'healthy', score: 40,
    contributions: { ...role.original.contributions, peakPenalty: 60 },
    resource: { ...role.original.resource, blockedUntil: undefined,
      peakPenalty: { points: 60, until: 1_750_003_600_000 } },
  };
  return {
    ...status, reasonCode: 'current_unhealthy', currentScore: 57.5, selectedScore: 57.5,
    policy: { ...status.policy, deepseekPeakPolicy: 'penalize', deepseekPeakPenalty: 60 },
    candidates: [{
      ...candidate, score: 57.5, nativeScore: 0, deepseekRoleShare: 0.25, totalRoleWeight: 4,
      nativeAvailableRoleCount: 0, fallbackRoleCount: 2,
      contributions: { ...candidate.contributions, peakPenalty: 15 },
      roleScores: [
        { ...role, weight: 3, original: { ...deepseek, availability: 'capability_unavailable' },
          effectiveScore: 70, fallback: { sourcePreset: 'subscription-only', sourceRole: 'reviewer', reason: 'capability_unavailable' } },
        { ...role, key: 'tower_worker', route: 'tower_worker', profileName: undefined, weight: 1,
          original: { ...role.effective, availability: 'quota_below_floor' },
          effective: { ...deepseek, source: 'auto-fallback', modelSource: 'auto-fallback', thinkingSource: 'auto-fallback' },
          effectiveScore: 20, fallbackPenalty: 20,
          fallback: { sourcePreset: 'metered', sourceRole: 'agent', reason: 'quota_below_floor' } },
      ],
    }],
  };
}
