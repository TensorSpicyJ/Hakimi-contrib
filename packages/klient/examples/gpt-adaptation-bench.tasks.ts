/**
 * `gpt-adaptation-bench` frozen task set.
 *
 * The twelve task definitions, their synthetic fixture trees, and the
 * per-task negative fixture ("wrong") used to prove the hidden grader
 * discriminates. Everything here is synthetic: no real project, no user
 * file, no host instruction file is ever copied into an agent workspace.
 *
 * Two invariants hold for every task and are asserted by the offline
 * self-test:
 *   - `files` (pristine workspace) must FAIL the hidden grader;
 *   - `reference` (applied over `files`) must PASS the hidden grader;
 *   - `wrong` (applied over `files`) must FAIL the hidden grader.
 * A `visibleTamper` variant (pristine sources + trivially-passing visible
 * tests) must also FAIL, because grading never reads the agent-visible tests.
 *
 * This file is frozen before the production adapter change; the benchmark
 * manifest records its sha256. Do not tune tasks against observed scores.
 */

/** Behaviour class the task is meant to force through actual tool use. */
export type ExerciseTag =
  | 'cross-file-fix'
  | 'constrained-feature'
  | 'serial-dependent-calls'
  | 'multi-file-read'
  | 'fix-failing-test'
  | 'multi-turn-constraint'
  | 'resume-continue'
  | 'long-tool-result'
  | 'exact-output-contract'
  | 'refactor-constraint'
  | 'error-handling-edge'
  | 'parse-fix-with-test';

export interface BenchTask {
  readonly id: string;
  readonly title: string;
  readonly exercise: ExerciseTag;
  /** Refinement between the two arms: one hidden test file per task. */
  readonly graderFileName: string;
  /** Relative path -> file contents of the pristine agent workspace. */
  readonly files: Readonly<Record<string, string>>;
  /** The user turns, in order. Every turn is a real prompt. */
  readonly prompts: readonly string[];
  /** Close + restore the session between `prompts[resumeAfter]` and the next turn. */
  readonly resumeAfter?: number;
  /** Files the reference solution writes on top of `files` (may add files). */
  readonly reference: Readonly<Record<string, string>>;
  /** A plausible but incorrect solution; the grader must reject it. */
  readonly wrong: Readonly<Record<string, string>>;
  /** Hidden grader source; written outside the agent workspace, run at grading time. */
  readonly grader: string;
  /**
   * Optional exact assertions the scorer evaluates against the agent's files
   * (source-level constraints the hidden tests cannot see, e.g. "must not
   * leave the unsafe helper in place").
   */
  readonly exact?: readonly ExactCheck[];
}

export interface ExactCheck {
  readonly path: string;
  readonly mustMatch?: string;
  readonly mustNotMatch?: string;
  readonly label: string;
}

const VISIBLE_TEST_HEADER = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n`;

/** A visible test that always passes — used only by the tamper negative. */
export const TAMPERED_VISIBLE_TEST = `${VISIBLE_TEST_HEADER}\ntest('placeholder', () => {\n  assert.equal(1, 1);\n});\n`;

// ---------------------------------------------------------------------------
// T1 — locate and fix a cross-file pricing bug
// ---------------------------------------------------------------------------

const T1_FILES = {
  'package.json': '{\n  "name": "bench-t1",\n  "private": true,\n  "type": "module"\n}\n',
  'src/money.ts': `export function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export function formatCents(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}
`,
  'src/discount.ts': `import { roundCents } from './money.ts';

export function applyDiscount(subtotal: number, percentOff: number): number {
  if (percentOff < 0 || percentOff > 100) throw new RangeError('percentOff out of range');
  return roundCents(subtotal * (1 - percentOff));
}
`,
  'src/cart.ts': `import { applyDiscount } from './discount.ts';
import { roundCents } from './money.ts';

const TAX_RATE = 0.08;

/**
 * Total for a cart: tax is charged on the post-discount amount.
 */
export function cartTotal(subtotal: number, percentOff: number): number {
  const discounted = applyDiscount(subtotal, percentOff);
  return roundCents(discounted * (1 + TAX_RATE));
}
`,
  'test/cart.test.ts': `${VISIBLE_TEST_HEADER}import { cartTotal } from '../src/cart.ts';

test('total with no discount includes tax', () => {
  assert.equal(cartTotal(100, 0), 108);
});

test('total with a discount', () => {
  assert.equal(cartTotal(100, 10), 97.2);
});
`,
} as const;

const T1_REFERENCE = {
  'src/discount.ts': `import { roundCents } from './money.ts';

export function applyDiscount(subtotal: number, percentOff: number): number {
  if (percentOff < 0 || percentOff > 100) throw new RangeError('percentOff out of range');
  return roundCents(subtotal * (1 - percentOff / 100));
}
`,
} as const;

const T1_WRONG = {
  'src/discount.ts': `import { roundCents } from './money.ts';

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function applyDiscount(subtotal: number, percentOff: number): number {
  return roundCents(subtotal * (1 - clampPercent(percentOff)));
}
`,
} as const;

const T1_GRADER = `${VISIBLE_TEST_HEADER}import { cartTotal } from '../src/cart.ts';
import { applyDiscount } from '../src/discount.ts';

test('tax applies to the discounted amount', () => {
  assert.equal(cartTotal(100, 10), 97.2);
});

test('zero discount matches taxed subtotal', () => {
  assert.equal(cartTotal(250, 0), 270);
});

test('full discount yields zero', () => {
  assert.equal(cartTotal(100, 100), 0);
});

test('rounding stays at cents', () => {
  assert.equal(cartTotal(19.99, 25), 16.19);
});

test('discount helper keeps rejecting out-of-range input', () => {
  assert.throws(() => applyDiscount(10, 101), RangeError);
});
`;

// ---------------------------------------------------------------------------
// T2 — implement a feature under explicit constraints
// ---------------------------------------------------------------------------

const T2_FILES = {
  'package.json': '{\n  "name": "bench-t2",\n  "private": true,\n  "type": "module"\n}\n',
  'src/text.ts': `/** Truncate in the middle, keeping the head and the tail. */
export function truncateMiddle(_input: string, _maxLength: number): string {
  throw new Error('not implemented');
}
`,
  'test/text.test.ts': `${VISIBLE_TEST_HEADER}import { truncateMiddle } from '../src/text.ts';

test('short input is returned unchanged', () => {
  assert.equal(truncateMiddle('abc', 10), 'abc');
});
`,
} as const;

const T2_REFERENCE = {
  'src/text.ts': `const ELLIPSIS = '...';

/** Truncate in the middle, keeping the head and the tail. */
export function truncateMiddle(input: string, maxLength: number): string {
  if (!Number.isInteger(maxLength) || maxLength < 0) throw new RangeError('maxLength must be a non-negative integer');
  if (input.length <= maxLength) return input;
  if (maxLength <= ELLIPSIS.length) return ELLIPSIS.slice(0, maxLength);
  const keep = maxLength - ELLIPSIS.length;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return input.slice(0, head) + ELLIPSIS + (tail > 0 ? input.slice(input.length - tail) : '');
}
`,
} as const;

const T2_WRONG = {
  'src/text.ts': `/** Truncate in the middle, keeping the head and the tail. */
export function truncateMiddle(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  return input.slice(0, maxLength - 3) + '...';
}
`,
} as const;

const T2_GRADER = `${VISIBLE_TEST_HEADER}import { truncateMiddle } from '../src/text.ts';

test('short input unchanged', () => {
  assert.equal(truncateMiddle('abc', 3), 'abc');
  assert.equal(truncateMiddle('', 0), '');
});

test('long input keeps head and tail', () => {
  assert.equal(truncateMiddle('abcdefghij', 7), 'ab...ij');
});

test('result length never exceeds the budget', () => {
  for (const max of [4, 5, 6, 7, 8, 9]) {
    assert.ok(truncateMiddle('abcdefghijklmno', max).length <= max);
  }
});

test('budgets smaller than the ellipsis degrade gracefully', () => {
  assert.equal(truncateMiddle('abcdef', 2), '..');
  assert.equal(truncateMiddle('abcdef', 0), '');
});

test('invalid budget is rejected', () => {
  assert.throws(() => truncateMiddle('abc', -1), RangeError);
  assert.throws(() => truncateMiddle('abc', 1.5), RangeError);
});
`;

// ---------------------------------------------------------------------------
// T3 — serial dependent tool calls (read a spec, then wire it up)
// ---------------------------------------------------------------------------

const T3_FILES = {
  'package.json': '{\n  "name": "bench-t3",\n  "private": true,\n  "type": "module"\n}\n',
  'docs/config-spec.md': `# Config spec

Keys and defaults:

- \`retries\` (integer, default 3, minimum 0)
- \`timeoutMs\` (integer, default 1000, minimum 1)
- \`baseUrl\` (string, default "http://127.0.0.1", must start with "http")

Unknown keys are ignored. \`parseConfig\` returns the resolved record.
`,
  'src/config.ts': `export interface BenchConfig {
  retries: number;
  timeoutMs: number;
  baseUrl: string;
}

export function parseConfig(_raw: Record<string, unknown>): BenchConfig {
  throw new Error('not implemented');
}
`,
  'test/config.test.ts': `${VISIBLE_TEST_HEADER}import { parseConfig } from '../src/config.ts';

test('defaults apply', () => {
  assert.deepEqual(parseConfig({}), { retries: 3, timeoutMs: 1000, baseUrl: 'http://127.0.0.1' });
});
`,
} as const;

const T3_REFERENCE = {
  'src/config.ts': `export interface BenchConfig {
  retries: number;
  timeoutMs: number;
  baseUrl: string;
}

const DEFAULTS: BenchConfig = { retries: 3, timeoutMs: 1000, baseUrl: 'http://127.0.0.1' };

function readInt(raw: Record<string, unknown>, key: string, fallback: number, min: number): number {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new RangeError(\`\${key} must be an integer >= \${String(min)}\`);
  }
  return value;
}

export function parseConfig(raw: Record<string, unknown>): BenchConfig {
  const baseUrl = raw['baseUrl'];
  if (baseUrl !== undefined && (typeof baseUrl !== 'string' || !baseUrl.startsWith('http'))) {
    throw new RangeError('baseUrl must be a string starting with "http"');
  }
  return {
    retries: readInt(raw, 'retries', DEFAULTS.retries, 0),
    timeoutMs: readInt(raw, 'timeoutMs', DEFAULTS.timeoutMs, 1),
    baseUrl: typeof baseUrl === 'string' ? baseUrl : DEFAULTS.baseUrl,
  };
}
`,
} as const;

const T3_WRONG = {
  'src/config.ts': `export interface BenchConfig {
  retries: number;
  timeoutMs: number;
  baseUrl: string;
}

export function parseConfig(raw: Record<string, unknown>): BenchConfig {
  return {
    retries: (raw['retries'] as number | undefined) ?? 3,
    timeoutMs: (raw['timeoutMs'] as number | undefined) ?? 1000,
    baseUrl: (raw['baseUrl'] as string | undefined) ?? 'http://127.0.0.1',
  };
}
`,
} as const;

const T3_GRADER = `${VISIBLE_TEST_HEADER}import { parseConfig } from '../src/config.ts';

test('documented defaults', () => {
  assert.deepEqual(parseConfig({}), { retries: 3, timeoutMs: 1000, baseUrl: 'http://127.0.0.1' });
});

test('explicit values win', () => {
  assert.deepEqual(parseConfig({ retries: 0, timeoutMs: 25, baseUrl: 'https://example.test' }), {
    retries: 0,
    timeoutMs: 25,
    baseUrl: 'https://example.test',
  });
});

test('documented minimums are enforced', () => {
  assert.throws(() => parseConfig({ retries: -1 }), RangeError);
  assert.throws(() => parseConfig({ timeoutMs: 0 }), RangeError);
  assert.throws(() => parseConfig({ retries: 1.5 }), RangeError);
});

test('baseUrl must be http(s)', () => {
  assert.throws(() => parseConfig({ baseUrl: 'ftp://example.test' }), RangeError);
});

test('unknown keys are ignored', () => {
  assert.deepEqual(parseConfig({ extra: true, retries: 1 }), {
    retries: 1,
    timeoutMs: 1000,
    baseUrl: 'http://127.0.0.1',
  });
});
`;

// ---------------------------------------------------------------------------
// T4 — multi-file read before writing a summary
// ---------------------------------------------------------------------------

const T4_FILES = {
  'package.json': '{\n  "name": "bench-t4",\n  "private": true,\n  "type": "module"\n}\n',
  'src/plans/free.ts': 'export const FREE = { name: "free", seats: 1, monthlyCents: 0 } as const;\n',
  'src/plans/team.ts': 'export const TEAM = { name: "team", seats: 25, monthlyCents: 4900 } as const;\n',
  'src/plans/enterprise.ts':
    'export const ENTERPRISE = { name: "enterprise", seats: 500, monthlyCents: 49900 } as const;\n',
  'src/summary.ts': `export function summarizePlans(): string {
  throw new Error('not implemented');
}
`,
  'test/summary.test.ts': `${VISIBLE_TEST_HEADER}import { summarizePlans } from '../src/summary.ts';

test('summary mentions every plan', () => {
  const out = summarizePlans();
  assert.ok(out.includes('free'));
});
`,
} as const;

const T4_REFERENCE = {
  'src/summary.ts': `import { ENTERPRISE } from './plans/enterprise.ts';
import { FREE } from './plans/free.ts';
import { TEAM } from './plans/team.ts';

const PLANS = [FREE, TEAM, ENTERPRISE];

/** One line per plan, in the order free, team, enterprise. */
export function summarizePlans(): string {
  return PLANS.map(
    (plan) => \`\${plan.name}: \${String(plan.seats)} seats, \${(plan.monthlyCents / 100).toFixed(2)}/mo\`,
  ).join('\\n');
}
`,
} as const;

const T4_WRONG = {
  'src/summary.ts': `import { FREE } from './plans/free.ts';

/** One line per plan. */
export function summarizePlans(): string {
  return \`\${FREE.name}: \${String(FREE.seats)} seats\`;
}
`,
} as const;

const T4_GRADER = `${VISIBLE_TEST_HEADER}import { summarizePlans } from '../src/summary.ts';

test('one line per plan in the documented order', () => {
  assert.equal(
    summarizePlans(),
    ['free: 1 seats, 0.00/mo', 'team: 25 seats, 49.00/mo', 'enterprise: 500 seats, 499.00/mo'].join('\\n'),
  );
});
`;

// ---------------------------------------------------------------------------
// T5 — a failing visible test must be diagnosed and the source fixed
// ---------------------------------------------------------------------------

const T5_FILES = {
  'package.json': '{\n  "name": "bench-t5",\n  "private": true,\n  "type": "module"\n}\n',
  'src/range.ts': `/** Inclusive integer range [start, end]. */
export function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let value = start; value < end; value += 1) out.push(value);
  return out;
}
`,
  'src/stats.ts': `import { range } from './range.ts';

export function sumTo(n: number): number {
  return range(1, n).reduce((acc, value) => acc + value, 0);
}
`,
  'test/stats.test.ts': `${VISIBLE_TEST_HEADER}import { sumTo } from '../src/stats.ts';

test('sumTo is inclusive of n', () => {
  assert.equal(sumTo(5), 15);
});
`,
} as const;

const T5_REFERENCE = {
  'src/range.ts': `/** Inclusive integer range [start, end]. */
export function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let value = start; value <= end; value += 1) out.push(value);
  return out;
}
`,
} as const;

const T5_WRONG = {
  'src/stats.ts': `import { range } from './range.ts';

export function sumTo(n: number): number {
  return range(1, n).reduce((acc, value) => acc + value, 0) + n;
}
`,
} as const;

const T5_GRADER = `${VISIBLE_TEST_HEADER}import { sumTo } from '../src/stats.ts';
import { range } from '../src/range.ts';

test('sumTo is inclusive', () => {
  assert.equal(sumTo(5), 15);
  assert.equal(sumTo(1), 1);
  assert.equal(sumTo(0), 0);
});

test('range is inclusive on both ends and empty when reversed', () => {
  assert.deepEqual(range(1, 3), [1, 2, 3]);
  assert.deepEqual(range(3, 1), []);
});
`;

// ---------------------------------------------------------------------------
// T6 — multi-turn: implement, then absorb an added constraint
// ---------------------------------------------------------------------------

const T6_FILES = {
  'package.json': '{\n  "name": "bench-t6",\n  "private": true,\n  "type": "module"\n}\n',
  'src/slug.ts': `export function slugify(_input: string): string {
  throw new Error('not implemented');
}
`,
  'test/slug.test.ts': `${VISIBLE_TEST_HEADER}import { slugify } from '../src/slug.ts';

test('lowercases and joins words', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});
`,
} as const;

const T6_REFERENCE = {
  'src/slug.ts': `/** Lowercase, dash-joined slug. Returns 'untitled' for input with no usable characters. */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return slug === '' ? 'untitled' : slug;
}
`,
} as const;

const T6_WRONG = {
  'src/slug.ts': `/** Lowercase, dash-joined slug. */
export function slugify(input: string): string {
  return input.toLowerCase().replaceAll(' ', '-');
}
`,
} as const;

const T6_GRADER = `${VISIBLE_TEST_HEADER}import { slugify } from '../src/slug.ts';

test('words are dash-joined and lowercased', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('punctuation collapses into single dashes', () => {
  assert.equal(slugify('Hello,   World!!'), 'hello-world');
});

test('leading and trailing separators are trimmed', () => {
  assert.equal(slugify('  --Hello--  '), 'hello');
});

test('added constraint: empty slugs fall back to untitled', () => {
  assert.equal(slugify('!!!'), 'untitled');
  assert.equal(slugify(''), 'untitled');
});
`;

// ---------------------------------------------------------------------------
// T7 — session save/dispose/resume, then continue
// ---------------------------------------------------------------------------

const T7_FILES = {
  'package.json': '{\n  "name": "bench-t7",\n  "private": true,\n  "type": "module"\n}\n',
  'src/ledger.ts': `export interface Entry {
  readonly account: string;
  readonly amountCents: number;
}

/** Running balance per account. Positive amounts are debits. */
export function balances(_entries: readonly Entry[]): Record<string, number> {
  throw new Error('not implemented');
}
`,
  'src/report.ts': `import { balances, type Entry } from './ledger.ts';

export function report(_entries: readonly Entry[]): string {
  throw new Error('not implemented');
}
`,
  'test/report.test.ts': `${VISIBLE_TEST_HEADER}import { balances } from '../src/ledger.ts';

test('balances accumulate per account', () => {
  assert.deepEqual(balances([{ account: 'a', amountCents: 100 }]), { a: 100 });
});
`,
} as const;

const T7_REFERENCE = {
  'src/ledger.ts': `export interface Entry {
  readonly account: string;
  readonly amountCents: number;
}

/** Running balance per account. Positive amounts are debits. */
export function balances(entries: readonly Entry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of entries) out[entry.account] = (out[entry.account] ?? 0) + entry.amountCents;
  return out;
}
`,
  'src/report.ts': `import { balances, type Entry } from './ledger.ts';

/** One line per account, sorted by account id, amount rendered in cents. */
export function report(entries: readonly Entry[]): string {
  return Object.entries(balances(entries))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([account, cents]) => \`\${account}=\${String(cents)}\`)
    .join(',');
}
`,
} as const;

const T7_WRONG = {
  'src/report.ts': `import { balances, type Entry } from './ledger.ts';

export function report(entries: readonly Entry[]): string {
  return Object.entries(balances(entries))
    .map(([account, cents]) => \`\${account}=\${String(cents)}\`)
    .join(',');
}
`,
} as const;

const T7_GRADER = `${VISIBLE_TEST_HEADER}import { balances } from '../src/ledger.ts';
import { report } from '../src/report.ts';

test('balances accumulate', () => {
  assert.deepEqual(
    balances([
      { account: 'b', amountCents: 5 },
      { account: 'a', amountCents: 2 },
      { account: 'b', amountCents: -1 },
    ]),
    { b: 4, a: 2 },
  );
});

test('report sorts by account and survives the resume boundary', () => {
  assert.equal(
    report([
      { account: 'b', amountCents: 5 },
      { account: 'a', amountCents: 2 },
    ]),
    'a=2,b=5',
  );
  assert.equal(report([]), '');
});
`;

// ---------------------------------------------------------------------------
// T8 — read a long data file, then produce the exact aggregate
// ---------------------------------------------------------------------------

const T8_ROWS = Array.from({ length: 240 }, (_, index) => {
  const region = ['north', 'south', 'east', 'west'][index % 4] as string;
  return `${String(index + 1)},${region},${String((index * 7) % 50)}`;
}).join('\n');

const T8_FILES = {
  'package.json': '{\n  "name": "bench-t8",\n  "private": true,\n  "type": "module"\n}\n',
  'data/sales.csv': `id,region,units\n${T8_ROWS}\n`,
  'src/aggregate.ts': `export function unitsByRegion(_csv: string): Record<string, number> {
  throw new Error('not implemented');
}
`,
  'test/aggregate.test.ts': `${VISIBLE_TEST_HEADER}import { unitsByRegion } from '../src/aggregate.ts';

test('returns a record', () => {
  assert.equal(typeof unitsByRegion('id,region,units\\n1,north,2\\n'), 'object');
});
`,
} as const;

const T8_REFERENCE = {
  'src/aggregate.ts': `/** Sum \`units\` per \`region\` from a CSV with header id,region,units. */
export function unitsByRegion(csv: string): Record<string, number> {
  const lines = csv.trim().split('\\n');
  const header = lines[0]?.split(',') ?? [];
  const regionIndex = header.indexOf('region');
  const unitsIndex = header.indexOf('units');
  if (regionIndex < 0 || unitsIndex < 0) throw new Error('csv must have region and units columns');
  const out: Record<string, number> = {};
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const region = cells[regionIndex];
    const units = Number(cells[unitsIndex]);
    if (region === undefined || Number.isNaN(units)) continue;
    out[region] = (out[region] ?? 0) + units;
  }
  return out;
}
`,
} as const;

const T8_WRONG = {
  'src/aggregate.ts': `/** Count rows per region (not the requested sum of units). */
export function unitsByRegion(csv: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of csv.trim().split('\\n').slice(1)) {
    const region = line.split(',')[1];
    if (region === undefined) continue;
    out[region] = (out[region] ?? 0) + 1;
  }
  return out;
}
`,
} as const;

const T8_EXPECTED = (() => {
  const totals: Record<string, number> = {};
  for (let index = 0; index < 240; index += 1) {
    const region = ['north', 'south', 'east', 'west'][index % 4] as string;
    totals[region] = (totals[region] ?? 0) + ((index * 7) % 50);
  }
  return totals;
})();

const T8_GRADER = `${VISIBLE_TEST_HEADER}import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { unitsByRegion } from '../src/aggregate.ts';

const here = dirname(fileURLToPath(import.meta.url));

test('aggregates the full long fixture', () => {
  const csv = readFileSync(join(here, '..', 'data', 'sales.csv'), 'utf8');
  assert.deepEqual(unitsByRegion(csv), ${JSON.stringify(T8_EXPECTED)});
});

test('aggregates a small inline fixture', () => {
  assert.deepEqual(unitsByRegion('id,region,units\\n1,north,2\\n2,north,3\\n3,south,4\\n'), {
    north: 5,
    south: 4,
  });
});

test('rejects a csv without the required columns', () => {
  assert.throws(() => unitsByRegion('id,city\\n1,berlin\\n'), Error);
});
`;

// ---------------------------------------------------------------------------
// T9 — exact output contract
// ---------------------------------------------------------------------------

const T9_FILES = {
  'package.json': '{\n  "name": "bench-t9",\n  "private": true,\n  "type": "module"\n}\n',
  'src/duration.ts': `/** Render milliseconds as a fixed-width clock string: "1h 02m 03s" / "02m 03s" / "03s". */
export function formatDuration(_ms: number): string {
  throw new Error('not implemented');
}
`,
  'test/duration.test.ts': `${VISIBLE_TEST_HEADER}import { formatDuration } from '../src/duration.ts';

test('seconds only', () => {
  assert.equal(formatDuration(3000), '03s');
});
`,
} as const;

const T9_REFERENCE = {
  'src/duration.ts': `const pad = (value: number): string => String(value).padStart(2, '0');

/** Render milliseconds as a fixed-width clock string: "1h 02m 03s" / "02m 03s" / "03s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError('ms must be a non-negative finite number');
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return \`\${String(hours)}h \${pad(minutes)}m \${pad(seconds)}s\`;
  if (minutes > 0) return \`\${pad(minutes)}m \${pad(seconds)}s\`;
  return \`\${pad(seconds)}s\`;
}
`,
} as const;

const T9_WRONG = {
  'src/duration.ts': `/** Render milliseconds as a clock string. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return \`\${String(minutes)}m \${String(seconds)}s\`;
  return \`\${String(seconds)}s\`;
}
`,
} as const;

const T9_GRADER = `${VISIBLE_TEST_HEADER}import { formatDuration } from '../src/duration.ts';

test('exact rendering at every magnitude', () => {
  assert.equal(formatDuration(0), '00s');
  assert.equal(formatDuration(3000), '03s');
  assert.equal(formatDuration(59_999), '59s');
  assert.equal(formatDuration(60_000), '01m 00s');
  assert.equal(formatDuration(3_723_000), '1h 02m 03s');
});

test('sub-second remainders floor', () => {
  assert.equal(formatDuration(1999), '01s');
});

test('invalid input is rejected', () => {
  assert.throws(() => formatDuration(-1), RangeError);
  assert.throws(() => formatDuration(Number.POSITIVE_INFINITY), RangeError);
});
`;

// ---------------------------------------------------------------------------
// T10 — refactor under a constraint (no unsafe helper left behind)
// ---------------------------------------------------------------------------

const T10_FILES = {
  'package.json': '{\n  "name": "bench-t10",\n  "private": true,\n  "type": "module"\n}\n',
  'src/legacy.ts': `/* eslint-disable */
export function unsafeCast(value: unknown): number {
  return value as number;
}
`,
  'src/total.ts': `import { unsafeCast } from './legacy.ts';

export function total(values: readonly unknown[]): number {
  let sum = 0;
  for (const value of values) sum += unsafeCast(value);
  return sum;
}
`,
  'test/total.test.ts': `${VISIBLE_TEST_HEADER}import { total } from '../src/total.ts';

test('sums numbers', () => {
  assert.equal(total([1, 2, 3]), 6);
});
`,
} as const;

const T10_REFERENCE = {
  'src/total.ts': `export function total(values: readonly unknown[]): number {
  let sum = 0;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError('total only accepts finite numbers');
    }
    sum += value;
  }
  return sum;
}
`,
} as const;

const T10_WRONG = {
  'src/total.ts': `import { unsafeCast } from './legacy.ts';

export function total(values: readonly unknown[]): number {
  let sum = 0;
  for (const value of values) {
    const parsed = unsafeCast(value);
    if (typeof parsed !== 'number') continue;
    sum += parsed;
  }
  return sum;
}
`,
} as const;

const T10_GRADER = `${VISIBLE_TEST_HEADER}import { total } from '../src/total.ts';

test('sums finite numbers', () => {
  assert.equal(total([1, 2, 3]), 6);
  assert.equal(total([]), 0);
  assert.equal(total([1.5, -0.5]), 1);
});

test('non-numeric input is rejected instead of silently skipped or coerced', () => {
  assert.throws(() => total([1, '2']), TypeError);
  assert.throws(() => total([Number.NaN]), TypeError);
  assert.throws(() => total([Number.POSITIVE_INFINITY]), TypeError);
});
`;

const T10_EXACT: readonly ExactCheck[] = [
  { path: 'src/total.ts', mustNotMatch: 'unsafeCast', label: 'total no longer imports the unsafe cast helper' },
  { path: 'src/total.ts', mustNotMatch: 'as number', label: 'no unchecked numeric cast remains' },
];

// ---------------------------------------------------------------------------
// T11 — typed error handling on an edge case
// ---------------------------------------------------------------------------

const T11_FILES = {
  'package.json': '{\n  "name": "bench-t11",\n  "private": true,\n  "type": "module"\n}\n',
  'src/queue.ts': `export class Queue<T> {
  private readonly items: T[] = [];

  push(item: T): void {
    this.items.push(item);
  }

  pop(): T | undefined {
    return this.items.shift();
  }

  get size(): number {
    return this.items.length;
  }
}
`,
  'src/worker.ts': `import { Queue } from './queue.ts';

export function drain<T>(queue: Queue<T>, limit: number): T[] {
  const out: T[] = [];
  for (let index = 0; index < limit; index += 1) out.push(queue.pop() as T);
  return out;
}
`,
  'test/worker.test.ts': `${VISIBLE_TEST_HEADER}import { Queue } from '../src/queue.ts';
import { drain } from '../src/worker.ts';

test('drain respects the limit', () => {
  const queue = new Queue<number>();
  queue.push(1);
  queue.push(2);
  assert.deepEqual(drain(queue, 1), [1]);
});
`,
} as const;

const T11_REFERENCE = {
  'src/worker.ts': `import { Queue } from './queue.ts';

/** Drain at most \`limit\` items; never emits \`undefined\` for an empty queue. */
export function drain<T>(queue: Queue<T>, limit: number): T[] {
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError('limit must be a non-negative integer');
  const out: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    const item = queue.pop();
    if (item === undefined) break;
    out.push(item);
  }
  return out;
}
`,
} as const;

const T11_WRONG = {
  'src/worker.ts': `import { Queue } from './queue.ts';

export function drain<T>(queue: Queue<T>, limit: number): T[] {
  const out: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    const item = queue.pop();
    if (item !== undefined) out.push(item);
    else out.push(null as unknown as T);
  }
  return out;
}
`,
} as const;

const T11_GRADER = `${VISIBLE_TEST_HEADER}import { Queue } from '../src/queue.ts';
import { drain } from '../src/worker.ts';

test('drains up to the limit', () => {
  const queue = new Queue<number>();
  queue.push(1);
  queue.push(2);
  queue.push(3);
  assert.deepEqual(drain(queue, 2), [1, 2]);
  assert.equal(queue.size, 1);
});

test('an empty queue yields an empty batch, not undefined holes', () => {
  const queue = new Queue<string>();
  assert.deepEqual(drain(queue, 5), []);
});

test('draining fewer items than the limit stops early', () => {
  const queue = new Queue<number>();
  queue.push(7);
  assert.deepEqual(drain(queue, 10), [7]);
});

test('an invalid limit is rejected', () => {
  assert.throws(() => drain(new Queue<number>(), -1), RangeError);
});
`;

// ---------------------------------------------------------------------------
// T12 — parser bug fix, verified through the workspace test command
// ---------------------------------------------------------------------------

const T12_FILES = {
  'package.json': '{\n  "name": "bench-t12",\n  "private": true,\n  "type": "module"\n}\n',
  'src/kv.ts': `/** Parse "a=1;b=2" into a record. Values may contain '='. */
export function parsePairs(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const chunk of input.split(';')) {
    const separator = chunk.indexOf('=');
    if (separator <= 0) continue;
    out[chunk.slice(0, separator)] = chunk.slice(separator + 1);
  }
  return out;
}
`,
  'src/env.ts': `import { parsePairs } from './kv.ts';

/** Resolve \`$name\` references against earlier keys, left to right. */
export function resolveEnv(input: string): Record<string, string> {
  const raw = parsePairs(input);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = value.replaceAll(/\\$(\\w+)/g, (_, name: string) => out[name] ?? '');
  }
  return out;
}
`,
  'test/env.test.ts': `${VISIBLE_TEST_HEADER}import { parsePairs } from '../src/kv.ts';
import { resolveEnv } from '../src/env.ts';

test('parsePairs handles simple input', () => {
  assert.deepEqual(parsePairs('a=1;b=2'), { a: '1', b: '2' });
});

test('resolveEnv expands earlier keys', () => {
  assert.deepEqual(resolveEnv('host=example;url=http://$host/x'), {
    host: 'example',
    url: 'http://example/x',
  });
});
`,
} as const;

const T12_REFERENCE = {
  'src/kv.ts': `/** Parse "a=1;b=2" into a record. Values may contain '='; empty keys are skipped. */
export function parsePairs(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const chunk of input.split(';')) {
    const trimmed = chunk.trim();
    if (trimmed === '') continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    out[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return out;
}
`,
} as const;

const T12_WRONG = {
  'src/kv.ts': `/** Parse "a=1;b=2" into a record. */
export function parsePairs(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const chunk of input.split(';')) {
    const [key, ...rest] = chunk.split('=');
    if (key === undefined || rest.length === 0) continue;
    out[key] = rest.join('=');
  }
  return out;
}
`,
} as const;

const T12_GRADER = `${VISIBLE_TEST_HEADER}import { parsePairs } from '../src/kv.ts';
import { resolveEnv } from '../src/env.ts';

test('values may contain equals signs', () => {
  assert.deepEqual(parsePairs('token=a=b=c'), { token: 'a=b=c' });
});

test('surrounding whitespace is trimmed', () => {
  assert.deepEqual(parsePairs(' a = 1 ; b = 2 '), { a: '1', b: '2' });
});

test('empty chunks and empty keys are skipped', () => {
  assert.deepEqual(parsePairs(';;=oops;a=1;'), { a: '1' });
});

test('resolveEnv expands references left to right', () => {
  assert.deepEqual(resolveEnv('host=example.test; url=http://$host/x; bare=$missing'), {
    host: 'example.test',
    url: 'http://example.test/x',
    bare: '',
  });
});
`;

// ---------------------------------------------------------------------------
// The frozen twelve
// ---------------------------------------------------------------------------

export const BENCH_TASKS: readonly BenchTask[] = [
  {
    id: 'T01-cross-file-fix',
    title: 'Fix the cart total so tax applies after the discount',
    exercise: 'cross-file-fix',
    graderFileName: 'grader.test.ts',
    files: T1_FILES,
    prompts: [
      'The cart total in src/cart.ts is wrong. Read the pricing modules, find the bug, fix it, then run the tests.',
    ],
    reference: T1_REFERENCE,
    wrong: T1_WRONG,
    grader: T1_GRADER,
  },
  {
    id: 'T02-constrained-feature',
    title: 'Implement middle truncation under an exact length budget',
    exercise: 'constrained-feature',
    graderFileName: 'grader.test.ts',
    files: T2_FILES,
    prompts: [
      'Implement truncateMiddle in src/text.ts. It must keep the head and the tail of the input, always return a string no longer than maxLength, and reject invalid budgets with a RangeError. Run the tests when done.',
    ],
    reference: T2_REFERENCE,
    wrong: T2_WRONG,
    grader: T2_GRADER,
  },
  {
    id: 'T03-serial-dependent-calls',
    title: 'Implement parseConfig from the written spec',
    exercise: 'serial-dependent-calls',
    graderFileName: 'grader.test.ts',
    files: T3_FILES,
    prompts: [
      'Read docs/config-spec.md, then implement parseConfig in src/config.ts exactly as specified and run the tests.',
    ],
    reference: T3_REFERENCE,
    wrong: T3_WRONG,
    grader: T3_GRADER,
  },
  {
    id: 'T04-multi-file-read',
    title: 'Summarize three plan modules',
    exercise: 'multi-file-read',
    graderFileName: 'grader.test.ts',
    files: T4_FILES,
    prompts: [
      'Read every module under src/plans and implement summarizePlans in src/summary.ts: one line per plan, in the order free, team, enterprise, formatted "<name>: <seats> seats, <price>/mo" with two decimals.',
    ],
    reference: T4_REFERENCE,
    wrong: T4_WRONG,
    grader: T4_GRADER,
  },
  {
    id: 'T05-fix-failing-test',
    title: 'Diagnose and fix the failing range-based test',
    exercise: 'fix-failing-test',
    graderFileName: 'grader.test.ts',
    files: T5_FILES,
    prompts: [
      'A test in this project fails. Run the tests, find the cause, fix it properly, and make the suite pass again.',
    ],
    reference: T5_REFERENCE,
    wrong: T5_WRONG,
    grader: T5_GRADER,
  },
  {
    id: 'T06-multi-turn-constraint',
    title: 'Build slugify, then absorb a follow-up constraint',
    exercise: 'multi-turn-constraint',
    graderFileName: 'grader.test.ts',
    files: T6_FILES,
    prompts: [
      'Implement slugify in src/slug.ts: lowercase, dash-joined, surrounding separators trimmed. Run the tests.',
      'New constraint: when the input produces an empty slug, the function must return "untitled" instead of an empty string. Update the implementation and run the tests again.',
    ],
    reference: T6_REFERENCE,
    wrong: T6_WRONG,
    grader: T6_GRADER,
  },
  {
    id: 'T07-resume-continue',
    title: 'Implement the ledger, then continue after a session resume',
    exercise: 'resume-continue',
    graderFileName: 'grader.test.ts',
    files: T7_FILES,
    prompts: [
      'Implement balances in src/ledger.ts: sum amountCents per account, positive amounts are debits. Run the tests.',
      'Continue from the previous turn: now implement report in src/report.ts as "<account>=<cents>" joined by commas and sorted by account id. Run the tests.',
    ],
    resumeAfter: 0,
    reference: T7_REFERENCE,
    wrong: T7_WRONG,
    grader: T7_GRADER,
  },
  {
    id: 'T08-long-tool-result',
    title: 'Aggregate a long CSV without losing rows',
    exercise: 'long-tool-result',
    graderFileName: 'grader.test.ts',
    files: T8_FILES,
    prompts: [
      'Implement unitsByRegion in src/aggregate.ts: sum the units column per region from the CSV header id,region,units. data/sales.csv is long — make sure the full file is accounted for. Run the tests.',
    ],
    reference: T8_REFERENCE,
    wrong: T8_WRONG,
    grader: T8_GRADER,
  },
  {
    id: 'T09-exact-output-contract',
    title: 'Match an exact duration rendering contract',
    exercise: 'exact-output-contract',
    graderFileName: 'grader.test.ts',
    files: T9_FILES,
    prompts: [
      'Implement formatDuration in src/duration.ts. The output must be exactly "1h 02m 03s", "02m 03s" or "03s" (two-digit minutes and seconds, hours unpadded, hours omitted when zero, minutes omitted when zero and hours are zero). Invalid input throws RangeError. Run the tests.',
    ],
    reference: T9_REFERENCE,
    wrong: T9_WRONG,
    grader: T9_GRADER,
  },
  {
    id: 'T10-refactor-constraint',
    title: 'Remove the unsafe cast while keeping the public behaviour',
    exercise: 'refactor-constraint',
    graderFileName: 'grader.test.ts',
    files: T10_FILES,
    prompts: [
      'Refactor src/total.ts so it validates its inputs instead of relying on the unchecked cast in src/legacy.ts. total must keep summing finite numbers, and it must throw a TypeError for anything that is not a finite number. Do not change the exported signature, and run the tests.',
    ],
    reference: T10_REFERENCE,
    wrong: T10_WRONG,
    grader: T10_GRADER,
    exact: T10_EXACT,
  },
  {
    id: 'T11-error-handling-edge',
    title: 'Stop draining undefined holes out of the queue',
    exercise: 'error-handling-edge',
    graderFileName: 'grader.test.ts',
    files: T11_FILES,
    prompts: [
      'drain() in src/worker.ts is unsafe: it pushes undefined when the queue runs dry. Make it stop early instead, reject invalid limits with a RangeError, and run the tests.',
    ],
    reference: T11_REFERENCE,
    wrong: T11_WRONG,
    grader: T11_GRADER,
  },
  {
    id: 'T12-parse-fix-with-test',
    title: 'Fix the key/value parser and prove it through the test command',
    exercise: 'parse-fix-with-test',
    graderFileName: 'grader.test.ts',
    files: T12_FILES,
    prompts: [
      'parsePairs in src/kv.ts mishandles whitespace, empty chunks and values that contain "=". Fix it (and only it) so resolveEnv keeps working, then run the tests until they pass.',
    ],
    reference: T12_REFERENCE,
    wrong: T12_WRONG,
    grader: T12_GRADER,
  },
];

export const BENCH_TASK_SET_ID = 'gpt-adaptation-bench/tasks@1';

/** Workspace-relative paths the agent may touch; nothing else is exposed by the tools. */
export const BENCH_WORKSPACE_ALLOWED_TOOLS = [
  'bench_list_files',
  'bench_read_file',
  'bench_write_file',
  'bench_run_tests',
] as const;

export function findTask(id: string): BenchTask {
  const task = BENCH_TASKS.find((candidate) => candidate.id === id);
  if (task === undefined) throw new Error(`unknown bench task: ${id}`);
  return task;
}

/** Files that make the pristine workspace (initial state). */
export function taskWorkspaceFiles(task: BenchTask): Record<string, string> {
  return { ...task.files };
}

/** Visible test paths shipped inside the agent workspace. */
export function taskVisibleTests(task: BenchTask): readonly string[] {
  return Object.keys(task.files).filter((path) => path.startsWith('test/') || path.endsWith('.test.ts'));
}
