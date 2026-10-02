/**
 * `gpt-adaptation-bench` orchestrator.
 *
 * Freeze the experiment, then run it:
 *
 *   --dry-run    (default) validate the frozen manifest, print the exact run
 *                order and the request budget. No network, no credentials.
 *   --stub       the offline plan. Every arm serves its own deterministic
 *                Responses fixture on loopback (no HTTP leaves the process),
 *                the real engine loop/tools/persistence/grader run, and the
 *                arm's own fixture backend refuses any request beyond the
 *                turn budget. Produces `offline` artifacts only.
 *   --live       the measured runs. Uses the engine's own managed OAuth on an
 *                operator-provided auth home; the benchmark's own home,
 *                session store, index and logs stay isolated per run. Every
 *                request is ticketed before dispatch (hard per-run and global
 *                caps) and only redacted, derived facts are stored.
 *   --preflight  availability probe (one request per arm root).
 *   --report     read-only rebuild of a finished run directory.
 *
 * Each run executes in its own subprocess that loads exactly one engine source
 * tree through the arm loader (baseline / candidate / ablation can never share
 * a module), with its own workspace, home and sandbox scratch.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

import {
  BENCH_TASKS,
  BENCH_TASK_SET_ID,
  BENCH_WORKSPACE_ALLOWED_TOOLS,
  findTask,
  taskVisibleTests,
  type BenchTask,
} from './gpt-adaptation-bench.tasks.js';
import { gradeWorkspace, runAllScorerSelfTests, writeTree, sha256, type GradeResult } from './gpt-adaptation-bench.scorer.js';
import {
  REPLAY_SCRIPTS,
  extractFidelity,
  findReplayScript,
  renderSse,
  scriptDigest,
  type ScriptedResponse,
} from './gpt-adaptation-bench.events.js';
import {
  Ledger,
  clusterBootstrap,
  loadArtifacts,
  replayCoverageRow,
  summarize,
  taskPassed,
  type BenchMode,
  type GradeSummary,
  type ReplaySummary,
  type ReportSummary,
  type RunArtifact,
} from './gpt-adaptation-bench.report.js';
import { probeSandbox, runEscapeProbes, REPO_ROOT as SANDBOX_REPO_ROOT } from './gpt-adaptation-bench.sandbox.js';
import { BENCH_ABLATION_ARM_ID, engineFingerprint, type FixtureHandshake } from './gpt-adaptation-bench.arm.js';
import type { ArmPlan, BenchArmId, BenchRunKind, RunResult } from './gpt-adaptation-bench.arm.js';

const REPO_ROOT = SANDBOX_REPO_ROOT;
const KLIENT_DIR = join(REPO_ROOT, 'packages', 'klient');
const EXAMPLES_DIR = join(KLIENT_DIR, 'examples');
const ENTRY_PATH = join(EXAMPLES_DIR, 'gpt-adaptation-bench.arm-entry.ts');
const ARM_LOADER = join(EXAMPLES_DIR, 'gpt-adaptation-bench.arm-loader.mjs');
const FETCH_GUARD = join(EXAMPLES_DIR, 'gpt-adaptation-bench.fetch-guard.mjs');
const RAW_TEXT_LOADER = join(REPO_ROOT, 'build', 'register-raw-text-loader.mjs');

export const BENCH_VERSION = 'gpt-adaptation-bench/v3';
export const BENCH_SEED = 20260915;
/** Hard cap on model requests per task run, across every turn, retry and auth replay. */
export const BENCH_TASK_REQUEST_CAP = 6;
export const BENCH_CACHE_REQUESTS_PER_SESSION = 4;
export const BENCH_BUDGET_TOTAL = 356;
export const BENCH_PREFLIGHT_ALLOWANCE = 4;
export const BENCH_CACHE_PAIRS = 8;
export const BENCH_REPEATS = 2;
export const BENCH_MODEL_ID = 'bench-model';
export const BENCH_MODEL_NAME = 'bench-model';
export const BENCH_RUN_TIMEOUT_MS = 240_000;
export const BENCH_LIVE_MODEL_ID = 'openai-codex/gpt-6-astra';
export const BENCH_LIVE_EFFORT = 'high';
export const BENCH_ABLATION_ARM = BENCH_ABLATION_ARM_ID;

/**
 * The only engine files the candidate may change relative to the frozen
 * baseline. Everything else in the candidate arm is the baseline source.
 */
export const CANDIDATE_WHITELIST = [
  'src/kosong/contract/message.ts',
  'src/kosong/contract/generate.ts',
  'src/kosong/provider/bases/openai/openai-responses.ts',
  'src/kosong/provider/bases/openai/openai-common.ts',
  'src/kosong/provider/bases/openai/openai-legacy.ts',
  'src/agent/contextProjector/contextProjectorService.ts',
  'src/agent/loop/loopService.ts',
] as const;

const ABLATION_ARM_DIR = 'candidate-no-session-id';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface BenchCliOptions {
  readonly mode: 'dry-run' | 'stub' | 'live';
  readonly outDir: string;
  readonly runId: string;
  readonly reportDir?: string;
  readonly only: BenchRunKind | 'all';
  readonly budget: number;
  readonly model: string;
  readonly effort: string;
  readonly authHome?: string;
  readonly baselineDir: string;
  readonly seed: number;
  readonly freeze: boolean;
  readonly freezeMode: BenchMode;
  readonly selftest: boolean;
  readonly preflight: boolean;
  readonly help: boolean;
  readonly onlyRunId?: string;
}

export function parseArgs(
  argv: readonly string[],
  defaults: { outDir: string; runId: string },
): BenchCliOptions {
  const options: { -readonly [K in keyof BenchCliOptions]: BenchCliOptions[K] } = {
    mode: 'dry-run',
    outDir: defaults.outDir,
    runId: defaults.runId,
    only: 'all',
    budget: BENCH_BUDGET_TOTAL,
    model: BENCH_LIVE_MODEL_ID,
    effort: BENCH_LIVE_EFFORT,
    baselineDir: join(defaults.outDir, 'baseline-9c9435ecd'),
    seed: BENCH_SEED,
    freeze: false,
    freezeMode: 'live',
    selftest: false,
    preflight: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${String(arg)} requires a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case '--':
        break;
      case '--dry-run':
        options.mode = 'dry-run';
        break;
      case '--stub':
        options.mode = 'stub';
        break;
      case '--live':
        options.mode = 'live';
        break;
      case '--out':
        options.outDir = next();
        break;
      case '--run-id':
        options.runId = next();
        break;
      case '--report':
        options.reportDir = next();
        options.mode = 'dry-run';
        break;
      case '--only': {
        const requested = next();
        const normalized = requested.endsWith('s') ? requested.slice(0, -1) : requested;
        if (
          normalized !== 'task' &&
          normalized !== 'cache' &&
          normalized !== 'replay' &&
          normalized !== 'preflight' &&
          normalized !== 'all'
        ) {
          throw new Error(`--only expects task|cache|replay|preflight|all, got ${requested}`);
        }
        options.only = normalized;
        break;
      }
      case '--budget': {
        const raw = next();
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
          throw new Error(`--budget expects a positive integer, got ${JSON.stringify(raw)}`);
        }
        options.budget = parsed;
        break;
      }
      case '--model':
        options.model = next();
        break;
      case '--effort':
        options.effort = next();
        break;
      case '--auth-home':
        options.authHome = next();
        break;
      case '--baseline':
        options.baselineDir = next();
        break;
      case '--seed':
        options.seed = Number(next());
        break;
      case '--freeze':
        options.freeze = true;
        break;
      case '--freeze-mode': {
        const value = next();
        if (value !== 'live' && value !== 'offline') throw new Error('--freeze-mode expects live|offline');
        options.freezeMode = value;
        break;
      }
      case '--selftest':
        options.selftest = true;
        break;
      case '--preflight':
        options.preflight = true;
        break;
      case '--run':
        options.onlyRunId = next();
        break;
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${String(arg)}`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface ManifestFileHashes {
  readonly [relativePath: string]: string;
}

export interface BenchManifest {
  readonly bench: string;
  readonly taskSetId: string;
  readonly createdAt: string;
  readonly seed: number;
  /** The mode this manifest was frozen for; a run in the other mode is refused. */
  readonly intendedMode: BenchMode;
  readonly budget: { readonly total: number; readonly preflight: number };
  readonly files: ManifestFileHashes;
  readonly baseline: {
    readonly gitHead: string;
    readonly dir: string;
    readonly engineTreeDigest: string;
    /** Whole `packages/` tree (source + package.json), node_modules/dist excluded. */
    readonly workspaceTreeDigest: string;
    readonly files: ManifestFileHashes;
  };
  readonly candidate: {
    readonly strategy: 'baseline-copy+whitelist-overlay';
    readonly source: string;
    readonly whitelist: readonly string[];
    readonly overlayDigests: ManifestFileHashes;
    readonly overlayMatchesBaseline: boolean;
  };
  readonly ablation: {
    readonly arm: string;
    readonly mechanism: 'fetch-guard strips the session-id header (case-insensitive) from the outgoing request';
    readonly source: 'identical to candidate';
  };
  readonly replayScriptDigests: Readonly<Record<string, string>>;
  readonly planDigest: string;
  /** The model and effort the experiment is frozen to; a run may not swap either. */
  readonly model: {
    readonly live: string;
    readonly liveEffort: string;
    readonly offlineModelId: string;
    readonly offlineEffort: string;
    readonly effortsAdvertised: readonly string[];
  };
  readonly expected: {
    readonly taskRuns: number;
    readonly cacheSessions: number;
    readonly cacheRequests: number;
    readonly replayRuns: number;
    readonly reservedRequests: number;
  };
}

const FROZEN_FILE_NAMES = [
  'examples/gpt-adaptation-bench.ts',
  'examples/gpt-adaptation-bench.tasks.ts',
  'examples/gpt-adaptation-bench.scorer.ts',
  'examples/gpt-adaptation-bench.events.ts',
  'examples/gpt-adaptation-bench.arm.ts',
  'examples/gpt-adaptation-bench.arm-entry.ts',
  'examples/gpt-adaptation-bench.arm-loader.mjs',
  'examples/gpt-adaptation-bench.fetch-guard.mjs',
  'examples/gpt-adaptation-bench.sandbox.ts',
  'examples/gpt-adaptation-bench.report.ts',
  'test/gpt-adaptation-bench.test.ts',
  'test/gpt-adaptation-observability.test.ts',
  'package.json',
  'AGENTS.md',
] as const;

const BASELINE_PROVENANCE_FILES = [
  'packages/agent-core-v2/src/kosong/provider/bases/openai/openai-responses.ts',
  'packages/agent-core-v2/src/kosong/contract/message.ts',
  'pnpm-lock.yaml',
] as const;

/** Names whose content changed (or is missing) relative to a frozen hash set. */
export function compareFileHashes(
  expected: ManifestFileHashes,
  current: ManifestFileHashes,
): readonly string[] {
  return Object.entries(expected)
    .filter(([name, hash]) => current[name] !== hash)
    .map(([name]) => name)
    .sort();
}

export async function hashFiles(
  root: string,
  names: readonly string[],
): Promise<ManifestFileHashes> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const path = join(root, name);
    out[name] = existsSync(path) ? sha256(await readFile(path, 'utf8')) : '<missing>';
  }
  return out;
}

/** Recursive content digest of an engine source tree (path + bytes). */
export async function engineTreeDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        hash.update(relative(root, full));
        hash.update(await readFile(full));
      }
    }
  };
  await walk(root);
  return hash.digest('hex');
}

export function planDigest(plan: readonly RunPlanItem[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        plan.map((item) => [
          item.runId,
          item.kind,
          item.arm,
          item.taskId ?? null,
          item.repeat ?? null,
          item.scriptId ?? null,
          item.pairIndex ?? null,
        ]),
      ),
    )
    .digest('hex');
}

export function reservedRequests(plan: readonly RunPlanItem[]): number {
  return plan.reduce((total, item) => {
    if (item.kind === 'task') return total + BENCH_TASK_REQUEST_CAP;
    if (item.kind === 'cache') return total + BENCH_CACHE_REQUESTS_PER_SESSION;
    if (item.kind === 'preflight') return total + 1;
    return total;
  }, 0);
}

// ---------------------------------------------------------------------------
// Run plan
// ---------------------------------------------------------------------------

export interface RunPlanItem {
  readonly runId: string;
  readonly kind: BenchRunKind;
  readonly arm: BenchArmId;
  readonly taskId?: string;
  readonly repeat?: number;
  readonly scriptId?: string;
  readonly pairIndex?: number;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const random = mulberry32(seed);
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const a = out[index] as T;
    const b = out[swap] as T;
    out[index] = b;
    out[swap] = a;
  }
  return out;
}

/**
 * Task-pair blocks: within a block the first repeat runs baseline then
 * candidate and the second repeat runs candidate then baseline, and those four
 * runs stay adjacent. Blocks (and cache/replay pairs) are shuffled by seed.
 */
export function buildRunPlan(seed: number): readonly RunPlanItem[] {
  const taskBlocks = shuffled(
    BENCH_TASKS.map((task) => [
      { runId: `${task.id}__r0__baseline`, kind: 'task' as const, arm: 'baseline' as const, taskId: task.id, repeat: 0 },
      { runId: `${task.id}__r0__candidate`, kind: 'task' as const, arm: 'candidate' as const, taskId: task.id, repeat: 0 },
      { runId: `${task.id}__r1__candidate`, kind: 'task' as const, arm: 'candidate' as const, taskId: task.id, repeat: 1 },
      { runId: `${task.id}__r1__baseline`, kind: 'task' as const, arm: 'baseline' as const, taskId: task.id, repeat: 1 },
    ]),
    seed,
  );
  const cacheBlocks = shuffled(
    Array.from({ length: BENCH_CACHE_PAIRS }, (_, pair) => {
      const order: BenchArmId[] = pair % 2 === 0 ? ['candidate', BENCH_ABLATION_ARM] : [BENCH_ABLATION_ARM, 'candidate'];
      return order.map((arm) => ({
        runId: `cache-pair${String(pair)}__${arm}`,
        kind: 'cache' as const,
        arm,
        pairIndex: pair,
      }));
    }),
    seed ^ 0x5f3759df,
  );
  const replayBlocks = shuffled(
    REPLAY_SCRIPTS.map((script) => [
      { runId: `replay-${script.id}__baseline`, kind: 'replay' as const, arm: 'baseline' as const, scriptId: script.id },
      { runId: `replay-${script.id}__candidate`, kind: 'replay' as const, arm: 'candidate' as const, scriptId: script.id },
    ]),
    seed ^ 0x2545f491,
  );
  return [...taskBlocks.flat(), ...cacheBlocks.flat(), ...replayBlocks.flat()];
}

/**
 * Per-turn model-request budget: the sum never exceeds the task cap, so a
 * two-turn task cannot spend twelve requests.
 */
export function turnBudgetsFor(promptCount: number, cap = BENCH_TASK_REQUEST_CAP): readonly number[] {
  if (promptCount <= 0) return [];
  const base = Math.floor(cap / promptCount);
  const remainder = cap % promptCount;
  return Array.from({ length: promptCount }, (_, index) => Math.max(1, base + (index < remainder ? 1 : 0)));
}

// ---------------------------------------------------------------------------
// Arm roots
// ---------------------------------------------------------------------------

export interface ArmRoots {
  readonly roots: Readonly<Record<BenchArmId, string>>;
  readonly tsConfigs: Readonly<Record<BenchArmId, string>>;
  readonly notes: readonly string[];
  readonly overlayDigests: ManifestFileHashes;
  readonly overlayMatchesBaseline: boolean;
}

async function ensureBaselineLinks(baselineDir: string): Promise<void> {
  const repoNodeModules = join(REPO_ROOT, 'node_modules');
  const rootLink = join(baselineDir, 'node_modules');
  if (!existsSync(rootLink) && existsSync(repoNodeModules)) {
    await symlink(repoNodeModules, rootLink, 'dir');
  }
  const packagesDir = join(baselineDir, 'packages');
  if (!existsSync(packagesDir)) return;
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const real = join(REPO_ROOT, 'packages', entry.name, 'node_modules');
    const link = join(packagesDir, entry.name, 'node_modules');
    if (existsSync(real) && !existsSync(link)) await symlink(real, link, 'dir');
  }
}

async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, target);
    else if (entry.isFile()) await writeFile(target, await readFile(source));
  }
}

/** Arm tsconfig lives in the run directory: the baseline tree is never written. */
async function writeArmTsConfig(runRoot: string, arm: string, sourceRoot: string): Promise<string> {
  const rootConfig = JSON.parse(await readFile(join(REPO_ROOT, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: Record<string, unknown>;
  };
  const path = join(runRoot, 'tsconfig', `${arm}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        compilerOptions: rootConfig.compilerOptions,
        include: [`${sourceRoot}/packages/*/src/**/*.ts`, `${sourceRoot}/packages/*/src/**/*.tsx`],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return path;
}

/** Symlink every workspace package into an arm root except the engine itself. */
async function linkSiblingPackages(armRoot: string, sourceRoot: string): Promise<void> {
  const packagesDir = join(armRoot, 'packages');
  await mkdir(packagesDir, { recursive: true });
  for (const entry of await readdir(join(sourceRoot, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'agent-core-v2') continue;
    const link = join(packagesDir, entry.name);
    if (!existsSync(link)) await symlink(join(sourceRoot, 'packages', entry.name), link, 'dir');
  }
  await symlink(join(REPO_ROOT, 'node_modules'), join(armRoot, 'node_modules'), 'dir').catch(() => undefined);
}

export async function prepareArmRoots(options: {
  baselineDir: string;
  runRoot: string;
}): Promise<ArmRoots> {
  const notes: string[] = [];
  const baselineEngine = join(options.baselineDir, 'packages', 'agent-core-v2');
  if (!existsSync(join(baselineEngine, 'src', 'index.ts'))) {
    throw new Error(`baseline engine source not found at ${baselineEngine}`);
  }
  await ensureBaselineLinks(options.baselineDir);
  const baselineTs = await writeArmTsConfig(options.runRoot, 'baseline', options.baselineDir);
  notes.push(`baseline arm root ${options.baselineDir} (frozen snapshot; never written by this run)`);

  // Candidate: a private copy of the baseline engine plus the whitelisted
  // overlay files, so nothing else from the working tree can reach an arm.
  const candidateRoot = join(options.runRoot, 'arms', 'candidate');
  const candidateEngine = join(candidateRoot, 'packages', 'agent-core-v2');
  await rm(candidateRoot, { recursive: true, force: true });
  await copyTree(baselineEngine, candidateEngine);
  await symlink(
    join(options.baselineDir, 'packages', 'agent-core-v2', 'node_modules'),
    join(candidateEngine, 'node_modules'),
    'dir',
  );
  await linkSiblingPackages(candidateRoot, options.baselineDir);

  const overlayDigests: Record<string, string> = {};
  let overlayMatchesBaseline = true;
  for (const whitelisted of CANDIDATE_WHITELIST) {
    const source = join(REPO_ROOT, 'packages', 'agent-core-v2', whitelisted);
    const target = join(candidateEngine, whitelisted);
    const content = await readFile(source);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    const digest = sha256(content.toString('utf8'));
    overlayDigests[whitelisted] = digest;
    const baselineContent = await readFile(join(baselineEngine, whitelisted)).catch(() => Buffer.from(''));
    if (sha256(baselineContent.toString('utf8')) !== digest) overlayMatchesBaseline = false;
  }
  const candidateTs = await writeArmTsConfig(options.runRoot, 'candidate', candidateRoot);
  notes.push(
    `candidate arm = baseline copy + whitelist overlay (${String(CANDIDATE_WHITELIST.length)} files${overlayMatchesBaseline ? ', identical to baseline — no implemented change yet' : ''})`,
  );

  // Ablation: same source as the candidate; the fetch guard removes the
  // session-id header on the way out, so only the header differs.
  const ablationRoot = join(options.runRoot, 'arms', ABLATION_ARM_DIR);
  await rm(ablationRoot, { recursive: true, force: true });
  await copyTree(candidateRoot, ablationRoot);
  // `copyTree` walks real directories only; the sibling workspace packages are
  // symlinks, so they are re-created here (pinned inside the arm root).
  await linkSiblingPackages(ablationRoot, options.baselineDir);
  await symlink(join(candidateEngine, 'node_modules'), join(ablationRoot, 'packages', 'agent-core-v2', 'node_modules'), 'dir');
  const ablationTs = await writeArmTsConfig(options.runRoot, ABLATION_ARM_DIR, ablationRoot);
  notes.push('ablation arm = identical candidate source; the fetch guard strips the session-id header');

  return {
    roots: {
      baseline: options.baselineDir,
      candidate: candidateRoot,
      'candidate-no-session-id': ablationRoot,
    },
    tsConfigs: {
      baseline: baselineTs,
      candidate: candidateTs,
      'candidate-no-session-id': ablationTs,
    },
    notes,
    overlayDigests,
    overlayMatchesBaseline,
  };
}

// ---------------------------------------------------------------------------
// Resolution verification
// ---------------------------------------------------------------------------

const RESOLUTION_SPECS = [
  '@moonshot-ai/agent-core-v2',
  '@moonshot-ai/agent-core-v2/kosong/provider/bases/openai/openai-responses',
  '@moonshot-ai/agent-core-v2/agent/loop/loop',
  '@moonshot-ai/klient',
  '@moonshot-ai/protocol',
  '@moonshot-ai/minidb',
  '@moonshot-ai/minidb/cluster',
  '@moonshot-ai/kimi-code-oauth',
  '@moonshot-ai/tree-sitter-bash',
] as const;

export interface ResolutionReport {
  readonly arm: BenchArmId;
  readonly resolved: readonly { readonly specifier: string; readonly resolved: string }[];
  readonly failed: readonly { readonly specifier: string; readonly error: string }[];
  readonly allInsideArmRoot: boolean;
}

/**
 * Resolve every workspace specifier through the arm loader and require each
 * target to be inside the arm root — proof that no arm reads a workspace
 * package out of the working tree.
 */
export async function verifyArmResolution(options: {
  arm: BenchArmId;
  armRoot: string;
  runRoot: string;
}): Promise<ResolutionReport> {
  const probeDir = join(options.runRoot, 'probe');
  await mkdir(probeDir, { recursive: true });
  const probePath = join(probeDir, `resolve-${options.arm}.mjs`);
  await writeFile(
    probePath,
    [
      `const specs = ${JSON.stringify([...RESOLUTION_SPECS])};`,
      'for (const spec of specs) {',
      '  try { console.log("PKG " + spec + " " + import.meta.resolve(spec)); }',
      '  catch (error) { console.log("PKG_FAIL " + spec + " " + String(error.message).replaceAll("\\n", " ").slice(0, 160)); }',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  const outcome = await runProcess(
    [process.execPath, '--import', ARM_LOADER, probePath],
    { cwd: probeDir, timeoutMs: 60_000, env: { KIMI_BENCH_ARM_ROOT: options.armRoot } },
  );
  const resolved: { specifier: string; resolved: string }[] = [];
  const failed: { specifier: string; error: string }[] = [];
  for (const line of outcome.stdout.split('\n')) {
    if (line.startsWith('PKG ')) {
      const [, specifier, url] = line.split(' ');
      if (specifier !== undefined && url !== undefined) resolved.push({ specifier, resolved: url });
    } else if (line.startsWith('PKG_FAIL ')) {
      const rest = line.slice('PKG_FAIL '.length);
      const specifier = rest.split(' ')[0] ?? '';
      failed.push({ specifier, error: rest.slice(specifier.length + 1) });
    }
  }
  const allInsideArmRoot = resolved.every((entry) =>
    entry.resolved.startsWith(`file://${options.armRoot}/`),
  );
  return { arm: options.arm, resolved, failed, allInsideArmRoot };
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

export interface ProcessOutcome {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

function runProcess(
  argv: readonly string[],
  options: { cwd: string; timeoutMs: number; env?: Readonly<Record<string, string>> },
): Promise<ProcessOutcome> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: options.cwd,
      env: { PATH: process.env['PATH'] ?? '', ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code ?? -1, timedOut, stdout, stderr });
    });
  });
}

const require = createRequire(join(KLIENT_DIR, 'package.json'));
const TSX_CLI = require.resolve('tsx/cli');

export function spawnArm(options: {
  armRoot: string;
  tsConfig: string;
  planPath: string;
  timeoutMs: number;
  env: Readonly<Record<string, string>>;
}): Promise<ProcessOutcome> {
  return runProcess(
    [
      process.execPath,
      TSX_CLI,
      '--tsconfig',
      options.tsConfig,
      '--import',
      RAW_TEXT_LOADER,
      '--import',
      ARM_LOADER,
      '--import',
      FETCH_GUARD,
      ENTRY_PATH,
      options.planPath,
    ],
    {
      cwd: KLIENT_DIR,
      timeoutMs: options.timeoutMs,
      env: { KIMI_BENCH_ARM_ROOT: options.armRoot, ...options.env },
    },
  );
}

// ---------------------------------------------------------------------------
// Fixture plans (offline)
// ---------------------------------------------------------------------------

function textResponse(text: string, id: string): ScriptedResponse {
  return {
    hasTerminalEvent: true,
    completeToolCalls: 0,
    events: [
      { type: 'response.created', response: { id } },
      { type: 'response.output_text.delta', delta: text },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: `msg_${id}`,
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      },
      { type: 'response.completed', response: { id, status: 'completed' } },
    ],
  };
}

/** Text response carrying a declared usage record (offline cache accounting only). */
function textResponseWithUsage(text: string, id: string, cachedTokens: number): ScriptedResponse {
  const base = textResponse(text, id);
  return {
    ...base,
    events: base.events.map((event) =>
      event.type === 'response.completed'
        ? {
            ...event,
            response: {
              ...(event['response'] as Record<string, unknown>),
              usage: {
                input_tokens: 8192,
                output_tokens: 1,
                total_tokens: 8193,
                input_tokens_details: { cached_tokens: cachedTokens },
              },
            },
          }
        : event,
    ),
  };
}

function toolResponse(tool: string, args: Record<string, unknown>, sequence: number): ScriptedResponse {
  const payload = JSON.stringify(args);
  const itemId = `fc_${String(sequence)}`;
  const callId = `call_${String(sequence)}`;
  return {
    hasTerminalEvent: true,
    completeToolCalls: 1,
    events: [
      { type: 'response.created', response: { id: `resp_${String(sequence)}` } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: itemId, call_id: callId, name: tool, arguments: '' },
      },
      { type: 'response.function_call_arguments.delta', item_id: itemId, output_index: 0, delta: payload },
      { type: 'response.function_call_arguments.done', item_id: itemId, output_index: 0, arguments: payload },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', id: itemId, call_id: callId, name: tool, arguments: payload },
      },
      { type: 'response.completed', response: { id: `resp_${String(sequence)}`, status: 'completed' } },
    ],
  };
}

export interface FixtureTurnPlan {
  readonly responses: readonly ScriptedResponse[];
}

/**
 * Offline plan for a task run. The first turn performs a real read (so turn 1
 * exercises tool use without producing the final answer), and the final turn
 * writes the frozen reference patch. A single-turn task does both in one turn.
 */
export function taskFixtureTurns(task: BenchTask): readonly FixtureTurnPlan[] {
  const referenceFiles = Object.entries(task.reference);
  const firstInitial = Object.keys(task.files)[0];
  const budgets = turnBudgetsFor(task.prompts.length);
  const turns: FixtureTurnPlan[] = [];
  let sequence = 0;
  if (task.prompts.length >= 2 && firstInitial !== undefined) {
    const read = toolResponse('bench_read_file', { path: firstInitial }, sequence);
    sequence += 1;
    turns.push({ responses: [read, textResponse('I will finish this in the next step.', 'turn0')] });
    const writes = referenceFiles.map(([path, content]) => {
      const response = toolResponse('bench_write_file', { path, content }, sequence);
      sequence += 1;
      return response;
    });
    turns.push({ responses: [...writes, textResponse('Implemented.', 'turn1')] });
  } else {
    const writes = referenceFiles.map(([path, content]) => {
      const response = toolResponse('bench_write_file', { path, content }, sequence);
      sequence += 1;
      return response;
    });
    turns.push({ responses: [...writes, textResponse('Implemented.', 'turn0')] });
  }
  const mismatched = turns
    .map((turn, index) => ({ turn, budget: budgets[index] ?? 0 }))
    .filter((entry) => entry.turn.responses.length > entry.budget);
  if (mismatched.length > 0) {
    throw new Error(
      `fixture plan for ${task.id} exceeds the per-turn budget: ${mismatched
        .map((entry) => `${String(entry.turn.responses.length)}>${String(entry.budget)}`)
        .join(', ')}`,
    );
  }
  return turns;
}

/**
 * The cache probe prefix. The per-session salt sits at the very front, so no
 * other session (in either arm) can have warmed this cache entry.
 */
export function cacheSystemPrompt(salt: string): string {
  const filler = Array.from(
    { length: 96 },
    (_, index) => `const benchConstant${String(index)} = "prefix-marker-${String(index)}-${'x'.repeat(40)}";`,
  ).join('\n');
  return [
    `// cache-probe-session ${salt}`,
    'You are a cache-affinity probe. Reply with the single word ack.',
    filler,
  ].join('\n');
}

export function replayFixtureTurns(scriptId: string): readonly FixtureTurnPlan[] {
  const script = findReplayScript(scriptId);
  const turns: FixtureTurnPlan[] = [];
  let cursor = 0;
  for (const count of script.responsesPerTurn) {
    turns.push({ responses: script.responses.slice(cursor, cursor + count) });
    cursor += count;
  }
  if (cursor !== script.responses.length) {
    throw new Error(`replay script ${scriptId} declares ${String(script.responsesPerTurn.length)} turns but has ${String(script.responses.length)} responses`);
  }
  return turns;
}

// ---------------------------------------------------------------------------
// Ledger helpers
// ---------------------------------------------------------------------------

export { Ledger };

function guardTicketsPath(runRoot: string, runId: string): string {
  return join(runRoot, 'guard', runId, 'tickets.json');
}

interface GuardTicketState {
  readonly count: number;
  readonly cap: number;
  readonly exceeded: number;
}

export async function readGuardTickets(
  runRoot: string,
  runId: string,
): Promise<GuardTicketState | undefined> {
  const path = guardTicketsPath(runRoot, runId);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<GuardTicketState>;
    return { count: parsed.count ?? 0, cap: parsed.cap ?? 0, exceeded: parsed.exceeded ?? 0 };
  } catch {
    return undefined;
  }
}

interface GuardRequestRecord {
  readonly kind: string;
  /** On `kind: 'other'`: whether the request was let through as auth traffic or refused. */
  readonly disposition?: 'auth' | 'refused';
  readonly index?: number;
  readonly sessionIdSent?: boolean;
  readonly request?: {
    readonly messageItems: number;
    readonly messageItemsWithId: number;
    readonly messageItemsWithPhase: number;
    readonly reasoningItems: number;
    readonly reasoningWithEncrypted: number;
    readonly toolCallItems: number;
    readonly toolNames: readonly string[];
  };
  readonly usage?: { readonly inputTokens: number | null; readonly outputTokens: number | null; readonly cachedTokens: number | null } | null;
  readonly firstByteMs?: number | null;
  readonly firstVisibleTokenMs?: number | null;
  readonly status?: number;
  readonly terminalEventSeen?: string | null;
  readonly responseMetadata?: {
    readonly messageItemsWithPhase: number;
    readonly messageItemsWithId: number;
    readonly reasoningWithEncrypted: number;
  } | null;
}

export async function readGuardRequests(
  runRoot: string,
  runId: string,
): Promise<readonly GuardRequestRecord[]> {
  const path = join(runRoot, 'guard', runId, 'requests.jsonl');
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  const out: GuardRequestRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as GuardRequestRecord);
    } catch {
      // A torn line is skipped; the ticket count stays authoritative.
    }
  }
  return out;
}

function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}

// ---------------------------------------------------------------------------
// Running one item
// ---------------------------------------------------------------------------

interface RunContext {
  readonly options: BenchCliOptions;
  readonly mode: BenchMode;
  readonly runRoot: string;
  readonly armRoots: ArmRoots;
  readonly ledger: Ledger;
  readonly manifest: BenchManifest;
}

function childMetrics(child: RunResult | undefined): {
  toolCalls: number;
  toolFailures: number;
  firstVisibleTokenMs: number | null;
  ttftByTurn: readonly (number | null)[];
  durationMs: number | null;
} {
  const prompts = child?.prompts ?? [];
  const calls = prompts.flatMap((prompt) => prompt.toolCalls);
  // The run-level TTFT is the first turn's, never the fastest turn's: taking a
  // minimum across turns would report a latency no single run had.
  const ttftByTurn = prompts.map((prompt) => prompt.firstVisibleTokenMs ?? null);
  return {
    toolCalls: calls.length,
    toolFailures: calls.filter((call) => call.ok === false).length,
    firstVisibleTokenMs: ttftByTurn[0] ?? null,
    ttftByTurn,
    durationMs:
      child === undefined ? null : Math.max(0, child.endedAt - child.startedAt),
  };
}

/**
 * Sum the guard-observed usage. Every field counts only the requests that
 * actually reported it, and the record keeps the coverage so a partial total
 * can never be mistaken for a complete one.
 */
function usageFromGuard(records: readonly GuardRequestRecord[]): RunArtifact['usage'] {
  const responses = records.filter((record) => record.kind === 'responses');
  const withUsage = responses.filter((record) => record.usage !== null && record.usage !== undefined);
  if (withUsage.length === 0) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let inputTokensKnown = 0;
  let outputTokensKnown = 0;
  let cachedTokensKnown = 0;
  for (const record of withUsage) {
    const usage = record.usage;
    if (usage === null || usage === undefined) continue;
    if (usage.inputTokens !== null) {
      inputTokens += usage.inputTokens;
      inputTokensKnown += 1;
    }
    if (usage.outputTokens !== null) {
      outputTokens += usage.outputTokens;
      outputTokensKnown += 1;
    }
    if (usage.cachedTokens !== null) {
      cachedTokens += usage.cachedTokens;
      cachedTokensKnown += 1;
    }
  }
  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    requests: responses.length,
    requestsWithUsage: withUsage.length,
    inputTokensKnown,
    outputTokensKnown,
    cachedTokensKnown,
  };
}

/**
 * Live-only HTTP-measurement verdict. A run whose success cannot be backed by
 * complete guard evidence (no ticket, no observation, an unapproved endpoint,
 * or a ticket/record mismatch) is a measurement failure: it may be archived,
 * but it can never be scored, and the orchestrator stops on it.
 */
function measurementVerdict(options: {
  readonly mode: BenchMode;
  readonly child: RunResult | undefined;
  readonly records: readonly GuardRequestRecord[];
  readonly tickets: GuardTicketState | undefined;
  readonly expectedModel: string;
}): string | null {
  if (options.mode !== 'live') return null;
  const refused = options.records.filter(
    (record) => record.kind === 'other' && record.disposition === 'refused',
  );
  if (refused.length > 0) {
    return `${String(refused.length)} request(s) to an unapproved endpoint`;
  }
  const responses = options.records.filter((record) => record.kind === 'responses');
  const incomplete = responses.filter((record) => typeof record.status !== 'number');
  if (incomplete.length > 0) {
    return `${String(incomplete.length)} guard record(s) without a status`;
  }
  if (options.child?.status === 'ok') {
    if (options.tickets === undefined || options.tickets.count === 0) {
      return 'the run reported success but took no request ticket';
    }
    if (responses.length === 0) {
      return 'the run reported success but the guard observed no response';
    }
    if (responses.length !== options.tickets.count) {
      return `${String(options.tickets.count)} ticket(s) but ${String(responses.length)} guard record(s)`;
    }
    if (responses.some((record) => (record.status ?? 0) >= 200 && (record.status ?? 0) < 300 && (record.terminalEventSeen ?? null) === null)) {
      return 'the run reported success but a Responses terminal event was not observed';
    }
    if (options.expectedModel !== '' && options.child.modelId !== options.expectedModel) {
      return `the run bound model "${options.child.modelId}" instead of the frozen "${options.expectedModel}"`;
    }
  }
  return null;
}

/**
 * Per-request replay-metadata presence, aggregated straight from the guard
 * records: how much item id / phase / encrypted reasoning the engine actually
 * sent back on the wire (not what the probes hoped it would).
 */
function replayMetadataFromGuard(
  records: readonly GuardRequestRecord[],
): RunArtifact['replayMetadata'] {
  const responses = records.filter((record) => record.kind === 'responses');
  if (responses.length === 0) return undefined;
  const sum = (pick: (request: GuardRequestRecord['request']) => number | undefined): number =>
    responses.reduce((total, record) => total + (pick(record.request) ?? 0), 0);
  return {
    requests: responses.length,
    messageItems: sum((request) => request?.messageItems),
    messageItemsWithId: sum((request) => request?.messageItemsWithId),
    messageItemsWithPhase: sum((request) => request?.messageItemsWithPhase),
    reasoningItems: sum((request) => request?.reasoningItems),
    reasoningWithEncrypted: sum((request) => request?.reasoningWithEncrypted),
  };
}

/**
 * Rebuild the cache session's per-request measurements from the guard records
 * (one position per planned request; a field the backend did not report stays
 * `null`). The engine-side event stream is only a fallback when no guard record
 * exists, so a partial engine event can never pass as a backend measurement.
 */
function guardCacheRequests(
  records: readonly GuardRequestRecord[],
  expected: number,
): RunResult['cacheRequests'] | undefined {
  const responses = records.filter((record) => record.kind === 'responses');
  if (responses.length === 0) return undefined;
  return Array.from({ length: expected }, (_, index) => {
    const usage = responses[index]?.usage ?? null;
    const firstTokenLatencyMs = responses[index]?.firstVisibleTokenMs ?? null;
    return {
      index,
      inputTokens: usage?.inputTokens ?? null,
      cachedTokens: usage?.cachedTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      firstTokenLatencyMs,
      streamDurationMs: null,
      usageObserved: usage !== null,
      timingObserved: firstTokenLatencyMs !== null,
    };
  });
}

function replaySummaryFor(options: {
  readonly scriptId: string;
  readonly requests: readonly {
    readonly index: number;
    readonly messageItems: number;
    readonly messageItemsWithId: number;
    readonly messageItemsWithPhase: number;
    readonly reasoningItems: number;
    readonly reasoningWithEncrypted: number;
    readonly toolCallItems: number;
    readonly terminalEventServed?: boolean;
  }[];
  child: RunResult | undefined;
  totalRequests: number;
}): ReplaySummary {
  const script = findReplayScript(options.scriptId);
  const coverage = replayCoverageRow(
    script,
    options.requests.map((request, position) => ({
      index: request.index ?? position + 1,
      messageItemsWithId: request.messageItemsWithId,
      messageItemsWithPhase: request.messageItemsWithPhase,
      reasoningWithEncrypted: request.reasoningWithEncrypted,
    })),
  );
  const truncatedServed = options.requests.some((request) => request.terminalEventServed === false);
  const prompts = options.child?.prompts ?? [];
  const completedTurns = prompts.filter((prompt) => prompt.endedReason === 'completed').length;
  const toolExecutions = prompts.reduce((total, prompt) => total + prompt.toolCalls.length, 0);
  return {
    scriptId: options.scriptId,
    requestsObserved: options.totalRequests,
    extraRequests:
      options.totalRequests === 0 ? null : Math.max(0, options.totalRequests - script.responses.length),
    misreportedSuccess:
      options.requests.length === 0 ? null : truncatedServed && completedTurns > 0,
    incompleteToolExecutions: options.requests.length === 0 ? null : truncatedServed ? toolExecutions : 0,
    terminalEventExpected: script.responses.every((response) => response.hasTerminalEvent),
    coverage,
    noReplayOpportunity: coverage.filter((entry) => entry.phases === null).length,
  };
}

function contractVerdict(task: BenchTask | undefined, child: RunResult | undefined): boolean | null {
  if (task === undefined || child === undefined) return null;
  const contract = child.contract;
  if (contract === undefined) return null;
  if (contract.resumeRequired) {
    if (!contract.resumePerformed || contract.restored !== true) return false;
  }
  if (contract.turnsCompleted !== task.prompts.length) return false;
  if (task.resumeAfter !== undefined && !contract.continuedAfterResume) return false;
  return true;
}

function toGradeSummary(grade: GradeResult): GradeSummary {
  return {
    passed: grade.passed,
    tests: grade.tally.tests,
    pass: grade.tally.pass,
    fail: grade.tally.fail,
    exactOk: grade.exact.every((check) => check.ok),
    exitCode: grade.exitCode,
    timedOut: grade.timedOut,
    graderDigest: grade.graderDigest,
    failures: grade.failures,
  };
}

/**
 * A replay item is always the deterministic offline plan — never a live call —
 * whatever the surrounding invocation asked for.
 */
export function resolveItemMode(contextMode: BenchMode, kind: BenchRunKind): BenchMode {
  return kind === 'replay' ? 'offline' : contextMode;
}

async function runItem(context: RunContext, item: RunPlanItem): Promise<RunArtifact> {
  const { options, runRoot, armRoots } = context;
  const mode: BenchMode = resolveItemMode(context.mode, item.kind);
  const startedAt = new Date().toISOString();
  const workspaceDir = join(runRoot, 'workspaces', item.runId);
  const profilePath = join(runRoot, 'profiles', `${item.runId}.md`);
  const resultPath = join(runRoot, 'raw', `${item.runId}.json`);
  const sandboxRoot = join(runRoot, 'sandbox', item.runId);
  const engineHomeDir = join(runRoot, 'home', `${mode}-${item.runId}`);

  const task = item.kind === 'task' && item.taskId !== undefined ? findTask(item.taskId) : undefined;
  await rm(workspaceDir, { recursive: true, force: true });
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(engineHomeDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(profilePath), { recursive: true });
  await mkdir(sandboxRoot, { recursive: true });
  if (task !== undefined) await writeTree(workspaceDir, task.files);
  else await writeFile(join(workspaceDir, 'README.md'), 'synthetic benchmark workspace\n', 'utf8');

  const turnBudgets: number[] =
    item.kind === 'task'
      ? [...turnBudgetsFor(task?.prompts.length ?? 1)]
      : item.kind === 'cache'
        ? [BENCH_CACHE_REQUESTS_PER_SESSION]
        : item.kind === 'preflight'
          ? [1]
          : (() => {
              const script = item.scriptId === undefined ? undefined : findReplayScript(item.scriptId);
              // Each turn gets its scripted requests plus one spare, so a
              // truncated response can still reach a natural end (and the
              // misreport the arm is measuring stays observable).
              return script === undefined ? [4] : script.responsesPerTurn.map((count) => count + 1);
            })();

  let endpoint: ArmPlan['endpoint'] = { mode: 'live' };
  let handshakePath: string | undefined;
  let guardHosts: string | undefined;
  let authBridge: RunArtifact['authBridge'];
  let authConfigPath: string | undefined;
  if (mode === 'live') {
    const authHome =
      options.authHome ??
      process.env['KIMI_CODE_HOME'] ??
      process.env['HAKIMI_HOME'] ??
      join(homedir(), '.hakimi');
    // The run keeps its own home (sessions, index, logs). Only the managed
    // OAuth credential store and the provider/model configuration are read
    // through from the auth home; the harness never opens either file, and the
    // configuration digest is verified again after the run.
    const credentialsSource = join(authHome, 'credentials');
    const credentialsLinked = existsSync(credentialsSource);
    if (credentialsLinked) {
      await symlink(credentialsSource, join(engineHomeDir, 'credentials'), 'dir').catch(() => undefined);
    }
    const configSource = join(authHome, 'config.toml');
    let configDigest = '<absent>';
    if (existsSync(configSource)) {
      configDigest = sha256(await readFile(configSource, 'utf8'));
      await symlink(configSource, join(engineHomeDir, 'config.toml')).catch(() => undefined);
      authConfigPath = configSource;
    }
    authBridge = { authHome, credentialsLinked, configDigest, configUnchanged: true };
  }
  if (mode === 'offline') {
    const port = await freePort();
    const turns: readonly FixtureTurnPlan[] =
      item.kind === 'task' && task !== undefined
        ? taskFixtureTurns(task)
        : item.kind === 'replay' && item.scriptId !== undefined
          ? replayFixtureTurns(item.scriptId)
          : item.kind === 'cache'
            ? [
                {
                  responses: Array.from({ length: BENCH_CACHE_REQUESTS_PER_SESSION }, (_, index) =>
                    textResponseWithUsage('ack', `cache${String(index)}`, index === 0 ? 0 : 4096),
                  ),
                },
              ]
            : [{ responses: [textResponse('pong', 'preflight')] }];
    handshakePath = join(runRoot, 'handshake', `${item.runId}.json`);
    await mkdir(dirname(handshakePath), { recursive: true });
    const handshake: FixtureHandshake = {
      port,
      engineFingerprint: engineFingerprint([...BENCH_WORKSPACE_ALLOWED_TOOLS]),
      // Cache and preflight runs call `generate` directly and project no tools.
      enforceToolFingerprint: item.kind === 'task' || item.kind === 'replay',
      turns,
    };
    await writeFile(handshakePath, `${JSON.stringify(handshake)}\n`, 'utf8');
    endpoint = { mode: 'fixture', port, apiKey: 'bench-key' };
    guardHosts = `127.0.0.1:${String(port)}`;
  }

  const plan: ArmPlan = {
    runId: item.runId,
    kind: item.kind,
    arm: item.arm,
    armRoot: armRoots.roots[item.arm],
    homeDir: engineHomeDir,
    workspaceDir,
    profilePath,
    resultPath,
    sandboxRoot,
    model: {
      id: mode === 'live' ? options.model : BENCH_MODEL_ID,
      name: mode === 'live' ? options.model : BENCH_MODEL_NAME,
      maxContextSize: 65536,
      supportEfforts: ['low', 'medium', 'high'],
      defaultEffort: options.effort,
    },
    effort: options.effort,
    endpoint,
    prompts:
      item.kind === 'task'
        ? [...(task?.prompts ?? [])]
        : item.kind === 'cache'
          ? []
          : item.kind === 'preflight'
            ? []
            : Array.from(
                {
                  length:
                    item.scriptId === undefined
                      ? 1
                      : findReplayScript(item.scriptId).responsesPerTurn.length,
                },
                (_, index) => (index === 0 ? 'Start the replay task.' : 'Continue the replay task.'),
              ),
    resumeAfter: task?.resumeAfter,
    turnBudgets,
    cache:
      item.kind === 'cache'
        ? {
            sessionKey: `bench-session-${sha256(`${String(item.pairIndex ?? 0)}:${item.arm}:${String(options.seed)}`).slice(0, 16)}`,
            requests: BENCH_CACHE_REQUESTS_PER_SESSION,
            // The per-session salt is only meaningful for the real backend; it
            // keeps the two arms from sharing a warm cache entry.
            systemPrompt: cacheSystemPrompt(
              sha256(`${String(item.pairIndex ?? 0)}:${item.arm}:${String(options.seed)}`).slice(0, 16),
            ),
            userText: 'Reply with the single word ack.',
          }
        : undefined,
    maxStepsPerTurn: BENCH_TASK_REQUEST_CAP,
    maxAttemptsPerStep: 2,
    runTimeoutMs: BENCH_RUN_TIMEOUT_MS,
    handshakePath,
  };

  const guardDir = join(runRoot, 'guard', item.runId);
  await mkdir(guardDir, { recursive: true });
  const env: Record<string, string> = {
    KIMI_BENCH_GUARD_DIR: guardDir,
    KIMI_BENCH_RUN_CAP: String(turnBudgets.reduce((total, budget) => total + budget, 0)),
    HOME: engineHomeDir,
  };
  if (guardHosts !== undefined) env['KIMI_BENCH_GUARD_HOSTS'] = guardHosts;
  if (item.arm === BENCH_ABLATION_ARM) env['KIMI_BENCH_STRIP_SESSION_ID'] = '1';
  if (mode === 'live') env['KIMI_BENCH_EXPECTED_MODEL'] = options.model.split('/').at(-1) ?? '';

  const planPath = join(runRoot, 'plans', `${item.runId}.json`);
  await mkdir(dirname(planPath), { recursive: true });
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

  const outcome = await spawnArm({
    armRoot: armRoots.roots[item.arm],
    tsConfig: armRoots.tsConfigs[item.arm],
    planPath,
    timeoutMs: plan.runTimeoutMs + 60_000,
    env,
  });

  let child: RunResult | undefined;
  if (existsSync(resultPath)) {
    try {
      child = JSON.parse(await readFile(resultPath, 'utf8')) as RunResult;
    } catch {
      child = undefined;
    }
  }

  const guardRecords = await readGuardRequests(runRoot, item.runId);
  const tickets = await readGuardTickets(runRoot, item.runId);
  const observedRequests =
    mode === 'live' ? (tickets?.count ?? 0) : (child?.fixture?.requests ?? 0);
  const observedSource: RunArtifact['requestsObservedSource'] =
    mode === 'live' ? (tickets === undefined ? 'none' : 'guard') : child?.fixture === undefined ? 'none' : 'fixture';
  // The guard runs in every mode: offline runs are ticketed and captured too,
  // so the same HTTP evidence exists for the pipeline checks.
  const guardObservedRequests =
    guardRecords.filter((record) => record.kind === 'responses').length > 0
      ? guardRecords.filter((record) => record.kind === 'responses').length
      : null;

  const metrics = childMetrics(child);
  const usage = mode === 'live' ? usageFromGuard(guardRecords) : null;

  let grade: GradeSummary | undefined;
  if (task !== undefined && child !== undefined && item.kind === 'task') {
    const result = await gradeWorkspace(task, workspaceDir, {
      scratchDir: join(runRoot, 'scratch', item.runId),
    });
    grade = toGradeSummary(result);
  }

  const contractSatisfied = contractVerdict(task, child);

  let replay: ReplaySummary | undefined;
  if (item.kind === 'replay' && item.scriptId !== undefined) {
    const requests =
      mode === 'live'
        ? guardRecords
            .filter((record) => record.kind === 'responses')
            .map((record, position) => ({
              index: record.index ?? position + 1,
              messageItems: record.request?.messageItems ?? 0,
              messageItemsWithId: record.request?.messageItemsWithId ?? 0,
              messageItemsWithPhase: record.request?.messageItemsWithPhase ?? 0,
              reasoningItems: record.request?.reasoningItems ?? 0,
              reasoningWithEncrypted: record.request?.reasoningWithEncrypted ?? 0,
              toolCallItems: record.request?.toolCallItems ?? 0,
              terminalEventServed: record.terminalEventSeen !== null,
            }))
        : ((child?.requests ?? []) as readonly (GuardRequestRecord['request'] & { index: number; turn: number })[]).map(
            (record, position) => ({
              index: record.index ?? position + 1,
              messageItems: record.messageItems,
              messageItemsWithId: record.messageItemsWithId,
              messageItemsWithPhase: record.messageItemsWithPhase,
              reasoningItems: record.reasoningItems,
              reasoningWithEncrypted: record.reasoningWithEncrypted,
              toolCallItems: record.toolCallItems,
              terminalEventServed:
                (record as unknown as { terminalEventServed?: boolean }).terminalEventServed ?? false,
            }),
          );
    replay = replaySummaryFor({
      scriptId: item.scriptId,
      requests,
      child,
      totalRequests: observedRequests,
    });
  }

  const testsSandboxed =
    child === undefined ? null : ((child.sandbox?.supported ?? null) as boolean | null);

  const measurementFailed = measurementVerdict({
    mode,
    child,
    records: guardRecords,
    tickets,
    expectedModel: mode === 'live' ? options.model : '',
  });
  const liveCacheRequests =
    mode === 'live' && item.kind === 'cache'
      ? guardCacheRequests(guardRecords, BENCH_CACHE_REQUESTS_PER_SESSION)
      : undefined;

  if (authBridge !== undefined && authConfigPath !== undefined) {
    const after = sha256(await readFile(authConfigPath, 'utf8'));
    if (after !== authBridge.configDigest) {
      throw new Error(
        `the managed configuration ${authConfigPath} changed during benchmark run ${item.runId}; ` +
          'a benchmark run must never write the operator config',
      );
    }
    authBridge = { ...authBridge, configUnchanged: true };
  }

  const artifact: RunArtifact = {
    runId: item.runId,
    mode,
    kind: item.kind,
    arm: item.arm,
    taskId: item.taskId,
    repeat: item.repeat,
    scriptId: item.scriptId,
    pairIndex: item.pairIndex,
    child:
      liveCacheRequests === undefined || child === undefined
        ? child
        : { ...child, cacheRequests: liveCacheRequests },
    childExitCode: outcome.exitCode,
    childTimedOut: outcome.timedOut,
    grade,
    contractSatisfied,
    replay,
    requestsObserved: observedRequests,
    requestsObservedSource: observedSource,
    guardObservedRequests,
    measurementFailed,
    modelObserved:
      child === undefined ? undefined : { id: child.modelId, effort: child.effort },
    replayMetadata: replayMetadataFromGuard(guardRecords),
    toolCalls: metrics.toolCalls,
    toolFailures: metrics.toolFailures,
    usage,
    firstVisibleTokenMs: metrics.firstVisibleTokenMs,
    ttftByTurn: metrics.ttftByTurn,
    durationMs: metrics.durationMs,
    testsSandboxed,
    authBridge,
    note:
      child === undefined
        ? `child produced no result file: ${outcome.stderr.split('\n').slice(0, 3).join(' ').slice(0, 400)}`
        : (child.fixture?.exhaustedTurns.length ?? 0) > 0
          ? `fixture refused a request beyond the scripted plan (turn ${child.fixture?.exhaustedTurns.join(',') ?? ''}) — expected for truncation scripts`
          : undefined,
    startedAt,
    endedAt: new Date().toISOString(),
  };

  await mkdir(join(runRoot, 'runs'), { recursive: true });
  await writeFile(join(runRoot, 'runs', `${item.runId}.json`), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return artifact;
}

function taskNotCountedReasons(artifact: RunArtifact): readonly string[] {
  const reasons: string[] = [];
  if (artifact.childTimedOut) reasons.push('timeout');
  if (artifact.child === undefined) reasons.push('no-result');
  else if (artifact.child.status !== 'ok') reasons.push(artifact.child.status);
  if (artifact.childExitCode !== 0) reasons.push(`exit=${String(artifact.childExitCode)}`);
  if (artifact.contractSatisfied !== true) reasons.push('CONTRACT VIOLATED');
  if (artifact.measurementFailed !== undefined && artifact.measurementFailed !== null) {
    reasons.push(`measurement: ${artifact.measurementFailed}`);
  }
  if (artifact.mode === 'live' && artifact.requestsObservedSource !== 'guard') {
    reasons.push('no guard observation');
  }
  return reasons;
}

/**
 * A run-level halt: the failure must stop the whole invocation instead of
 * being recorded as one more failed sample (a lost measurement, or an
 * auth/quota/rate-limit wall that would silently poison every later artifact).
 */
export class BenchStopError extends Error {
  readonly code = 'BENCH_STOP';

  constructor(reason: string) {
    super(reason);
    this.name = 'BenchStopError';
  }
}

const AUTH_OR_QUOTA_RE = /\b(?:401|403|429)\b|quota|rate[ _-]?limit|auth_error|insufficient/i;

/** Reason to stop the whole run after this artifact, or null to continue. */
export function stopReasonForArtifact(artifact: RunArtifact): string | null {
  if (artifact.measurementFailed !== undefined && artifact.measurementFailed !== null) {
    return `measurement failure in ${artifact.runId}: ${artifact.measurementFailed}`;
  }
  if (artifact.child?.status === 'ok' && !artifact.childTimedOut) return null;
  if (artifact.mode !== 'live') return null;
  const text = `${artifact.child?.errorText ?? ''} ${artifact.note ?? ''}`;
  if (AUTH_OR_QUOTA_RE.test(text)) {
    return `auth/quota/rate-limit wall in ${artifact.runId}: ${text.trim().slice(0, 200)}`;
  }
  return null;
}

function outcomeLabel(artifact: RunArtifact): string {
  if (artifact.kind === 'task' && artifact.grade !== undefined) {
    if (taskPassed(artifact)) return 'graded pass';
    if (!artifact.grade.passed) return 'graded fail';
    const reasons = taskNotCountedReasons(artifact);
    return reasons.length === 1 && reasons[0] === 'CONTRACT VIOLATED'
      ? 'graded pass but CONTRACT VIOLATED'
      : `graded pass but NOT COUNTED (${reasons.join(', ')})`;
  }
  if (artifact.replay !== undefined) {
    return `requests=${String(artifact.requestsObserved)} misreported=${String(artifact.replay.misreportedSuccess)} incompleteTools=${String(artifact.replay.incompleteToolExecutions)}`;
  }
  return artifact.child?.status ?? 'no-result';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export const HELP = `gpt-adaptation-bench — GPT adaptation paired benchmark

Usage:
  pnpm -C packages/klient bench:gpt-adaptation -- --freeze --freeze-mode live --run-id <id>
  pnpm -C packages/klient bench:gpt-adaptation -- --dry-run --run-id <id>
  pnpm -C packages/klient bench:gpt-adaptation -- --stub --run-id <id>
  pnpm -C packages/klient bench:gpt-adaptation -- --live --run-id <id> [--auth-home <dir>]
  pnpm -C packages/klient bench:gpt-adaptation -- --report <run-dir>

Modes:
  --dry-run   (default) validate the frozen manifest, print the run order and budget
  --stub      offline plan: deterministic loopback fixtures per arm (no network, no credentials)
  --live      measured plan against the real backend (durable request cap per run and globally)
  --report    read-only rebuild of a finished run directory
Options:
  --freeze            (re)write the frozen manifest; refused once results exist
  --freeze-mode       live|offline (which mode this manifest is for; default live; --stub only matches offline)
  --selftest          scorer self-test + sandbox escape probes, offline
  --preflight         probe model/auth readiness on both arm roots (1 request each)
  --only task|cache|replay|preflight|all
  --run <run-id>      execute a single planned run id
  --out <dir>         benchmark root (default .tmp/gpt-adaptation-bench)
  --baseline <dir>    frozen baseline snapshot
  --budget <n>        request cap; can never exceed the frozen manifest budget
  --model <id>        live model id (never falls back)
  --effort <level>    fixed thinking effort for both arms
  --auth-home <dir>   home holding the managed OAuth login (live only; never the run home)
  --seed <n>          ordering seed (frozen in the manifest)
`;

export async function main(argv: readonly string[]): Promise<number> {
  const defaults = {
    outDir: join(REPO_ROOT, '.tmp', 'gpt-adaptation-bench'),
    runId: `run-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`,
  };
  const options = parseArgs(argv, defaults);
  if (options.help) {
    console.log(HELP);
    return 0;
  }

  if (options.reportDir !== undefined) {
    const artifacts = await loadArtifacts(options.reportDir);
    const ledger = new Ledger(join(dirname(resolve(options.reportDir)), 'ledger.jsonl'));
    await ledger.load();
    const summary = summarize(options.reportDir, artifacts, ledger.consumed());
    for (const line of summary.lines) console.log(line);
    return 0;
  }

  if (options.selftest) {
    console.log('=== scorer self-test ===');
    const scratchRoot = join(options.outDir, 'selftest', 'scorer');
    await rm(scratchRoot, { recursive: true, force: true });
    await mkdir(scratchRoot, { recursive: true });
    const results = await runAllScorerSelfTests({ scratchDir: scratchRoot });
    for (const result of results) {
      console.log(
        `${result.ok ? 'OK  ' : 'FAIL'} ${result.taskId} ${result.variants
          .map((variant) => `${variant.variant}=${variant.passed ? 'pass' : 'fail'}${variant.ok ? '' : '(!)'}`)
          .join(' ')}`,
      );
    }
    console.log('=== sandbox escape probes ===');
    const probes = await runEscapeProbes({
      scratchRoot: join(options.outDir, 'selftest', 'sandbox'),
      runRoot: join(options.outDir, options.runId),
    });
    for (const probe of probes) {
      console.log(
        `${probe.okay ? 'OK  ' : 'FAIL'} ${probe.name.padEnd(24)} ${probe.kind.padEnd(10)} ${probe.blocked ? 'blocked' : 'NOT BLOCKED'} ${probe.detail}`,
      );
    }
    const sandboxOk = probes.every((probe) => probe.okay);
    console.log(`=== result: scorer ${results.every((r) => r.ok) ? 'OK' : 'FAIL'}, sandbox ${sandboxOk ? 'OK' : 'FAIL'} ===`);
    return results.every((result) => result.ok) && sandboxOk ? 0 : 1;
  }

  const runRoot = join(options.outDir, options.runId);
  await mkdir(runRoot, { recursive: true });
  const ledger = new Ledger(join(options.outDir, 'ledger.jsonl'));
  await ledger.load();
  const manifestPath = join(runRoot, 'manifest.json');

  if (options.freeze) {
    const runsDir = join(runRoot, 'runs');
    if (existsSync(runsDir) && (await readdir(runsDir)).length > 0) {
      throw new Error('refusing to re-freeze a run directory that already has results; use a new --run-id');
    }
    if (options.budget > BENCH_BUDGET_TOTAL) {
      throw new Error(
        `--budget ${String(options.budget)} exceeds the experiment cap ${String(BENCH_BUDGET_TOTAL)}; ` +
          'freezing is the one place the caps must not be raised',
      );
    }
    if (options.budget < BENCH_PREFLIGHT_ALLOWANCE) {
      throw new Error(
        `--budget ${String(options.budget)} is below the preflight allowance ${String(BENCH_PREFLIGHT_ALLOWANCE)}`,
      );
    }
    if (!existsSync(join(options.baselineDir, 'packages', 'agent-core-v2', 'src', 'index.ts'))) {
      throw new Error(`baseline source tree not found at ${options.baselineDir}`);
    }
    const plan = buildRunPlan(options.seed);
    const baselineFiles = await hashFiles(options.baselineDir, BASELINE_PROVENANCE_FILES);
    const overlayDigests: Record<string, string> = {};
    let overlayMatchesBaseline = true;
    for (const whitelisted of CANDIDATE_WHITELIST) {
      const relativePath = join('packages', 'agent-core-v2', whitelisted);
      const current = await readFile(join(REPO_ROOT, relativePath), 'utf8');
      const baseline = await readFile(join(options.baselineDir, relativePath), 'utf8').catch(() => '');
      overlayDigests[whitelisted] = sha256(current);
      if (sha256(baseline) !== sha256(current)) overlayMatchesBaseline = false;
    }
    const manifest: BenchManifest = {
      bench: BENCH_VERSION,
      taskSetId: BENCH_TASK_SET_ID,
      createdAt: new Date().toISOString(),
      seed: options.seed,
      intendedMode: options.freezeMode,
      budget: { total: options.budget, preflight: BENCH_PREFLIGHT_ALLOWANCE },
      files: await hashFiles(KLIENT_DIR, FROZEN_FILE_NAMES),
      baseline: {
        gitHead: existsSync(join(options.baselineDir, '.git-head'))
          ? (await readFile(join(options.baselineDir, '.git-head'), 'utf8')).trim()
          : '<unrecorded>',
        dir: options.baselineDir,
        engineTreeDigest: await engineTreeDigest(join(options.baselineDir, 'packages', 'agent-core-v2', 'src')),
        workspaceTreeDigest: await engineTreeDigest(join(options.baselineDir, 'packages')),
        files: baselineFiles,
      },
      candidate: {
        strategy: 'baseline-copy+whitelist-overlay',
        source: REPO_ROOT,
        whitelist: [...CANDIDATE_WHITELIST],
        overlayDigests,
        overlayMatchesBaseline,
      },
      ablation: {
        arm: BENCH_ABLATION_ARM,
        mechanism: 'fetch-guard strips the session-id header (case-insensitive) from the outgoing request',
        source: 'identical to candidate',
      },
      replayScriptDigests: Object.fromEntries(REPLAY_SCRIPTS.map((script) => [script.id, scriptDigest(script)])),
      planDigest: planDigest(plan),
      model: {
        live: options.model,
        liveEffort: options.effort,
        offlineModelId: BENCH_MODEL_ID,
        offlineEffort: BENCH_LIVE_EFFORT,
        effortsAdvertised: ['low', 'medium', 'high'],
      },
      expected: {
        taskRuns: plan.filter((item) => item.kind === 'task').length,
        cacheSessions: plan.filter((item) => item.kind === 'cache').length,
        cacheRequests: plan.filter((item) => item.kind === 'cache').length * BENCH_CACHE_REQUESTS_PER_SESSION,
        replayRuns: plan.filter((item) => item.kind === 'replay').length,
        reservedRequests: reservedRequests(plan),
      },
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`frozen manifest written to ${manifestPath}`);
    console.log(`intended mode ${manifest.intendedMode}; task set ${manifest.taskSetId}`);
    console.log(`planDigest ${manifest.planDigest}`);
    console.log(
      `baseline head ${manifest.baseline.gitHead} engineTree=${manifest.baseline.engineTreeDigest.slice(0, 16)}`,
    );
    for (const [name, hash] of Object.entries(manifest.baseline.files)) {
      console.log(`  baseline ${name} ${hash}`);
    }
    for (const [name, hash] of Object.entries(manifest.files)) {
      console.log(`  harness  ${name} ${hash}`);
    }
    if (manifest.candidate.overlayMatchesBaseline) {
      console.log('candidate whitelist files are identical to the baseline (no implemented change yet)');
    }
    return 0;
  }

  if (!existsSync(manifestPath)) {
    throw new Error(`no frozen manifest at ${manifestPath}; run --freeze first`);
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BenchManifest;

  const mode: BenchMode = options.mode === 'live' ? 'live' : 'offline';
  if (options.mode !== 'dry-run' && mode !== manifest.intendedMode) {
    throw new Error(
      `this manifest is frozen for mode "${manifest.intendedMode}" but the invocation is "${mode}"; ` +
        'stub and live results may never be mixed in one run directory',
    );
  }

  const plan = buildRunPlan(manifest.seed);
  const digest = planDigest(plan);
  if (digest !== manifest.planDigest) {
    throw new Error(
      `run plan changed after freezing (expected ${manifest.planDigest}, recomputed ${digest}); re-freeze with a new --run-id`,
    );
  }
  if (options.mode !== 'dry-run' && manifest.model !== undefined) {
    if (mode === 'live' && options.model !== manifest.model.live) {
      throw new Error(
        `--model ${options.model} differs from the frozen live model ${manifest.model.live}; the model is part of the frozen experiment`,
      );
    }
    const frozenEffort = mode === 'live' ? manifest.model.liveEffort : manifest.model.offlineEffort;
    if (options.effort !== frozenEffort) {
      throw new Error(
        `--effort ${options.effort} differs from the frozen ${mode} effort ${frozenEffort}; the effort is part of the frozen experiment`,
      );
    }
  }

  const selected = plan
    .filter((item) => options.only === 'all' || item.kind === options.only)
    .filter((item) => options.onlyRunId === undefined || item.runId === options.onlyRunId);
  if (selected.length === 0) {
    throw new Error(
      `no planned runs match --only ${options.only}${options.onlyRunId === undefined ? '' : ` --run ${options.onlyRunId}`}`,
    );
  }
  // Already-settled runs stay in the plan and are skipped, so their reserve must
  // not be charged twice against the remaining budget.
  const settledRunIds = ledger.settledRunIds();
  const pending = selected.filter((item) => !(mode === 'live' && settledRunIds.has(item.runId)));
  const reserved = reservedRequests(pending);
  const modeCap = Math.min(options.budget, manifest.budget.total);
  if (options.budget > manifest.budget.total) {
    throw new Error(
      `--budget ${String(options.budget)} exceeds the frozen budget ${String(manifest.budget.total)}; the frozen cap cannot be raised`,
    );
  }

  if (options.mode === 'dry-run') {
    console.log('mode dry-run (no network, no credentials)');
    console.log(`run dir ${runRoot}`);
    console.log(`plan digest ${digest}`);
    console.log(
      `runs: ${String(selected.filter((item) => item.kind === 'task').length)} task, ` +
        `${String(selected.filter((item) => item.kind === 'cache').length)} cache session, ` +
        `${String(selected.filter((item) => item.kind === 'replay').length)} replay`,
    );
    console.log(
      `reserved live requests ${String(reserved)} = task ${String(reservedRequests(selected.filter((i) => i.kind === 'task')))} + cache ${String(reservedRequests(selected.filter((i) => i.kind === 'cache')))} (replay is local)`,
    );
    console.log(
      `durable ledger: consumed ${String(ledger.consumed())} of frozen budget ${String(manifest.budget.total)} (cap in force ${String(modeCap)})`,
    );
    for (const item of selected) {
      console.log(`  ${item.runId.padEnd(44)} ${item.kind.padEnd(6)} ${item.arm}`);
    }
    return 0;
  }

  // The sandbox is a hard requirement: without it the tests tool would have
  // filesystem and network access, so no run may proceed.
  const sandbox = await probeSandbox();
  if (!sandbox.supported) {
    throw new Error(
      `refusing to run: the test sandbox is unavailable (${sandbox.reason ?? 'unsupported'}), ` +
        'which would let benchmark tests read the hidden grader and the network',
    );
  }

  if (mode === 'live') {
    const preflightRemaining = Math.max(0, BENCH_PREFLIGHT_ALLOWANCE - ledger.preflightRuns());
    const planned = ledger.consumed() + reserved + preflightRemaining;
    if (modeCap < planned) {
      throw new Error(
        `budget ${String(modeCap)} cannot cover ${String(ledger.consumed())} consumed + ${String(reserved)} reserved + ${String(preflightRemaining)} preflight allowance`,
      );
    }
  }

  const armRoots = await prepareArmRoots({ baselineDir: options.baselineDir, runRoot });
  for (const note of armRoots.notes) console.log(`arm: ${note}`);
  // The candidate arm must carry exactly the frozen overlay: this is what makes
  // the whitelisted adapter files the whole implemented change at runtime.
  const overlayInArmVerified = (
    await Promise.all(
      CANDIDATE_WHITELIST.map(async (whitelisted) => {
        const inArm = await readFile(
          join(armRoots.roots.candidate, 'packages', 'agent-core-v2', whitelisted),
          'utf8',
        ).catch(() => '<missing>');
        return sha256(inArm) === manifest.candidate.overlayDigests[whitelisted];
      }),
    )
  ).every((verified) => verified);
  if (!overlayInArmVerified) {
    throw new Error('the candidate arm does not carry the frozen overlay; refusing to measure it');
  }
  console.log(`candidate arm carries the frozen overlay (${String(CANDIDATE_WHITELIST.length)} files)`);

  // Verify the frozen baseline, and that every arm resolves its workspace
  // packages from inside its own root.
  const baselineTreeNow = await engineTreeDigest(join(options.baselineDir, 'packages', 'agent-core-v2', 'src'));
  if (baselineTreeNow !== manifest.baseline.engineTreeDigest) {
    throw new Error(
      `the baseline snapshot changed after freezing (engine tree ${baselineTreeNow.slice(0, 16)} != ${manifest.baseline.engineTreeDigest.slice(0, 16)})`,
    );
  }
  const baselineWorkspaceNow = await engineTreeDigest(join(options.baselineDir, 'packages'));
  if (
    manifest.baseline.workspaceTreeDigest !== undefined &&
    baselineWorkspaceNow !== manifest.baseline.workspaceTreeDigest
  ) {
    throw new Error(
      `the baseline workspace tree changed after freezing (packages/ ${baselineWorkspaceNow.slice(0, 16)} != ${manifest.baseline.workspaceTreeDigest.slice(0, 16)}); ` +
        'every arm dependency must be the frozen one',
    );
  }
  const baselineFilesNow = await hashFiles(options.baselineDir, BASELINE_PROVENANCE_FILES);
  const baselineDrift = compareFileHashes(manifest.baseline.files, baselineFilesNow);
  if (baselineDrift.length > 0) {
    throw new Error(`baseline provenance files changed after freezing: ${baselineDrift.join(', ')}`);
  }
  // The candidate overlay is the whole implemented change: re-hash the
  // whitelisted files from the working tree and refuse a drifted overlay.
  // Modifications anywhere else in the working tree are explicitly out of
  // scope for this experiment (an arm never sees them).
  const overlayDrift: string[] = [];
  for (const whitelisted of CANDIDATE_WHITELIST) {
    const current = await readFile(join(REPO_ROOT, 'packages', 'agent-core-v2', whitelisted), 'utf8');
    if (manifest.candidate.overlayDigests[whitelisted] !== sha256(current)) {
      overlayDrift.push(whitelisted);
    }
  }
  if (overlayDrift.length > 0) {
    throw new Error(
      `the candidate overlay changed after freezing: ${overlayDrift.join(', ')}; re-freeze with a new --run-id`,
    );
  }
  const harnessNow = await hashFiles(KLIENT_DIR, FROZEN_FILE_NAMES);
  const drifted = compareFileHashes(manifest.files, harnessNow);
  if (drifted.length > 0) {
    throw new Error(
      `frozen harness files changed: ${drifted.join(', ')}; re-freeze with a new --run-id`,
    );
  }
  const resolution: ResolutionReport[] = [];
  for (const arm of new Set(selected.map((item) => item.arm))) {
    resolution.push(await verifyArmResolution({ arm, armRoot: armRoots.roots[arm], runRoot }));
  }
  for (const report of resolution) {
    if (!report.allInsideArmRoot || report.failed.length > 0) {
      throw new Error(
        `arm ${report.arm} resolves a workspace package outside its root: ${report.failed
          .map((entry) => `${entry.specifier} (${entry.error})`)
          .join(', ')}${report.allInsideArmRoot ? '' : ' [path escaped arm root]'}`,
      );
    }
    console.log(`arm ${report.arm}: ${String(report.resolved.length)} workspace specifiers pinned inside the arm root`);
  }

  await writeFile(
    join(runRoot, 'run.json'),
    `${JSON.stringify(
      {
        mode,
        runId: options.runId,
        startedAt: new Date().toISOString(),
        manifestDigest: sha256(await readFile(manifestPath, 'utf8')),
        planDigest: digest,
        model: mode === 'live' ? options.model : BENCH_MODEL_ID,
        effort: options.effort,
        armRoots: armRoots.roots,
        armTsConfigs: armRoots.tsConfigs,
        sandbox,
        resolution,
        budget: { frozen: manifest.budget.total, cap: modeCap, reserved },
        workingTree: {
          whitelist: [...CANDIDATE_WHITELIST],
          overlayMatchesBaseline: manifest.candidate.overlayMatchesBaseline,
          overlayVerified: true,
          overlayInArmVerified,
          baselineWorkspaceTreeDigest: manifest.baseline.workspaceTreeDigest,
          note: 'only the whitelist is overlaid onto a frozen baseline copy; every other working-tree modification is out of scope and never reaches an arm',
        },
        modelPolicy: {
          frozenLive: manifest.model?.live ?? null,
          frozenLiveEffort: manifest.model?.liveEffort ?? null,
          frozenOfflineEffort: manifest.model?.offlineEffort ?? null,
          expectedWireModel: mode === 'live' ? (options.model.split('/').at(-1) ?? '') : null,
          liveEndpoint: mode === 'live'
            ? { host: 'chatgpt.com', path: '/backend-api/codex/responses', policy: 'fail-closed at the fetch guard' }
            : null,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const artifacts: RunArtifact[] = [];
  const context: RunContext = { options, mode, runRoot, armRoots, ledger, manifest };
  let stopReason: string | null = null;

  const execute = async (item: RunPlanItem): Promise<void> => {
    if (ledger.settledRunIds().has(item.runId) && options.mode === 'live') {
      console.log(`skip ${item.runId} (already settled in the durable ledger)`);
      return;
    }
    const reserveAmount =
      item.kind === 'task'
        ? BENCH_TASK_REQUEST_CAP
        : item.kind === 'cache'
          ? BENCH_CACHE_REQUESTS_PER_SESSION
          : item.kind === 'preflight'
            ? 1
            : 0;
    if (mode === 'live' && item.kind !== 'replay') {
      if (ledger.consumed() + reserveAmount > modeCap) {
        throw new Error(
          `durable request budget exhausted (${String(ledger.consumed())}/${String(modeCap)}); stopping before ${item.runId}`,
        );
      }
      await ledger.append({
        ts: new Date().toISOString(),
        kind: 'reserve',
        runId: item.runId,
        arm: item.arm,
        runKind: item.kind,
        reserved: reserveAmount,
      });
    }
    const artifact = await runItem(context, item);
    artifacts.push(artifact);
    if (mode === 'live' && item.kind !== 'replay') {
      const tickets = await readGuardTickets(runRoot, item.runId);
      const consumed = tickets?.count ?? reserveAmount;
      await ledger.append({
        ts: new Date().toISOString(),
        kind: 'settle',
        runId: item.runId,
        arm: item.arm,
        runKind: item.kind,
        consumed: Math.min(consumed, reserveAmount),
        status: artifact.child?.status ?? 'no-result',
        note:
          tickets === undefined
            ? 'ticket state missing: the full reserve is charged (the missing measurement is never used as the observed count)'
            : undefined,
      });
    }
    console.log(`${item.runId.padEnd(44)} ${outcomeLabel(artifact)}`);
    const reason = stopReasonForArtifact(artifact);
    if (reason !== null) {
      throw new BenchStopError(reason);
    }
  };

  try {
    if (options.preflight) {
      let preflightFailed = false;
      for (const arm of ['baseline', 'candidate'] as const) {
        const used = ledger.preflightRuns();
        if (used >= BENCH_PREFLIGHT_ALLOWANCE) {
          console.log(`preflight allowance ${String(BENCH_PREFLIGHT_ALLOWANCE)} already spent`);
          break;
        }
        const item: RunPlanItem = { runId: `preflight${String(used + 1)}__${arm}`, kind: 'preflight', arm };
        await execute(item);
        const preflight = artifacts.at(-1)?.child?.preflight;
        console.log(
          `preflight ${arm}: authReady=${String(preflight?.authReady)} responded=${String(preflight?.responded)}` +
            (preflight?.text === undefined ? '' : ` text=${JSON.stringify(preflight.text)}`) +
            (preflight?.errorText === undefined ? '' : ` error=${preflight.errorText}`),
        );
        if (preflight?.responded !== true) {
          preflightFailed = true;
          break;
        }
      }
      if (preflightFailed) {
        stopReason = 'preflight failed — no formal run may start from a failed availability probe';
      } else {
        console.log('preflight ok — rerun without --preflight for the formal plan');
      }
    } else {
      for (const item of selected) await execute(item);
    }
  } catch (error) {
    if (!(error instanceof BenchStopError)) throw error;
    stopReason = error.message;
    console.log(`stopping the run: ${error.message}`);
  }

  const summary = summarize(runRoot, artifacts, ledger.consumed());
  await writeFile(join(runRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log('');
  for (const line of summary.lines) console.log(line);
  if (stopReason !== null) {
    console.log('');
    console.log(`run stopped early: ${stopReason}`);
    return 1;
  }
  return 0;
}

export async function runCli(argv: readonly string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (error) {
    console.error(`benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('gpt-adaptation-bench.ts')) {
  process.exit(await runCli(process.argv.slice(2)));
}

export { clusterBootstrap, cp, renderSse, taskVisibleTests, tmpdir, homedir, extractFidelity };
export type { ReportSummary };
