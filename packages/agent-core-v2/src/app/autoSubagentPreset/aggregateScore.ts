/**
 * `autoSubagentPreset` domain — whole-preset scoring and temporary role replacement.
 *
 * Captures the configured role/model pool and folds supplied resource and local
 * evidence into credential-free snapshots. No network, config writes or global
 * binding state; callers can rescore at the dispatch boundary with a fresh clock.
 */

import type { Model, IModelCatalog } from '#/kosong/model/catalog';
import type { EffectiveAccount } from './accountIdentity';
import { isUnknownCapability } from '#/kosong/contract/capability';
import type { ProviderUsageResult } from '#/app/providerUsage/providerUsage';
import type { SubagentAutoPresetConfig, SubagentBindingResolution, SubagentConfig, SubagentRouteRequest } from '#/session/subagent/configSection';
import {
  AUTO_PRESET_DEFAULT_ROLE_WEIGHT, AUTO_PRESET_FALLBACK_PENALTY,
  type AutoSubagentPresetCandidateScore, type AutoSubagentPresetLocalEvidence,
  type AutoSubagentPresetResetPriority,
  type AutoSubagentPresetRoleScore, type AutoSubagentPresetRouteScore,
  type AutoSubagentPresetScoreContributions,
} from './autoSubagentPreset';
import { assessResource, disabledAutoModel, satisfiesRoute } from './resourceEvidence';

export interface ScoringRole {
  readonly key: string;
  readonly request: SubagentRouteRequest;
}

interface RouteDraft {
  readonly role: ScoringRole;
  readonly binding?: SubagentBindingResolution;
  readonly model?: Model;
  readonly account?: EffectiveAccount;
}

interface PoolEntry extends RouteDraft {
  readonly preset?: string;
}

export interface PreparedPresetScores {
  readonly roles: readonly ScoringRole[];
  readonly presets: readonly { readonly preset: string; readonly routes: readonly RouteDraft[] }[];
  readonly pool: readonly PoolEntry[];
  readonly accounts: readonly EffectiveAccount[];
}

export interface RouteLocalStats {
  readonly evidence: AutoSubagentPresetLocalEvidence;
  readonly circuitBreakerOpenUntil?: number;
}

export function roleKey(request: SubagentRouteRequest): string {
  return request.route === 'agent' ? request.profileName ?? 'coder' : request.route;
}

export function preparePresetScores(
  section: SubagentConfig | undefined,
  participating: readonly string[],
  trigger: SubagentRouteRequest,
  catalog: IModelCatalog,
  resolve: (preset: string | undefined, request: SubagentRouteRequest) => SubagentBindingResolution,
  accountOf: (alias: string, model: Model) => EffectiveAccount | undefined,
): PreparedPresetScores {
  const keys = new Set(['coder', 'swarm', 'tower_worker', 'tower_reviewer']);
  for (const entries of [section?.agents, ...Object.values(section?.presets ?? {})]) {
    for (const key of Object.keys(entries ?? {})) keys.add(key);
  }
  keys.add(roleKey(trigger));
  keys.delete('main');
  const roles = [...keys].map((key): ScoringRole => {
    if (key === roleKey(trigger)) return { key, request: trigger };
    const route = key === 'swarm' || key === 'tower_worker' || key === 'tower_reviewer' ? key : 'agent';
    const profileName = key === 'swarm' ? 'coder' : key === 'tower_worker' ? 'tower-worker' : key === 'tower_reviewer' ? 'reviewer' : key;
    return { key, request: { route, profileName, caller: trigger.caller } };
  });
  const draft = (preset: string | undefined, role: ScoringRole): RouteDraft => {
    try {
      const binding = resolve(preset, role.request);
      const model = catalog.get(binding.model);
      return { role, binding, model, account: accountOf(binding.model, model) };
    } catch {
      return { role };
    }
  };
  const presets = Object.keys(section?.presets ?? {}).map((preset) => ({ preset, routes: roles.map((role) => draft(preset, role)) }));
  const pool: PoolEntry[] = [];
  for (const preset of participating) {
    for (const route of presets.find((entry) => entry.preset === preset)?.routes ?? []) {
      if (route.binding?.modelSource !== 'preset' && route.binding?.modelSource !== 'agents') continue;
      pool.push({ ...route, preset: route.binding.modelSource === 'preset' ? preset : undefined });
    }
  }
  for (const role of roles) {
    if (section?.agents !== undefined && Object.hasOwn(section.agents, role.key) && section.agents[role.key]?.model !== undefined) pool.push(draft(undefined, role));
  }
  const accounts = new Map<string, EffectiveAccount>();
  for (const entry of [...presets.flatMap((preset) => preset.routes), ...pool]) {
    if (entry.model !== undefined && entry.account?.queryProvider !== undefined && !disabledAutoModel(entry.model, entry.binding!.model)) accounts.set(entry.account.key, entry.account);
  }
  return { roles, presets, pool, accounts: [...accounts.values()] };
}

export function scorePresets(
  prepared: PreparedPresetScores,
  participating: readonly string[],
  settings: SubagentAutoPresetConfig,
  now: number,
  results: ReadonlyMap<string, ProviderUsageResult | undefined>,
  quotaOf: (result: ProviderUsageResult | undefined, allowExtraUsage: boolean, now: number) => { readonly remainingPercent: number; readonly resetAt?: number; readonly resetPriority?: AutoSubagentPresetResetPriority } | undefined,
  statsOf: (account: string, profile: string | undefined, alias: string, now: number) => RouteLocalStats,
  aggregateEvidence: (accounts: ReadonlySet<string>, now: number) => AutoSubagentPresetLocalEvidence,
  effectiveThinking: (requested: string | undefined, model: Model, fallback: boolean) => string,
  deepseekUsageEnabled: boolean,
): readonly AutoSubagentPresetCandidateScore[] {
  const routeAccounts = new WeakMap<AutoSubagentPresetRouteScore, string>();
  const statsCache = new Map<string, RouteLocalStats>();
  const stats = (entry: RouteDraft, role: ScoringRole): RouteLocalStats => {
    if (entry.model === undefined || entry.binding === undefined || entry.account === undefined) return { evidence: emptyLocalEvidence() };
    const key = JSON.stringify([entry.account.key, entry.model.name ?? entry.binding.model, role.request.profileName]);
    let value = statsCache.get(key);
    if (value === undefined) {
      value = statsOf(entry.account.key, role.request.profileName, entry.binding.model, now);
      statsCache.set(key, value);
    }
    return value;
  };
  for (const preset of prepared.presets) for (const entry of preset.routes) stats(entry, entry.role);
  for (const entry of prepared.pool) for (const role of prepared.roles) stats(entry, role);
  const maxTokens = Math.max(0, ...[...statsCache.values()].map((entry) => entry.evidence.tokenCount));
  const maxLatency = Math.max(0, ...[...statsCache.values()].map((entry) => entry.evidence.averageFirstTokenLatencyMs ?? 0));
  const scoreRoute = (entry: RouteDraft, role: ScoringRole, fallback: boolean): AutoSubagentPresetRouteScore => {
    const { binding, model } = entry;
    if (binding === undefined || model === undefined) return {
      availability: 'route_unresolved', contributions: emptyContributions(), localEvidence: emptyLocalEvidence(), resource: { kind: 'unknown', reason: 'missing' },
    };
    const local = stats(entry, role);
    const result = entry.account?.queryProvider === undefined ? undefined : results.get(entry.account.key);
    const assessed = assessResource(model, result, quotaOf(result, settings.allowExtraUsage, now), settings, now, deepseekUsageEnabled);
    const resourceScore = assessed.resource.kind === 'unknown' ? undefined : assessed.resource.resourceScore;
    const resetBonus = assessed.resource.kind === 'subscription' ? (assessed.resource.resetPriority?.bonus ?? 0) : 0;
    const thinking = effectiveThinking(binding.thinking, model, fallback);
    const wantsThinking = thinking !== 'off';
    const routeFitBonus = 2 + (model.capabilities !== undefined && !isUnknownCapability(model.capabilities) && model.capabilities.thinking === wantsThinking ? 1 : 0);
    const tokenPenalty = maxTokens === 0 ? 0 : settings.localUsageWeightPercent * Math.min(1, local.evidence.tokenCount / maxTokens);
    const reliabilityPenalty = settings.reliabilityWeightPercent * local.evidence.adjustedFailureRate;
    const latencyPenalty = maxLatency === 0 || local.evidence.averageFirstTokenLatencyMs === undefined ? 0
      : settings.latencyWeightPercent * Math.min(1, local.evidence.averageFirstTokenLatencyMs / maxLatency) * Math.min(1, local.evidence.firstTokenLatencySampleCount / 5);
    const availability = disabledAutoModel(model, binding.model) ? 'model_disabled'
      : !satisfiesRoute(model, role.request, fallback) ? 'capability_unavailable'
        : local.circuitBreakerOpenUntil !== undefined && local.circuitBreakerOpenUntil > now ? 'circuit_open' : assessed.availability;
    const peakPenalty = availability === 'healthy' && assessed.resource.kind === 'metered' ? (assessed.resource.peakPenalty?.points ?? 0) : 0;
    const score: AutoSubagentPresetRouteScore = {
      model: binding.model, thinking, provider: entry.account?.queryProvider ?? model.providerName,
      source: fallback ? 'auto-fallback' : binding.source,
      modelSource: fallback ? 'auto-fallback' : binding.modelSource,
      thinkingSource: fallback ? 'auto-fallback' : binding.thinkingSource,
      availability,
      score: resourceScore === undefined ? undefined : resourceScore + resetBonus + routeFitBonus - tokenPenalty - reliabilityPenalty - latencyPenalty - peakPenalty,
      contributions: {
        quotaRemaining: assessed.resource.kind === 'subscription' ? assessed.resource.quotaRemainingPercent : undefined,
        resourceScore, priorityBonus: 0, resetBonus, routeFitBonus, tokenPenalty, reliabilityPenalty, latencyPenalty, peakPenalty,
      },
      localEvidence: local.evidence, resource: assessed.resource,
      circuitBreakerOpenUntil: local.circuitBreakerOpenUntil,
    };
    routeAccounts.set(score, entry.account?.key ?? `unverified:${binding.model}`);
    return score;
  };
  return Object.freeze(prepared.presets.map(({ preset, routes }): AutoSubagentPresetCandidateScore => {
    const roleScores = routes.map((entry): AutoSubagentPresetRoleScore => {
      const role = entry.role;
      const original = scoreRoute(entry, role, false);
      let effective = original;
      let fallback: AutoSubagentPresetRoleScore['fallback'];
      if (original.availability !== 'healthy') {
        for (const sameRole of [true, false]) {
          const seen = new Set<string>();
          let best: { readonly score: AutoSubagentPresetRouteScore; readonly entry: PoolEntry } | undefined;
          for (const candidate of prepared.pool) {
            if ((candidate.role.key === role.key) !== sameRole || candidate.model === undefined || candidate.binding === undefined) continue;
            const identity = JSON.stringify([candidate.account?.key ?? candidate.binding.model, candidate.model.name ?? candidate.binding.model]);
            if (seen.has(identity)) continue;
            seen.add(identity);
            const score = scoreRoute(candidate, role, true);
            if (score.availability !== 'healthy' || score.score === undefined) continue;
            if (best === undefined || score.score > best.score.score!) best = { score, entry: candidate };
          }
          if (best !== undefined) {
            effective = best.score;
            fallback = { sourcePreset: best.entry.preset, sourceRole: best.entry.role.key, reason: original.availability };
            break;
          }
        }
      }
      const fallbackPenalty = fallback === undefined ? 0 : AUTO_PRESET_FALLBACK_PENALTY;
      return Object.freeze({ key: role.key, route: role.request.route, profileName: role.request.profileName,
        weight: settings.roleWeights !== undefined && Object.hasOwn(settings.roleWeights, role.key)
          ? settings.roleWeights[role.key]! : AUTO_PRESET_DEFAULT_ROLE_WEIGHT,
        original, effective, effectiveScore: effective.availability === 'healthy' ? Math.max(0, (effective.score ?? 0) - fallbackPenalty) : 0,
        fallbackPenalty, fallback });
    });
    const totalRoleWeight = roleScores.reduce((sum, role) => sum + role.weight, 0);
    const nativeAvailableRoleCount = roleScores.filter((role) => role.original.availability === 'healthy').length;
    const fallbackRoleCount = roleScores.filter((role) => role.fallback !== undefined).length;
    const unavailableRoleCount = roleScores.length - nativeAvailableRoleCount - fallbackRoleCount;
    const index = participating.indexOf(preset);
    const priorityBonus = index < 0 ? 0 : settings.priorityWeightPercent * (participating.length <= 1 ? 1 : (participating.length - 1 - index) / (participating.length - 1));
    const weighted = (value: (role: AutoSubagentPresetRoleScore) => number): number => totalRoleWeight === 0 ? 0 : roleScores.reduce((sum, role) => sum + role.weight * value(role), 0) / totalRoleWeight;
    const providers = new Set<string>();
    const knownProviders = new Set<string>();
    for (const role of roleScores) for (const route of [role.original, role.effective]) {
      const account = routeAccounts.get(route);
      if (account === undefined) continue;
      providers.add(account);
      if ((route.resource.kind === 'subscription' && route.resource.quotaRemainingPercent !== undefined) ||
        (route.resource.kind === 'metered' && route.resource.balanceStatus === 'known')) knownProviders.add(account);
    }
    const contributions = emptyContributions();
    const aggregateContributions: AutoSubagentPresetScoreContributions = {
      ...contributions, priorityBonus,
      resourceScore: roleScores.some((role) => role.weight > 0 && role.effective.contributions.resourceScore === undefined)
        ? undefined : weighted((role) => role.effective.contributions.resourceScore ?? 0),
      resetBonus: weighted((role) => role.effective.contributions.resetBonus),
      routeFitBonus: weighted((role) => role.effective.contributions.routeFitBonus),
      tokenPenalty: weighted((role) => role.effective.contributions.tokenPenalty),
      reliabilityPenalty: weighted((role) => role.effective.contributions.reliabilityPenalty),
      latencyPenalty: weighted((role) => role.effective.contributions.latencyPenalty),
      peakPenalty: weighted((role) => role.effective.contributions.peakPenalty ?? 0),
    };
    return Object.freeze({
      preset, participating: index >= 0,
      deepseekRoleShare: weighted((role) => role.effective.availability === 'healthy' && role.effective.resource.kind === 'metered' ? 1 : 0),
      availability: unavailableRoleCount === 0 ? 'healthy' : unavailableRoleCount === roleScores.length ? 'unavailable' : 'partial',
      selectable: index >= 0 && totalRoleWeight > 0 && roleScores.some((role) => role.weight > 0 && role.effective.availability === 'healthy'),
      score: totalRoleWeight === 0 ? undefined : weighted((role) => role.effectiveScore) + priorityBonus,
      nativeScore: totalRoleWeight === 0 ? undefined : weighted((role) => role.original.availability === 'healthy' ? Math.max(0, role.original.score ?? 0) : 0) + priorityBonus,
      contributions: Object.freeze(aggregateContributions), localEvidence: Object.freeze(aggregateEvidence(providers, now)),
      roleScores: Object.freeze(roleScores), roleCount: roleScores.length, nativeAvailableRoleCount, fallbackRoleCount, unavailableRoleCount, totalRoleWeight,
      coverage: { resourceProviderCount: knownProviders.size, totalProviderCount: providers.size,
        localEvidenceRoleCount: roleScores.filter((role) => role.original.localEvidence.sampleCount > 0).length, totalRoleCount: roleScores.length },
    });
  }));
}

export function bindingForRole(candidate: AutoSubagentPresetCandidateScore | undefined, request: SubagentRouteRequest, manualRevision: number): SubagentBindingResolution | undefined {
  const role = candidate?.roleScores?.find((entry) => entry.key === roleKey(request));
  if (role === undefined || role.effective.availability !== 'healthy' || role.effective.model === undefined) return undefined;
  const route = role.effective;
  const original = role.original.model === undefined ? undefined : {
    model: role.original.model, thinking: role.original.thinking, source: role.original.source!,
    modelSource: role.original.modelSource!, thinkingSource: role.original.thinkingSource!,
  };
  return { model: route.model!, thinking: route.thinking, source: route.source!, modelSource: route.modelSource!, thinkingSource: route.thinkingSource!,
    preset: candidate!.preset, manualRevision,
    temporaryFallback: role.fallback === undefined ? undefined : { ...role.fallback, original } };
}

export function emptyLocalEvidence(): AutoSubagentPresetLocalEvidence {
  return { scope: 'none', sampleCount: 0, failureCount: 0, adjustedFailureRate: 0, tokenCount: 0, firstTokenLatencySampleCount: 0, llmRequestCount: 0 };
}

function emptyContributions(): AutoSubagentPresetScoreContributions {
  return { priorityBonus: 0, resetBonus: 0, routeFitBonus: 0, tokenPenalty: 0, reliabilityPenalty: 0, latencyPenalty: 0 };
}
