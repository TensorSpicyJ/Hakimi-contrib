/**
 * `autoSubagentPreset` domain — exponential reset-priority pure helpers.
 *
 * Identifies declared subscription windows of at least one day from
 * providerUsage summary/limit rows and scores the single most urgent one with
 * an exponential curve (`maxBonus * expm1(exponent * u) / expm1(exponent)`,
 * `u = 1 - timeToReset / horizon`, horizon capped at the window's own period).
 * Short rate-limit windows, undeclared periods, invalid/exhausted rows, stale
 * resets, and a zero max bonus never produce a candidate. Pure and
 * credential-free; the caller decides how the bonus and the floor exception
 * apply. Shared by the App-scope evidence and scoring helpers.
 */

import type { UsageRow, UsageWindow } from '@moonshot-ai/kimi-code-oauth';
import type { SubagentAutoPresetConfig } from '#/session/subagent/configSection';
import type { AutoSubagentPresetResetPriority } from './autoSubagentPreset';

export const RESET_PRIORITY_MIN_WINDOW_MS = 24 * 60 * 60 * 1000;

const UNIT_MS: Readonly<Record<UsageWindow['unit'], number>> = {
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
};

export interface ResetPriorityPolicy {
  readonly windowMs: number;
  readonly exponent: number;
  readonly maxBonus: number;
  readonly quotaFloorPercent: number;
}

export function resetPriorityPolicy(settings: SubagentAutoPresetConfig): ResetPriorityPolicy {
  return {
    windowMs: settings.resetPriorityWindowMs,
    exponent: settings.resetPriorityExponent,
    maxBonus: settings.resetPriorityMaxBonus,
    quotaFloorPercent: settings.quotaFloorPercent,
  };
}

export function windowDurationMs(window: UsageWindow | undefined): number | undefined {
  if (window === undefined) return undefined;
  const unit = UNIT_MS[window.unit];
  if (!Number.isFinite(window.duration) || window.duration <= 0) return undefined;
  return window.duration * unit;
}

export function windowRemainingPercent(limit: number, used: number): number | undefined {
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used) || used < 0) return undefined;
  return Math.min(100, Math.max(0, ((limit - used) / limit) * 100));
}

export function subscriptionResetPriority(
  rows: readonly UsageRow[],
  policy: ResetPriorityPolicy,
  now: number,
): AutoSubagentPresetResetPriority | undefined {
  if (policy.maxBonus <= 0) return undefined;
  let best: AutoSubagentPresetResetPriority | undefined;
  for (const row of rows) {
    const windowMs = windowDurationMs(row.window);
    if (windowMs === undefined || windowMs < RESET_PRIORITY_MIN_WINDOW_MS) continue;
    const remainingPercent = windowRemainingPercent(row.limit, row.used);
    if (remainingPercent === undefined || remainingPercent <= 0) continue;
    const resetAt = row.resetAt === undefined ? Number.NaN : Date.parse(row.resetAt);
    if (!Number.isFinite(resetAt) || resetAt <= now) continue;
    const horizonMs = Math.min(policy.windowMs, windowMs);
    const timeToReset = resetAt - now;
    const u = timeToReset >= horizonMs ? 0 : 1 - timeToReset / horizonMs;
    const bonus = (policy.maxBonus * Math.expm1(policy.exponent * u)) / Math.expm1(policy.exponent);
    if (
      best === undefined ||
      bonus > best.bonus ||
      (bonus === best.bonus && resetAt < best.resetAt)
    ) {
      best = { window: row.window!, resetAt, remainingPercent, horizonMs, bonus, floorRelaxed: false };
    }
  }
  return best;
}
