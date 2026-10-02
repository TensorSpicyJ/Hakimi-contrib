/**
 * `autoSubagentPreset` domain — `IAutoSubagentPresetService` implementation.
 *
 * Collects account evidence through providerUsage, alias-group local reports
 * through providerUsageLedger, live run facts through agentRunUsage, and canonical
 * bindings through subagent/modelCatalog. The model/provider registries establish
 * private account ownership at each observed start; completed ownership never
 * follows later alias edits, and unobserved ledger history supplies no account
 * evidence. Protocol metadata and thinking helpers align scores with runtime
 * effort. Pure helpers score presets and compatible temporary replacements.
 * Uses config/flag gates, hostClock deadlines and the shared subagent activation
 * boundary to revalidate routing, model/provider configuration, manual revision,
 * current-role availability and Shanghai time restrictions before dispatch.
 * Provider queries and ledger hydration remain outside that boundary; temporary
 * bindings are returned directly, never stored in global routing configuration.
 * Status and real-session facts are published through event, with sanitized
 * diagnostics through log. User selection enables automatic mode and refreshes
 * evidence, bypassing only margin and switch cooldown. Unlocked automatic mode
 * replaces a current preset outside the candidate list rather than implicitly
 * treating it as a manual lock. Automatic bindings require a participating,
 * selectable candidate; an empty candidate list never authorizes dispatch.
 * Asynchronous activations re-decide from the original current preset using
 * fresh prefetched evidence, with at most one corrective write. Only a verified
 * final change starts cooldown or publishes a changed fact; unstable corrections
 * refuse dispatch without querying providers under the writer lock.
 * Declared subscription windows of at least one day earn the shared exponential
 * reset-priority bonus as their reset approaches and may relax the retention
 * floor while genuinely unexhausted; cached quota evidence invalidates across
 * any known reset boundary, a response still citing a crossed reset is
 * refreshed once and refused when it stays stale, and evidence whose reset
 * boundary passes before the commit is treated as unknown for that dispatch.
 * Failed evaluations retain configuration but cannot authorize an unverified
 * automatic dispatch. Bound at App scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ConfigTarget, IConfigService } from '#/app/config/config';
import { deepMerge } from '#/app/config/configPure';
import { ILogService } from '#/_base/log/log';
import { IHostClock } from '#/os/interface/hostClock';
import { IFlagService } from '#/app/flag/flag';
import { IEventService } from '#/app/event/event';
import { Error2, ErrorCodes } from '#/errors';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { IProviderService } from '#/kosong/provider/provider';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import { drivesThinkingThroughTraits, requiresStrictThinkingValidation, resolveForcedThinkingEffort, resolveThinkingEffortForModel, type ThinkingConfig } from '#/kosong/model/thinking';
import { DEEPSEEK_USAGE_FLAG_ID } from '#/app/providerUsage/flag';
import { AccountIdentity, type EffectiveAccount } from './accountIdentity';
import {
  IProviderUsageService,
  type ProviderUsageResult,
} from '#/app/providerUsage/providerUsage';
import {
  IAgentRunUsageService,
  type AgentRunUsageEntry,
  type AgentRunUsageStartedRecord,
} from '#/app/agentRunUsage/agentRunUsage';
import { IProviderUsageLedgerService } from '#/app/providerUsageLedger/providerUsageLedger';
import { LiveRunIdentity, type RunIdentity } from './liveRunIdentity';
import { AUTO_SUBAGENT_PRESET_FLAG_ID } from '#/session/subagent/flag';
import {
  SUBAGENT_SECTION,
  activeSubagentPreset,
  DEFAULT_AUTO_PRESET_QUOTA_FLOOR_PERCENT,
  DEFAULT_AUTO_PRESET_RESET_PRIORITY_EXPONENT,
  DEFAULT_AUTO_PRESET_RESET_PRIORITY_MAX_BONUS,
  DEFAULT_AUTO_PRESET_RESET_PRIORITY_WINDOW_MS,
  resolveSubagentAutoPresetConfig,
  resolveSubagentBinding,
  type SubagentBindingResolution,
  resolveSubagentBindingForPreset,
  type SubagentAutoPresetConfig,
  type SubagentConfig,
  type SubagentRouteRequest,
} from '#/session/subagent/configSection';
import { ISubagentPresetActivationService } from '#/session/subagent/presetActivation';

import { bindingForRole, preparePresetScores, scorePresets } from './aggregateScore';
import { summarizeRuns } from './localEvidence';
import {
  resetPriorityPolicy,
  subscriptionResetPriority,
  windowDurationMs,
  windowRemainingPercent,
  type ResetPriorityPolicy,
} from './resetPriority';
import {
  autoSubagentPresetPolicySnapshot,
  type AutoSubagentPresetCandidateScore,
  type AutoSubagentPresetContext,
  type AutoSubagentPresetEvaluation,
  type AutoSubagentPresetLocalEvidence,
  type AutoSubagentPresetReasonCode,
  type AutoSubagentPresetResetPriority,
  type AutoSubagentPresetStatus,
  IAutoSubagentPresetService,
  SUBAGENT_PRESET_CHANGED_EVENT_TYPE,
  SUBAGENT_PRESET_EVALUATED_EVENT_TYPE,
  type SubagentPresetChangedPayload,
  type SubagentPresetEvaluatedPayload,
} from './autoSubagentPreset';

export const MAX_TRACKED_FINISHED_RUNS = 10_000;
export const AUTO_PRESET_EXPLICIT_ROUTE_BONUS = 2;
export const AUTO_PRESET_THINKING_FIT_BONUS = 1;
export const AUTO_PRESET_PROFILE_SAMPLE_THRESHOLD = 3;
export const AUTO_PRESET_FULL_CONFIDENCE_SAMPLE_COUNT = 5;

export interface ProviderQuotaEvidence {
  readonly remainingPercent: number;
  readonly resetAt?: number;
  readonly resetPriority?: AutoSubagentPresetResetPriority;
}

const DEFAULT_RESET_PRIORITY_POLICY: ResetPriorityPolicy = {
  windowMs: DEFAULT_AUTO_PRESET_RESET_PRIORITY_WINDOW_MS,
  exponent: DEFAULT_AUTO_PRESET_RESET_PRIORITY_EXPONENT,
  maxBonus: DEFAULT_AUTO_PRESET_RESET_PRIORITY_MAX_BONUS,
  quotaFloorPercent: DEFAULT_AUTO_PRESET_QUOTA_FLOOR_PERCENT,
};

interface QuotaCacheEntry {
  readonly result: ProviderUsageResult | undefined;
  readonly resolvedAt: number;
  readonly refreshAt?: number;
}

interface HydrationFlight {
  readonly promise: Promise<boolean>;
}

interface LocalStats {
  readonly evidence: AutoSubagentPresetLocalEvidence;
  readonly circuitBreakerOpenUntil?: number;
}

interface Decision {
  readonly selectedPreset?: string;
  readonly activatePreset?: string;
  readonly reasonCode: AutoSubagentPresetReasonCode;
}

interface CommitOutcome {
  readonly currentPreset?: string;
  readonly selectedPreset?: string;
  readonly activatedPreset?: string;
  readonly reasonCode: AutoSubagentPresetReasonCode;
}

interface EvaluationDetails extends CommitOutcome {
  readonly candidates?: readonly AutoSubagentPresetCandidateScore[];
  readonly binding?: SubagentBindingResolution;
}

export function providerQuotaEvidence(
  result: ProviderUsageResult | undefined,
  allowExtraUsage: boolean,
  now: number = Date.now(),
  policy: ResetPriorityPolicy = DEFAULT_RESET_PRIORITY_POLICY,
): ProviderQuotaEvidence | undefined {
  if (result === undefined || result.kind !== 'ok') return undefined;
  const rows = result.summary === null ? [...result.limits] : [result.summary, ...result.limits];
  const evidence: ProviderQuotaEvidence[] = [];
  for (const row of rows) {
    const remainingPercent = windowRemainingPercent(row.limit, row.used);
    // A reported row with unreadable usage, limit, reset or window fields
    // invalidates the whole account evidence: the remaining fragment is not a
    // complete resource proof, above or below the floor. An undeclared window
    // period stays a valid numeric constraint; it only never earns expiry
    // priority.
    if (
      remainingPercent === undefined ||
      (row.resetAt !== undefined && !Number.isFinite(Date.parse(row.resetAt))) ||
      (row.window !== undefined && windowDurationMs(row.window) === undefined)
    ) {
      return undefined;
    }
    evidence.push({ remainingPercent, resetAt: futureResetAt(row.resetAt, now) });
  }
  let plan = providerQuotaEvidenceOf(evidence);
  const planExhausted = plan !== undefined && plan.remainingPercent <= 0;

  const wallet = walletRemainingPercent(result, allowExtraUsage);
  let walletTookOver = false;
  if (plan === undefined) {
    if (wallet === undefined) return undefined;
    plan = { remainingPercent: wallet };
    walletTookOver = true;
  } else if (wallet !== undefined && wallet > plan.remainingPercent) {
    // A positive wallet can truly take over the tightest plan window, so its
    // remaining percent is a valid alternative quota boundary.
    plan = { remainingPercent: wallet };
    walletTookOver = true;
  }
  const priority = subscriptionResetPriority(rows, policy, now);
  // When the raw subscription is exhausted and only the paid wallet keeps the
  // account usable, the expiring plan window must not lend its bonus to the
  // wallet balance. A still-consumable subscription keeps its own bonus even
  // while the wallet takes over the displayed remaining percent.
  if (priority === undefined || (walletTookOver && planExhausted)) return plan;
  // The retention floor yields only to genuinely expiring subscription quota:
  // every reported window must be readable and unexhausted, and a wallet
  // balance never poses as expiring plan quota.
  const floorRelaxed =
    !walletTookOver &&
    priority.bonus > 0 &&
    plan.remainingPercent > 0 &&
    plan.remainingPercent < policy.quotaFloorPercent;
  return { ...plan, resetPriority: { ...priority, floorRelaxed } };
}

function providerQuotaEvidenceOf(
  rows: readonly ProviderQuotaEvidence[],
): ProviderQuotaEvidence | undefined {
  let plan: ProviderQuotaEvidence | undefined;
  for (const row of rows) {
    if (
      plan === undefined ||
      row.remainingPercent < plan.remainingPercent ||
      (row.remainingPercent === plan.remainingPercent &&
        row.resetAt !== undefined &&
        (plan.resetAt === undefined || row.resetAt < plan.resetAt))
    ) {
      plan = row;
    }
  }
  return plan;
}

export function providerQuotaPercent(
  result: ProviderUsageResult | undefined,
  allowExtraUsage: boolean,
): number | undefined {
  return providerQuotaEvidence(result, allowExtraUsage)?.remainingPercent;
}

function usageRows(
  result: Extract<ProviderUsageResult, { readonly kind: 'ok' }>,
): readonly { readonly resetAt?: string }[] {
  return result.summary === null ? result.limits : [result.summary, ...result.limits];
}

function referencesPastReset(result: ProviderUsageResult | undefined, now: number): boolean {
  if (result === undefined || result.kind !== 'ok') return false;
  return usageRows(result).some((row) => {
    const parsed = row.resetAt === undefined ? Number.NaN : Date.parse(row.resetAt);
    return Number.isFinite(parsed) && parsed <= now;
  });
}

function resetBoundaryAt(result: ProviderUsageResult | undefined, now: number): number | undefined {
  if (result === undefined || result.kind !== 'ok') return undefined;
  let boundary: number | undefined;
  for (const row of usageRows(result)) {
    const parsed = row.resetAt === undefined ? Number.NaN : Date.parse(row.resetAt);
    if (Number.isFinite(parsed) && parsed > now && (boundary === undefined || parsed < boundary)) {
      boundary = parsed;
    }
  }
  return boundary;
}

function walletRemainingPercent(
  result: Extract<ProviderUsageResult, { readonly kind: 'ok' }>,
  allowExtraUsage: boolean,
): number | undefined {
  if (!allowExtraUsage || result.extraUsage === null) return undefined;
  const { balanceCents, totalCents } = result.extraUsage;
  if (
    !Number.isFinite(totalCents) ||
    totalCents <= 0 ||
    !Number.isFinite(balanceCents) ||
    balanceCents <= 0
  ) {
    return undefined;
  }
  return Math.min(100, Math.max(0, (balanceCents / totalCents) * 100));
}

function futureResetAt(raw: string | undefined, now: number): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed > now ? parsed : undefined;
}

export class AutoSubagentPresetService extends Disposable implements IAutoSubagentPresetService {
  declare readonly _serviceBrand: undefined;

  private readonly quotaCache = new Map<string, QuotaCacheEntry>();
  private readonly inFlightQuota = new Map<string, Promise<ProviderUsageResult | undefined>>();
  private readonly finishedRuns = new Map<string, AgentRunUsageEntry>();
  private maxTrackedRuns = MAX_TRACKED_FINISHED_RUNS;
  private hydrated = false;
  private hydration: HydrationFlight | undefined;
  private hydrationGeneration = 0;
  private switchCooldownUntil: number | undefined;
  private latestStatus: AutoSubagentPresetStatus | undefined;
  private readonly accountIdentity = new AccountIdentity();
  private readonly liveRunIdentity: LiveRunIdentity;
  private evidenceRevision = 0;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IProviderUsageService private readonly usage: IProviderUsageService,
    @IAgentRunUsageService private readonly runUsage: IAgentRunUsageService,
    @ISubagentPresetActivationService
    private readonly activation: ISubagentPresetActivationService,
    @IEventService private readonly eventService: IEventService,
    @ILogService private readonly log: ILogService,
    @IHostClock private readonly clock: IHostClock,
    @IModelService private readonly models: IModelService,
    @IProviderService private readonly providers: IProviderService,
    @IProtocolAdapterRegistry private readonly protocolAdapters: IProtocolAdapterRegistry,
    @IProviderUsageLedgerService private readonly usageLedger: IProviderUsageLedgerService,
  ) {
    super();
    this.liveRunIdentity = new LiveRunIdentity((started) => this.resolveRunIdentity(started), () => this.maxTrackedRuns);
    this._register(this.runUsage.onDidStartRun((record) => this.liveRunIdentity.start(record)));
    this._register(this.runUsage.onDidFinishRun(this.onRunFinished));
    let evidenceConfiguration = this.evidenceConfigurationSnapshot();
    const invalidate = () => {
      const current = this.evidenceConfigurationSnapshot();
      if (current === evidenceConfiguration) return;
      evidenceConfiguration = current;
      this.evidenceRevision += 1;
      this.quotaCache.clear();
      this.inFlightQuota.clear();
      this.liveRunIdentity.invalidateChanged();
    };
    this._register(this.models.onDidChangeModels(invalidate));
    this._register(this.providers.onDidChangeProviders(invalidate));
    this._register(this.config.onDidSectionChange((event) => {
      if (['models', 'providers', 'experimental'].includes(event.domain)) invalidate();
    }));
  }

  status(): AutoSubagentPresetStatus | undefined {
    return this.latestStatus;
  }

  async resolveBinding(request: SubagentRouteRequest, context: AutoSubagentPresetContext): Promise<SubagentBindingResolution> {
    const passthrough = () => this.activation.runExclusive(async () => {
      context.signal?.throwIfAborted();
      const settings = resolveSubagentAutoPresetConfig(this.readSection());
      if (!this.flags.enabled(AUTO_SUBAGENT_PRESET_FLAG_ID) || !settings.enabled || settings.manualLock) {
        return resolveSubagentBinding(this.config, this.flags, this.modelCatalog, request);
      }
      return undefined;
    });
    const manual = await passthrough();
    context.signal?.throwIfAborted();
    if (manual !== undefined) return manual;
    let evaluation: (AutoSubagentPresetEvaluation & { readonly binding?: SubagentBindingResolution }) | undefined;
    try {
      evaluation = await this.evaluateInner(request, context, this.clock.now().getTime(), false, this.activation.manualRevision, true);
    } catch {
      this.log.warn('auto subagent binding evaluation failed; refusing an unverified dispatch');
      const section = this.readSection();
      evaluation = this.completeEvaluation(request, context, this.clock.now().getTime(), resolveSubagentAutoPresetConfig(section), {
        currentPreset: activeSubagentPreset(section),
        reasonCode: isAborted(context.signal) ? 'cancelled' : 'evaluation_failed',
      });
    }
    context.signal?.throwIfAborted();
    if (evaluation?.binding !== undefined) return evaluation.binding;
    const lateManual = await passthrough();
    context.signal?.throwIfAborted();
    if (lateManual !== undefined) return lateManual;
    throw this.bindingUnavailable(request, evaluation?.reasonCode ?? 'evaluation_failed');
  }

  private bindingUnavailable(request: SubagentRouteRequest, reason: string): Error2 {
    return new Error2(ErrorCodes.AUTO_SUBAGENT_BINDING_UNAVAILABLE,
      'No verified available model can serve this subagent role.',
      { details: { route: request.route, profileName: request.profileName, reason } });
  }

  evaluate(
    request: SubagentRouteRequest,
    context: AutoSubagentPresetContext,
  ): Promise<AutoSubagentPresetEvaluation> {
    return this.evaluateSafely(request, context, false);
  }

  selectAutomatically(
    request: SubagentRouteRequest,
    context: AutoSubagentPresetContext,
  ): Promise<AutoSubagentPresetEvaluation> {
    return this.evaluateSafely(request, context, true);
  }

  private async evaluateSafely(
    request: SubagentRouteRequest,
    context: AutoSubagentPresetContext,
    userInitiated: boolean,
  ): Promise<AutoSubagentPresetEvaluation> {
    const evaluatedAt = this.clock.now().getTime();
    const manualRevision = userInitiated
      ? context.manualRevision ?? this.activation.manualRevision
      : this.activation.manualRevision;
    try {
      if (userInitiated) {
        const reasonCode = await this.activation.runExclusive(async () => {
          if (isAborted(context.signal)) return 'cancelled' as const;
          if (this.activation.manualRevision !== manualRevision) return 'manual_override' as const;
          const flag = this.flags.explain(AUTO_SUBAGENT_PRESET_FLAG_ID);
          if (flag?.source === 'env' && !flag.enabled) return 'flag_disabled' as const;
          if (!request.caller.modelAlias?.trim()) return 'caller_model_unavailable' as const;
          await this.enableAutomaticSelection();
          return undefined;
        });
        if (reasonCode !== undefined) {
          const section = this.readSection();
          return this.completeEvaluation(request, context, evaluatedAt, resolveSubagentAutoPresetConfig(section), {
            currentPreset: activeSubagentPreset(section),
            reasonCode,
          });
        }
      }
      return await this.evaluateInner(request, context, evaluatedAt, userInitiated, manualRevision);
    } catch {
      this.log.warn('auto subagent preset evaluation failed; keeping the current preset');
      const section = this.readSection();
      const settings = resolveSubagentAutoPresetConfig(section);
      return this.completeEvaluation(request, context, evaluatedAt, settings, {
        currentPreset: activeSubagentPreset(section),
        reasonCode: 'evaluation_failed',
      });
    }
  }

  private async enableAutomaticSelection(): Promise<void> {
    const patches = {
      [SUBAGENT_SECTION]: { autoPreset: { enabled: true, manualLock: false } },
      experimental: { [AUTO_SUBAGENT_PRESET_FLAG_ID]: true },
    };
    for (const target of [ConfigTarget.User, ConfigTarget.Memory]) {
      await this.config.replaceSections((current) => {
        const sections: Record<string, unknown> = {};
        for (const [domain, patch] of Object.entries(patches)) {
          if (target === ConfigTarget.User || current[domain] !== undefined) {
            sections[domain] = deepMerge(current[domain], patch);
          }
        }
        return sections;
      }, target);
    }
  }

  private async evaluateInner(
    request: SubagentRouteRequest,
    context: AutoSubagentPresetContext,
    evaluatedAt: number,
    userInitiated: boolean,
    manualRevision: number,
    dispatch = false,
  ): Promise<AutoSubagentPresetEvaluation & { readonly binding?: SubagentBindingResolution }> {
    const section = this.readSection();
    const settings = resolveSubagentAutoPresetConfig(section);
    const currentPreset = activeSubagentPreset(section);
    if (isAborted(context.signal)) {
      return this.completeEvaluation(request, context, evaluatedAt, settings, {
        currentPreset,
        reasonCode: 'cancelled',
      });
    }
    if (!this.flags.enabled(AUTO_SUBAGENT_PRESET_FLAG_ID)) {
      this.disarm();
      return this.completeEvaluation(request, context, evaluatedAt, settings, {
        currentPreset,
        reasonCode: 'flag_disabled',
      });
    }
    if (!settings.enabled) {
      this.disarm();
      return this.completeEvaluation(request, context, evaluatedAt, settings, {
        currentPreset,
        reasonCode: 'auto_preset_disabled',
      });
    }
    if (settings.manualLock) {
      this.disarm();
      return this.completeEvaluation(request, context, evaluatedAt, settings, {
        currentPreset,
        reasonCode: 'manual_lock',
      });
    }
    if (
      typeof request.caller.modelAlias !== 'string' ||
      request.caller.modelAlias.trim().length === 0
    ) {
      return this.completeEvaluation(request, context, evaluatedAt, settings, {
        currentPreset,
        reasonCode: 'caller_model_unavailable',
      });
    }

    const candidates = this.candidatePresets(settings, section);
    const assumedManualRevision = manualRevision;
    const assumedDecisionSnapshot = this.decisionSnapshot();
    const rescore = await this.scoreCandidates(request, candidates, settings, evaluatedAt, context.signal, userInitiated);
    const outcome = await this.commitDecision(
      request, rescore, currentPreset, assumedManualRevision, assumedDecisionSnapshot,
      context, evaluatedAt, userInitiated, dispatch,
    );
    const evaluation = this.completeEvaluation(request, context, evaluatedAt, settings, {
      ...outcome,
      candidates: outcome.candidates ?? rescore(),
    });
    return { ...evaluation, binding: outcome.binding };
  }

  private async scoreCandidates(
    request: SubagentRouteRequest,
    candidates: readonly string[],
    settings: SubagentAutoPresetConfig,
    _now: number,
    signal: AbortSignal | undefined,
    refreshQuota: boolean,
  ): Promise<() => readonly AutoSubagentPresetCandidateScore[]> {
    const prepared = preparePresetScores(this.readSection(), candidates, request, this.modelCatalog,
      (preset, role) => resolveSubagentBindingForPreset(this.config, this.flags, this.modelCatalog, preset, role),
      (alias, model) => this.accountIdentity.resolve(alias, model, this.models, this.providers));
    const epoch = this.evidenceEpoch();
    const policy = resetPriorityPolicy(settings);
    await this.ensureUsageHydrated();
    const results = new Map<string, ProviderUsageResult | undefined>();
    await Promise.all(prepared.accounts.map(async (account) => {
      let result = await this.quotaResultOf(account, epoch, settings, signal, refreshQuota);
      if (result?.kind === 'ok' && result.meteredUsage !== undefined && this.currentEvidence(account, epoch)) {
        const metered = result.meteredUsage;
        try {
          const local = await this.usageLedger.getMeteredUsage(account.providerAliases, { signal });
          result = { ...result, meteredUsage: { ...local, balance: metered.balance } };
        } catch {
          result = { ...result, meteredUsage: { ...metered, degraded: true,
            today: { ...metered.today, isPartial: true }, month: { ...metered.month, isPartial: true } } };
        }
      }
      results.set(account.key, result);
    }));
    return () => {
      const now = this.clock.now().getTime();
      return scorePresets(prepared, candidates, settings, now,
        this.liveQuotaResults(results, epoch, now), (result, allowExtraUsage, at) => providerQuotaEvidence(result, allowExtraUsage, at, policy),
        (account, profile, alias, at) => this.localStats(account, profile, settings, at, alias),
        (accounts, at) => this.aggregateLocalEvidence(accounts, settings, at),
        (requested, model, fallback) => this.effectiveThinking(requested, model, fallback),
        this.flags.enabled(DEEPSEEK_USAGE_FLAG_ID));
    };
  }

  private liveQuotaResults(
    results: ReadonlyMap<string, ProviderUsageResult | undefined>,
    epoch: string,
    now: number,
  ): ReadonlyMap<string, ProviderUsageResult | undefined> {
    if (this.evidenceEpoch() !== epoch) return new Map();
    // Quota was collected before the activation boundary: any known reset that
    // has passed since then makes the response pre-reset evidence, which must
    // not authorize this dispatch. The next evaluation re-queries across the
    // boundary, so refusing here stays conservative without retrying inside
    // the writer lock.
    let filtered: Map<string, ProviderUsageResult | undefined> | undefined;
    for (const [key, result] of results) {
      if (referencesPastReset(result, now)) (filtered ??= new Map(results)).set(key, undefined);
    }
    return filtered ?? results;
  }

  private commitDecision(
    request: SubagentRouteRequest,
    rescore: () => readonly AutoSubagentPresetCandidateScore[],
    assumedCurrent: string | undefined,
    assumedManualRevision: number,
    assumedDecisionSnapshot: string,
    context: AutoSubagentPresetContext,
    evaluatedAt: number,
    userInitiated: boolean,
    dispatch: boolean,
  ): Promise<EvaluationDetails> {
    return this.activation.runExclusive(async (transaction) => {
      const section = this.readSection();
      const currentPreset = activeSubagentPreset(section);
      const finish = (outcome: CommitOutcome, preset = currentPreset, candidates = rescore()): EvaluationDetails => {
        const live = resolveSubagentAutoPresetConfig(this.readSection());
        if (activeSubagentPreset(this.readSection()) !== preset || this.decisionSnapshot() !== assumedDecisionSnapshot || this.activation.manualRevision !== assumedManualRevision) return { ...outcome, reasonCode: 'routing_config_changed', binding: undefined };
        const candidate = candidates.find((entry) => entry.preset === preset && entry.participating === true && entry.selectable);
        const binding = dispatch && !isAborted(context.signal) && live.enabled && !live.manualLock && this.flags.enabled(AUTO_SUBAGENT_PRESET_FLAG_ID)
          ? bindingForRole(candidate, request, assumedManualRevision) : undefined;
        return { ...outcome, candidates, binding };
      };
      if (isAborted(context.signal)) return { currentPreset, reasonCode: 'cancelled' };
      if (!this.flags.enabled(AUTO_SUBAGENT_PRESET_FLAG_ID)) {
        this.disarm();
        return { currentPreset, reasonCode: 'flag_disabled' };
      }

      const settings = resolveSubagentAutoPresetConfig(section);
      if (!settings.enabled) {
        this.disarm();
        return { currentPreset, reasonCode: 'auto_preset_disabled' };
      }
      if (settings.manualLock) {
        this.disarm();
        return { currentPreset, reasonCode: 'manual_lock' };
      }
      const candidates = this.candidatePresets(settings, section);
      if (this.activation.manualRevision !== assumedManualRevision) {
        return { currentPreset, reasonCode: 'manual_override' };
      }
      if (currentPreset !== assumedCurrent) {
        return { currentPreset, reasonCode: 'preset_changed_during_evaluation' };
      }
      if (this.decisionSnapshot() !== assumedDecisionSnapshot) {
        return { currentPreset, reasonCode: 'routing_config_changed' };
      }
      if (candidates.length === 0) return finish({ currentPreset, reasonCode: 'no_candidates' });

      let effectivePreset = currentPreset;
      for (let writes = 0; ; writes += 1) {
        if (isAborted(context.signal)) return { currentPreset, reasonCode: 'cancelled' };
        if (!this.flags.enabled(AUTO_SUBAGENT_PRESET_FLAG_ID)) {
          this.disarm();
          return { currentPreset, reasonCode: 'flag_disabled' };
        }
        if (this.activation.manualRevision !== assumedManualRevision) return { currentPreset, reasonCode: 'manual_override' };
        if (this.decisionSnapshot() !== assumedDecisionSnapshot || activeSubagentPreset(this.readSection()) !== effectivePreset) {
          return { currentPreset, reasonCode: 'routing_config_changed' };
        }
        const now = this.clock.now().getTime();
        const states = rescore();
        const eligible = dispatch ? states.map((state) => ({ ...state, selectable: state.selectable && bindingForRole(state, request, assumedManualRevision) !== undefined })) : states;
        const decision = this.decide(eligible, currentPreset, settings, now, userInitiated);
        if (decision.selectedPreset === undefined) return { currentPreset, reasonCode: decision.reasonCode, candidates: states };
        const target = decision.activatePreset ?? currentPreset;
        if (target === effectivePreset) {
          const activatedPreset = effectivePreset !== currentPreset ? effectivePreset : undefined;
          const outcome = finish({ currentPreset, selectedPreset: decision.selectedPreset, activatedPreset, reasonCode: decision.reasonCode }, effectivePreset, states);
          if (outcome.reasonCode !== decision.reasonCode || activatedPreset === undefined) return outcome;
          this.switchCooldownUntil = now + settings.switchCooldownMs;
          if (context.sessionId !== undefined) {
            const payload: SubagentPresetChangedPayload = {
              sessionId: context.sessionId,
              previousPreset: currentPreset,
              currentPreset: activatedPreset,
              reasonCode: decision.reasonCode,
              profileName: request.profileName,
              evaluatedAt,
              previousScore: scoreOf(states, currentPreset),
              currentScore: scoreOf(states, activatedPreset),
            };
            try {
              this.eventService.publish({ type: SUBAGENT_PRESET_CHANGED_EVENT_TYPE, payload });
            } catch {
              this.log.warn('auto subagent preset changed event publish failed');
            }
          }
          return finish(outcome, effectivePreset, states);
        }
        if (writes >= 2 || target === undefined) return { currentPreset, reasonCode: 'evaluation_failed', candidates: states };
        const result = await transaction.activateEvaluated(target, context.signal);
        if (result.kind === 'cancelled') return { currentPreset, reasonCode: 'cancelled' };
        if (result.kind === 'failed') {
          this.log.warn('auto subagent preset activation failed; refusing an unverified dispatch');
          return { currentPreset, selectedPreset: decision.selectedPreset, reasonCode: 'activation_failed' };
        }
        if (result.warning !== undefined) this.log.warn('auto subagent preset activation completed with a runtime warning');
        effectivePreset = activeSubagentPreset(this.readSection());
        if (effectivePreset !== target) return { currentPreset: effectivePreset, selectedPreset: decision.selectedPreset, reasonCode: 'activation_no_effect' };
      }
    });
  }

  private decide(
    states: readonly AutoSubagentPresetCandidateScore[],
    currentPreset: string | undefined,
    settings: SubagentAutoPresetConfig,
    now: number,
    userInitiated: boolean,
  ): Decision {
    const target = highestScoringHealthy(states, currentPreset);
    if (target === undefined) {
      return {
        reasonCode: states.some((state) => (state.coverage?.resourceProviderCount ?? 0) > 0)
          ? 'no_healthy_candidate'
          : 'no_quota_evidence',
      };
    }
    if (currentPreset === undefined) {
      return {
        selectedPreset: target.preset,
        activatePreset: target.preset,
        reasonCode: 'higher_score',
      };
    }

    const current = states.find((state) => state.preset === currentPreset);
    if (target.preset === currentPreset) {
      return { selectedPreset: currentPreset, reasonCode: 'current_optimal' };
    }
    if (current?.selectable !== true) {
      return {
        selectedPreset: target.preset,
        activatePreset: target.preset,
        reasonCode:
          current?.roleScores?.some((role) => role.weight > 0 && role.effective.availability === 'circuit_open') === true
            ? 'circuit_breaker_escape'
            : 'current_unhealthy',
      };
    }

    const lead = (target.score ?? Number.NEGATIVE_INFINITY) - (current.score ?? 0);
    if (!userInitiated && lead < settings.switchMarginPercent) {
      return { selectedPreset: target.preset, reasonCode: 'score_margin_not_met' };
    }
    if (!userInitiated && activeDeadline(this.switchCooldownUntil, now) !== undefined) {
      return { selectedPreset: target.preset, reasonCode: 'switch_cooldown' };
    }
    return {
      selectedPreset: target.preset,
      activatePreset: target.preset,
      reasonCode: 'higher_score',
    };
  }

  private completeEvaluation(
    request: SubagentRouteRequest,
    context: AutoSubagentPresetContext,
    evaluatedAt: number,
    settings: SubagentAutoPresetConfig,
    details: EvaluationDetails,
  ): AutoSubagentPresetEvaluation {
    const candidates = details.candidates ?? [];
    const status: AutoSubagentPresetStatus = Object.freeze({
      evaluationScope: 'preset',
      evaluatedAt,
      route: request.route,
      profileName: request.profileName,
      reasonCode: details.reasonCode,
      currentPreset: details.currentPreset,
      selectedPreset: details.selectedPreset,
      activatedPreset: details.activatedPreset,
      currentScore: scoreOf(candidates, details.currentPreset),
      selectedScore: scoreOf(candidates, details.selectedPreset),
      switchCooldownUntil: activeDeadline(this.switchCooldownUntil, evaluatedAt),
      candidates,
      policy: Object.freeze(autoSubagentPresetPolicySnapshot(settings)),
    });
    this.latestStatus = status;
    if (context.sessionId !== undefined) {
      const payload: SubagentPresetEvaluatedPayload = { ...status, sessionId: context.sessionId };
      try {
        this.eventService.publish({ type: SUBAGENT_PRESET_EVALUATED_EVENT_TYPE, payload });
      } catch {
        this.log.warn('auto subagent preset evaluated event publish failed');
      }
    }
    return {
      request,
      currentPreset: details.currentPreset,
      activatedPreset: details.activatedPreset,
      reason: legacyReason(details.reasonCode),
      reasonCode: details.reasonCode,
      status,
    };
  }

  private readSection(): SubagentConfig | undefined {
    try {
      return this.config.get<SubagentConfig | undefined>(SUBAGENT_SECTION);
    } catch {
      return undefined;
    }
  }

  private candidatePresets(
    settings: SubagentAutoPresetConfig,
    section: SubagentConfig | undefined,
  ): string[] {
    const configured = Object.keys(section?.presets ?? {});
    if (settings.candidates === undefined) return configured;
    return settings.candidates.filter((name) => configured.includes(name));
  }

  private async quotaResultOf(
    account: EffectiveAccount,
    epoch: string,
    settings: SubagentAutoPresetConfig,
    signal: AbortSignal | undefined,
    refresh: boolean,
  ): Promise<ProviderUsageResult | undefined> {
    const provider = account.queryProvider;
    if (provider === undefined || isAborted(signal) || !this.currentEvidence(account, epoch)) return undefined;
    const cacheKey = `${epoch}:${account.key}`;
    const now = this.clock.now().getTime();
    const cached = this.quotaCache.get(cacheKey);
    if (
      !refresh &&
      cached !== undefined &&
      now - cached.resolvedAt < settings.refreshIntervalMs &&
      (cached.refreshAt === undefined || now < cached.refreshAt)
    ) {
      return cached.result;
    }
    const existing = this.inFlightQuota.get(cacheKey);
    if (existing !== undefined) return awaitWithCallerAbort(existing, signal);

    const pending = this.queryQuota(provider, cacheKey, () => this.currentEvidence(account, epoch), settings, signal);
    this.inFlightQuota.set(cacheKey, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlightQuota.get(cacheKey) === pending) this.inFlightQuota.delete(cacheKey);
    }
  }

  private async queryQuota(
    provider: string,
    cacheKey: string,
    stillCurrent: () => boolean,
    settings: SubagentAutoPresetConfig,
    signal: AbortSignal | undefined,
  ): Promise<ProviderUsageResult | undefined> {
    const attempt = async (): Promise<
      | { readonly kind: 'abort' }
      | { readonly kind: 'failed' }
      | { readonly kind: 'result'; readonly result: ProviderUsageResult | undefined }
    > => {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let onCallerAbort: (() => void) | undefined;
      const query = Promise.resolve()
        .then(() => stillCurrent() ? this.usage.queryUsage(provider, { signal: controller.signal }) : [])
        .then(
          (results) => ({ kind: 'result' as const, result: results[0] }),
          () => ({ kind: 'failed' as const }),
        );
      const timedOut = new Promise<{ readonly kind: 'timeout' }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: 'timeout' }), settings.queryTimeoutMs);
      });
      const callerAborted = new Promise<{ readonly kind: 'caller-abort' }>((resolve) => {
        if (signal === undefined) return;
        onCallerAbort = () => resolve({ kind: 'caller-abort' });
        signal.addEventListener('abort', onCallerAbort, { once: true });
      });

      try {
        const outcome = await Promise.race([query, timedOut, callerAborted]);
        if (outcome.kind === 'timeout' || outcome.kind === 'caller-abort') controller.abort();
        if (outcome.kind === 'caller-abort' || isAborted(signal) || !stillCurrent()) return { kind: 'abort' };
        return outcome.kind === 'result'
          ? { kind: 'result', result: outcome.result }
          : { kind: 'failed' };
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        if (onCallerAbort !== undefined) signal?.removeEventListener('abort', onCallerAbort);
      }
    };

    let outcome = await attempt();
    if (outcome.kind === 'abort') return undefined;
    if (outcome.kind === 'result' && referencesPastReset(outcome.result, this.clock.now().getTime())) {
      // The response still cites a reset boundary that has already passed, so
      // it predates that reset: refresh once, and if the evidence stays stale
      // it is refused outright — stale quota may describe a pre-reset balance
      // and must never authorize a verified binding.
      const retry = await attempt();
      if (retry.kind !== 'result' || referencesPastReset(retry.result, this.clock.now().getTime())) {
        return undefined;
      }
      outcome = retry;
    }
    if (outcome.kind === 'failed') {
      this.quotaCache.set(cacheKey, { result: undefined, resolvedAt: this.clock.now().getTime() });
      return undefined;
    }
    this.quotaCache.set(cacheKey, {
      result: outcome.result,
      resolvedAt: this.clock.now().getTime(),
      refreshAt: resetBoundaryAt(outcome.result, this.clock.now().getTime()),
    });
    return outcome.result;
  }

  private localStats(
    provider: string,
    profileName: string | undefined,
    settings: SubagentAutoPresetConfig,
    now: number,
    alias: string,
  ): LocalStats {
    const providerSamples = this.providerRuns(provider)
      .filter((entry) => entry.finished !== undefined && entry.finished.endedAt >= now - settings.localUsageWindowMs)
      .filter((entry) => entry.finished?.status !== 'cancelled');
    const model = this.modelCatalog.get(alias);
    const profileSamples = providerSamples.filter((entry) =>
      entry.started.profileName === profileName && this.liveRunIdentity.of(entry)?.model === (model.name ?? alias));
    const useProfile = profileSamples.length >= AUTO_PRESET_PROFILE_SAMPLE_THRESHOLD;
    return {
      evidence: summarizeRuns(useProfile ? profileSamples : providerSamples, useProfile ? 'profile' : 'provider'),
      circuitBreakerOpenUntil: this.circuitBreakerOpenUntil(provider, settings, now),
    };
  }

  private aggregateLocalEvidence(providers: ReadonlySet<string>, settings: SubagentAutoPresetConfig, now: number): AutoSubagentPresetLocalEvidence {
    return summarizeRuns([...this.finishedRuns.values()].filter((entry) =>
      entry.finished !== undefined && entry.finished.status !== 'cancelled' &&
      entry.finished.endedAt >= now - settings.localUsageWindowMs && providers.has(this.providerOfRun(entry) ?? '')), 'provider');
  }

  private decisionSnapshot(): string {
    const section = this.readSection();
    return this.accountIdentity.fingerprint({
      subagent: section === undefined ? undefined : { ...section, preset: undefined },
      models: this.config.get('models'), providers: this.config.get('providers'),
      thinking: this.config.get('thinking'), epoch: this.evidenceEpoch(),
    });
  }

  private evidenceEpoch(): string {
    return this.accountIdentity.fingerprint({ revision: this.evidenceRevision, configuration: this.evidenceConfigurationSnapshot() });
  }

  private evidenceConfigurationSnapshot(): string {
    return this.accountIdentity.fingerprint({
      models: this.models.list(), providers: this.providers.list(),
      deepseek: this.flags.enabled(DEEPSEEK_USAGE_FLAG_ID),
      queries: Object.keys(this.providers.list()).toSorted().map((name) => this.accountIdentity.queryKey(name, this.providers.get(name))),
    });
  }

  private currentEvidence(account: EffectiveAccount, epoch: string): boolean {
    return this.evidenceEpoch() === epoch && account.queryProvider !== undefined &&
      (!account.deepseek || this.flags.enabled(DEEPSEEK_USAGE_FLAG_ID)) &&
      this.accountIdentity.queryKey(account.queryProvider, this.providers.get(account.queryProvider)) === account.key;
  }

  private effectiveThinking(requested: string | undefined, model: Model, fallback: boolean): string {
    const config = this.config.get<ThinkingConfig | undefined>('thinking');
    const strict = fallback || requiresStrictThinkingValidation(this.protocolAdapters, model.protocol, model.providerType);
    const base = resolveThinkingEffortForModel(requested, config, model, strict);
    return resolveForcedThinkingEffort(config?.forcedEffort, base, drivesThinkingThroughTraits(model.providerType)) ?? base;
  }

  private circuitBreakerOpenUntil(
    provider: string,
    settings: SubagentAutoPresetConfig,
    now: number,
  ): number | undefined {
    const runs = this.providerRuns(provider)
      .filter((entry) => entry.finished?.status !== 'cancelled')
      .toSorted((left, right) => right.finished!.endedAt - left.finished!.endedAt);
    let consecutiveFailures = 0;
    let lastFailureAt: number | undefined;
    for (const entry of runs) {
      if (entry.finished?.status === 'completed') break;
      if (entry.finished?.status === 'failed') {
        lastFailureAt ??= entry.finished.endedAt;
        consecutiveFailures += 1;
      }
    }
    if (
      consecutiveFailures < settings.circuitBreakerFailureThreshold ||
      lastFailureAt === undefined
    ) {
      return undefined;
    }
    return activeDeadline(lastFailureAt + settings.circuitBreakerCooldownMs, now);
  }

  private providerRuns(provider: string): AgentRunUsageEntry[] {
    const entries: AgentRunUsageEntry[] = [];
    for (const entry of this.finishedRuns.values()) {
      if (this.providerOfRun(entry) === provider) entries.push(entry);
    }
    return entries;
  }

  private providerOfRun(entry: AgentRunUsageEntry): string | undefined {
    return this.liveRunIdentity.of(entry)?.account;
  }

  private resolveRunIdentity(started: AgentRunUsageStartedRecord): RunIdentity | undefined {
    const alias = started.modelAlias;
    if (alias === undefined) return undefined;
    try {
      const model = this.modelCatalog.get(alias);
      const account = this.accountIdentity.resolve(alias, model, this.models, this.providers);
      return account === undefined ? undefined : { account: account.key, model: model.name ?? alias, protocol: model.protocol };
    } catch {
      return undefined;
    }
  }

  private onRunFinished = (entry: AgentRunUsageEntry): void => {
    const observed = this.liveRunIdentity.finish(entry);
    this.quotaCache.clear();
    if (observed) this.rememberRun(entry);
  };

  private disarm(): void {
    this.hydrated = false;
    this.hydrationGeneration += 1;
  }

  private rememberRun(entry: AgentRunUsageEntry): void {
    this.rememberRunIn(this.finishedRuns, entry);
  }

  private rememberRunIn(
    runs: Map<string, AgentRunUsageEntry>,
    entry: AgentRunUsageEntry,
  ): void {
    if (this.liveRunIdentity.of(entry) === undefined) return;
    const runId = entry.started.runId;
    if (runs.has(runId)) runs.delete(runId);
    if (runs.size >= this.maxTrackedRuns) {
      const oldest = runs.keys().next().value;
      if (oldest !== undefined) runs.delete(oldest);
    }
    runs.set(runId, entry);
  }

  private async ensureUsageHydrated(): Promise<void> {
    if (this.hydrated) return;
    const existing = this.hydration;
    if (existing !== undefined) {
      const succeeded = await existing.promise;
      if (!succeeded || this.hydrated) return;
      return this.ensureUsageHydrated();
    }

    const generation = this.hydrationGeneration;
    const promise = this.hydrateUsage(generation);
    const flight = { promise };
    this.hydration = flight;
    try {
      await promise;
    } finally {
      if (this.hydration === flight) this.hydration = undefined;
    }
  }

  private async hydrateUsage(generation: number): Promise<boolean> {
    let entries: readonly AgentRunUsageEntry[];
    try {
      entries = await this.runUsage.read();
    } catch {
      return false;
    }
    if (generation !== this.hydrationGeneration) return false;

    const byRunId = new Map<string, AgentRunUsageEntry>();
    for (const entry of entries) {
      if (entry.finished !== undefined && this.liveRunIdentity.of(entry) !== undefined) byRunId.set(entry.started.runId, entry);
    }
    for (const entry of this.finishedRuns.values()) {
      if (entry.finished !== undefined && this.liveRunIdentity.of(entry) !== undefined) byRunId.set(entry.started.runId, entry);
    }
    const sorted = [...byRunId.values()].toSorted(
      (left, right) => left.finished!.endedAt - right.finished!.endedAt,
    );
    const retained = sorted.slice(Math.max(0, sorted.length - this.maxTrackedRuns));
    if (generation !== this.hydrationGeneration) return false;

    this.finishedRuns.clear();
    for (const entry of retained) this.rememberRun(entry);
    this.hydrated = true;
    return true;
  }
}

function legacyReason(reasonCode: AutoSubagentPresetReasonCode): string {
  switch (reasonCode) {
    case 'cancelled':
      return 'cancelled';
    case 'flag_disabled':
      return 'flag disabled';
    case 'auto_preset_disabled':
      return 'auto preset disabled';
    case 'manual_lock':
    case 'manual_override':
      return 'manual preset selection';
    case 'caller_model_unavailable':
      return 'no caller model';
    case 'no_candidates':
      return 'no candidate presets';
    case 'explicit_preset':
      return 'explicit preset selection';
    case 'no_quota_evidence':
      return 'no quota evidence';
    case 'no_healthy_candidate':
      return 'no candidate above quota floor';
    case 'current_optimal':
      return 'current preset already optimal';
    case 'score_margin_not_met':
      return 'candidate lead below switch margin';
    case 'switch_cooldown':
      return 'switch cooldown active';
    case 'current_unhealthy':
      return 'switched from a current preset not eligible for automatic selection';
    case 'circuit_breaker_escape':
      return 'switched from open circuit breaker';
    case 'higher_score':
      return 'switched to higher score';
    case 'preset_changed_during_evaluation':
      return 'preset changed during evaluation';
    case 'routing_config_changed':
      return 'routing config changed during evaluation';
    case 'evaluation_failed':
      return 'preset evaluation failed';
    case 'activation_failed':
      return 'preset activation failed';
    case 'activation_no_effect':
      return 'preset activation did not change the active preset';
  }
}

function highestScoringHealthy(
  states: readonly AutoSubagentPresetCandidateScore[],
  currentPreset: string | undefined,
): AutoSubagentPresetCandidateScore | undefined {
  let best: AutoSubagentPresetCandidateScore | undefined;
  for (const state of states) {
    if (!state.selectable || state.score === undefined) continue;
    if (best === undefined || state.score > best.score!) {
      best = state;
      continue;
    }
    if (state.score === best.score && state.preset === currentPreset) best = state;
  }
  return best;
}

function scoreOf(
  states: readonly AutoSubagentPresetCandidateScore[],
  preset: string | undefined,
): number | undefined {
  if (preset === undefined) return undefined;
  return states.find((state) => state.preset === preset)?.score;
}

function activeDeadline(deadline: number | undefined, now: number): number | undefined {
  return deadline !== undefined && deadline > now ? deadline : undefined;
}

async function awaitWithCallerAbort(
  pending: Promise<ProviderUsageResult | undefined>,
  signal: AbortSignal | undefined,
): Promise<ProviderUsageResult | undefined> {
  if (signal === undefined) return pending;
  if (signal.aborted) return undefined;
  let onAbort!: () => void;
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

registerScopedService(
  LifecycleScope.App,
  IAutoSubagentPresetService,
  AutoSubagentPresetService,
  ScopeActivation.OnDemand,
  'autoSubagentPreset',
);
