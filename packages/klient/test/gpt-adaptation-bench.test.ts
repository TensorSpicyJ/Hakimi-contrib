/**
 * Offline tests for the GPT adaptation benchmark harness.
 *
 * Everything here runs without network access, credentials or the user's home.
 * The end-to-end cases drive the real engine loop, the bounded tools, the
 * sandboxed test runner and the hidden grader through the benchmark's own
 * loopback fixtures; the live path is never exercised.
 */

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { BENCH_TASKS, BENCH_WORKSPACE_ALLOWED_TOOLS, type BenchTask } from '../examples/gpt-adaptation-bench.tasks.js';
import { gradeWorkspace, parseTapSummary, runAllScorerSelfTests, writeTree } from '../examples/gpt-adaptation-bench.scorer.js';
import {
  REPLAY_SCRIPTS,
  expectedMetadata,
  expectedMetadataBefore,
  extractFidelity,
  renderSse,
  scriptDigest,
  summarizeHeaders,
} from '../examples/gpt-adaptation-bench.events.js';
import {
  SANDBOX_MAX_OUTPUT_BYTES,
  SANDBOX_OUTPUT_TRUNCATION_MARKER,
  maskTargets,
  probeSandbox,
  resolvedUserHome,
  runEscapeProbes,
  runSandboxed,
  sandboxLauncherDescription,
  scratchRoot,
} from '../examples/gpt-adaptation-bench.sandbox.js';
import {
  BENCH_ABLATION_ARM,
  BENCH_BUDGET_TOTAL,
  BENCH_CACHE_REQUESTS_PER_SESSION,
  BENCH_TASK_REQUEST_CAP,
  buildRunPlan,
  parseArgs,
  planDigest,
  prepareArmRoots,
  reservedRequests,
  turnBudgetsFor,
  verifyArmResolution,
  engineTreeDigest,
  CANDIDATE_WHITELIST,
} from '../examples/gpt-adaptation-bench.js';
import { engineFingerprint } from '../examples/gpt-adaptation-bench.arm.js';
import { Ledger, clusterBootstrap, replayCoverageRow, summarize } from '../examples/gpt-adaptation-bench.report.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const KLIENT_DIR = join(REPO_ROOT, 'packages', 'klient');
const TSX_CLI = createRequire(join(KLIENT_DIR, 'package.json')).resolve('tsx/cli');
let BASELINE_DIR: string;
let disposeBaseline: (() => Promise<void>) | undefined;

const TEST_SCRATCH_ROOT = join(REPO_ROOT, '.tmp', 'gpt-adaptation-bench', 'test-scratch');

beforeAll(async () => {
  const fixture = await scratch();
  disposeBaseline = fixture.dispose;
  BASELINE_DIR = join(fixture.dir, 'baseline');
  await mkdir(BASELINE_DIR);
  for (const path of ['packages', 'build', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.json']) {
    await cp(join(REPO_ROOT, path), join(BASELINE_DIR, path), {
      recursive: true,
      filter: (source) => !/(?:^|\/)(?:node_modules|dist|reports|\.tmp)(?:\/|$)/.test(source),
    });
  }
  await writeFile(join(BASELINE_DIR, 'packages', 'agent-core-v2', 'src', 'benchmark-baseline-marker.ts'),
    'export const baselineFixture = true;\n');
}, 30_000);

afterAll(async () => {
  await disposeBaseline?.();
});

/**
 * Every test scratch directory lives inside the working tree (never the system
 * temp directory), so nothing this benchmark creates or removes is outside the
 * repository's own `.tmp` area.
 */
async function scratch(): Promise<{ dir: string; dispose: () => Promise<void> }> {
  await mkdir(TEST_SCRATCH_ROOT, { recursive: true });
  const dir = await mkdtemp(join(TEST_SCRATCH_ROOT, 'case-'));
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
}

function runProcess(
  argv: readonly string[],
  options: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: options.cwd,
      env: { PATH: process.env['PATH'] ?? '', ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 300_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function runBenchmark(
  args: readonly string[],
  options: { outDir?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runProcess(
    [
      process.execPath,
      TSX_CLI,
      '--tsconfig',
      join(KLIENT_DIR, 'tsconfig.examples.json'),
      '--import',
      join(REPO_ROOT, 'build', 'register-raw-text-loader.mjs'),
      join(KLIENT_DIR, 'examples', 'gpt-adaptation-bench.ts'),
      ...args,
    ],
    { cwd: KLIENT_DIR, env: options.outDir === undefined ? {} : { BENCH_TEST_OUT: options.outDir } },
  );
}

describe('task set', () => {
  test('ships exactly twelve distinct tasks with real tool-using prompts', () => {
    expect(BENCH_TASKS.length).toBe(12);
    expect(new Set(BENCH_TASKS.map((task) => task.id)).size).toBe(12);
    for (const task of BENCH_TASKS) {
      expect(task.prompts.length).toBeGreaterThan(0);
      expect(task.grader.includes('node:test')).toBe(true);
      expect(Object.keys(task.files).length).toBeGreaterThan(0);
      expect(Object.keys(task.reference).length).toBeGreaterThan(0);
      expect(Object.keys(task.wrong).length).toBeGreaterThan(0);
    }
  });

  test('covers the required behaviour classes and a resume task', () => {
    const tags = new Set(BENCH_TASKS.map((task) => task.exercise));
    for (const required of [
      'cross-file-fix',
      'constrained-feature',
      'serial-dependent-calls',
      'multi-file-read',
      'fix-failing-test',
      'multi-turn-constraint',
      'resume-continue',
      'long-tool-result',
    ] as const) {
      expect(tags.has(required)).toBe(true);
    }
    expect(BENCH_TASKS.some((task) => task.resumeAfter !== undefined)).toBe(true);
  });
});

describe('scorer', () => {
  test('parses the tap summary', () => {
    expect(parseTapSummary('# tests 3\n# pass 2\n# fail 1\n')).toEqual({ tests: 3, pass: 2, fail: 1 });
  });

  test(
    'empty / wrong / tampered variants fail and the reference patch passes for all 12 tasks',
    { timeout: 300_000 },
    async () => {
      const { dir, dispose } = await scratch();
      try {
        const results = await runAllScorerSelfTests({ scratchDir: dir });
        const broken = results.filter((result) => !result.ok);
        expect(
          broken
            .map(
              (result) =>
                `${result.taskId}: ${result.variants
                  .filter((variant) => !variant.ok)
                  .map((variant) => `${variant.variant}(${variant.detail})`)
                  .join(' | ')}`,
            )
            .join('\n'),
        ).toBe('');
        expect(results.length).toBe(12);
      } finally {
        await dispose();
      }
    },
  );

  test('a workspace collision with the private grader path is a failed grade, not a runner crash', async () => {
    const { dir, dispose } = await scratch();
    try {
      const task = BENCH_TASKS[0] as BenchTask;
      const workspace = join(dir, 'ws');
      await writeTree(workspace, { ...task.files, ...task.reference, __hidden__: 'not a directory' });
      const grade = await gradeWorkspace(task, workspace, { scratchDir: dir });
      expect(grade.passed).toBe(false);
      expect(grade.failures.join(' ')).toContain('grader setup failed');
    } finally {
      await dispose();
    }
  });

  test('runs the hidden grader inside the sandbox, never on the host', { timeout: 300_000 }, async () => {
    const { dir, dispose } = await scratch();
    try {
      const task = BENCH_TASKS[0] as BenchTask;
      const workspace = join(dir, 'ws');
      await writeTree(workspace, { ...task.files, ...task.reference });
      const grade = await gradeWorkspace(task, workspace, { scratchDir: join(dir, 'ignored') });
      expect(grade.sandboxed).toBe(true);
      expect(grade.passed).toBe(true);
      expect(grade.sandboxReason).toBeUndefined();
    } finally {
      await dispose();
    }
  });

  test(
    'the grading root holds only the workspace copy plus the single grader file',
    { timeout: 300_000 },
    async () => {
      const { dir, dispose } = await scratch();
      try {
        const task = BENCH_TASKS[0] as BenchTask;
        const referenceText = Object.values(task.reference).join('\n');
        const synthetic = {
          ...task,
          id: 'SYNTH-grading-root',
          grader: [
            "import { test } from 'node:test';",
            "import assert from 'node:assert/strict';",
            "import { readFileSync, readdirSync, statSync } from 'node:fs';",
            "import { join } from 'node:path';",
            'function walk(dir: string): string[] {',
            '  const out: string[] = [];',
            '  for (const entry of readdirSync(dir)) {',
            '    const full = join(dir, entry);',
            '    if (statSync(full).isDirectory()) out.push(...walk(full));',
            '    else out.push(full.slice(process.cwd().length + 1));',
            '  }',
            '  return out;',
            '}',
            "test('the grading root is minimal and holds no reference patch', () => {",
            '  const files = walk(process.cwd()).sort();',
            "  assert.deepEqual(files, ['__hidden__/" + task.graderFileName + "', 'package.json', 'src/cart.ts', 'src/discount.ts', 'src/money.ts', 'test/cart.test.ts']);",
            '  for (const file of files) {',
            "    if (file.startsWith('__hidden__')) continue;",
            "    const content = readFileSync(file, 'utf8');",
            "    assert.ok(!content.includes('1 - percentOff / 100'), file + ' still holds the reference solution');",
            '  }',
            '});',
            '',
          ].join('\n'),
        } as BenchTask;
        const workspace = join(dir, 'ws');
        await writeTree(workspace, synthetic.files);
        const grade = await gradeWorkspace(synthetic, workspace, { scratchDir: join(dir, 'ignored') });
        expect(grade.sandboxed).toBe(true);
        expect(grade.failures.join(' ')).toBe('');
        expect(grade.passed).toBe(true);
        expect(referenceText.length).toBeGreaterThan(0);
      } finally {
        await dispose();
      }
    },
  );

  test(
    'a grader that tries to read a host file cannot do so',
    { timeout: 300_000 },
    async () => {
      const { dir, dispose } = await scratch();
      try {
        // Sentinel inside the working tree: the grader must not reach it.
        const sentinelDir = join(TEST_SCRATCH_ROOT, 'sentinel');
        await mkdir(sentinelDir, { recursive: true });
        const sentinelPath = join(sentinelDir, `host-${Math.random().toString(36).slice(2, 8)}.txt`);
        await writeFile(sentinelPath, 'host-only-secret\n', 'utf8');
        const synthetic = {
          ...(BENCH_TASKS[0] as BenchTask),
          id: 'SYNTH-grader-escape',
          grader: [
            "import { test } from 'node:test';",
            "import assert from 'node:assert/strict';",
            "import { readFileSync } from 'node:fs';",
            `test('cannot read the host sentinel', () => {`,
            `  assert.throws(() => readFileSync(${JSON.stringify(sentinelPath)}, 'utf8'));`,
            `});`,
            '',
          ].join('\n'),
          exact: undefined,
        } as BenchTask;
        const workspace = join(dir, 'ws');
        await writeTree(workspace, synthetic.files);
        const grade = await gradeWorkspace(synthetic, workspace, { scratchDir: join(dir, 'ignored') });
        expect(grade.sandboxed).toBe(true);
        expect(grade.passed).toBe(true);
        expect(grade.tally.pass).toBe(1);
        await rm(sentinelPath, { force: true });
      } finally {
        await dispose();
      }
    },
  );

  test(
    'model code imported by the grader cannot read host files or escape',
    { timeout: 300_000 },
    async () => {
      const { dir, dispose } = await scratch();
      try {
        const escapeProbePath = join(REPO_ROOT, 'packages', 'klient', 'examples', 'gpt-adaptation-bench.tasks.ts');
        const synthetic = {
          ...(BENCH_TASKS[0] as BenchTask),
          id: 'SYNTH-model-escape',
          files: {
            'src/evil.ts': [
              "import { spawnSync } from 'node:child_process';",
              "import { readFileSync } from 'node:fs';",
              'export function triesToEscape(): string[] {',
              '  const out: string[] = [];',
              `  try { readFileSync(${JSON.stringify(escapeProbePath)}, 'utf8'); out.push('read-grader-source'); } catch { /* blocked */ }`,
              `  try { readFileSync('/proc/${String(process.pid)}/root${escapeProbePath}', 'utf8'); out.push('proc-root'); } catch { /* blocked */ }`,
              "  const umount = spawnSync('umount', ['/work'], { encoding: 'utf8' });",
              "  if (umount.status === 0) out.push('umount');",
              `  const fetchAttempt = spawnSync('/bin/node', ['-e', 'fetch("https://example.com").then(()=>process.exit(0)).catch(()=>process.exit(3))']);`,
              '  if (fetchAttempt.status === 0) out.push(\'network\');',
              '  return out;',
              '}',
              '',
            ].join('\n'),
          },
          grader: [
            "import { test } from 'node:test';",
            "import assert from 'node:assert/strict';",
            "import { triesToEscape } from '../src/evil.ts';",
            "test('model code has no escape hatch', () => {",
            "  assert.deepEqual(triesToEscape(), []);",
            "});",
            '',
          ].join('\n'),
          exact: undefined,
        } as BenchTask;
        const workspace = join(dir, 'ws');
        await writeTree(workspace, synthetic.files);
        const grade = await gradeWorkspace(synthetic, workspace, { scratchDir: join(dir, 'ignored') });
        expect(grade.sandboxed).toBe(true);
        expect(grade.failures.join(' ')).not.toContain('read-grader-source');
        expect(grade.passed).toBe(true);
      } finally {
        await dispose();
      }
    },
  );

  test('grades a pristine workspace as a failure and the reference patch as a pass', async () => {
    const { dir, dispose } = await scratch();
    try {
      const task = BENCH_TASKS[0] as BenchTask;
      const pristine = join(dir, 'pristine');
      await writeTree(pristine, task.files);
      const pristineGrade = await gradeWorkspace(task, pristine, { scratchDir: join(dir, 'g1') });
      expect(pristineGrade.passed).toBe(false);
      const reference = join(dir, 'reference');
      await writeTree(reference, { ...task.files, ...task.reference });
      const referenceGrade = await gradeWorkspace(task, reference, { scratchDir: join(dir, 'g2') });
      expect(referenceGrade.passed).toBe(true);
      expect(referenceGrade.exact.every((check) => check.ok)).toBe(true);
    } finally {
      await dispose();
    }
  });
});

describe('run plan', () => {
  test('freezes 48 task runs, 16 cache sessions and 18 replay runs inside the budget', () => {
    const plan = buildRunPlan(20260915);
    expect(plan.filter((item) => item.kind === 'task').length).toBe(48);
    expect(plan.filter((item) => item.kind === 'cache').length).toBe(16);
    expect(plan.filter((item) => item.kind === 'replay').length).toBe(18);
    expect(new Set(plan.map((item) => item.runId)).size).toBe(plan.length);
    expect(reservedRequests(plan)).toBe(48 * BENCH_TASK_REQUEST_CAP + 16 * BENCH_CACHE_REQUESTS_PER_SESSION);
    expect(reservedRequests(plan)).toBeLessThanOrEqual(BENCH_BUDGET_TOTAL);
  });

  test('task-pair blocks keep rep0 AB then rep1 BA adjacent', () => {
    const plan = buildRunPlan(20260915);
    for (const task of BENCH_TASKS) {
      const positions = (arm: 'baseline' | 'candidate', repeat: number): number =>
        plan.findIndex((item) => item.taskId === task.id && item.arm === arm && item.repeat === repeat);
      const r0Baseline = positions('baseline', 0);
      const r0Candidate = positions('candidate', 0);
      const r1Baseline = positions('baseline', 1);
      const r1Candidate = positions('candidate', 1);
      // AB then BA, and the four runs are contiguous.
      expect(r0Baseline).toBeLessThan(r0Candidate);
      expect(r1Candidate).toBeLessThan(r1Baseline);
      const indexes = [r0Baseline, r0Candidate, r1Candidate, r1Baseline].sort((a, b) => a - b);
      expect((indexes[3] as number) - (indexes[0] as number)).toBe(3);
      expect(indexes[0]).toBe(r0Baseline);
      expect(indexes[3]).toBe(r1Baseline);
    }
  });

  test('cache pairs interleave the candidate and the ablation arm', () => {
    const plan = buildRunPlan(20260915);
    for (let pair = 0; pair < 8; pair += 1) {
      const rows = plan.filter((item) => item.kind === 'cache' && item.pairIndex === pair);
      expect(rows.length).toBe(2);
      const expectedOrder = pair % 2 === 0 ? ['candidate', BENCH_ABLATION_ARM] : [BENCH_ABLATION_ARM, 'candidate'];
      expect(rows.map((row) => row.arm)).toEqual(expectedOrder);
    }
  });

  test('every task and replay script appears on both arms, and the plan is seed-deterministic', () => {
    const plan = buildRunPlan(20260915);
    for (const script of REPLAY_SCRIPTS) {
      const rows = plan.filter((item) => item.scriptId === script.id);
      expect(rows.map((row) => row.arm)).toEqual(['baseline', 'candidate']);
    }
    for (const task of BENCH_TASKS) {
      const rows = plan.filter((item) => item.taskId === task.id);
      expect(rows.length).toBe(4);
    }
    expect(planDigest(buildRunPlan(7))).toBe(planDigest(buildRunPlan(7)));
    expect(planDigest(buildRunPlan(7))).not.toBe(planDigest(buildRunPlan(8)));
  });

  test('per-turn budgets never let a multi-turn task exceed the task cap', () => {
    expect(turnBudgetsFor(1)).toEqual([6]);
    expect(turnBudgetsFor(2)).toEqual([3, 3]);
    expect(turnBudgetsFor(3)).toEqual([2, 2, 2]);
    for (const count of [1, 2, 3]) {
      const budgets = turnBudgetsFor(count);
      expect(budgets.reduce((total, value) => total + value, 0)).toBeLessThanOrEqual(BENCH_TASK_REQUEST_CAP);
      expect(budgets.every((value) => value >= 1)).toBe(true);
    }
    expect(turnBudgetsFor(2).reduce((a, b) => a + b, 0)).toBe(6);
  });

  test('every task fixture plan fits its per-turn budget', async () => {
    const { taskFixtureTurns } = await import('../examples/gpt-adaptation-bench.js');
    for (const task of BENCH_TASKS) {
      const turns = taskFixtureTurns(task);
      const budgets = turnBudgetsFor(task.prompts.length);
      expect(turns.length).toBe(task.prompts.length);
      turns.forEach((turn, index) => {
        expect(turn.responses.length).toBeLessThanOrEqual(budgets[index] as number);
      });
      // The final turn must not be a no-op: the reference patch is written there.
      const finalTurn = JSON.stringify(turns.at(-1)?.responses ?? []);
      for (const path of Object.keys(task.reference)) {
        expect(finalTurn.includes(path)).toBe(true);
      }
    }
  });

  test('an over-budget fixture plan is refused rather than silently truncated', async () => {
    const { taskFixtureTurns } = await import('../examples/gpt-adaptation-bench.js');
    const reference: Record<string, string> = {};
    for (let index = 0; index < 9; index += 1) reference[`src/f${String(index)}.ts`] = 'export {};\n';
    const fabricated = {
      ...(BENCH_TASKS[0] as BenchTask),
      prompts: ['one turn'],
      reference,
    } as BenchTask;
    expect(() => taskFixtureTurns(fabricated)).toThrow(/exceeds the per-turn budget/);
  });
});

describe('cli', () => {
  test('defaults to dry-run with the frozen budget', () => {
    const options = parseArgs([], { outDir: '/tmp/bench', runId: 'x' });
    expect(options.mode).toBe('dry-run');
    expect(options.seed).toBe(20260915);
    expect(options.budget).toBe(BENCH_BUDGET_TOTAL);
    expect(options.model).toBe('openai-codex/gpt-6-astra');
    expect(options.freezeMode).toBe('live');
  });

  test('rejects a non-numeric or non-positive budget', () => {
    expect(() => parseArgs(['--budget', 'abc'], { outDir: '/tmp/bench', runId: 'x' })).toThrow(/positive integer/);
    expect(() => parseArgs(['--budget', 'NaN'], { outDir: '/tmp/bench', runId: 'x' })).toThrow(/positive integer/);
    expect(() => parseArgs(['--budget', '0'], { outDir: '/tmp/bench', runId: 'x' })).toThrow(/positive integer/);
    expect(() => parseArgs(['--budget', '-5'], { outDir: '/tmp/bench', runId: 'x' })).toThrow(/positive integer/);
  });

  test('accepts the documented modes and rejects unknown flags', () => {
    expect(parseArgs(['--stub'], { outDir: '/tmp/b', runId: 'x' }).mode).toBe('stub');
    expect(parseArgs(['--live'], { outDir: '/tmp/b', runId: 'x' }).mode).toBe('live');
    expect(parseArgs(['--only', 'tasks'], { outDir: '/tmp/b', runId: 'x' }).only).toBe('task');
    expect(() => parseArgs(['--nope'], { outDir: '/tmp/b', runId: 'x' })).toThrow();
  });
});

describe('ledger', () => {
  test('a reserved run that never settled still counts as consumed after a restart', async () => {
    const { dir, dispose } = await scratch();
    try {
      const path = join(dir, 'ledger.jsonl');
      const first = new Ledger(path);
      await first.load();
      await first.append({ ts: 't', kind: 'reserve', runId: 'r1', arm: 'candidate', runKind: 'task', reserved: 6 });
      await first.append({ ts: 't', kind: 'settle', runId: 'r1', arm: 'candidate', runKind: 'task', consumed: 4, status: 'ok' });
      await first.append({ ts: 't', kind: 'reserve', runId: 'r2', arm: 'baseline', runKind: 'task', reserved: 6 });
      await first.append({ ts: 't', kind: 'reserve', runId: 'p1', arm: 'candidate', runKind: 'preflight', reserved: 1 });

      const second = new Ledger(path);
      await second.load();
      // r1 settled at 4, r2 reserved 6 and never settled, preflight reserved 1.
      expect(second.consumed()).toBe(11);
      expect(second.preflightRuns()).toBe(1);
      expect(second.settledRunIds().has('r1')).toBe(true);
      expect(second.settledRunIds().has('r2')).toBe(false);
      expect(second.count('task')).toBe(2);
    } finally {
      await dispose();
    }
  });

  test('a torn trailing line never refunds budget', async () => {
    const { dir, dispose } = await scratch();
    try {
      const path = join(dir, 'ledger.jsonl');
      const ledger = new Ledger(path);
      await ledger.load();
      await ledger.append({ ts: 't', kind: 'reserve', runId: 'r1', arm: 'candidate', runKind: 'cache', reserved: 4 });
      const { appendFile } = await import('node:fs/promises');
      await appendFile(path, '{"ts":"torn"', 'utf8');
      const reloaded = new Ledger(path);
      await reloaded.load();
      expect(reloaded.consumed()).toBe(4);
      expect(reloaded.count('cache')).toBe(1);
    } finally {
      await dispose();
    }
  });
});

describe('sandbox', () => {
  test(
    'every escape probe is blocked, the control works and the boundary state is asserted',
    { timeout: 300_000 },
    async () => {
      const { dir, dispose } = await scratch();
      try {
        const probe = await probeSandbox();
        expect(probe.supported, probe.reason ?? '').toBe(true);
        const probes = await runEscapeProbes({ scratchRoot: dir, runRoot: join(dir, 'run') });
        const failed = probes.filter((entry) => !entry.okay);
        expect(
          failed.map((entry) => `${entry.name}(${entry.kind},blocked=${String(entry.blocked)},${entry.detail})`).join('\n'),
        ).toBe('');
        // Host reads, capability-based escapes, and the network must all fail.
        for (const name of [
          'read-repo-sentinel',
          'read-benchmark-source',
          'read-hidden-grader',
          'read-user-home',
          'proc-host-pid',
          'umount-attempt',
          'chroot-escape',
          'mount-bind',
          'symlink-escape',
          'network-fetch',
          'network-dns',
          'network-child-process',
        ]) {
          const entry = probes.find((candidate) => candidate.name === name);
          expect(entry?.kind, name).toBe('must-block');
          expect(entry?.blocked, `${name}: ${entry?.detail ?? ''}`).toBe(true);
        }
        // Boundary state: one PID (itself), zero capabilities, no inherited host fd.
        const procList = probes.find((entry) => entry.name === 'proc-list');
        expect(procList?.detail).toBe('["1"]');
        const capabilities = probes.find((entry) => entry.name === 'capabilities-empty');
        expect(capabilities?.detail).toMatch(/"prm":"0+"/);
        expect(capabilities?.detail).toMatch(/"eff":"0+"/);
        expect(capabilities?.detail).toMatch(/"bnd":"0+"/);
        expect(capabilities?.detail).toMatch(/"nnp":"1"/);
        const descriptors = probes.find((entry) => entry.name === 'file-descriptors');
        expect(descriptors?.detail ?? '').not.toContain(REPO_ROOT);
        // Control: the sandbox can read its own workspace.
        expect(probes.find((entry) => entry.name === 'read-own-workspace')?.blocked).toBe(false);
      } finally {
        await dispose();
      }
    },
  );

  test('runs a real TS test suite with type stripping inside the sandbox', async () => {
    const { dir, dispose } = await scratch();
    try {
      const workspace = join(dir, 'ws');
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, 'm.ts'), 'export const add = (a: number, b: number): number => a + b;\n');
      await writeFile(
        join(workspace, 't.test.ts'),
        'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./m.ts";\ntest("adds", () => assert.equal(add(1, 2), 3));\n',
      );
      const result = await runSandboxed({
        workspaceDir: workspace,
        // Exactly the argv shape the benchmark's test tool passes.
        innerArgv: [process.execPath, '--test', '--test-reporter=tap', 't.test.ts'],
        scratchRoot: dir,
        timeoutMs: 120_000,
        label: 'unit',
      });
      expect(result.isolated).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(parseTapSummary(result.stdout)).toEqual({ tests: 1, pass: 1, fail: 0 });
    } finally {
      await dispose();
    }
  });

  test('the payload runs from a fresh root that contains only the input files', async () => {
    const { dir, dispose } = await scratch();
    try {
      const workspace = join(dir, 'ws');
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, 'only.txt'), 'only-file\n', 'utf8');
      const result = await runSandboxed({
        workspaceDir: workspace,
        innerArgv: [
          '/bin/node',
          '--input-type=module',
          '--eval',
          'import { readdirSync } from "node:fs"; console.log(JSON.stringify([readdirSync("/").sort(), readdirSync("/bin").sort()]))',
        ],
        scratchRoot: dir,
        timeoutMs: 60_000,
        label: 'root-shape',
      });
      const line = result.stdout.trim().split('\n').at(-1) ?? '';
      const [rootEntries, binEntries] = JSON.parse(line) as [string[], string[]];
      expect(rootEntries).toEqual(['bin', 'dev', 'etc', 'lib', 'lib64', 'proc', 'tmp', 'work']);
      // Only the runtime and the capability-dropping helper are executable.
      expect(binEntries).toEqual(['node', 'setpriv']);
    } finally {
      await dispose();
    }
  });

  test('runtime mutations cannot reach the template or a subsequent sandbox', { timeout: 120_000 }, async () => {
    const { dir, dispose } = await scratch();
    try {
      expect((await probeSandbox()).supported).toBe(true);
      const template = join(REPO_ROOT, '.tmp/gpt-adaptation-bench/sandbox/runtime/bin/setpriv');
      const before = await stat(template);
      const workspace = join(dir, 'ws');
      await mkdir(workspace, { recursive: true });
      const result = await runSandboxed({
        workspaceDir: workspace, scratchRoot: dir, timeoutMs: 30_000, label: 'private-runtime',
        innerArgv: ['/bin/node', '-e', `
          const fs = require('node:fs');
          if (fs.statSync('/bin/setpriv').ino === ${String(before.ino)}) process.exit(3);
          fs.chmodSync('/bin/setpriv', 0);
          fs.writeFileSync('/etc/private-marker', 'changed only inside this root');
          console.log('private mutation completed');
        `],
      });
      expect(result.exitCode).toBe(0);
      expect((await stat(template)).mode).toBe(before.mode);
      const next = await runSandboxed({
        workspaceDir: workspace, scratchRoot: dir, timeoutMs: 30_000, label: 'unaffected-runtime',
        innerArgv: ['/bin/node', '-e', `console.log(require('node:fs').existsSync('/etc/private-marker'))`],
      });
      expect(next.exitCode).toBe(0);
      expect(next.stdout.trim()).toBe('false');
    } finally {
      await dispose();
    }
  });

  test('the launcher drops every capability and creates the namespaces', () => {
    const launcher = sandboxLauncherDescription();
    expect(launcher).toContain('unshare --user --map-root-user --mount --pid --fork --net');
    expect(launcher).toContain('--root=');
    expect(launcher).toContain('--mount-proc');
    expect(launcher).toContain('/bin/setpriv --no-new-privs');
    expect(launcher).toContain('--bounding-set=-all');
    expect(launcher).toContain('--inh-caps=-all');
    expect(launcher).toContain('--ambient-caps=-all');
  });

  test('captures a bounded amount of sandbox output', { timeout: 120_000 }, async () => {
    const { dir, dispose } = await scratch();
    try {
      const workspace = join(dir, 'ws');
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, 'loud.mjs'), 'process.stdout.write("x".repeat(400000));\n', 'utf8');
      const result = await runSandboxed({
        workspaceDir: workspace,
        innerArgv: ['/bin/node', 'loud.mjs'],
        scratchRoot: dir,
        timeoutMs: 60_000,
        label: 'output-cap',
      });
      expect(result.isolated).toBe(true);
      expect(result.outputTruncated).toBe(true);
      expect(result.stdout.length).toBeLessThanOrEqual(SANDBOX_MAX_OUTPUT_BYTES + SANDBOX_OUTPUT_TRUNCATION_MARKER.length);
    } finally {
      await dispose();
    }
  });

  test('a timeout kills only the sandbox process group and leaves the host alone', { timeout: 120_000 }, async () => {
    const { dir, dispose } = await scratch();
    try {
      const workspace = join(dir, 'ws');
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, 'sleep.mjs'), 'setTimeout(() => {}, 600000);\n', 'utf8');
      const before = Date.now();
      const result = await runSandboxed({
        workspaceDir: workspace,
        innerArgv: ['/bin/node', 'sleep.mjs'],
        scratchRoot: dir,
        timeoutMs: 3_000,
        label: 'timeout',
      });
      expect(result.isolated).toBe(true);
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).not.toBe(0);
      expect(Date.now() - before).toBeLessThan(30_000);
      // This test process is still alive and unharmed.
      expect(process.pid).toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });

  test('the sandbox scratch never leaves the working tree, and $HOME cannot move it', async () => {
    expect(scratchRoot().startsWith(REPO_ROOT)).toBe(true);
    expect(scratchRoot().startsWith('/tmp')).toBe(false);
    const realHome = resolvedUserHome();
    const previous = process.env['HOME'];
    try {
      process.env['HOME'] = '/nonexistent-run-home';
      expect(resolvedUserHome()).toBe(realHome);
      expect(maskTargets()).toContain(realHome);
    } finally {
      if (previous === undefined) delete process.env['HOME'];
      else process.env['HOME'] = previous;
    }
  });
});

describe('fetch guard', () => {
  async function startCountingServer(): Promise<{ url: string; headerSeen: () => string | undefined; close: () => Promise<void> }> {
    let observed: string | undefined;
    const server: Server = createServer((req, res) => {
      observed = req.headers['session-id'] as string | undefined;
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        [
          'event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n',
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","usage":{"input_tokens":10,"output_tokens":1,"input_tokens_details":{"cached_tokens":7}}}}\n\n',
          'data: [DONE]\n\n',
        ].join(''),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    return {
      url: `http://127.0.0.1:${String(port)}`,
      headerSeen: () => observed,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }

  test(
    'tickets requests before dispatch, strips session-id, and records redacted facts',
    { timeout: 120_000 },
    async () => {
      const { dir, dispose } = await scratch();
      const server = await startCountingServer();
      try {
        const guardDir = join(dir, 'guard');
        await mkdir(guardDir, { recursive: true });
        const script = `
          const responses = [];
          for (let index = 0; index < 3; index += 1) {
            try {
              const response = await fetch(${JSON.stringify(server.url)} + '/backend-api/codex/responses', {
                method: 'POST',
                headers: { 'session-id': 'abc', 'content-type': 'application/json', 'X-Keep': '1' },
                body: JSON.stringify({ model: 'm', input: [{ type: 'message', id: 'x', phase: 'final_answer' }], tools: [], stream: true }),
              });
              await response.text();
              responses.push('ok:' + response.status);
            } catch (error) {
              responses.push('denied:' + (error.code ?? error.message));
            }
          }
          // A request to another host must pass through untouched (it fails on
          // its own, which is fine) and must not consume a ticket.
          try { await fetch('http://127.0.0.1:1/elsewhere'); } catch {}
          console.log('RESULT ' + JSON.stringify(responses));
        `;
        const outcome = await runProcess([process.execPath, '--import', join(KLIENT_DIR, 'examples', 'gpt-adaptation-bench.fetch-guard.mjs'), '-e', script], {
          cwd: dir,
          env: {
            KIMI_BENCH_GUARD_DIR: guardDir,
            KIMI_BENCH_RUN_CAP: '2',
            KIMI_BENCH_GUARD_HOSTS: server.url.replace('http://', ''),
          },
        });
        expect(outcome.stderr).toBe('');
        const resultLine = outcome.stdout.split('\n').find((line) => line.startsWith('RESULT '));
        const responses = JSON.parse((resultLine ?? 'RESULT []').slice('RESULT '.length)) as string[];
        expect(responses[0]).toBe('ok:200');
        expect(responses[1]).toBe('ok:200');
        expect(responses[2]).toMatch(/^denied:BENCH_REQUEST_CAP_EXCEEDED/);

        const tickets = JSON.parse(await readFile(join(guardDir, 'tickets.json'), 'utf8')) as {
          count: number;
          cap: number;
          exceeded: number;
        };
        expect(tickets).toEqual({ count: 2, cap: 2, exceeded: 1 });

        const lines = (await readFile(join(guardDir, 'requests.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const responses2 = lines.filter((line) => line['kind'] === 'responses');
        const denied = lines.filter((line) => line['kind'] === 'denied');
        const other = lines.filter((line) => line['kind'] === 'other');
        expect(responses2.length).toBe(2);
        expect(denied.length).toBe(1);
        expect(other.length).toBe(1);
        const first = responses2[0] as {
          sessionIdPresent: boolean;
          sessionIdSent: boolean;
          headerNames: string[];
          request: { messageItemsWithId: number; messageItemsWithPhase: number; toolNames: string[] };
          usage: { inputTokens: number; cachedTokens: number } | null;
          terminalEventSeen: string | null;
          firstByteMs: number | null;
        };
        expect(first.sessionIdPresent).toBe(true);
        expect(first.sessionIdSent).toBe(true);
        expect(first.headerNames).toContain('session-id');
        expect(first.request.messageItemsWithId).toBe(1);
        expect(first.request.messageItemsWithPhase).toBe(1);
        expect(first.usage).toEqual({ inputTokens: 10, outputTokens: 1, cachedTokens: 7, totalTokens: null });
        expect(first.terminalEventSeen).toBe('response.completed');
        expect(typeof first.firstByteMs).toBe('number');
        // No raw body or credential value is stored.
        const serialized = JSON.stringify(lines);
        expect(serialized).not.toContain('abc');
      } finally {
        await server.close();
        await dispose();
      }
    },
  );

  test('strips the session-id header when the ablation flag is set', { timeout: 120_000 }, async () => {
    const { dir, dispose } = await scratch();
    const server = await startCountingServer();
    try {
      const guardDir = join(dir, 'guard');
      await mkdir(guardDir, { recursive: true });
      const script = `
        await fetch(${JSON.stringify(server.url)} + '/backendbase', { method: 'POST', headers: { 'Session-Id': 'zzz', 'x-a': '1' }, body: '{}' }).catch(() => {});
        await fetch(${JSON.stringify(server.url)} + '/backend-api/codex/responses', { method: 'POST', headers: { 'Session-Id': 'zzz', 'x-a': '1' }, body: '{}' }).catch(() => {});
      `;
      await runProcess([process.execPath, '--import', join(KLIENT_DIR, 'examples', 'gpt-adaptation-bench.fetch-guard.mjs'), '-e', script], {
        cwd: dir,
        env: {
          KIMI_BENCH_GUARD_DIR: guardDir,
          KIMI_BENCH_RUN_CAP: '5',
          KIMI_BENCH_STRIP_SESSION_ID: '1',
          KIMI_BENCH_GUARD_HOSTS: server.url.replace('http://', ''),
        },
      });
      expect(server.headerSeen()).toBeUndefined();
      const lines = (await readFile(join(guardDir, 'requests.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const intercepted = lines.find((line) => line['kind'] === 'responses') as {
        sessionIdPresent: boolean;
        sessionIdSent: boolean;
        strip: boolean;
      };
      expect(intercepted.sessionIdPresent).toBe(true);
      expect(intercepted.sessionIdSent).toBe(false);
      expect(intercepted.strip).toBe(true);
    } finally {
      await server.close();
      await dispose();
    }
  });
});

describe('replay scripts and fidelity', () => {
  test('expected metadata is measured against outputs completed before each request', () => {
    const twoTurn = REPLAY_SCRIPTS.find((script) => script.id === 'reasoning-then-text');
    expect(twoTurn).toBeDefined();
    if (twoTurn === undefined) return;
    expect(expectedMetadata(twoTurn)).toEqual({ phases: 2, itemIds: 2, encrypted: 1, toolCallIds: 0 });
    expect(expectedMetadataBefore(twoTurn, 0)).toEqual({ phases: 0, itemIds: 0, encrypted: 0, toolCallIds: 0 });
    expect(expectedMetadataBefore(twoTurn, 1)).toEqual({ phases: 1, itemIds: 1, encrypted: 1, toolCallIds: 0 });
    expect(expectedMetadataBefore(twoTurn, 2)).toEqual({ phases: 2, itemIds: 2, encrypted: 1, toolCallIds: 0 });
  });

  test('a perfect replay scores 1.0 on the last replayable request and N/A on the first', () => {
    const script = REPLAY_SCRIPTS.find((candidate) => candidate.id === 'reasoning-then-text');
    if (script === undefined) return;
    const coverage = replayCoverageRow(script, [
      { index: 1, messageItemsWithId: 0, messageItemsWithPhase: 0, reasoningWithEncrypted: 0 },
      { index: 2, messageItemsWithId: 1, messageItemsWithPhase: 1, reasoningWithEncrypted: 1 },
    ]);
    expect(coverage[0]?.phases).toBeNull();
    expect(coverage[0]?.itemIds).toBeNull();
    expect(coverage[1]?.phases).toBe(1);
    expect(coverage[1]?.itemIds).toBe(1);
    expect(coverage[1]?.encrypted).toBe(1);
  });

  test('a single-request script has no replay opportunity at all', () => {
    const script = REPLAY_SCRIPTS.find((candidate) => candidate.id === 'clean-text');
    if (script === undefined) return;
    const coverage = replayCoverageRow(script, [
      { index: 1, messageItemsWithId: 1, messageItemsWithPhase: 1, reasoningWithEncrypted: 0 },
    ]);
    expect(coverage[0]?.phases).toBeNull();
    expect(coverage[0]?.itemIds).toBeNull();
  });

  test('every script declares its per-turn response split and renders as SSE', () => {
    for (const script of REPLAY_SCRIPTS) {
      expect(script.responsesPerTurn.reduce((total, value) => total + value, 0)).toBe(script.responses.length);
      expect(script.responsesPerTurn.length).toBe(script.prompts);
      expect(scriptDigest(script)).toMatch(/^[0-9a-f]{64}$/);
      for (const response of script.responses) {
        const body = renderSse(response);
        expect(body.endsWith('data: [DONE]\n\n')).toBe(true);
        if (!response.hasTerminalEvent) expect(body).not.toContain('response.completed');
      }
    }
    const ids = REPLAY_SCRIPTS.map((script) => script.id);
    for (const required of ['truncate-after-text', 'truncate-mid-tool-args', 'truncate-after-args', 'failed-response', 'late-phase', 'multi-item-mixed']) {
      expect(ids).toContain(required);
    }
  });

  test('derived facts never carry raw secrets', () => {
    const fidelity = extractFidelity(
      { input: [{ type: 'message', id: 'm', phase: 'commentary' }, { type: 'reasoning', encrypted_content: 'SECRET-BLOB' }] },
      1,
      { authorization: 'Bearer sk-secret', 'session-id': 'session-abc', 'content-type': 'application/json' },
    );
    const serialized = JSON.stringify(fidelity);
    expect(serialized).not.toContain('SECRET-BLOB');
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('session-abc');
    expect(fidelity.headers['authorization']).toMatch(/^<present:[0-9a-f]{12}>$/);
    expect(summarizeHeaders({ Cookie: 'a=b', 'x-request-id': 'r' })['Cookie']).toMatch(/^<present:/);
  });

  test('the tool-set fingerprint is derived from the projected tool names in both processes', () => {
    const expected = engineFingerprint([...BENCH_WORKSPACE_ALLOWED_TOOLS]);
    expect(expected).toMatch(/^[0-9a-f]{10}$/);
    expect(engineFingerprint([...BENCH_WORKSPACE_ALLOWED_TOOLS].reverse())).toBe(expected);
    expect(engineFingerprint(['bench_read_file', 'bench_write_file'])).not.toBe(expected);
  });
});

describe('freeze integrity helpers', () => {
  test('compareFileHashes names every changed, added or missing entry', async () => {
    const { compareFileHashes } = await import('../examples/gpt-adaptation-bench.js');
    const expected = { 'a.ts': 'h1', 'b.ts': 'h2', 'c.ts': 'h3' };
    expect(compareFileHashes(expected, { 'a.ts': 'h1', 'b.ts': 'x', 'c.ts': 'h3' })).toEqual(['b.ts']);
    expect(compareFileHashes(expected, { 'a.ts': 'h1', 'b.ts': 'h2' })).toEqual(['c.ts']);
    expect(compareFileHashes(expected, { ...expected, 'd.ts': 'h4' })).toEqual([]);
  });
});

describe('arm roots', () => {
  test(
    'the candidate arm is the baseline copy plus the whitelist overlay, never the working tree',
    { timeout: 300_000 },
    async () => {
      const { dir, dispose } = await scratch();
      try {
        const armRoots = await prepareArmRoots({ baselineDir: BASELINE_DIR, runRoot: dir });
        const candidateEngineDir = join(dir, 'arms', 'candidate', 'packages', 'agent-core-v2');
        const candidateEngine = join(candidateEngineDir, 'src');
        const baselineEngineDir = join(BASELINE_DIR, 'packages', 'agent-core-v2');
        const workingEngineDir = join(REPO_ROOT, 'packages', 'agent-core-v2');
        const workingEngine = join(workingEngineDir, 'src');
        const baselineEngine = join(baselineEngineDir, 'src');
        const { existsSync } = await import('node:fs');
        expect(existsSync(join(workingEngine, 'benchmark-baseline-marker.ts'))).toBe(false);
        expect(existsSync(join(candidateEngine, 'benchmark-baseline-marker.ts'))).toBe(true);
        // The non-whitelisted files come from the baseline, not the working tree.
        const untouched = 'features/aitpResearch/injection/aitpResearchInjection.ts';
        const armContent = await readFile(join(candidateEngine, untouched), 'utf8');
        const baselineContent = await readFile(join(baselineEngine, untouched), 'utf8');
        expect(sha(armContent)).toBe(sha(baselineContent));
        // The whitelisted files come from the working tree.
        for (const whitelisted of CANDIDATE_WHITELIST) {
          const armFile = await readFile(join(candidateEngineDir, whitelisted), 'utf8');
          const workingFile = await readFile(join(workingEngineDir, whitelisted), 'utf8');
          expect(sha(armFile)).toBe(sha(workingFile));
        }

        const resolution = await verifyArmResolution({ arm: 'candidate', armRoot: armRoots.roots.candidate, runRoot: dir });
        expect(resolution.failed).toEqual([]);
        expect(resolution.allInsideArmRoot).toBe(true);
        expect(resolution.resolved.length).toBeGreaterThanOrEqual(9);
        for (const entry of resolution.resolved) {
          expect(entry.resolved.startsWith(`file://${armRoots.roots.candidate}/`)).toBe(true);
        }
        // The baseline arm resolves inside its own root too.
        const baselineResolution = await verifyArmResolution({ arm: 'baseline', armRoot: armRoots.roots.baseline, runRoot: dir });
        expect(baselineResolution.allInsideArmRoot).toBe(true);
        expect(baselineResolution.failed).toEqual([]);
      } finally {
        await dispose();
      }
    },
  );

  test('the ablation arm has identical source to the candidate', async () => {
    const { dir, dispose } = await scratch();
    try {
      const armRoots = await prepareArmRoots({ baselineDir: BASELINE_DIR, runRoot: dir });
      const candidate = join(armRoots.roots.candidate, 'packages', 'agent-core-v2', 'src');
      const ablation = join(armRoots.roots[BENCH_ABLATION_ARM], 'packages', 'agent-core-v2', 'src');
      expect(await engineTreeDigest(ablation)).toBe(await engineTreeDigest(candidate));
    } finally {
      await dispose();
    }
  });

  test('the frozen baseline tree is never written to', async () => {
    const before = await engineTreeDigest(join(BASELINE_DIR, 'packages', 'agent-core-v2', 'src'));
    const { dir, dispose } = await scratch();
    try {
      await prepareArmRoots({ baselineDir: BASELINE_DIR, runRoot: dir });
      const after = await engineTreeDigest(join(BASELINE_DIR, 'packages', 'agent-core-v2', 'src'));
      expect(after).toBe(before);
    } finally {
      await dispose();
    }
  });
});

function sha(value: string): string {
  return createRequire(import.meta.url)('node:crypto').createHash('sha256').update(value).digest('hex') as string;
}

describe('report', () => {
  test('reports offline artifacts as evidence and never as an official score', () => {
    const offline = [
      {
        runId: 'T01__r0__candidate',
        mode: 'offline' as const,
        kind: 'task' as const,
        arm: 'candidate' as const,
        taskId: 'T01-cross-file-fix',
        repeat: 0,
        childExitCode: 0,
        childTimedOut: false,
        contractSatisfied: true,
        requestsObserved: 3,
        requestsObservedSource: 'fixture' as const,
        toolCalls: 2,
        toolFailures: 0,
        usage: null,
        firstVisibleTokenMs: 12,
        durationMs: 900,
        testsSandboxed: true,
        startedAt: 't',
        endedAt: 't',
        grade: { passed: true, tests: 5, pass: 5, fail: 0, exactOk: true, exitCode: 0, timedOut: false, graderDigest: 'x', failures: [] },
      },
    ];
    const summary = summarize('/tmp/run', offline, 0);
    const text = summary.lines.join('\n');
    expect(summary.officialScores).toBe(false);
    expect(text).toContain('official score: none');
    expect(text).toContain('offline artifacts (pipeline evidence only');
    // Offline (fixture) cost numbers are meaningless and are not presented as scores.
    expect(text).not.toContain('task-run cost/observability');
  });

  test('flags a directory that mixes offline and live artifacts', () => {
    const artifact = {
      runId: 'r',
      mode: 'live' as const,
      kind: 'task' as const,
      arm: 'candidate' as const,
      taskId: 'T01-cross-file-fix',
      childExitCode: 0,
      childTimedOut: false,
      contractSatisfied: true,
      requestsObserved: 2,
      requestsObservedSource: 'guard' as const,
      toolCalls: 0,
      toolFailures: 0,
      usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      firstVisibleTokenMs: null,
      durationMs: null,
      testsSandboxed: null,
      startedAt: 't',
      endedAt: 't',
    };
    const mixed = summarize('/tmp/run', [artifact, { ...artifact, runId: 's', mode: 'offline' }], 2);
    expect(mixed.mixedModes).toBe(true);
    expect(mixed.lines.join('\n')).toContain('MIXED');
    expect(mixed.officialScores).toBe(true);
    expect(mixed.liveArtifacts.length).toBe(1);
  });

  test('cluster bootstrap reports a cluster count and censors small samples', () => {
    const interval = clusterBootstrap('task-cluster', [0, 0.5, -0.5, 0], 1);
    expect(interval.clusters).toBe(4);
    expect(interval.note).toContain('4 clusters');
    expect(clusterBootstrap('task-cluster', [], 1).clusters).toBe(0);
  });
});

describe('end-to-end offline runs', () => {
  test(
    'drives a task through the real engine, the bounded tools, the sandbox and the grader',
    { timeout: 600_000 },
    async () => {
      const { dir, dispose } = await scratch();
      try {
        const outDir = join(dir, 'bench');
        const freeze = await runBenchmark([
          '--freeze',
          '--freeze-mode',
          'offline',
          '--out',
          outDir,
          '--run-id',
          'e2e',
          '--baseline',
          BASELINE_DIR,
        ]);
        expect(freeze.code).toBe(0);
        expect(freeze.stdout).toContain('frozen manifest written');

        const target = 'T01-cross-file-fix__r0__candidate';
        const run = await runBenchmark(['--stub', '--out', outDir, '--run-id', 'e2e', '--baseline', BASELINE_DIR, '--run', target]);
        expect(run.stderr).toBe('');
        expect(run.stdout).toContain('graded pass');

        const artifact = JSON.parse(await readFile(join(outDir, 'e2e', 'runs', `${target}.json`), 'utf8')) as {
          mode: string;
          grade?: { passed: boolean };
          contractSatisfied: boolean | null;
          requestsObserved: number;
          requestsObservedSource: string;
          testsSandboxed: boolean | null;
          child?: {
            armRootVerified: boolean;
            fixture?: { fingerprintVerified: boolean; requests: number; exhaustedTurns: number[] };
            prompts: { toolCalls: { name: string; ok?: boolean }[]; endedReason?: string }[];
          };
        };
        expect(artifact.mode).toBe('offline');
        expect(artifact.grade?.passed).toBe(true);
        expect(artifact.contractSatisfied).toBe(true);
        expect(artifact.requestsObserved).toBeGreaterThanOrEqual(2);
        expect(artifact.requestsObservedSource).toBe('fixture');
        expect(artifact.testsSandboxed).toBe(true);
        expect(artifact.child?.armRootVerified).toBe(true);
        expect(artifact.child?.fixture?.fingerprintVerified).toBe(true);
        expect(artifact.child?.fixture?.exhaustedTurns).toEqual([]);
        expect(artifact.child?.prompts[0]?.endedReason).toBe('completed');

        const report = await runBenchmark(['--report', join(outDir, 'e2e'), '--out', outDir, '--run-id', 'e2e']);
        expect(report.stdout).toContain('official score: none');
        expect(report.stdout).toContain('modes: offline');
      } finally {
        await dispose();
      }
    },
  );

  test(
    'the resume task really closes and restores the session before continuing',
    { timeout: 600_000 },
    async () => {
      const { dir, dispose } = await scratch();
      try {
        const outDir = join(dir, 'bench');
        await runBenchmark(['--freeze', '--freeze-mode', 'offline', '--out', outDir, '--run-id', 'resume', '--baseline', BASELINE_DIR]);
        const target = 'T07-resume-continue__r0__candidate';
        const run = await runBenchmark(['--stub', '--out', outDir, '--run-id', 'resume', '--baseline', BASELINE_DIR, '--run', target]);
        expect(run.stderr).toBe('');
        const artifact = JSON.parse(await readFile(join(outDir, 'resume', 'runs', `${target}.json`), 'utf8')) as {
          grade?: { passed: boolean };
          contractSatisfied: boolean | null;
          child?: {
            contract?: {
              resumeRequired: boolean;
              resumePerformed: boolean;
              restored?: boolean;
              continuedAfterResume: boolean;
              turnsCompleted: number;
            };
            prompts: { index: number; restoreBefore?: boolean; endedReason?: string; launched: boolean }[];
          };
        };
        expect(artifact.grade?.passed).toBe(true);
        expect(artifact.contractSatisfied).toBe(true);
        const contract = artifact.child?.contract;
        expect(contract?.resumeRequired).toBe(true);
        expect(contract?.resumePerformed).toBe(true);
        expect(contract?.restored).toBe(true);
        expect(contract?.continuedAfterResume).toBe(true);
        expect(contract?.turnsCompleted).toBe(2);
        const prompts = artifact.child?.prompts ?? [];
        expect(prompts.length).toBe(2);
        expect(prompts[0]?.restoreBefore).toBe(false);
        expect(prompts[1]?.restoreBefore).toBe(true);
        expect(prompts[1]?.endedReason).toBe('completed');
      } finally {
        await dispose();
      }
    },
  );

  test(
    'refuses to raise the frozen budget and refuses mixing stub mode into a live freeze',
    { timeout: 300_000 },
    async () => {
      const { dir, dispose } = await scratch();
      try {
        const outDir = join(dir, 'bench');
        await runBenchmark(['--freeze', '--freeze-mode', 'live', '--out', outDir, '--run-id', 'guard', '--baseline', BASELINE_DIR]);
        const raised = await runBenchmark(['--live', '--budget', '500', '--out', outDir, '--run-id', 'guard', '--baseline', BASELINE_DIR]);
        expect(raised.stderr).toContain('exceeds the frozen budget');

        const mixed = await runBenchmark(['--stub', '--out', outDir, '--run-id', 'guard', '--baseline', BASELINE_DIR]);
        expect(mixed.stderr).toContain('frozen for mode "live"');

        const missing = await runBenchmark(['--live', '--out', outDir, '--run-id', 'nope', '--baseline', BASELINE_DIR]);
        expect(missing.stderr).toContain('no frozen manifest');
      } finally {
        await dispose();
      }
    },
  );
});
