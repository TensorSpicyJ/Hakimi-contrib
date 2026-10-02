import type {
  AppConfig,
  AutoSubagentPresetCandidateAvailability,
  AutoSubagentPresetCandidateScore,
  AutoSubagentPresetReasonCode,
  AutoSubagentPresetResetPriority,
  AutoSubagentPresetStatus,
  AutoSubagentPresetRoleScore,
  AutoSubagentPresetRouteScore,
  AutoSubagentPresetResourceEvidence,
  SubagentModelConfig,
} from '../api/types';

/** Minimal i18n translator signature the label helpers accept — lets callers
 *  pass the component's `useI18n().t` (or the singleton's `i18n.global.t`) so
 *  the helpers stay pure and unit-testable against both locales. */
export type SubagentPresetT = (key: string, named?: Record<string, unknown>) => string;

export const AUTO_SUBAGENT_PRESET_FLAG_ID = 'auto_subagent_preset';

export function autoSubagentPresetSupported(
  experimentalFlags: Readonly<Record<string, boolean>>,
): boolean {
  return Object.prototype.hasOwnProperty.call(
    experimentalFlags,
    AUTO_SUBAGENT_PRESET_FLAG_ID,
  );
}

/** The runtime switches automatically only when both its effective feature flag
 *  and the subagent-domain preference are enabled. */
export function autoSubagentPresetEnabled(
  config: Pick<AppConfig, 'subagent'> | null | undefined,
  experimentalFlags: Readonly<Record<string, boolean>>,
): boolean {
  return (
    config?.subagent?.autoPreset?.enabled === true &&
    experimentalFlags[AUTO_SUBAGENT_PRESET_FLAG_ID] === true
  );
}

export function autoSubagentPresetFlagOverridden(
  config: Pick<AppConfig, 'experimental'> | null | undefined,
  experimentalFlags: Readonly<Record<string, boolean>>,
): boolean {
  if (!autoSubagentPresetSupported(experimentalFlags)) return false;
  const configured = config?.experimental?.[AUTO_SUBAGENT_PRESET_FLAG_ID] === true;
  return configured !== experimentalFlags[AUTO_SUBAGENT_PRESET_FLAG_ID];
}

/** One user-facing switch controls both internal gates without resending any
 *  existing preset or route tables; the daemon deep-merges each config domain.
 *  Subagent preference comes first so a partial write never enables the flag
 *  before its fail-closed domain gate is in place. */
export function autoSubagentPresetPatch(enabled: boolean): Partial<AppConfig> {
  return {
    subagent: { autoPreset: { enabled } },
    experimental: { [AUTO_SUBAGENT_PRESET_FLAG_ID]: enabled },
  };
}

/**
 * `autoPreset.manualLock` — set by the server whenever a preset is activated
 * manually. While true the auto-preset runtime keeps the manual choice and
 * stops switching on its own; the UI shows the persistent "manual lock" state.
 */
export function subagentPresetManualLock(
  config: Pick<AppConfig, 'subagent'> | null | undefined,
): boolean {
  return config?.subagent?.autoPreset?.manualLock === true;
}

export function autoSubagentPresetUnavailableReason(
  config: AppConfig | null | undefined,
  flags: Readonly<Record<string, boolean>>,
  t: SubagentPresetT,
  supported?: boolean,
): string | undefined {
  if (!config) return t('header.subagentPresetConfigUnavailable');
  // Cleared effective flags are unknown, not evidence that the route is absent.
  // Only a completed metadata read (or the action's explicit 404) denies support.
  if (supported === false) return t('header.subagentPresetAutoUnsupported');
  if (autoSubagentPresetFlagOverridden(config, flags) && !flags[AUTO_SUBAGENT_PRESET_FLAG_ID]) {
    return t('header.subagentPresetAutoEnvDisabled');
  }
  return undefined;
}

export function autoSubagentPresetActionLabel(
  automatic: boolean,
  locked: boolean,
  t: SubagentPresetT,
): string {
  return t(automatic
    ? 'header.subagentPresetAutoAgain'
    : locked ? 'header.subagentPresetResumeAuto' : 'header.subagentPresetAutoSelect');
}

/** Every completed request gets feedback, including an unchanged selection. */
export function autoSubagentPresetResultLabel(
  config: AppConfig,
  status: AutoSubagentPresetStatus,
  locale: string,
  t: SubagentPresetT,
): string {
  return t('header.subagentPresetAutoResult', {
    preset: config.subagent?.preset || t('header.subagentPresetBaseOption'),
    reason: subagentPresetReasonLabel(status.reasonCode, t),
    time: new Date(status.evaluatedAt).toLocaleString(locale),
  });
}

/**
 * Priority order of the automatic-switching candidates. A configured
 * `candidates` list — including an empty list — is authoritative as-is, so a
 * subset is never extended with missing presets. Without the field, every
 * declared preset in declaration order is considered.
 */
export function subagentPresetCandidatesOrder(
  config: Pick<AppConfig, 'subagent'> | null | undefined,
  declaredOrder: string[],
): string[] {
  const candidates = config?.subagent?.autoPreset?.candidates;
  return candidates === undefined ? [...declaredOrder] : [...candidates];
}

/** Persist the candidate priority list; targets only
 *  `subagent.autoPreset.candidates` (other auto-preset fields stay untouched). */
export function subagentPresetCandidatesPatch(candidates: string[]): Partial<AppConfig> {
  return { subagent: { autoPreset: { candidates } } };
}

export function mainRouteForPreset(
  config: Pick<AppConfig, 'subagent'>,
  preset: string,
): SubagentModelConfig | undefined {
  if (preset.length === 0) return undefined;
  return config.subagent?.presets?.[preset]?.['main'];
}

/**
 * Label for the persistent routing control in the chat header. An active preset
 * renders by name; an absent selector renders the base-routing fallback so the
 * current choice is always visible. The preset name rides a `{preset}` i18n
 * placeholder so both locales share the target shape.
 */
export function subagentPresetLabel(
  preset: string | undefined | null,
  t: SubagentPresetT,
): string {
  const normalized = preset?.trim();
  if (!normalized) return t('header.subagentPresetBase');
  return t('header.subagentPreset', { preset: normalized });
}

export function subagentPresetReasonLabel(
  reasonCode: AutoSubagentPresetReasonCode,
  t: SubagentPresetT,
): string {
  return t(`header.subagentPresetReasons.${reasonCode}`);
}

function scoreValue(value: number): string {
  const normalized = Math.abs(value) < 0.05 ? 0 : value;
  return normalized.toFixed(1);
}

export interface SubagentPresetCurrentEvaluation {
  readonly preset?: string;
  readonly score?: number;
}

export function subagentPresetCurrentEvaluation(
  status: AutoSubagentPresetStatus,
  activePreset: string | undefined,
): SubagentPresetCurrentEvaluation {
  const preset =
    status.activatedPreset?.trim() ||
    activePreset?.trim() ||
    status.currentPreset?.trim() ||
    undefined;
  if (preset === undefined) return {};
  const candidateScore = status.candidates.find(
    (candidate) => candidate.preset === preset,
  )?.score;
  const fallbackScore =
    preset === status.activatedPreset || preset === status.selectedPreset
      ? status.selectedScore
      : preset === status.currentPreset
        ? status.currentScore
        : undefined;
  return { preset, score: candidateScore ?? fallbackScore };
}

export function formatSubagentPresetScore(
  score: number | undefined,
  t: SubagentPresetT,
): string {
  return score === undefined
    ? t('header.subagentPresetScoreNoData')
    : t('header.subagentPresetScore', { score: scoreValue(score) });
}

export function formatSubagentPresetDuration(durationMs: number, t: SubagentPresetT): string {
  const safeMs = Math.max(0, durationMs);
  if (safeMs >= 60 * 60 * 1000) {
    return t('header.subagentPresetDurationHours', {
      count: Math.ceil(safeMs / (60 * 60 * 1000)),
    });
  }
  if (safeMs >= 60 * 1000) {
    return t('header.subagentPresetDurationMinutes', {
      count: Math.ceil(safeMs / (60 * 1000)),
    });
  }
  return t('header.subagentPresetDurationSeconds', {
    count: Math.max(1, Math.ceil(safeMs / 1000)),
  });
}

export function subagentPresetRemainingLabel(
  until: number | undefined,
  now: number,
  key: 'cooldown' | 'circuit',
  t: SubagentPresetT,
): string | undefined {
  if (until === undefined || until <= now) return undefined;
  return t(
    key === 'cooldown'
      ? 'header.subagentPresetCooldownRemaining'
      : 'header.subagentPresetCircuitRemaining',
    { duration: formatSubagentPresetDuration(until - now, t) },
  );
}

export function subagentPresetAvailabilityLabel(
  availability: AutoSubagentPresetCandidateAvailability,
  t: SubagentPresetT,
): string {
  return t(`header.subagentPresetAvailability.${availability}`);
}

function contributionLabel(
  key: 'quota' | 'priority' | 'reset' | 'routeFit' | 'tokens' | 'reliability' | 'latency',
  value: number,
  positive: boolean,
  t: SubagentPresetT,
): string {
  const sign = positive ? '+' : '−';
  return t('header.subagentPresetContributionValue', {
    label: t(`header.subagentPresetContributions.${key}`),
    value: `${sign}${scoreValue(Math.abs(value))}`,
  });
}

/** Compact candidate explanation for the header menu: strongest gain/loss plus
 *  an explicit missing-evidence or circuit-breaker state. */
export function subagentPresetCandidateSummary(
  candidate: AutoSubagentPresetCandidateScore,
  now: number,
  t: SubagentPresetT,
): string {
  if (candidate.roleScores !== undefined) {
    return [subagentPresetCandidateState(candidate, t), subagentPresetRoleCounts(candidate, t),
      subagentPresetPeakSummary(candidate, t),
      candidate.localEvidence.sampleCount === 0 ? t('header.subagentPresetNoLocalEvidence') : '',
    ].filter(Boolean).join(' · ');
  }
  const circuit = subagentPresetRemainingLabel(
    candidate.circuitBreakerOpenUntil,
    now,
    'circuit',
    t,
  );
  if (circuit !== undefined) return circuit;
  if (candidate.availability !== 'healthy') {
    return subagentPresetAvailabilityLabel(candidate.availability, t);
  }

  const gains = [
    ['quota', candidate.contributions.quotaRemaining] as const,
    ['priority', candidate.contributions.priorityBonus] as const,
    ['reset', candidate.contributions.resetBonus] as const,
    ['routeFit', candidate.contributions.routeFitBonus] as const,
  ]
    .filter(
      (entry): entry is readonly ['quota' | 'priority' | 'reset' | 'routeFit', number] =>
        entry[1] !== undefined && entry[1] > 0,
    )
    .toSorted((a, b) => b[1] - a[1]);
  const penalties = [
    ['tokens', candidate.contributions.tokenPenalty] as const,
    ['reliability', candidate.contributions.reliabilityPenalty] as const,
    ['latency', candidate.contributions.latencyPenalty] as const,
  ]
    .filter((entry) => entry[1] > 0)
    .toSorted((a, b) => b[1] - a[1]);
  const parts: string[] = [];
  const gain = gains[0];
  const penalty = penalties[0];
  if (gain !== undefined) parts.push(contributionLabel(gain[0], gain[1], true, t));
  if (penalty !== undefined) {
    parts.push(contributionLabel(penalty[0], penalty[1], false, t));
  }
  if (candidate.localEvidence.scope === 'none') {
    parts.push(t('header.subagentPresetNoLocalEvidence'));
  }
  return parts.length > 0 ? parts.join(' · ') : t('header.subagentPresetNoData');
}

/** Full deterministic score breakdown for the read-only Settings diagnostics. */
export function subagentPresetCandidateBreakdown(
  candidate: Pick<AutoSubagentPresetCandidateScore, 'contributions'>,
  t: SubagentPresetT,
): string {
  const c = candidate.contributions;
  const parts = [
    c.resourceScore !== undefined
      ? t('settings.presetScoring.resourceScore', { score: scoreValue(c.resourceScore) })
      : c.quotaRemaining === undefined
        ? t('header.subagentPresetQuotaNoData')
        : contributionLabel('quota', c.quotaRemaining, true, t),
    contributionLabel('priority', c.priorityBonus, true, t),
    contributionLabel('reset', c.resetBonus, true, t),
    contributionLabel('routeFit', c.routeFitBonus, true, t),
    contributionLabel('tokens', c.tokenPenalty, false, t),
    contributionLabel('reliability', c.reliabilityPenalty, false, t),
    contributionLabel('latency', c.latencyPenalty, false, t),
  ];
  if (c.peakPenalty !== undefined) parts.push(c.peakPenalty === 0 ? t('settings.presetScoring.peakNoPenalty')
    : t('settings.presetScoring.peakRawPenalty', { points: scoreValue(c.peakPenalty) }));
  return parts.join(' · ');
}

export function subagentPresetEvidenceLabel(
  candidate: AutoSubagentPresetCandidateScore,
  t: SubagentPresetT,
): string {
  if (candidate.localEvidence.scope === 'none') {
    return t('header.subagentPresetNoLocalEvidence');
  }
  return t(
    candidate.localEvidence.scope === 'profile'
      ? 'header.subagentPresetProfileEvidence'
      : 'header.subagentPresetProviderEvidence',
    { count: candidate.localEvidence.sampleCount },
  );
}

export function subagentPresetEvaluationScopeLabel(
  status: AutoSubagentPresetStatus,
  t: SubagentPresetT,
): string {
  return t(status.evaluationScope === 'preset' && status.candidates.every((c) => c.roleScores !== undefined)
    ? 'header.subagentPresetAggregate' : 'header.subagentPresetLegacy');
}

/** Current configuration is distinct from a historical automatic activation. */
export function subagentPresetConfiguredLabel(config: Pick<AppConfig, 'subagent'> | null | undefined, t: SubagentPresetT): string {
  return t('settings.smartRoutingConfiguredSelection', {
    preset: config?.subagent?.preset?.trim() || t('header.subagentPresetBaseOption'),
  });
}

/** Diagnostics retain removed presets, but history cannot re-enable a route. */
export function subagentPresetDisplayRows(
  names: readonly string[],
  status: AutoSubagentPresetStatus | undefined,
  candidates?: readonly string[],
): Array<{ preset: string; candidate?: AutoSubagentPresetCandidateScore; configured: boolean; participating: boolean }> {
  return [...new Set([...names, ...(status?.candidates.map((c) => c.preset) ?? [])])].map((preset) => {
    const candidate = status?.candidates.find((c) => c.preset === preset);
    const configured = names.includes(preset);
    return { preset, candidate, configured, participating: configured && (candidates?.includes(preset) ?? candidate?.participating ?? true) };
  });
}

/** Excluded but configured presets remain valid manual choices; deleted ones do not. */
export function subagentPresetMenuRows(names: readonly string[], status: AutoSubagentPresetStatus | undefined, candidates?: readonly string[]) {
  return subagentPresetDisplayRows(names, status, candidates).filter((row) => row.configured);
}

export function subagentPresetParticipationLabel(participating: boolean, t: SubagentPresetT): string {
  return t(participating ? 'header.subagentPresetParticipating' : 'header.subagentPresetExcluded');
}

export function subagentPresetCandidateState(candidate: AutoSubagentPresetCandidateScore, t: SubagentPresetT): string {
  if (candidate.roleScores === undefined) return t('header.subagentPresetLegacy');
  if (candidate.availability !== 'healthy') return subagentPresetAvailabilityLabel(candidate.availability, t);
  return t((candidate.fallbackRoleCount ?? candidate.roleScores.filter((r) => r.fallback).length) > 0
    ? 'header.subagentPresetFallback' : 'header.subagentPresetNative');
}

export function subagentPresetTotals(candidate: AutoSubagentPresetCandidateScore | undefined, t: SubagentPresetT): string {
  if (!candidate?.roleScores) return formatSubagentPresetScore(candidate?.score, t);
  return t('header.subagentPresetTotals', {
    native: presetScoreNumber(candidate.nativeScore, t), effective: presetScoreNumber(candidate.score, t),
  });
}

export function presetScoreNumber(value: number | undefined, t: SubagentPresetT): string {
  return value === undefined || !Number.isFinite(value) ? t('settings.presetScoring.unknown') : scoreValue(value);
}

export function subagentPresetRoleCounts(candidate: AutoSubagentPresetCandidateScore, t: SubagentPresetT): string {
  return t('header.subagentPresetRoleCounts', {
    native: candidate.nativeAvailableRoleCount ?? candidate.roleScores?.filter((r) => r.original.availability === 'healthy').length ?? 0,
    total: candidate.roleCount ?? candidate.roleScores?.length ?? 0,
    fallback: candidate.fallbackRoleCount ?? candidate.roleScores?.filter((r) => r.fallback).length ?? 0,
    unavailable: candidate.unavailableRoleCount ?? candidate.roleScores?.filter((r) => r.effective.availability !== 'healthy').length ?? 0,
  });
}

export function subagentPresetCoverageLabel(candidate: AutoSubagentPresetCandidateScore, t: SubagentPresetT): string {
  const c = candidate.coverage;
  return c ? t('settings.presetScoring.coverage', {
    resources: c.resourceProviderCount, providers: c.totalProviderCount,
    local: c.localEvidenceRoleCount, roles: c.totalRoleCount,
  }) : t('header.subagentPresetNoData');
}

/** Decimal strings are money, never percentages. Missing/invalid is not zero. */
export function formatPresetCny(value: string | null | undefined, locale: string, t: SubagentPresetT): string {
  if (value === null || value === undefined || !/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) {
    return t('settings.presetScoring.unknown');
  }
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'CNY', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(Number(value));
}

export function subagentPresetResourceLabel(resource: AutoSubagentPresetResourceEvidence, locale: string, t: SubagentPresetT): string {
  if (resource.kind === 'unknown') return t(`settings.presetScoring.unknownResource.${resource.reason}`);
  if (resource.kind === 'subscription') return resource.quotaRemainingPercent === undefined
    ? t('header.subagentPresetQuotaNoData')
    : t('settings.presetScoring.quota', { percent: resource.quotaRemainingPercent.toFixed(1) });
  const parts = [t(`settings.presetScoring.balanceStatus.${resource.balanceStatus}`)];
  if (resource.balanceStatus === 'known') parts.push(t('settings.presetScoring.balance', { amount: formatPresetCny(resource.balanceCny, locale, t) }));
  if (resource.isAvailable === false) parts.push(t('header.subagentPresetAvailability.account_unavailable'));
  return parts.join(' · ');
}

/** New snapshots override the legacy boolean; absent legacy evidence stays unknown. */
export function subagentPresetPeakPolicyLabel(
  policy: Partial<AutoSubagentPresetStatus['policy']>,
  t: SubagentPresetT,
): string | undefined {
  const mode = policy.deepseekPeakPolicy ?? (policy.deepseekAvoidPeakHours === undefined
    ? undefined : policy.deepseekAvoidPeakHours ? 'block' : 'off');
  if (mode === undefined) return undefined;
  const parts = [t('settings.presetScoring.peakPolicy', { mode: t(`settings.presetScoring.peakModes.${mode}`) })];
  if (policy.deepseekPeakPenalty !== undefined) parts.push(t('settings.presetScoring.peakFullWeight', {
    points: scoreValue(policy.deepseekPeakPenalty),
  }));
  return parts.join(' · ');
}

/** Display server facts, not a role-count ratio or a second score deduction. */
export function subagentPresetPeakSummary(candidate: AutoSubagentPresetCandidateScore, t: SubagentPresetT): string | undefined {
  const parts: string[] = [];
  if (candidate.deepseekRoleShare !== undefined) parts.push(t('settings.presetScoring.peakShare', {
    percent: scoreValue(candidate.deepseekRoleShare * 100),
  }));
  const penalty = candidate.contributions.peakPenalty;
  if (penalty !== undefined) parts.push(penalty === 0 ? t('settings.presetScoring.peakNoPenalty')
    : t('settings.presetScoring.peakRawPenalty', { points: scoreValue(penalty) }));
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export function subagentPresetRolePeakLabel(resource: AutoSubagentPresetResourceEvidence, locale: string, t: SubagentPresetT): string | undefined {
  if (resource.kind !== 'metered' || resource.peakPenalty === undefined) return undefined;
  return t('settings.presetScoring.peakRole', {
    points: scoreValue(resource.peakPenalty.points),
    time: new Date(resource.peakPenalty.until).toLocaleString(locale, { timeZone: 'Asia/Shanghai' }),
  });
}

/**
 * Exponential expiring-quota evidence for one subscription window: the real
 * window period (e.g. 1 week — never the short 5h throttle `quotaResetAt`),
 * the real reset date and distance, the real remaining percent, and the
 * server-computed bonus points. Absent evidence stays absent; the UI never
 * recomputes the bonus or assumes the quota recovers at the reset time.
 */
export function subagentPresetResetPriorityLabel(
  resetPriority: AutoSubagentPresetResetPriority | undefined,
  now: number,
  locale: string,
  t: SubagentPresetT,
): string | undefined {
  if (resetPriority === undefined) return undefined;
  return t('settings.presetScoring.resetPriority', {
    window: t('settings.usageWindow', {
      duration: resetPriority.window.duration,
      unit: t(`settings.usageUnits.${resetPriority.window.unit}`),
    }),
    time: new Date(resetPriority.resetAt).toLocaleString(locale),
    remaining: formatSubagentPresetDuration(Math.max(0, resetPriority.resetAt - now), t),
    percent: resetPriority.remainingPercent.toFixed(1),
    bonus: scoreValue(resetPriority.bonus),
  });
}

/** Explains why a low-but-positive quota is still usable: the expiring window
 *  relaxed the usual quota floor. Nothing else is waived. */
export function subagentPresetResetFloorRelaxedLabel(
  resetPriority: AutoSubagentPresetResetPriority | undefined,
  t: SubagentPresetT,
): string | undefined {
  return resetPriority?.floorRelaxed === true
    ? t('settings.presetScoring.resetFloorRelaxed')
    : undefined;
}

export function subagentPresetBindingLabel(route: AutoSubagentPresetRouteScore, t: SubagentPresetT): string {
  return `${route.model ?? t('settings.presetScoring.unknown')} · ${route.thinking ?? t('settings.presetScoring.unknown')}`;
}

export function subagentPresetBindingSourceLabel(route: AutoSubagentPresetRouteScore, t: SubagentPresetT): string {
  const source = (value: string | undefined) => value ? t(`settings.presetScoring.sources.${value}`) : t('settings.presetScoring.unknown');
  return t('settings.presetScoring.source', { model: source(route.modelSource ?? route.source), thinking: source(route.thinkingSource ?? route.source) });
}

export function subagentPresetRoleContribution(role: AutoSubagentPresetRoleScore, totalRoleWeight: number | undefined): number | undefined {
  return totalRoleWeight !== undefined && totalRoleWeight > 0
    ? role.weight * role.effectiveScore / totalRoleWeight : undefined;
}

/** The same account appears in many roles/presets. Render it once, never add its periods. */
export function subagentPresetMeteredProviders(candidates: readonly AutoSubagentPresetCandidateScore[]): Array<{
  provider: string; resource: Extract<AutoSubagentPresetResourceEvidence, { kind: 'metered' }>;
}> {
  const providers = new Map<string, Extract<AutoSubagentPresetResourceEvidence, { kind: 'metered' }>>();
  for (const candidate of candidates) for (const role of candidate.roleScores ?? []) {
    for (const route of [role.original, role.effective]) {
      if (route.provider && route.resource.kind === 'metered' && !providers.has(route.provider)) providers.set(route.provider, route.resource);
    }
  }
  return [...providers].map(([provider, resource]) => ({ provider, resource }));
}

/** Preset values carried by a `subagentPreset` status turn (marker metadata). */
export interface SubagentPresetSwitchView {
  from?: string;
  to: string;
  reasonCode?: AutoSubagentPresetReasonCode;
  profileName?: string;
  evaluatedAt?: number;
  previousScore?: number;
  currentScore?: number;
}

/** Localized transcript separator for one automatic preset switch. */
export function subagentPresetChangedLabel(
  view: SubagentPresetSwitchView | undefined,
  t: SubagentPresetT,
): string {
  const to = view?.to ?? '';
  const switched = Boolean(view?.from && view.from !== view.to);
  const base = switched
    ? t('conversation.subagentPresetAutoSwitched', { from: view?.from, to })
    : t('conversation.subagentPresetAutoSet', { preset: to });
  if (view?.reasonCode === undefined) return base;
  let reason = subagentPresetReasonLabel(view.reasonCode, t);
  if (view.profileName) {
    reason = t('conversation.subagentPresetReasonWithProfile', {
      reason,
      profile: view.profileName,
    });
  }
  return t('conversation.subagentPresetSwitchWithReason', { switch: base, reason });
}
