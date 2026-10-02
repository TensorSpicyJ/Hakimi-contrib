/**
 * `gpt-adaptation-bench` hidden grader and scoring.
 *
 * Grading never reads the agent-visible tests. For every run the scorer
 * builds a fresh scratch copy of the agent workspace, writes the task's
 * hidden test file under `__hidden__/`, and runs it with the plain host
 * Node (`node --test --test-reporter=tap`). Results are objective:
 * exit code + TAP counts, plus optional source-level exact checks.
 *
 * `runScorerSelfTest` proves the grader discriminates before any live run:
 * pristine, wrong-patch and visible-test-tamper variants must all FAIL, the
 * reference patch must PASS, and the exact checks must reject a source that
 * keeps the forbidden symbol.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import {
  BENCH_TASKS,
  TAMPERED_VISIBLE_TEST,
  taskVisibleTests,
  type BenchTask,
  type ExactCheck,
} from './gpt-adaptation-bench.tasks.js';
import { runSandboxed } from './gpt-adaptation-bench.sandbox.js';

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * A single shell-free child process with a hard timeout.
 *
 * Host-side helper for trusted commands only: anything that touches model
 * output must go through `runSandboxed` instead.
 */
export function runCommand(
  argv: readonly string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: options.cwd,
      env: options.env ?? { PATH: process.env['PATH'] ?? '' },
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
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

export interface Tally {
  readonly tests: number;
  readonly pass: number;
  readonly fail: number;
}

/** Parse the TAP summary `node --test` prints (`# pass 3` / `# fail 1`). */
export function parseTapSummary(stdout: string): Tally {
  const read = (key: string): number => {
    const match = new RegExp(`^# ${key} (\\d+)$`, 'm').exec(stdout);
    return match === null ? 0 : Number(match[1]);
  };
  return { tests: read('tests'), pass: read('pass'), fail: read('fail') };
}

export function failedTestNames(stdout: string): readonly string[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('not ok '))
    .map((line) => line.replace(/^not ok \d+ - /, '').trim());
}

export interface ExactCheckResult {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface GradeResult {
  /** Objective verdict: the hidden suite ran, exited 0, and every exact check held. */
  readonly passed: boolean;
  readonly tally: Tally;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly failures: readonly string[];
  readonly exact: readonly ExactCheckResult[];
  /** sha256 of the hidden test file, so a report can prove which grader ran. */
  readonly graderDigest: string;
  readonly stdoutDigest: string;
  /** True when the grader ran inside the fresh-root sandbox. */
  readonly sandboxed: boolean;
  /** Why the grader could not run (sandbox unavailable) or why its output is unreliable. */
  readonly sandboxReason?: string;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Write a relative-path file tree under `root`, creating directories. */
export async function writeTree(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
}

async function evaluateExact(
  workspace: string,
  checks: readonly ExactCheck[] | undefined,
): Promise<readonly ExactCheckResult[]> {
  if (checks === undefined) return [];
  const out: ExactCheckResult[] = [];
  for (const check of checks) {
    let text: string | undefined;
    try {
      text = await readFile(join(workspace, check.path), 'utf8');
    } catch {
      text = undefined;
    }
    if (text === undefined) {
      out.push({ label: check.label, ok: false, detail: `${check.path} is missing` });
      continue;
    }
    if (check.mustMatch !== undefined && !text.includes(check.mustMatch)) {
      out.push({ label: check.label, ok: false, detail: `missing ${JSON.stringify(check.mustMatch)}` });
      continue;
    }
    if (check.mustNotMatch !== undefined && text.includes(check.mustNotMatch)) {
      out.push({ label: check.label, ok: false, detail: `still contains ${JSON.stringify(check.mustNotMatch)}` });
      continue;
    }
    out.push({ label: check.label, ok: true, detail: 'ok' });
  }
  return out;
}

export interface GradeOptions {
  /**
   * Advisory only: sandbox scratch always lives under the repository's
   * `.tmp/gpt-adaptation-bench/sandbox`, so nothing is created or deleted
   * outside the working tree.
   */
  readonly scratchDir: string;
  readonly timeoutMs?: number;
  /**
   * Advisory only: the grader always runs on the sandbox's own copy of the
   * runtime, never a caller-supplied binary.
   */
  readonly nodeBinary?: string;
}

/**
 * Grade one workspace inside the sandbox.
 *
 * The hidden grader imports the model's own sources, so it is exactly as
 * untrusted as the tests are: it runs in a fresh root that contains only the
 * workspace copy, the runtime and the single grader file — never the host,
 * never the reference patches, and never the rest of the task set. Grading
 * happens after the agent's turn, and its output goes only to the caller.
 */
export async function gradeWorkspace(
  task: BenchTask,
  workspace: string,
  options: GradeOptions,
): Promise<GradeResult> {
  const graderRelative = join('__hidden__', task.graderFileName);
  const result = await runSandboxed({
    workspaceDir: workspace,
    // The grader lives one level below the workspace root so the frozen
    // graders' relative imports (`../src/...`, `../data/...`) keep working.
    innerArgv: ['/bin/node', '--test', '--test-reporter=tap', './' + graderRelative],
    scratchRoot: options.scratchDir,
    timeoutMs: options.timeoutMs ?? 120_000,
    label: 'grade',
    extraFiles: { [graderRelative]: task.grader },
  }).catch((error: unknown) => ({
    exitCode: -1,
    stdout: '',
    stderr: '',
    timedOut: false,
    isolated: false,
    outputTruncated: false,
    reason: `grader setup failed: ${error instanceof Error ? error.message : String(error)}`,
  }));

  const tally = parseTapSummary(result.stdout);
  const exact = await evaluateExact(workspace, task.exact);
  const combined = `${result.stdout}\n${result.stderr}`;
  if (!result.isolated) {
    return {
      passed: false,
      tally,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      failures: [`grader not run: ${result.reason ?? 'sandbox unavailable'}`],
      exact,
      graderDigest: sha256(task.grader),
      stdoutDigest: sha256(combined),
      sandboxed: false,
      sandboxReason: result.reason ?? 'sandbox unavailable',
    };
  }
  // A truncated capture means the TAP stream may be incomplete: an unreliable
  // grade is a failure, never a pass.
  const unreliable = result.outputTruncated === true;
  const ran = tally.tests > 0;
  const passed =
    ran &&
    !unreliable &&
    result.exitCode === 0 &&
    tally.fail === 0 &&
    exact.every((check) => check.ok);
  return {
    passed,
    tally,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    failures: unreliable
      ? ['grader output exceeded the sandbox capture limit; grade is unreliable']
      : failedTestNames(result.stdout),
    exact,
    graderDigest: sha256(task.grader),
    stdoutDigest: sha256(combined),
    sandboxed: true,
    sandboxReason: undefined,
  };
}

// ---------------------------------------------------------------------------
// Negative / positive fixture variants and the scorer self-test
// ---------------------------------------------------------------------------

export interface ScorerVariantResult {
  readonly variant: string;
  readonly passed: boolean;
  readonly expected: boolean;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ScorerSelfTestResult {
  readonly taskId: string;
  readonly variants: readonly ScorerVariantResult[];
  readonly ok: boolean;
}

function pristine(task: BenchTask): Record<string, string> {
  return { ...task.files };
}

/** A workspace whose visible tests were replaced by a trivially passing suite. */
function tampered(task: BenchTask): Record<string, string> {
  const files = pristine(task);
  for (const visible of taskVisibleTests(task)) files[visible] = TAMPERED_VISIBLE_TEST;
  return files;
}

export async function runScorerSelfTest(
  task: BenchTask,
  options: GradeOptions,
): Promise<ScorerSelfTestResult> {
  const root = join(options.scratchDir, 'selftest');
  await rm(root, { recursive: true, force: true });
  const variants: readonly { name: string; files: Record<string, string>; expected: boolean }[] = [
    { name: 'empty-patch', files: pristine(task), expected: false },
    { name: 'wrong-patch', files: { ...pristine(task), ...task.wrong }, expected: false },
    { name: 'visible-test-tamper', files: tampered(task), expected: false },
    { name: 'reference-patch', files: { ...pristine(task), ...task.reference }, expected: true },
    {
      name: 'reference+visible-test-tamper',
      files: { ...tampered(task), ...task.reference },
      expected: true,
    },
  ];

  const results: ScorerVariantResult[] = [];
  for (const variant of variants) {
    const workspace = join(root, variant.name);
    await mkdir(workspace, { recursive: true });
    await writeTree(workspace, variant.files);
    const grade = await gradeWorkspace(task, workspace, {
      ...options,
      scratchDir: join(root, `${variant.name}.scratch`),
    });
    results.push({
      variant: variant.name,
      passed: grade.passed,
      expected: variant.expected,
      ok: grade.passed === variant.expected,
      detail: `exit=${String(grade.exitCode)} tests=${String(grade.tally.tests)} pass=${String(grade.tally.pass)} fail=${String(grade.tally.fail)} exact=${grade.exact.map((check) => (check.ok ? 'ok' : 'bad')).join(',') || '-'}`,
    });
  }

  // Exact checks must reject a source that still carries the forbidden symbol.
  if (task.exact !== undefined && task.exact.length > 0) {
    const workspace = join(root, 'reference+forbidden-symbol');
    await mkdir(workspace, { recursive: true });
    await writeTree(workspace, { ...pristine(task), ...task.reference });
    for (const check of task.exact) {
      if (check.mustNotMatch === undefined) continue;
      const path = join(workspace, check.path);
      const current = await readFile(path, 'utf8');
      await writeFile(path, `${current}\n// ${check.mustNotMatch}\n`, 'utf8');
    }
    const grade = await gradeWorkspace(task, workspace, {
      ...options,
      scratchDir: join(root, 'reference+forbidden-symbol.scratch'),
    });
    results.push({
      variant: 'reference+forbidden-symbol',
      passed: grade.passed,
      expected: false,
      ok: grade.passed === false,
      detail: `exact=${grade.exact.map((check) => (check.ok ? 'ok' : 'bad')).join(',')}`,
    });
  }

  return { taskId: task.id, variants: results, ok: results.every((result) => result.ok) };
}

export async function runAllScorerSelfTests(options: GradeOptions): Promise<readonly ScorerSelfTestResult[]> {
  const out: ScorerSelfTestResult[] = [];
  for (const task of BENCH_TASKS) out.push(await runScorerSelfTest(task, options));
  return out;
}
