/**
 * `autoSubagentPreset` domain — credential-free resource and capability policy.
 *
 * Interprets providerUsage evidence without network access; official DeepSeek
 * balances use a binary funded-account baseline, never a quota percentage.
 * A positive reset-priority bonus on still-positive declared subscription
 * windows relaxes only the retention floor; exhausted, unknown or invalid
 * evidence is never relaxed. Shanghai peak restrictions are evaluated against
 * the supplied host time.
 */

import { officialDeepSeekBalanceUrl } from '@moonshot-ai/kimi-code-oauth';
import type { Model } from '#/kosong/model/catalog';
import { isUnknownCapability } from '#/kosong/contract/capability';
import type { ProviderUsageResult } from '#/app/providerUsage/providerUsage';
import { resolveDeepseekPeakPolicy, type SubagentAutoPresetConfig, type SubagentRouteAvailability, type SubagentRouteRequest } from '#/session/subagent/configSection';
import type { AutoSubagentPresetResetPriority, AutoSubagentPresetResourceEvidence } from './autoSubagentPreset';
import { AUTO_PRESET_METERED_FUNDED_RESOURCE_SCORE } from './autoSubagentPreset';

export interface ResourceAssessment {
  readonly resource: AutoSubagentPresetResourceEvidence;
  readonly availability: SubagentRouteAvailability;
}

export interface SubscriptionQuotaEvidence {
  readonly remainingPercent: number;
  readonly resetAt?: number;
  readonly resetPriority?: AutoSubagentPresetResetPriority;
}

export function deepseekBlockedUntil(now: number): number | undefined {
  const local = new Date(now + 8 * 60 * 60 * 1000);
  const day = local.getUTCDay();
  if (day === 0 || day === 6) return undefined;
  const hour = local.getUTCHours();
  const end = hour >= 9 && hour < 12 ? 12 : hour >= 14 && hour < 18 ? 18 : undefined;
  if (end === undefined) return undefined;
  local.setUTCHours(end, 0, 0, 0);
  return local.getTime() - 8 * 60 * 60 * 1000;
}

export function disabledAutoModel(model: Model, alias: string): boolean {
  const names = [alias, model.id, model.name, ...(model.aliases ?? [])].filter(Boolean);
  if (names.some((name) => /gpt[-_. ]?5[.-]6(?:\b|_)/i.test(name))) return true;
  if (/opencode[-_ ]?go/i.test(model.providerType ?? '') || /opencode[-_ ]?go/i.test(model.providerName)) return true;
  try {
    const url = new URL(model.baseUrl ?? '');
    return url.hostname === 'opencode.ai' && /^\/zen\/go(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

export function satisfiesRoute(model: Model, request: SubagentRouteRequest, fallback: boolean): boolean {
  const requirements = request.requirements ?? {};
  const capability = model.capabilities;
  const needsImage = request.profileName === 'multimodal' || requirements.image_in === true;
  const needsTools = fallback || requirements.tool_use === true || needsImage;
  const needed = needsImage || needsTools || requirements.video_in || requirements.audio_in ||
    requirements.thinking || requirements.dynamically_loaded_tools ||
    requirements.minContextTokens !== undefined || requirements.minInputTokens !== undefined;
  if (!needed) return true;
  if (capability === undefined || isUnknownCapability(capability)) return false;
  if (needsImage && !capability.image_in) return false;
  if (needsTools && !capability.tool_use) return false;
  for (const key of ['video_in', 'audio_in', 'thinking', 'dynamically_loaded_tools'] as const) {
    if (requirements[key] === true && capability[key] !== true) return false;
  }
  for (const [minimum, maximum] of [
    [requirements.minContextTokens, Math.min(capability.max_context_tokens, model.maxContextSize ?? capability.max_context_tokens)],
    [requirements.minInputTokens, capability.max_input_tokens === undefined ? undefined : Math.min(capability.max_input_tokens, model.maxInputSize ?? capability.max_input_tokens)],
  ]) {
    if (minimum === undefined) continue;
    if (!Number.isFinite(minimum) || minimum < 0 || maximum === undefined || !Number.isFinite(maximum) || maximum <= 0 || maximum < minimum) return false;
  }
  return true;
}

export function assessResource(
  model: Model,
  result: ProviderUsageResult | undefined,
  quota: SubscriptionQuotaEvidence | undefined,
  settings: SubagentAutoPresetConfig,
  now: number,
  deepseekUsageEnabled: boolean,
): ResourceAssessment {
  if (officialDeepSeekBalanceUrl(model.baseUrl) !== undefined) {
    if (!deepseekUsageEnabled) return { availability: 'provider_unsupported', resource: { kind: 'unknown', reason: 'unsupported' } };
    const metered = result?.kind === 'ok' ? result.meteredUsage : undefined;
    const balance = metered?.balance;
    const cny = balance?.kind === 'ok' ? balance.balances.find((item) => item.currency === 'CNY') : undefined;
    const valid = cny !== undefined && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(cny.total) &&
      cny.total.length <= 128 && Number.isFinite(Number(cny.total));
    const isAvailable = balance?.kind === 'ok' ? balance.isAvailable : undefined;
    const balanceStatus = balance?.kind === 'error' || result?.kind === 'error'
      ? 'query_failed' : cny === undefined ? 'missing' : valid ? 'known' : 'invalid';
    const funded = valid && isAvailable === true && Number(cny.total) > 0;
    const peakPolicy = resolveDeepseekPeakPolicy(settings);
    const peakUntil = peakPolicy === 'off' ? undefined : deepseekBlockedUntil(now);
    const blockedUntil = peakPolicy === 'block' ? peakUntil : undefined;
    const resource: AutoSubagentPresetResourceEvidence = {
      kind: 'metered',
      currency: 'CNY',
      balanceCny: valid ? cny.total : undefined,
      isAvailable,
      balanceStatus,
      resourceScore: valid && isAvailable !== undefined ? funded ? AUTO_PRESET_METERED_FUNDED_RESOURCE_SCORE : 0 : undefined,
      resourceScoreBasis: 'funded_account',
      meteredUsage: metered === undefined ? undefined : {
        source: metered.source,
        costSource: metered.costSource,
        currency: metered.currency,
        timezone: metered.timezone,
        trackingStartedAt: metered.trackingStartedAt,
        degraded: metered.degraded,
        today: metered.today,
        month: metered.month,
      },
      blockedUntil,
      peakPenalty: funded && peakPolicy === 'penalize' && peakUntil !== undefined
        ? { points: settings.deepseekPeakPenalty, until: peakUntil } : undefined,
    };
    const availability: SubagentRouteAvailability = blockedUntil !== undefined ? 'time_restricted'
      : balanceStatus === 'invalid' ? 'balance_invalid'
        : isAvailable === false ? 'account_unavailable'
          : !valid || isAvailable === undefined ? 'balance_unknown'
            : !funded ? 'balance_empty' : 'healthy';
    return { resource, availability };
  }
  if (quota !== undefined) {
    const floorRelaxed = quota.resetPriority?.floorRelaxed === true;
    // True exhaustion is unavailable on its own, before any reserve-floor
    // policy: a zero floor means "keep no positive reserve", never "an
    // exhausted window is usable".
    const exhausted = quota.remainingPercent <= 0;
    return {
      resource: {
        kind: 'subscription',
        resourceScore: quota.remainingPercent,
        quotaRemainingPercent: quota.remainingPercent,
        quotaResetAt: quota.resetAt,
        resetPriority: quota.resetPriority,
      },
      availability: exhausted || (quota.remainingPercent < settings.quotaFloorPercent && !floorRelaxed) ? 'quota_below_floor' : 'healthy',
    };
  }
  return {
    resource: { kind: 'unknown', reason: result?.kind === 'unsupported' ? 'unsupported' : result?.kind === 'error' ? 'query_failed' : 'missing' },
    availability: result?.kind === 'unsupported' ? 'provider_unsupported' : 'quota_unknown',
  };
}
