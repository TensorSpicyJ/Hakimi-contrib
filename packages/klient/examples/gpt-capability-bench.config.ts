import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from './gpt-harness-bench.sandbox.js';
import type { BatchCaps } from './gpt-capability-bench.ledger.js';
import type { SuiteId } from './gpt-capability-bench.suites.js';

export interface Variant {
  id: string;
  adapter: 'hakimi';
  toolCatalog: boolean;
  /** User-prompt intervention, not an unimplemented system-prompt switch. */
  promptPrefix: string;
  contextPolicy: 'production' | 'compact-before-followup';
}
export const DEFAULT_VARIANTS: readonly Variant[] = [
  { id: 'baseline', adapter: 'hakimi', toolCatalog: false, promptPrefix: '', contextPolicy: 'production' },
  { id: 'catalog', adapter: 'hakimi', toolCatalog: true, promptPrefix: '', contextPolicy: 'production' },
];
export const PROFILES = {
  generous: { maxRequests: 60, maxObservedTokens: 1_200_000, timeoutMs: 900_000 },
  balanced: { maxRequests: 24, maxObservedTokens: 300_000, timeoutMs: 480_000 },
  tight: { maxRequests: 8, maxObservedTokens: 80_000, timeoutMs: 180_000 },
} as const;
export type Profile = keyof typeof PROFILES;
export interface Options {
  mode: 'dry-run' | 'selftest' | 'stub' | 'live';
  suite: SuiteId;
  model: string;
  effort: string;
  tasks?: string[];
  split: 'development' | 'acceptance' | 'all';
  repeats: number;
  seed: number;
  profiles: Profile[];
  variants: readonly Variant[];
  out: string;
  resume: boolean;
  smoke: boolean;
  authFile?: string;
  modelCatalog?: string;
  report?: string;
  caps?: BatchCaps;
}
function positive(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error('Expected a positive integer');
  return result;
}
export function validateVariants(value: unknown): readonly Variant[] {
  if (!Array.isArray(value) || value.length < 2) throw new Error('Variants require baseline and at least one candidate');
  for (const v of value as Variant[]) {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(v.id) || v.adapter !== 'hakimi' || typeof v.toolCatalog !== 'boolean' || typeof v.promptPrefix !== 'string' || !['production', 'compact-before-followup'].includes(v.contextPolicy)) throw new Error('Invalid or unimplemented variant');
    if (Object.keys(v).some((key) => !['id', 'adapter', 'toolCatalog', 'promptPrefix', 'contextPolicy'].includes(key))) throw new Error('Unknown variant setting; unimplemented flags cannot be silently accepted');
  }
  if (new Set(value.map((v: Variant) => v.id)).size !== value.length || value[0].id !== 'baseline') throw new Error('First variant must be baseline; ids must be unique');
  return value as Variant[];
}
export function parseArgs(args: readonly string[]): Options {
  const o: Options = { mode: 'dry-run', suite: 'v3', model: 'gpt-6-astra', effort: 'high', split: 'development', repeats: 4, seed: 20260927,
    profiles: ['generous'], variants: DEFAULT_VARIANTS, out: join(REPO_ROOT, '.tmp/hakimi-benchmark-v2', `run-${Date.now()}`), resume: false, smoke: false };
  const caps: Partial<BatchCaps> = {};
  let chosenMode: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--') continue;
    if (['--dry-run', '--selftest', '--stub', '--live'].includes(key)) {
      if (chosenMode !== undefined && chosenMode !== key) throw new Error('Choose one execution mode');
      chosenMode = key; o.mode = key.slice(2) as Options['mode']; continue;
    }
    if (key === '--resume') { o.resume = true; continue; }
    if (key === '--smoke') { o.smoke = true; continue; }
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} requires a value`);
    switch (key) {
      case '--suite': if (value !== 'v1' && value !== 'v2' && value !== 'v3') throw new Error('Unknown task suite'); o.suite = value; break;
      case '--tasks': o.tasks = value.split(','); break;
      case '--split': if (!['development', 'acceptance', 'all'].includes(value)) throw new Error('Unknown split'); o.split = value as Options['split']; break;
      case '--repeats': o.repeats = positive(value); break;
      case '--seed': o.seed = positive(value); break;
      case '--profiles': o.profiles = value.split(',') as Profile[]; if (o.profiles.some((p) => !Object.hasOwn(PROFILES, p))) throw new Error('Unknown budget profile'); break;
      case '--variants': o.variants = validateVariants(JSON.parse(readFileSync(resolve(REPO_ROOT, value), 'utf8'))); break;
      case '--out': o.out = resolve(REPO_ROOT, value); break;
      case '--auth-file': o.authFile = resolve(REPO_ROOT, value); break;
      case '--model-catalog': o.modelCatalog = resolve(REPO_ROOT, value); break;
      case '--report': o.report = resolve(REPO_ROOT, value); break;
      case '--batch-max-runs': caps.maxRuns = positive(value); break;
      case '--batch-max-requests': caps.maxRequests = positive(value); break;
      case '--batch-timeout-ms': caps.timeoutMs = positive(value); break;
      case '--batch-max-observed-tokens': caps.maxObservedTokens = positive(value); break;
      default: throw new Error(`Unknown option ${key}`);
    }
  }
  if (new Set(o.profiles).size !== o.profiles.length || o.tasks !== undefined && new Set(o.tasks).size !== o.tasks.length) throw new Error('Duplicate task/profile');
  if (o.smoke) o.repeats = 1;
  if (o.mode === 'live') {
    if (!caps.maxRuns || !caps.maxRequests || !caps.timeoutMs) throw new Error('--live requires explicit --batch-max-runs, --batch-max-requests, --batch-timeout-ms; task creation is not spend authorization');
    if (!o.authFile || !o.modelCatalog) throw new Error('--live requires host-only --auth-file and a frozen --model-catalog');
  }
  if (caps.maxRuns && caps.maxRequests && caps.timeoutMs) o.caps = { maxRuns: caps.maxRuns, maxRequests: caps.maxRequests, timeoutMs: caps.timeoutMs, maxObservedTokens: caps.maxObservedTokens ?? caps.maxRuns * Math.max(...o.profiles.map((p) => PROFILES[p].maxObservedTokens)) };
  else if (Object.keys(caps).length > 0) throw new Error('Supply all three batch caps together');
  return o;
}

/** Seeded Fisher-Yates blocks, rotating arm positions within each task. */
export function balancedOrder(tasks: readonly string[], variants: readonly string[], repeats: number, profiles: readonly string[], seed: number) {
  // The PRNG requires unsigned 32-bit coercion; Math.trunc is not equivalent.
  /* eslint-disable unicorn/prefer-math-trunc */
  let state = seed >>> 0;
  const random = () => { state += 0x6d2b79f5; let n = Math.imul(state ^ state >>> 15, state | 1); n ^= n + Math.imul(n ^ n >>> 7, n | 61); return ((n ^ n >>> 14) >>> 0) / 4294967296; };
  /* eslint-enable unicorn/prefer-math-trunc */
  const shuffled = [...tasks];
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]; }
  return shuffled.flatMap((taskId, taskIndex) => profiles.flatMap((budgetProfile) => Array.from({ length: repeats }, (_, repeat) => {
    const offset = (repeat + taskIndex) % variants.length;
    return variants.map((_, n) => ({ taskId, variant: variants[(n + offset) % variants.length]!, repeat, budgetProfile }));
  }).flat()));
}
