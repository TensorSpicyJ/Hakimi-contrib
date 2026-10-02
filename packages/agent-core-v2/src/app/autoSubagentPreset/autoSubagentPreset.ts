/**
 * `autoSubagentPreset` domain — automatic subagent-preset selection contract.
 *
 * Defines the App-scope evaluator, its process-global latest-decision snapshot,
 * structured/localizable reason codes, reproducible candidate score breakdowns,
 * and the `event.subagent.preset_evaluated` / `preset_changed` facts. A status's
 * current preset and score describe the state at evaluation start; an activated
 * preset records the committed post-evaluation choice. User-requested selection
 * enables automatic mode and immediately re-evaluates without automatic debounce;
 * session-less calls update status without publishing session facts. Edges may
 * supply a pre-await manual revision for user selection; ordinary evaluation
 * ignores that context field. App scope.
 *
 * `resolveBinding` is the dispatch contract: disabled/locked mode passes through
 * the canonical resolver; automatic mode selects by aggregate score, revalidates
 * the current role and config under the activation boundary, and returns its
 * native or temporary binding only from a participating, selectable candidate.
 * Empty candidates or no usable binding reject with a coded error. A delayed
 * activation revalidates the decision before exposing its binding or cooldown;
 * at most one corrective activation is allowed before refusing unstable evidence.
 * Temporary bindings never mutate preset tables or global Memory routing.
 * `evaluate` / `selectAutomatically` retain aggregate semantics regardless of
 * the triggering route; the latter is the global UI action, not a coder filter.
 *
 * `evaluationScope: 'preset'` identifies aggregate snapshots; absent roleScores
 * retain the legacy single-route display. All presets share role keys: profile
 * names for Agent, and swarm/tower_worker/tower_reviewer for dedicated routes;
 * main is excluded. Weights default to 1; zero-weight roles remain visible.
 * Native/effective means use the same fixed totalRoleWeight denominator, with
 * unavailable roles contributing 0. Priority is added only once per candidate;
 * role contributions carry priorityBonus 0. `nativeScore` is the native mean plus
 * priority; `score` is the effective mean plus priority. A zero denominator has
 * no score and is not selectable. Partial means some, but not all, roles have
 * usable effective bindings; participating and selectable are separate facts.
 *
 * Role original/effective scores retain pre-clamp, pre-fallback-penalty values;
 * effectiveScore is max(0, effective.score - fallbackPenalty), or 0 if unusable.
 * peakPenalty is a raw policy deduction applied once to usable official DeepSeek
 * role scores, not the post-clamp net decrease. The candidate folds effective
 * deductions by role weight; deepseekRoleShare uses the same fixed denominator
 * and counts only healthy effective official DeepSeek routes, including fallbacks.
 * Metered peakPenalty.until marks a soft-penalty period, never blockedUntil.
 * Policy snapshots expose the resolved policy, including legacy block/off mapping.
 * explicit_preset remains readable for history but is no longer an automatic hold.
 * Fallback metadata appears only for a temporary replacement. Coverage counts
 * resource evidence by distinct effective account across original/effective
 * routes, not repeated role rows. Verified provider aliases use the canonical
 * queried provider name in public route evidence; private account identities
 * are never serialized. Unverified model-level auth/endpoint overrides stay
 * unknown. localEvidenceRoleCount counts original roles with usable samples:
 * account/model ownership must have been observed at a live start and stayed
 * unchanged until completion. Pre-observation history stays readable but supplies
 * no account evidence; scope 'none' means no usable history, not no recorded runs.
 * Metered usage combines the current equivalent provider aliases' local records,
 * not an official account bill; cost is never an authorization signal.
 * Resource-known includes known empty accounts, not failed queries.
 * resetPriority appears only on subscription evidence with a declared window of
 * at least one day, a future reset and positive remaining quota; its bonus
 * follows the configured exponential curve (zero outside the horizon or when
 * the policy is disabled), and floorRelaxed marks the sole exception to the
 * retention floor, granted only while every reported window stays readable and
 * unexhausted. A reported row with unreadable usage, limit, reset or window
 * fields voids the whole account evidence instead of being skipped. True
 * exhaustion is unavailable before any floor policy, and a wallet that takes
 * over an exhausted subscription never inherits the plan's expiry bonus.
 * Evidence citing a reset boundary that has already passed is refused, whether
 * at query time or at the commit boundary.
 * Candidate local evidence deduplicates run records; balances/cost periods must
 * never be summed across repeated provider rows. Metered funded-account 100 is
 * a binary availability baseline, not remaining quota or a task-budget promise.
 * Unknown balances, quota and costs stay absent/null, never fabricated zero.
 * Timestamps outside meteredUsage are epoch milliseconds; meteredUsage retains
 * providerUsage's ISO calendar-period contract. Payloads contain safe routing
 * identifiers, reason codes and numeric/monetary evidence only — no credentials,
 * endpoints, prompts, paths, summaries, raw error messages or other user content.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { LocalMeteredUsage } from '#/app/providerUsage/meteredUsage';
import { resolveDeepseekPeakPolicy } from '#/session/subagent/configSection';
import type {
  SubagentAutoPresetConfig,
  SubagentBindingResolution,
  SubagentBindingSource,
  SubagentFallbackMetadata,
  SubagentRouteAvailability,
  SubagentRouteKind,
  SubagentRouteRequest,
} from '#/session/subagent/configSection';

export const AUTO_PRESET_FALLBACK_PENALTY = 10;
export const AUTO_PRESET_METERED_FUNDED_RESOURCE_SCORE = 100;
export const AUTO_PRESET_DEFAULT_ROLE_WEIGHT = 1;

export interface AutoSubagentPresetContext {
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  readonly manualRevision?: number;
}

export type AutoSubagentPresetReasonCode =
  | 'cancelled'
  | 'flag_disabled'
  | 'auto_preset_disabled'
  | 'manual_lock'
  | 'caller_model_unavailable'
  | 'no_candidates'
  | 'explicit_preset'
  | 'no_quota_evidence'
  | 'no_healthy_candidate'
  | 'current_optimal'
  | 'score_margin_not_met'
  | 'switch_cooldown'
  | 'current_unhealthy'
  | 'circuit_breaker_escape'
  | 'higher_score'
  | 'manual_override'
  | 'preset_changed_during_evaluation'
  | 'routing_config_changed'
  | 'evaluation_failed'
  | 'activation_failed'
  | 'activation_no_effect';

export type AutoSubagentPresetRouteAvailability = SubagentRouteAvailability;

export type AutoSubagentPresetCandidateAvailability =
  | AutoSubagentPresetRouteAvailability
  | 'partial'
  | 'unavailable';

export type AutoSubagentPresetEvidenceScope = 'profile' | 'provider' | 'none';

export interface AutoSubagentPresetScoreContributions {
  readonly quotaRemaining?: number;
  readonly resourceScore?: number;
  readonly priorityBonus: number;
  readonly resetBonus: number;
  readonly routeFitBonus: number;
  readonly tokenPenalty: number;
  readonly reliabilityPenalty: number;
  readonly latencyPenalty: number;
  readonly peakPenalty?: number;
}

export interface AutoSubagentPresetLocalEvidence {
  readonly scope: AutoSubagentPresetEvidenceScope;
  readonly sampleCount: number;
  readonly failureCount: number;
  readonly adjustedFailureRate: number;
  readonly tokenCount: number;
  readonly averageFirstTokenLatencyMs?: number;
  readonly firstTokenLatencySampleCount: number;
  readonly llmRequestCount: number;
}

export interface AutoSubagentPresetResetPriority {
  readonly window: {
    readonly duration: number;
    readonly unit: 'minute' | 'hour' | 'day' | 'week';
  };
  readonly resetAt: number;
  readonly remainingPercent: number;
  readonly horizonMs: number;
  readonly bonus: number;
  readonly floorRelaxed: boolean;
}

export type AutoSubagentPresetResourceEvidence = (
  | {
      readonly kind: 'subscription';
      readonly resourceScore?: number;
      readonly quotaRemainingPercent?: number;
      readonly quotaResetAt?: number;
      readonly resetPriority?: AutoSubagentPresetResetPriority;
    }
  | {
      readonly kind: 'metered';
      readonly currency: 'CNY';
      readonly balanceCny?: string;
      readonly isAvailable?: boolean;
      readonly balanceStatus: 'known' | 'query_failed' | 'invalid' | 'missing';
      readonly resourceScore?: 0 | typeof AUTO_PRESET_METERED_FUNDED_RESOURCE_SCORE;
      readonly resourceScoreBasis: 'funded_account';
      readonly meteredUsage?: LocalMeteredUsage;
      readonly peakPenalty?: {
        readonly points: number;
        readonly until: number;
      };
    }
  | {
      readonly kind: 'unknown';
      readonly reason: 'missing' | 'query_failed' | 'unsupported';
    }
) & {
  readonly blockedUntil?: number;
};

export interface AutoSubagentPresetRouteScore {
  readonly model?: string;
  readonly thinking?: string;
  readonly provider?: string;
  readonly source?: SubagentBindingSource;
  readonly modelSource?: SubagentBindingSource;
  readonly thinkingSource?: SubagentBindingSource;
  readonly availability: AutoSubagentPresetRouteAvailability;
  readonly score?: number;
  readonly contributions: AutoSubagentPresetScoreContributions;
  readonly localEvidence: AutoSubagentPresetLocalEvidence;
  readonly resource: AutoSubagentPresetResourceEvidence;
  readonly circuitBreakerOpenUntil?: number;
}

export interface AutoSubagentPresetRoleScore {
  readonly key: string;
  readonly route: SubagentRouteKind;
  readonly profileName?: string;
  readonly weight: number;
  readonly original: AutoSubagentPresetRouteScore;
  readonly effective: AutoSubagentPresetRouteScore;
  readonly effectiveScore: number;
  readonly fallbackPenalty: number;
  readonly fallback?: SubagentFallbackMetadata;
}

export interface AutoSubagentPresetCoverage {
  readonly resourceProviderCount: number;
  readonly totalProviderCount: number;
  readonly localEvidenceRoleCount: number;
  readonly totalRoleCount: number;
}

export interface AutoSubagentPresetCandidateScore {
  readonly preset: string;
  readonly provider?: string;
  readonly availability: AutoSubagentPresetCandidateAvailability;
  readonly selectable: boolean;
  readonly score?: number;
  readonly quotaRemainingPercent?: number;
  readonly quotaResetAt?: number;
  readonly circuitBreakerOpenUntil?: number;
  readonly contributions: AutoSubagentPresetScoreContributions;
  readonly localEvidence: AutoSubagentPresetLocalEvidence;
  readonly participating?: boolean;
  readonly nativeScore?: number;
  readonly roleScores?: readonly AutoSubagentPresetRoleScore[];
  readonly coverage?: AutoSubagentPresetCoverage;
  readonly roleCount?: number;
  readonly nativeAvailableRoleCount?: number;
  readonly fallbackRoleCount?: number;
  readonly unavailableRoleCount?: number;
  readonly totalRoleWeight?: number;
  readonly deepseekRoleShare?: number;
}

export interface AutoSubagentPresetPolicySnapshot {
  readonly roleWeights?: Readonly<Record<string, number>>;
  readonly deepseekAvoidPeakHours?: boolean;
  readonly deepseekPeakPolicy?: 'block' | 'penalize' | 'off';
  readonly deepseekPeakPenalty?: number;
  readonly fallbackPenalty?: number;
  readonly meteredFundedResourceScore?: number;
  readonly resetPriorityWindowMs?: number;
  readonly resetPriorityExponent?: number;
  readonly resetPriorityMaxBonus?: number;
  readonly quotaFloorPercent: number;
  readonly switchMarginPercent: number;
  readonly localUsageWindowMs: number;
  readonly localUsageWeightPercent: number;
  readonly priorityWeightPercent: number;
  readonly reliabilityWeightPercent: number;
  readonly latencyWeightPercent: number;
  readonly switchCooldownMs: number;
  readonly circuitBreakerFailureThreshold: number;
  readonly circuitBreakerCooldownMs: number;
}

export interface AutoSubagentPresetStatus {
  readonly evaluationScope?: 'preset';
  readonly evaluatedAt: number;
  readonly route: SubagentRouteKind;
  readonly profileName?: string;
  readonly reasonCode: AutoSubagentPresetReasonCode;
  readonly currentPreset?: string;
  readonly selectedPreset?: string;
  readonly activatedPreset?: string;
  readonly currentScore?: number;
  readonly selectedScore?: number;
  readonly switchCooldownUntil?: number;
  readonly candidates: readonly AutoSubagentPresetCandidateScore[];
  readonly policy: AutoSubagentPresetPolicySnapshot;
}

export interface SubagentPresetEvaluatedPayload extends AutoSubagentPresetStatus {
  readonly sessionId: string;
}

export interface SubagentPresetChangedPayload {
  readonly sessionId: string;
  readonly previousPreset?: string;
  readonly currentPreset: string;
  readonly reasonCode: AutoSubagentPresetReasonCode;
  readonly profileName?: string;
  readonly evaluatedAt: number;
  readonly previousScore?: number;
  readonly currentScore?: number;
}

export const SUBAGENT_PRESET_EVALUATED_EVENT_TYPE = 'event.subagent.preset_evaluated';
export const SUBAGENT_PRESET_CHANGED_EVENT_TYPE = 'event.subagent.preset_changed';

export interface AutoSubagentPresetEvaluation {
  readonly request: SubagentRouteRequest;
  readonly currentPreset?: string;
  readonly activatedPreset?: string;
  readonly reason: string;
  readonly reasonCode?: AutoSubagentPresetReasonCode;
  readonly status?: AutoSubagentPresetStatus;
}

export interface IAutoSubagentPresetService {
  readonly _serviceBrand: undefined;

  resolveBinding(
    request: SubagentRouteRequest,
    context: AutoSubagentPresetContext,
  ): Promise<SubagentBindingResolution>;
  evaluate(
    request: SubagentRouteRequest,
    context: AutoSubagentPresetContext,
  ): Promise<AutoSubagentPresetEvaluation>;
  selectAutomatically(
    request: SubagentRouteRequest,
    context: AutoSubagentPresetContext,
  ): Promise<AutoSubagentPresetEvaluation>;
  status(): AutoSubagentPresetStatus | undefined;
}

export const IAutoSubagentPresetService: ServiceIdentifier<IAutoSubagentPresetService> =
  createDecorator<IAutoSubagentPresetService>('autoSubagentPresetService');

export function autoSubagentPresetPolicySnapshot(
  settings: SubagentAutoPresetConfig,
): AutoSubagentPresetPolicySnapshot {
  return {
    roleWeights: settings.roleWeights,
    deepseekAvoidPeakHours: settings.deepseekAvoidPeakHours,
    deepseekPeakPolicy: resolveDeepseekPeakPolicy(settings),
    deepseekPeakPenalty: settings.deepseekPeakPenalty,
    fallbackPenalty: AUTO_PRESET_FALLBACK_PENALTY,
    meteredFundedResourceScore: AUTO_PRESET_METERED_FUNDED_RESOURCE_SCORE,
    resetPriorityWindowMs: settings.resetPriorityWindowMs,
    resetPriorityExponent: settings.resetPriorityExponent,
    resetPriorityMaxBonus: settings.resetPriorityMaxBonus,
    quotaFloorPercent: settings.quotaFloorPercent,
    switchMarginPercent: settings.switchMarginPercent,
    localUsageWindowMs: settings.localUsageWindowMs,
    localUsageWeightPercent: settings.localUsageWeightPercent,
    priorityWeightPercent: settings.priorityWeightPercent,
    reliabilityWeightPercent: settings.reliabilityWeightPercent,
    latencyWeightPercent: settings.latencyWeightPercent,
    switchCooldownMs: settings.switchCooldownMs,
    circuitBreakerFailureThreshold: settings.circuitBreakerFailureThreshold,
    circuitBreakerCooldownMs: settings.circuitBreakerCooldownMs,
  };
}
