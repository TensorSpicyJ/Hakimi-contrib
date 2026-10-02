/**
 * `providerUsageLedger` domain — DeepSeek pricing and Asia/Shanghai clock.
 *
 * Pure functions only: an exact (never prefix-matched) model-name → dated rate
 * schedule, a fixed-precision CNY cost in integer nano-yuan (1 CNY = 10^9 nanos)
 * so per-request amounts are never rounded to cents before aggregation, and the
 * Asia/Shanghai wall-clock helpers used to group attempts into calendar
 * days/months and to select the official peak/off-peak rate.
 *
 * Current rates verified 2026-09-21 against
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing and
 * https://api-docs.deepseek.com/updates. The V4.1 release date has day granularity;
 * its schedule starts at Shanghai midnight. The older Flash rates retain the
 * existing local snapshot rather than claiming a newly verified historical rate:
 *   2026-09-07 — retained snapshot for `deepseek-v4-pro`, `deepseek-v4-flash`, and
 *                `deepseek-v4-flash-vision-exp`.
 *   2026-09-10 — V4.1 release: `deepseek-flash` becomes billable, and the two
 *                legacy flash names begin routing to V4.1 at the new rates.
 *                `deepseek-v4-pro` rates are unchanged.
 * A request outside its model's schedule stays unpriced instead of borrowing a
 * neighbouring rate. Peak windows ignore the Chinese public-holiday exclusions
 * the vendor also applies.
 */

import type { TokenUsage } from '#/kosong/contract/usage';

export const LEGACY_PRICING_VERSION = '2026-09-07';
export const LEGACY_PRICING_VALID_FROM = Date.parse(
  `${LEGACY_PRICING_VERSION}T00:00:00+08:00`,
);
export const V41_PRICING_VERSION = '2026-09-10';
export const V41_PRICING_VALID_FROM = Date.parse(`${V41_PRICING_VERSION}T00:00:00+08:00`);

const NANOS_PER_CNY = 1_000_000_000n;
const MILLIS_PER_HOUR = 3_600_000;
const SHANGHAI_UTC_OFFSET_MS = 8 * MILLIS_PER_HOUR;

interface TierRate {
  readonly cacheHitNanosPerToken: bigint;
  readonly cacheMissNanosPerToken: bigint;
  readonly outputNanosPerToken: bigint;
}

interface RateSchedule {
  readonly pricingVersion: string;
  readonly validFromEpochMs: number;
  readonly peak: TierRate;
  readonly offPeak: TierRate;
}

const LEGACY_FLASH_SCHEDULE: RateSchedule = {
  pricingVersion: LEGACY_PRICING_VERSION,
  validFromEpochMs: LEGACY_PRICING_VALID_FROM,
  peak: {
    cacheHitNanosPerToken: 100n,
    cacheMissNanosPerToken: 3000n,
    outputNanosPerToken: 9000n,
  },
  offPeak: {
    cacheHitNanosPerToken: 50n,
    cacheMissNanosPerToken: 1500n,
    outputNanosPerToken: 4500n,
  },
};

const V41_FLASH_SCHEDULE: RateSchedule = {
  pricingVersion: V41_PRICING_VERSION,
  validFromEpochMs: V41_PRICING_VALID_FROM,
  peak: {
    cacheHitNanosPerToken: 40n,
    cacheMissNanosPerToken: 2000n,
    outputNanosPerToken: 8000n,
  },
  offPeak: {
    cacheHitNanosPerToken: 20n,
    cacheMissNanosPerToken: 1000n,
    outputNanosPerToken: 4000n,
  },
};

const PRO_SCHEDULE: RateSchedule = {
  pricingVersion: LEGACY_PRICING_VERSION,
  validFromEpochMs: LEGACY_PRICING_VALID_FROM,
  peak: {
    cacheHitNanosPerToken: 300n,
    cacheMissNanosPerToken: 9000n,
    outputNanosPerToken: 27000n,
  },
  offPeak: {
    cacheHitNanosPerToken: 150n,
    cacheMissNanosPerToken: 4500n,
    outputNanosPerToken: 13500n,
  },
};

const MODEL_SCHEDULES: Readonly<Record<string, readonly RateSchedule[]>> = {
  'deepseek-v4-pro': [PRO_SCHEDULE],
  'deepseek-v4-flash': [LEGACY_FLASH_SCHEDULE, V41_FLASH_SCHEDULE],
  'deepseek-v4-flash-vision-exp': [LEGACY_FLASH_SCHEDULE, V41_FLASH_SCHEDULE],
  'deepseek-flash': [V41_FLASH_SCHEDULE],
};

export interface DeepSeekAttemptPrice {
  readonly pricingVersion: string;
  readonly costNanos: bigint;
}

export function resolveDeepSeekPrice(
  modelName: string,
  startedAtEpochMs: number,
  usage: TokenUsage,
): DeepSeekAttemptPrice | undefined {
  if (!Object.prototype.hasOwnProperty.call(MODEL_SCHEDULES, modelName)) return undefined;
  const schedules = MODEL_SCHEDULES[modelName];
  if (schedules === undefined) return undefined;
  let selected: RateSchedule | undefined;
  for (const schedule of schedules) {
    if (schedule.validFromEpochMs <= startedAtEpochMs) selected = schedule;
  }
  if (selected === undefined) return undefined;
  const rate = isDeepSeekPeak(startedAtEpochMs) ? selected.peak : selected.offPeak;
  const cacheRead = toNonNegative(usage.inputCacheRead);
  const inputOther = toNonNegative(usage.inputOther) + toNonNegative(usage.inputCacheCreation);
  const output = toNonNegative(usage.output);
  return {
    pricingVersion: selected.pricingVersion,
    costNanos:
      BigInt(cacheRead) * rate.cacheHitNanosPerToken +
      BigInt(inputOther) * rate.cacheMissNanosPerToken +
      BigInt(output) * rate.outputNanosPerToken,
  };
}

function toNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function formatNanosToCny(nanos: bigint): string {
  const negative = nanos < 0n;
  const abs = negative ? -nanos : nanos;
  const whole = abs / NANOS_PER_CNY;
  const fraction = abs % NANOS_PER_CNY;
  let fractionText = fraction.toString().padStart(9, '0').replace(/0+$/, '');
  const sign = negative ? '-' : '';
  if (fractionText.length === 0) return `${sign}${whole.toString()}`;
  return `${sign}${whole.toString()}.${fractionText}`;
}

export interface ShanghaiTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number;
}

const SHANGHAI_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function shanghaiParts(epochMs: number): ShanghaiTimeParts {
  const parts = SHANGHAI_FORMATTER.formatToParts(new Date(epochMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  const year = read('year');
  const month = read('month');
  const day = read('day');
  const hour = read('hour');
  const minute = read('minute');
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour, minute, weekday };
}

export function startOfShanghaiDay(epochMs: number): number {
  const { year, month, day } = shanghaiParts(epochMs);
  return Date.UTC(year, month - 1, day) - SHANGHAI_UTC_OFFSET_MS;
}

export function endOfShanghaiDay(epochMs: number): number {
  return startOfShanghaiDay(epochMs) + 24 * MILLIS_PER_HOUR;
}

export function startOfShanghaiMonth(epochMs: number): number {
  const { year, month } = shanghaiParts(epochMs);
  return Date.UTC(year, month - 1, 1) - SHANGHAI_UTC_OFFSET_MS;
}

export function endOfShanghaiMonth(epochMs: number): number {
  const { year, month } = shanghaiParts(epochMs);
  return Date.UTC(year, month, 1) - SHANGHAI_UTC_OFFSET_MS;
}

export function shanghaiYearMonth(epochMs: number): string {
  const { year, month } = shanghaiParts(epochMs);
  return `${String(year)}-${String(month).padStart(2, '0')}`;
}

export function isDeepSeekPeak(epochMs: number): boolean {
  const { weekday, hour } = shanghaiParts(epochMs);
  if (weekday < 1 || weekday > 5) return false;
  const morningPeak = hour >= 9 && hour < 12;
  const afternoonPeak = hour >= 14 && hour < 18;
  return morningPeak || afternoonPeak;
}
