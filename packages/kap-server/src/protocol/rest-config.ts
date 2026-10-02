import { z } from 'zod';

export const providerConfigResponseSchema = z.object({
  type: z.string(),
  base_url: z.string().optional(),
  default_model: z.string().optional(),
  has_api_key: z.boolean(),
});
export type ProviderConfigResponse = z.infer<typeof providerConfigResponseSchema>;

export const configResponseSchema = z.object({
  providers: z.record(z.string(), providerConfigResponseSchema).default({}),
  default_provider: z.string().optional(),
  default_model: z.string().optional(),
  models: z.record(z.string(), z.unknown()).optional(),
  thinking: z.unknown().optional(),
  plan_mode: z.boolean().optional(),
  yolo: z.boolean().optional(),
  default_permission_mode: z.string().optional(),
  default_plan_mode: z.boolean().optional(),
  permission: z.unknown().optional(),
  hooks: z.array(z.unknown()).optional(),
  services: z.unknown().optional(),
  merge_all_available_skills: z.boolean().optional(),
  extra_skill_dirs: z.array(z.string()).optional(),
  loop_control: z.unknown().optional(),
  background: z.unknown().optional(),
  subagent: z.unknown().optional(),
  secondary_model: z.unknown().optional(),
  experimental: z.record(z.string(), z.boolean()).optional(),
  telemetry: z.boolean().optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});
export type ConfigResponse = z.infer<typeof configResponseSchema>;

export const subagentPresetActivationRequestSchema = z.object({
  /** Empty clears the active preset and returns subagents to base routing. */
  preset: z.string(),
});
export type SubagentPresetActivationRequest = z.infer<
  typeof subagentPresetActivationRequestSchema
>;

export const subagentPresetActivationResponseSchema = z.object({
  config: configResponseSchema,
  warning: z.string().optional(),
});
export type SubagentPresetActivationResponse = z.infer<
  typeof subagentPresetActivationResponseSchema
>;

export const autoSubagentPresetReasonCodeSchema = z.enum([
  'cancelled',
  'flag_disabled',
  'auto_preset_disabled',
  'manual_lock',
  'caller_model_unavailable',
  'no_candidates',
  'explicit_preset',
  'no_quota_evidence',
  'no_healthy_candidate',
  'current_optimal',
  'score_margin_not_met',
  'switch_cooldown',
  'current_unhealthy',
  'circuit_breaker_escape',
  'higher_score',
  'manual_override',
  'preset_changed_during_evaluation',
  'routing_config_changed',
  'evaluation_failed',
  'activation_failed',
  'activation_no_effect',
]);

const finiteNumberSchema = z.number().finite();
const nonNegativeNumberSchema = finiteNumberSchema.nonnegative();
const nonNegativeIntegerSchema = nonNegativeNumberSchema.int();
const rateSchema = nonNegativeNumberSchema.max(1);
const percentSchema = nonNegativeNumberSchema.max(100);
const nonEmptyStringSchema = z.string().min(1);

const timestampSchema = nonNegativeIntegerSchema.max(8_640_000_000_000_000);
const decimalSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const isoTimeSchema = z.iso.datetime({ offset: true });
const routeSchema = z.enum(['agent', 'swarm', 'tower_worker', 'tower_reviewer']);
const bindingSourceSchema = z.enum(['preset', 'agents', 'legacy-secondary', 'caller', 'auto-fallback']);
const routeAvailabilitySchema = z.enum([
  'healthy', 'route_unresolved', 'quota_unknown', 'quota_below_floor', 'circuit_open',
  'balance_empty', 'balance_unknown', 'balance_invalid', 'account_unavailable',
  'time_restricted', 'capability_unavailable', 'provider_unsupported', 'model_disabled',
]);
const candidateAvailabilitySchema = z.enum([...routeAvailabilitySchema.options, 'partial', 'unavailable']);

const meteredUsagePeriodCoreSchema = z.object({
  startAt: isoTimeSchema,
  endAt: isoTimeSchema,
  requestCount: nonNegativeIntegerSchema,
  measuredRequestCount: nonNegativeIntegerSchema,
  pendingRequestCount: nonNegativeIntegerSchema,
  missingUsageRequestCount: nonNegativeIntegerSchema,
  unpricedRequestCount: nonNegativeIntegerSchema,
  inputTokens: nonNegativeIntegerSchema,
  outputTokens: nonNegativeIntegerSchema,
  cacheReadTokens: nonNegativeIntegerSchema,
  totalTokens: nonNegativeIntegerSchema,
  estimatedCost: decimalSchema.nullable(),
  isPartial: z.boolean(),
});
const localMeteredUsageCoreSchema = z.object({
  source: z.literal('local'),
  costSource: z.literal('estimated'),
  currency: z.literal('CNY'),
  timezone: z.literal('Asia/Shanghai'),
  trackingStartedAt: isoTimeSchema.nullable(),
  degraded: z.boolean(),
  today: meteredUsagePeriodCoreSchema,
  month: meteredUsagePeriodCoreSchema,
});
const resetPriorityWindowUnitSchema = z.enum(['minute', 'hour', 'day', 'week']);
const resetPriorityCoreSchema = z.object({
  window: z.object({
    duration: finiteNumberSchema.positive(),
    unit: resetPriorityWindowUnitSchema,
  }),
  resetAt: timestampSchema,
  remainingPercent: percentSchema,
  horizonMs: nonNegativeNumberSchema,
  bonus: nonNegativeNumberSchema,
  floorRelaxed: z.boolean(),
});
const resourceCoreSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('subscription'),
    resourceScore: percentSchema.optional(),
    quotaRemainingPercent: percentSchema.optional(),
    quotaResetAt: timestampSchema.optional(),
    resetPriority: resetPriorityCoreSchema.optional(),
    blockedUntil: timestampSchema.optional(),
  }),
  z.object({
    kind: z.literal('metered'),
    currency: z.literal('CNY'),
    balanceCny: decimalSchema.optional(),
    isAvailable: z.boolean().optional(),
    balanceStatus: z.enum(['known', 'query_failed', 'invalid', 'missing']),
    resourceScore: z.union([z.literal(0), z.literal(100)]).optional(),
    resourceScoreBasis: z.literal('funded_account'),
    meteredUsage: localMeteredUsageCoreSchema.optional(),
    peakPenalty: z.object({ points: nonNegativeNumberSchema, until: timestampSchema.min(0) }).optional(),
    blockedUntil: timestampSchema.optional(),
  }),
  z.object({
    kind: z.literal('unknown'),
    reason: z.enum(['missing', 'query_failed', 'unsupported']),
    blockedUntil: timestampSchema.optional(),
  }),
]);

const autoSubagentPresetScoreContributionsCoreSchema = z.object({
  resourceScore: percentSchema.optional(),
  quotaRemaining: percentSchema.optional(),
  priorityBonus: nonNegativeNumberSchema,
  resetBonus: nonNegativeNumberSchema,
  routeFitBonus: nonNegativeNumberSchema,
  tokenPenalty: nonNegativeNumberSchema,
  reliabilityPenalty: nonNegativeNumberSchema,
  latencyPenalty: nonNegativeNumberSchema,
  peakPenalty: nonNegativeNumberSchema.optional(),
});

const autoSubagentPresetLocalEvidenceCoreSchema = z.object({
  scope: z.enum(['profile', 'provider', 'none']),
  sampleCount: nonNegativeIntegerSchema,
  failureCount: nonNegativeIntegerSchema,
  adjustedFailureRate: rateSchema,
  tokenCount: nonNegativeIntegerSchema,
  averageFirstTokenLatencyMs: nonNegativeNumberSchema.optional(),
  firstTokenLatencySampleCount: nonNegativeIntegerSchema,
  llmRequestCount: nonNegativeIntegerSchema,
});

const routeScoreCoreSchema = z.object({
  model: nonEmptyStringSchema.optional(),
  thinking: nonEmptyStringSchema.optional(),
  provider: nonEmptyStringSchema.optional(),
  source: bindingSourceSchema.optional(),
  modelSource: bindingSourceSchema.optional(),
  thinkingSource: bindingSourceSchema.optional(),
  availability: routeAvailabilitySchema,
  score: finiteNumberSchema.optional(),
  contributions: autoSubagentPresetScoreContributionsCoreSchema,
  localEvidence: autoSubagentPresetLocalEvidenceCoreSchema,
  resource: resourceCoreSchema,
  circuitBreakerOpenUntil: timestampSchema.optional(),
});
const fallbackCoreSchema = z.object({
  sourcePreset: nonEmptyStringSchema.optional(),
  sourceRole: nonEmptyStringSchema,
  reason: routeAvailabilitySchema.exclude(['healthy']),
});
const roleScoreCoreSchema = z.object({
  key: nonEmptyStringSchema,
  route: routeSchema,
  profileName: nonEmptyStringSchema.optional(),
  weight: nonNegativeNumberSchema,
  original: routeScoreCoreSchema,
  effective: routeScoreCoreSchema,
  effectiveScore: nonNegativeNumberSchema,
  fallbackPenalty: nonNegativeNumberSchema,
  fallback: fallbackCoreSchema.optional(),
});
const coverageCoreSchema = z.object({
  resourceProviderCount: nonNegativeIntegerSchema,
  totalProviderCount: nonNegativeIntegerSchema,
  localEvidenceRoleCount: nonNegativeIntegerSchema,
  totalRoleCount: nonNegativeIntegerSchema,
});
const autoSubagentPresetCandidateScoreCoreSchema = z.object({
  preset: nonEmptyStringSchema,
  provider: nonEmptyStringSchema.optional(),
  availability: candidateAvailabilitySchema,
  selectable: z.boolean(),
  score: finiteNumberSchema.optional(),
  quotaRemainingPercent: percentSchema.optional(),
  quotaResetAt: timestampSchema.optional(),
  circuitBreakerOpenUntil: timestampSchema.optional(),
  contributions: autoSubagentPresetScoreContributionsCoreSchema,
  localEvidence: autoSubagentPresetLocalEvidenceCoreSchema,
  participating: z.boolean().optional(),
  nativeScore: finiteNumberSchema.optional(),
  roleScores: z.array(roleScoreCoreSchema).optional(),
  coverage: coverageCoreSchema.optional(),
  roleCount: nonNegativeIntegerSchema.optional(),
  nativeAvailableRoleCount: nonNegativeIntegerSchema.optional(),
  fallbackRoleCount: nonNegativeIntegerSchema.optional(),
  unavailableRoleCount: nonNegativeIntegerSchema.optional(),
  totalRoleWeight: nonNegativeNumberSchema.optional(),
  deepseekRoleShare: rateSchema.optional(),
});

const autoSubagentPresetPolicySnapshotCoreSchema = z.object({
  roleWeights: z.record(z.string(), nonNegativeNumberSchema).optional(),
  deepseekAvoidPeakHours: z.boolean().optional(),
  deepseekPeakPolicy: z.enum(['block', 'penalize', 'off']).optional(),
  deepseekPeakPenalty: nonNegativeNumberSchema.optional(),
  fallbackPenalty: nonNegativeNumberSchema.optional(),
  meteredFundedResourceScore: percentSchema.optional(),
  resetPriorityWindowMs: nonNegativeNumberSchema.optional(),
  resetPriorityExponent: nonNegativeNumberSchema.optional(),
  resetPriorityMaxBonus: nonNegativeNumberSchema.optional(),
  quotaFloorPercent: percentSchema,
  switchMarginPercent: percentSchema,
  localUsageWindowMs: nonNegativeNumberSchema,
  localUsageWeightPercent: percentSchema,
  priorityWeightPercent: percentSchema,
  reliabilityWeightPercent: percentSchema,
  latencyWeightPercent: percentSchema,
  switchCooldownMs: nonNegativeNumberSchema,
  circuitBreakerFailureThreshold: nonNegativeIntegerSchema,
  circuitBreakerCooldownMs: nonNegativeNumberSchema,
});

const autoSubagentPresetStatusCoreSchema = z.object({
  evaluationScope: z.literal('preset').optional(),
  evaluatedAt: timestampSchema,
  route: routeSchema,
  profileName: nonEmptyStringSchema.optional(),
  reasonCode: autoSubagentPresetReasonCodeSchema,
  currentPreset: nonEmptyStringSchema.optional(),
  selectedPreset: nonEmptyStringSchema.optional(),
  activatedPreset: nonEmptyStringSchema.optional(),
  currentScore: finiteNumberSchema.optional(),
  selectedScore: finiteNumberSchema.optional(),
  switchCooldownUntil: timestampSchema.optional(),
  candidates: z.array(autoSubagentPresetCandidateScoreCoreSchema),
  policy: autoSubagentPresetPolicySnapshotCoreSchema,
});

const subagentPresetScoreContributionsSchema = z.object({
  quota_remaining: percentSchema.optional(),
  resource_score: percentSchema.optional(),
  priority_bonus: nonNegativeNumberSchema,
  reset_bonus: nonNegativeNumberSchema,
  route_fit_bonus: nonNegativeNumberSchema,
  token_penalty: nonNegativeNumberSchema,
  reliability_penalty: nonNegativeNumberSchema,
  latency_penalty: nonNegativeNumberSchema,
  peak_penalty: nonNegativeNumberSchema.optional(),
});

const subagentPresetLocalEvidenceSchema = z.object({
  scope: z.enum(['profile', 'provider', 'none']),
  sample_count: nonNegativeIntegerSchema,
  failure_count: nonNegativeIntegerSchema,
  adjusted_failure_rate: rateSchema,
  token_count: nonNegativeIntegerSchema,
  average_first_token_latency_ms: nonNegativeNumberSchema.optional(),
  first_token_latency_sample_count: nonNegativeIntegerSchema,
  llm_request_count: nonNegativeIntegerSchema,
});
const meteredUsagePeriodSchema = z.object({
  start_at: isoTimeSchema,
  end_at: isoTimeSchema,
  request_count: nonNegativeIntegerSchema,
  measured_request_count: nonNegativeIntegerSchema,
  pending_request_count: nonNegativeIntegerSchema,
  missing_usage_request_count: nonNegativeIntegerSchema,
  unpriced_request_count: nonNegativeIntegerSchema,
  input_tokens: nonNegativeIntegerSchema,
  output_tokens: nonNegativeIntegerSchema,
  cache_read_tokens: nonNegativeIntegerSchema,
  total_tokens: nonNegativeIntegerSchema,
  estimated_cost: decimalSchema.nullable(),
  is_partial: z.boolean(),
});
const localMeteredUsageSchema = z.object({
  source: z.literal('local'),
  cost_source: z.literal('estimated'),
  currency: z.literal('CNY'),
  timezone: z.literal('Asia/Shanghai'),
  tracking_started_at: isoTimeSchema.nullable(),
  degraded: z.boolean(),
  today: meteredUsagePeriodSchema,
  month: meteredUsagePeriodSchema,
});
const resetPrioritySchema = z.object({
  window: z.object({
    duration: finiteNumberSchema.positive(),
    unit: resetPriorityWindowUnitSchema,
  }),
  reset_at: timestampSchema,
  remaining_percent: percentSchema,
  horizon_ms: nonNegativeNumberSchema,
  bonus: nonNegativeNumberSchema,
  floor_relaxed: z.boolean(),
});
const resourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('subscription'),
    resource_score: percentSchema.optional(),
    quota_remaining_percent: percentSchema.optional(),
    quota_reset_at: timestampSchema.optional(),
    reset_priority: resetPrioritySchema.optional(),
    blocked_until: timestampSchema.optional(),
  }),
  z.object({
    kind: z.literal('metered'),
    currency: z.literal('CNY'),
    balance_cny: decimalSchema.optional(),
    is_available: z.boolean().optional(),
    balance_status: z.enum(['known', 'query_failed', 'invalid', 'missing']),
    resource_score: z.union([z.literal(0), z.literal(100)]).optional(),
    resource_score_basis: z.literal('funded_account'),
    metered_usage: localMeteredUsageSchema.optional(),
    peak_penalty: z.object({ points: nonNegativeNumberSchema, until: timestampSchema.min(0) }).optional(),
    blocked_until: timestampSchema.optional(),
  }),
  z.object({
    kind: z.literal('unknown'),
    reason: z.enum(['missing', 'query_failed', 'unsupported']),
    blocked_until: timestampSchema.optional(),
  }),
]);
const routeScoreSchema = z.object({
  model: nonEmptyStringSchema.optional(),
  thinking: nonEmptyStringSchema.optional(),
  provider: nonEmptyStringSchema.optional(),
  source: bindingSourceSchema.optional(),
  model_source: bindingSourceSchema.optional(),
  thinking_source: bindingSourceSchema.optional(),
  availability: routeAvailabilitySchema,
  score: finiteNumberSchema.optional(),
  contributions: subagentPresetScoreContributionsSchema,
  local_evidence: subagentPresetLocalEvidenceSchema,
  resource: resourceSchema,
  circuit_breaker_open_until: timestampSchema.optional(),
});
const roleScoreSchema = z.object({
  key: nonEmptyStringSchema,
  route: routeSchema,
  profile_name: nonEmptyStringSchema.optional(),
  weight: nonNegativeNumberSchema,
  original: routeScoreSchema,
  effective: routeScoreSchema,
  effective_score: nonNegativeNumberSchema,
  fallback_penalty: nonNegativeNumberSchema,
  fallback: z.object({
    source_preset: nonEmptyStringSchema.optional(),
    source_role: nonEmptyStringSchema,
    reason: routeAvailabilitySchema.exclude(['healthy']),
  }).optional(),
});
const subagentPresetCandidateScoreSchema = z.object({
  preset: nonEmptyStringSchema,
  provider: nonEmptyStringSchema.optional(),
  availability: candidateAvailabilitySchema,
  selectable: z.boolean(),
  score: finiteNumberSchema.optional(),
  quota_remaining_percent: percentSchema.optional(),
  quota_reset_at: timestampSchema.optional(),
  circuit_breaker_open_until: timestampSchema.optional(),
  contributions: subagentPresetScoreContributionsSchema,
  local_evidence: subagentPresetLocalEvidenceSchema,
  participating: z.boolean().optional(),
  native_score: finiteNumberSchema.optional(),
  role_scores: z.array(roleScoreSchema).optional(),
  coverage: z.object({
    resource_provider_count: nonNegativeIntegerSchema,
    total_provider_count: nonNegativeIntegerSchema,
    local_evidence_role_count: nonNegativeIntegerSchema,
    total_role_count: nonNegativeIntegerSchema,
  }).optional(),
  role_count: nonNegativeIntegerSchema.optional(),
  native_available_role_count: nonNegativeIntegerSchema.optional(),
  fallback_role_count: nonNegativeIntegerSchema.optional(),
  unavailable_role_count: nonNegativeIntegerSchema.optional(),
  total_role_weight: nonNegativeNumberSchema.optional(),
  deepseek_role_share: rateSchema.optional(),
});

const subagentPresetPolicySnapshotSchema = z.object({
  role_weights: z.record(z.string(), nonNegativeNumberSchema).optional(),
  deepseek_avoid_peak_hours: z.boolean().optional(),
  deepseek_peak_policy: z.enum(['block', 'penalize', 'off']).optional(),
  deepseek_peak_penalty: nonNegativeNumberSchema.optional(),
  fallback_penalty: nonNegativeNumberSchema.optional(),
  metered_funded_resource_score: percentSchema.optional(),
  reset_priority_window_ms: nonNegativeNumberSchema.optional(),
  reset_priority_exponent: nonNegativeNumberSchema.optional(),
  reset_priority_max_bonus: nonNegativeNumberSchema.optional(),
  quota_floor_percent: percentSchema,
  switch_margin_percent: percentSchema,
  local_usage_window_ms: nonNegativeNumberSchema,
  local_usage_weight_percent: percentSchema,
  priority_weight_percent: percentSchema,
  reliability_weight_percent: percentSchema,
  latency_weight_percent: percentSchema,
  switch_cooldown_ms: nonNegativeNumberSchema,
  circuit_breaker_failure_threshold: nonNegativeIntegerSchema,
  circuit_breaker_cooldown_ms: nonNegativeNumberSchema,
});

export const subagentPresetStatusSchema = z.object({
  evaluation_scope: z.literal('preset').optional(),
  evaluated_at: timestampSchema,
  route: routeSchema,
  profile_name: nonEmptyStringSchema.optional(),
  reason_code: autoSubagentPresetReasonCodeSchema,
  current_preset: nonEmptyStringSchema.optional(),
  selected_preset: nonEmptyStringSchema.optional(),
  activated_preset: nonEmptyStringSchema.optional(),
  current_score: finiteNumberSchema.optional(),
  selected_score: finiteNumberSchema.optional(),
  switch_cooldown_until: timestampSchema.optional(),
  candidates: z.array(subagentPresetCandidateScoreSchema),
  policy: subagentPresetPolicySnapshotSchema,
});
export type SubagentPresetStatus = z.infer<typeof subagentPresetStatusSchema>;

export const subagentPresetAutoRequestSchema = z.object({
  session_id: z.string().min(1).optional(),
}).strict();
export type SubagentPresetAutoRequest = z.infer<typeof subagentPresetAutoRequestSchema>;

export const subagentPresetAutoResponseSchema = z.object({
  config: configResponseSchema,
  status: subagentPresetStatusSchema,
  warning: z.string().optional(),
});
export type SubagentPresetAutoResponse = z.infer<typeof subagentPresetAutoResponseSchema>;

/** No automatic evaluation has run yet when the response data is `null`. */
export const subagentPresetStatusResponseSchema = subagentPresetStatusSchema.nullable();
export type SubagentPresetStatusResponse = z.infer<typeof subagentPresetStatusResponseSchema>;

export function projectSubagentPresetStatus(status: unknown): SubagentPresetStatus | undefined {
  const parsed = autoSubagentPresetStatusCoreSchema.safeParse(status);
  if (!parsed.success) return undefined;
  return projectParsedSubagentPresetStatus(parsed.data);
}

export function projectSubagentPresetEvaluatedPayload(
  payload: unknown,
): { sessionId: string; status: SubagentPresetStatus } | undefined {
  const parsed = autoSubagentPresetStatusCoreSchema
    .extend({ sessionId: nonEmptyStringSchema })
    .safeParse(payload);
  if (!parsed.success) return undefined;
  return {
    sessionId: parsed.data.sessionId,
    status: projectParsedSubagentPresetStatus(parsed.data),
  };
}

function projectContributions(value: z.infer<typeof autoSubagentPresetScoreContributionsCoreSchema>) {
  return {
    quota_remaining: value.quotaRemaining,
    resource_score: value.resourceScore,
    priority_bonus: value.priorityBonus,
    reset_bonus: value.resetBonus,
    route_fit_bonus: value.routeFitBonus,
    token_penalty: value.tokenPenalty,
    reliability_penalty: value.reliabilityPenalty,
    latency_penalty: value.latencyPenalty,
    peak_penalty: value.peakPenalty,
  };
}

function projectLocalEvidence(value: z.infer<typeof autoSubagentPresetLocalEvidenceCoreSchema>) {
  return {
    scope: value.scope,
    sample_count: value.sampleCount,
    failure_count: value.failureCount,
    adjusted_failure_rate: value.adjustedFailureRate,
    token_count: value.tokenCount,
    average_first_token_latency_ms: value.averageFirstTokenLatencyMs,
    first_token_latency_sample_count: value.firstTokenLatencySampleCount,
    llm_request_count: value.llmRequestCount,
  };
}

function projectMeteredPeriod(value: z.infer<typeof meteredUsagePeriodCoreSchema>) {
  return {
    start_at: value.startAt,
    end_at: value.endAt,
    request_count: value.requestCount,
    measured_request_count: value.measuredRequestCount,
    pending_request_count: value.pendingRequestCount,
    missing_usage_request_count: value.missingUsageRequestCount,
    unpriced_request_count: value.unpricedRequestCount,
    input_tokens: value.inputTokens,
    output_tokens: value.outputTokens,
    cache_read_tokens: value.cacheReadTokens,
    total_tokens: value.totalTokens,
    estimated_cost: value.estimatedCost,
    is_partial: value.isPartial,
  };
}

function projectResource(value: z.infer<typeof resourceCoreSchema>): z.infer<typeof resourceSchema> {
  switch (value.kind) {
    case 'subscription': {
      const resetPriority = value.resetPriority;
      return {
        kind: value.kind,
        resource_score: value.resourceScore,
        quota_remaining_percent: value.quotaRemainingPercent,
        quota_reset_at: value.quotaResetAt,
        reset_priority: resetPriority === undefined ? undefined : {
          window: { duration: resetPriority.window.duration, unit: resetPriority.window.unit },
          reset_at: resetPriority.resetAt,
          remaining_percent: resetPriority.remainingPercent,
          horizon_ms: resetPriority.horizonMs,
          bonus: resetPriority.bonus,
          floor_relaxed: resetPriority.floorRelaxed,
        },
        blocked_until: value.blockedUntil,
      };
    }
    case 'metered': {
      const usage = value.meteredUsage;
      return {
        kind: value.kind,
        currency: value.currency,
        balance_cny: value.balanceCny,
        is_available: value.isAvailable,
        balance_status: value.balanceStatus,
        resource_score: value.resourceScore,
        resource_score_basis: value.resourceScoreBasis,
        peak_penalty: value.peakPenalty === undefined ? undefined : {
          points: value.peakPenalty.points, until: value.peakPenalty.until,
        },
        blocked_until: value.blockedUntil,
        metered_usage: usage === undefined ? undefined : {
          source: usage.source,
          cost_source: usage.costSource,
          currency: usage.currency,
          timezone: usage.timezone,
          tracking_started_at: usage.trackingStartedAt,
          degraded: usage.degraded,
          today: projectMeteredPeriod(usage.today),
          month: projectMeteredPeriod(usage.month),
        },
      };
    }
    case 'unknown':
      return { kind: value.kind, reason: value.reason, blocked_until: value.blockedUntil };
  }
}

function projectRouteScore(value: z.infer<typeof routeScoreCoreSchema>) {
  return {
    model: value.model,
    thinking: value.thinking,
    provider: value.provider,
    source: value.source,
    model_source: value.modelSource,
    thinking_source: value.thinkingSource,
    availability: value.availability,
    score: value.score,
    contributions: projectContributions(value.contributions),
    local_evidence: projectLocalEvidence(value.localEvidence),
    resource: projectResource(value.resource),
    circuit_breaker_open_until: value.circuitBreakerOpenUntil,
  };
}

function projectParsedSubagentPresetStatus(
  status: z.infer<typeof autoSubagentPresetStatusCoreSchema>,
): SubagentPresetStatus {
  return {
    evaluation_scope: status.evaluationScope,
    evaluated_at: status.evaluatedAt,
    route: status.route,
    profile_name: status.profileName,
    reason_code: status.reasonCode,
    current_preset: status.currentPreset,
    selected_preset: status.selectedPreset,
    activated_preset: status.activatedPreset,
    current_score: status.currentScore,
    selected_score: status.selectedScore,
    switch_cooldown_until: status.switchCooldownUntil,
    candidates: status.candidates.map((candidate) => ({
      preset: candidate.preset,
      provider: candidate.provider,
      availability: candidate.availability,
      selectable: candidate.selectable,
      score: candidate.score,
      quota_remaining_percent: candidate.quotaRemainingPercent,
      quota_reset_at: candidate.quotaResetAt,
      circuit_breaker_open_until: candidate.circuitBreakerOpenUntil,
      contributions: projectContributions(candidate.contributions),
      local_evidence: projectLocalEvidence(candidate.localEvidence),
      participating: candidate.participating,
      native_score: candidate.nativeScore,
      role_count: candidate.roleCount,
      native_available_role_count: candidate.nativeAvailableRoleCount,
      fallback_role_count: candidate.fallbackRoleCount,
      unavailable_role_count: candidate.unavailableRoleCount,
      total_role_weight: candidate.totalRoleWeight,
      deepseek_role_share: candidate.deepseekRoleShare,
      coverage: candidate.coverage === undefined ? undefined : {
        resource_provider_count: candidate.coverage.resourceProviderCount,
        total_provider_count: candidate.coverage.totalProviderCount,
        local_evidence_role_count: candidate.coverage.localEvidenceRoleCount,
        total_role_count: candidate.coverage.totalRoleCount,
      },
      role_scores: candidate.roleScores?.map((role) => ({
        key: role.key,
        route: role.route,
        profile_name: role.profileName,
        weight: role.weight,
        original: projectRouteScore(role.original),
        effective: projectRouteScore(role.effective),
        effective_score: role.effectiveScore,
        fallback_penalty: role.fallbackPenalty,
        fallback: role.fallback === undefined ? undefined : {
          source_preset: role.fallback.sourcePreset,
          source_role: role.fallback.sourceRole,
          reason: role.fallback.reason,
        },
      })),
    })),
    policy: {
      role_weights: status.policy.roleWeights,
      deepseek_avoid_peak_hours: status.policy.deepseekAvoidPeakHours,
      deepseek_peak_policy: status.policy.deepseekPeakPolicy,
      deepseek_peak_penalty: status.policy.deepseekPeakPenalty,
      fallback_penalty: status.policy.fallbackPenalty,
      metered_funded_resource_score: status.policy.meteredFundedResourceScore,
      reset_priority_window_ms: status.policy.resetPriorityWindowMs,
      reset_priority_exponent: status.policy.resetPriorityExponent,
      reset_priority_max_bonus: status.policy.resetPriorityMaxBonus,
      quota_floor_percent: status.policy.quotaFloorPercent,
      switch_margin_percent: status.policy.switchMarginPercent,
      local_usage_window_ms: status.policy.localUsageWindowMs,
      local_usage_weight_percent: status.policy.localUsageWeightPercent,
      priority_weight_percent: status.policy.priorityWeightPercent,
      reliability_weight_percent: status.policy.reliabilityWeightPercent,
      latency_weight_percent: status.policy.latencyWeightPercent,
      switch_cooldown_ms: status.policy.switchCooldownMs,
      circuit_breaker_failure_threshold: status.policy.circuitBreakerFailureThreshold,
      circuit_breaker_cooldown_ms: status.policy.circuitBreakerCooldownMs,
    },
  };
}

export const patchConfigRequestSchema = z.object({
  providers: z.record(z.string(), z.unknown()).optional(),
  default_provider: z.string().optional(),
  default_model: z.string().optional(),
  models: z.record(z.string(), z.unknown()).optional(),
  thinking: z.unknown().optional(),
  plan_mode: z.boolean().optional(),
  yolo: z.boolean().optional(),
  default_permission_mode: z.string().optional(),
  default_plan_mode: z.boolean().optional(),
  permission: z.unknown().optional(),
  hooks: z.array(z.unknown()).optional(),
  services: z.unknown().optional(),
  merge_all_available_skills: z.boolean().optional(),
  extra_skill_dirs: z.array(z.string()).optional(),
  loop_control: z.unknown().optional(),
  background: z.unknown().optional(),
  subagent: z.unknown().optional(),
  secondary_model: z.unknown().optional(),
  experimental: z.record(z.string(), z.boolean()).optional(),
  telemetry: z.boolean().optional(),
});
export type PatchConfigRequest = z.infer<typeof patchConfigRequestSchema>;
