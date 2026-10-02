/**
 * `providerUsageLedger` pricing tests — the pure DeepSeek dated rate schedules,
 * fixed precision CNY formatting, and the Asia/Shanghai day/month + peak clock.
 */

import { describe, expect, it } from 'vitest';

import {
  endOfShanghaiDay,
  endOfShanghaiMonth,
  formatNanosToCny,
  isDeepSeekPeak,
  LEGACY_PRICING_VERSION,
  resolveDeepSeekPrice,
  shanghaiParts,
  shanghaiYearMonth,
  startOfShanghaiDay,
  startOfShanghaiMonth,
  V41_PRICING_VERSION,
} from '#/app/providerUsageLedger/pricing';

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

function shanghaiEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): number {
  return Date.UTC(year, month - 1, day, hour, minute) - SHANGHAI_OFFSET_MS;
}

const OUTPUT_MILLION = {
  inputOther: 0,
  output: 1_000_000,
  inputCacheRead: 0,
  inputCacheCreation: 0,
};

function pricedCny(
  modelName: string,
  startedAtEpochMs: number,
  usage = OUTPUT_MILLION,
): string | undefined {
  const priced = resolveDeepSeekPrice(modelName, startedAtEpochMs, usage);
  return priced === undefined ? undefined : formatNanosToCny(priced.costNanos);
}

describe('resolveDeepSeekPrice model names', () => {
  it('prices the exact known V4 names and leaves every other name unpriced', () => {
    const at = shanghaiEpoch(2026, 9, 10, 10, 0);
    expect(resolveDeepSeekPrice('deepseek-v4-pro', at, OUTPUT_MILLION)).toBeDefined();
    expect(resolveDeepSeekPrice('deepseek-v4-flash', at, OUTPUT_MILLION)).toBeDefined();
    expect(resolveDeepSeekPrice('deepseek-v4-flash-vision-exp', at, OUTPUT_MILLION)).toBeDefined();
    expect(resolveDeepSeekPrice('deepseek-flash', at, OUTPUT_MILLION)).toBeDefined();
    expect(resolveDeepSeekPrice('deepseek-chat', at, OUTPUT_MILLION)).toBeUndefined();
    expect(resolveDeepSeekPrice('deepseek-flash-extra', at, OUTPUT_MILLION)).toBeUndefined();
    expect(resolveDeepSeekPrice('deepseek-v4-flash-extra', at, OUTPUT_MILLION)).toBeUndefined();
    expect(resolveDeepSeekPrice('', at, OUTPUT_MILLION)).toBeUndefined();
  });

  it('does not resolve prototype keys to a schedule', () => {
    const at = shanghaiEpoch(2026, 9, 10, 10, 0);
    expect(resolveDeepSeekPrice('constructor', at, OUTPUT_MILLION)).toBeUndefined();
    expect(resolveDeepSeekPrice('toString', at, OUTPUT_MILLION)).toBeUndefined();
    expect(resolveDeepSeekPrice('__proto__', at, OUTPUT_MILLION)).toBeUndefined();
    expect(resolveDeepSeekPrice('hasOwnProperty', at, OUTPUT_MILLION)).toBeUndefined();
  });
});

describe('resolveDeepSeekPrice effective dates', () => {
  it('keeps every name unpriced before the first snapshot', () => {
    const before = shanghaiEpoch(2026, 9, 6, 23, 59);
    for (const name of ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-flash']) {
      expect(resolveDeepSeekPrice(name, before, OUTPUT_MILLION)).toBeUndefined();
    }
    expect(pricedCny('deepseek-v4-pro', shanghaiEpoch(2026, 9, 7, 10, 0))).toBe('27');
  });

  it('keeps the legacy flash rates for the legacy names before the V4.1 release', () => {
    const before = shanghaiEpoch(2026, 9, 9, 23, 59);
    for (const name of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
      const priced = resolveDeepSeekPrice(name, before, OUTPUT_MILLION);
      expect(priced?.pricingVersion).toBe(LEGACY_PRICING_VERSION);
      expect(priced?.costNanos).toBe(4_500_000_000n);
    }
  });

  it('switches the legacy flash names to the cheaper V4.1 rates at the day boundary', () => {
    const at = shanghaiEpoch(2026, 9, 10, 0, 0);
    for (const name of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
      const priced = resolveDeepSeekPrice(name, at, OUTPUT_MILLION);
      expect(priced?.pricingVersion).toBe(V41_PRICING_VERSION);
      expect(priced?.costNanos).toBe(4_000_000_000n);
    }
  });

  it('prices deepseek-flash only from the V4.1 release onward', () => {
    expect(resolveDeepSeekPrice('deepseek-flash', shanghaiEpoch(2026, 9, 9, 23, 59), OUTPUT_MILLION))
      .toBeUndefined();
    const priced = resolveDeepSeekPrice('deepseek-flash', shanghaiEpoch(2026, 9, 10, 0, 0), OUTPUT_MILLION);
    expect(priced?.pricingVersion).toBe(V41_PRICING_VERSION);
    expect(priced?.costNanos).toBe(4_000_000_000n);
  });

  it('keeps the pro version and rates unchanged across the V4.1 release', () => {
    for (const at of [shanghaiEpoch(2026, 9, 9, 10, 0), shanghaiEpoch(2026, 9, 10, 10, 0)]) {
      const priced = resolveDeepSeekPrice('deepseek-v4-pro', at, OUTPUT_MILLION);
      expect(priced?.pricingVersion).toBe(LEGACY_PRICING_VERSION);
      expect(priced?.costNanos).toBe(27_000_000_000n);
    }
  });
});

describe('resolveDeepSeekPrice amounts', () => {
  it('uses the peak and off-peak pro output rate', () => {
    expect(pricedCny('deepseek-v4-pro', shanghaiEpoch(2026, 9, 7, 10, 0))).toBe('27');
    expect(pricedCny('deepseek-v4-pro', shanghaiEpoch(2026, 9, 7, 20, 0))).toBe('13.5');
  });

  it('uses the legacy flash peak and off-peak rates', () => {
    expect(pricedCny('deepseek-v4-flash', shanghaiEpoch(2026, 9, 7, 10, 0))).toBe('9');
    expect(pricedCny('deepseek-v4-flash', shanghaiEpoch(2026, 9, 7, 20, 0))).toBe('4.5');
  });

  it('uses the V4.1 flash peak and off-peak rates', () => {
    expect(pricedCny('deepseek-flash', shanghaiEpoch(2026, 9, 10, 10, 0))).toBe('8');
    expect(pricedCny('deepseek-flash', shanghaiEpoch(2026, 9, 10, 20, 0))).toBe('4');
  });

  it('is off-peak on the weekend', () => {
    // 2026-09-12 is a Saturday.
    expect(pricedCny('deepseek-flash', shanghaiEpoch(2026, 9, 12, 10, 0))).toBe('4');
  });

  it('counts cache creation as uncached input rather than omitting it', () => {
    const created = {
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 1_000_000,
    };
    expect(pricedCny('deepseek-flash', shanghaiEpoch(2026, 9, 10, 10, 0), created)).toBe('2');
  });

  it('splits cache hit vs miss input against the distinct V4.1 rates', () => {
    const split = {
      inputOther: 1_000_000,
      output: 0,
      inputCacheRead: 2_000_000,
      inputCacheCreation: 0,
    };
    // V4.1 flash peak: miss 2000/tok * 1M + hit 40/tok * 2M
    expect(pricedCny('deepseek-flash', shanghaiEpoch(2026, 9, 10, 10, 0), split)).toBe('2.08');
  });
});

describe('formatNanosToCny', () => {
  it('formats whole CNY without a fractional part', () => {
    expect(formatNanosToCny(27_000_000_000n)).toBe('27');
  });

  it('keeps fixed precision without rounding to cents', () => {
    expect(formatNanosToCny(100n)).toBe('0.0000001');
  });

  it('formats zero as "0"', () => {
    expect(formatNanosToCny(0n)).toBe('0');
  });
});

describe('Shanghai clock', () => {
  it('maps a UTC instant to Shanghai wall-clock parts', () => {
    const parts = shanghaiParts(shanghaiEpoch(2026, 9, 7, 9, 30));
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(9);
    expect(parts.day).toBe(7);
    expect(parts.hour).toBe(9);
    expect(parts.minute).toBe(30);
  });

  it('computes day start/end across the UTC+8 boundary', () => {
    const at = shanghaiEpoch(2026, 9, 7, 15, 0);
    expect(startOfShanghaiDay(at)).toBe(shanghaiEpoch(2026, 9, 7, 0, 0));
    expect(endOfShanghaiDay(at)).toBe(shanghaiEpoch(2026, 9, 8, 0, 0));
  });

  it('computes month start/end', () => {
    const at = shanghaiEpoch(2026, 9, 15, 12, 0);
    expect(startOfShanghaiMonth(at)).toBe(shanghaiEpoch(2026, 9, 1, 0, 0));
    expect(endOfShanghaiMonth(at)).toBe(shanghaiEpoch(2026, 10, 1, 0, 0));
  });

  it('groups the year-month from the Shanghai wall clock', () => {
    expect(shanghaiYearMonth(shanghaiEpoch(2026, 9, 1, 0, 30))).toBe('2026-09');
    // 2026-08-31 23:30 Shanghai is still August.
    expect(shanghaiYearMonth(shanghaiEpoch(2026, 8, 31, 23, 30))).toBe('2026-08');
  });
});

describe('isDeepSeekPeak', () => {
  it('is peak during the weekday morning and afternoon windows', () => {
    // 2026-09-07 is a Monday.
    expect(isDeepSeekPeak(shanghaiEpoch(2026, 9, 7, 9, 0))).toBe(true);
    expect(isDeepSeekPeak(shanghaiEpoch(2026, 9, 7, 11, 59))).toBe(true);
    expect(isDeepSeekPeak(shanghaiEpoch(2026, 9, 7, 14, 0))).toBe(true);
    expect(isDeepSeekPeak(shanghaiEpoch(2026, 9, 7, 17, 59))).toBe(true);
  });

  it('is off-peak in the lunch gap and outside windows', () => {
    expect(isDeepSeekPeak(shanghaiEpoch(2026, 9, 7, 12, 0))).toBe(false);
    expect(isDeepSeekPeak(shanghaiEpoch(2026, 9, 7, 13, 59))).toBe(false);
    expect(isDeepSeekPeak(shanghaiEpoch(2026, 9, 7, 18, 0))).toBe(false);
    expect(isDeepSeekPeak(shanghaiEpoch(2026, 9, 7, 8, 59))).toBe(false);
  });

  it('is off-peak on the weekend', () => {
    // 2026-09-05 is a Saturday.
    expect(isDeepSeekPeak(shanghaiEpoch(2026, 9, 5, 10, 0))).toBe(false);
  });
});
