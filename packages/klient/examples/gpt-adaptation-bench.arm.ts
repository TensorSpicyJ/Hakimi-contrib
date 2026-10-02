/**
 * `gpt-adaptation-bench` arm driver — one isolated process per measured run.
 *
 * Boots the real `agent-core-v2` engine (the source tree selected by the arm
 * loader), registers the four bounded benchmark tools through the production
 * `registerAgentToolService` seam, creates a real session in a synthetic
 * workspace, and drives real prompts through the real prompt service, loop,
 * context memory and persistence. Resume runs really close and restore the
 * session. Nothing here re-implements a model/tool loop.
 *
 * The driver never reads or logs credentials: in stub mode it points a local
 * model record at the parent's loopback backend; in live mode it uses the
 * engine's own managed auth on the operator-provided home.
 */

import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { bootstrap, logSeed, resolveLoggingConfig } from '@moonshot-ai/agent-core-v2';
import { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import { createDecorator } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';
import { registerAgentToolService } from '@moonshot-ai/agent-core-v2/agent/toolRegistry/toolContribution';
import type { ToolExecution } from '@moonshot-ai/agent-core-v2/tool/toolContract';
import { createKlient } from '@moonshot-ai/klient/memory';
import type { AgentHandle, Klient } from '@moonshot-ai/klient';

import { probeSandbox, runSandboxed } from './gpt-adaptation-bench.sandbox.js';
import { renderSse, type ScriptedResponse } from './gpt-adaptation-bench.events.js';
import { BENCH_WORKSPACE_ALLOWED_TOOLS } from './gpt-adaptation-bench.tasks.js';

// ---------------------------------------------------------------------------
// Shared plan/result contract (consumed by the orchestrator)
// ---------------------------------------------------------------------------

export type BenchArmId = 'baseline' | 'candidate' | 'candidate-no-session-id';

/** The cache-ablation arm: same source as the candidate, session-id header stripped at the fetch boundary. */
export const BENCH_ABLATION_ARM_ID: BenchArmId = 'candidate-no-session-id';

export type BenchRunKind = 'task' | 'cache' | 'replay' | 'preflight';

export interface ArmPlan {
  readonly runId: string;
  readonly kind: BenchRunKind;
  readonly arm: BenchArmId;
  /** Absolute path of the engine source root the arm loader must resolve to. */
  readonly armRoot: string;
  readonly homeDir: string;
  readonly workspaceDir: string;
  readonly resultPath: string;
  /** Where the sandboxed test runner keeps its private copies. */
  readonly sandboxRoot: string;
  /** Where the synthetic agent profile file is written (never a user home in live mode). */
  readonly profilePath: string;
  readonly model: {
    /** Model registry id used by `setModel`. */
    readonly id: string;
    readonly name: string;
    readonly maxContextSize: number;
    readonly supportEfforts: readonly string[];
    readonly defaultEffort: string;
  };
  readonly effort: string;
  readonly endpoint:
    | {
        /** Parent-served scripted backend for this turn (loopback, no network). */
        readonly mode: 'fixture';
        /** Deterministic port for this run (the Codex-shaped base URL requires it). */
        readonly port: number;
        readonly apiKey: string;
      }
    | { readonly mode: 'live' };
  /**
   * Parallel array to `prompts`: the per-turn model-request budget. The arm
   * serves its own fixture backend, and refuses a requesting turn that exceeds
   * its budget — the budget is therefore enforced before any dispatch.
   */
  readonly turnBudgets: readonly number[];
  /** Parent-owned request-ticket directory (guard) for live runs. */
  readonly guardDir?: string;
  /** Parent-owned fingerprint/handshake file for fixture runs. */
  readonly handshakePath?: string;
  /** User turns to drive, in order. */
  readonly prompts: readonly string[];
  /** Close + restore the session after `prompts[resumeAfter]`. */
  readonly resumeAfter?: number;
  readonly maxStepsPerTurn: number;
  readonly maxAttemptsPerStep: number;
  /** Hard wall clock bound for the whole run, enforced by the parent too. */
  readonly runTimeoutMs: number;
  readonly cache?: {
    readonly sessionKey: string;
    readonly requests: number;
    readonly systemPrompt: string;
    readonly userText: string;
  };
}

export interface PromptMetrics {
  readonly index: number;
  readonly launched: boolean;
  readonly turnId?: number;
  readonly endedReason?: string;
  readonly aborted: boolean;
  readonly errorText?: string;
  readonly restoreBefore?: boolean;
  readonly firstVisibleTokenMs?: number;
  readonly durationMs: number;
  /** This turn issued at least one model request (observed by the arm's backend). */
  readonly modelRequests: number;
  readonly turnBudget: number;
  readonly budgetExhausted: boolean;
  readonly toolCalls: readonly { readonly name: string; readonly id: string; readonly ok?: boolean; readonly error?: string }[];
}

export interface RunResult {
  readonly runId: string;
  readonly kind: BenchRunKind;
  readonly arm: BenchArmId;
  readonly resolvedEngineIndex: string;
  readonly resolvedOpenAIResponses: string;
  readonly armRootVerified: boolean;
  readonly modelId: string;
  readonly effort: string;
  readonly sessionId?: string;
  readonly status: 'ok' | 'error' | 'timeout';
  readonly errorText?: string;
  readonly prompts: readonly PromptMetrics[];
  readonly usage?: unknown;
  readonly contextMessageCount?: number;
  readonly restored?: boolean;
  readonly cacheRequests?: readonly {
    readonly index: number;
    /** null when the backend reported no usage for this request (never 0). */
    readonly inputTokens: number | null;
    readonly cachedTokens: number | null;
    readonly outputTokens: number | null;
    /** null when no first-token timing was observed. */
    readonly firstTokenLatencyMs: number | null;
    readonly streamDurationMs: number | null;
    readonly usageObserved: boolean;
    readonly timingObserved: boolean;
  }[];
  readonly startedAt: number;
  readonly endedAt: number;
  /** Derived, redacted facts about every request the fixture backend served. */
  readonly requests?: readonly unknown[];
  /** Fixture-backend evidence: the engine's tool projection matched the expected fingerprint. */
  readonly fixture?: {
    readonly fingerprintVerified: boolean;
    readonly fingerprint: string;
    readonly expectedFingerprint: string;
    readonly requests: number;
    readonly exhaustedTurns: readonly number[];
  };
  readonly sandbox?: { readonly supported: boolean; readonly detail?: string };
  /** Resume / multi-turn contract evidence; the grader refuses a passing run without it. */
  readonly contract?: {
    readonly resumeRequired: boolean;
    readonly resumePerformed: boolean;
    readonly restored?: boolean;
    readonly modelAfterRestore?: string;
    readonly turnsLaunched: number;
    readonly turnsCompleted: number;
    readonly continuedAfterResume: boolean;
  };
  /** `--preflight` result: auth readiness plus a single tiny round trip. */
  readonly preflight?: {
    readonly authReady: boolean;
    readonly responded: boolean;
    readonly text?: string;
    readonly errorText?: string;
  };
}

// ---------------------------------------------------------------------------
// Bounded benchmark tools (registered through the production seam)
// ---------------------------------------------------------------------------

const MAX_READ_BYTES = 64 * 1024;
const MAX_LIST_ENTRIES = 400;
const MAX_TEST_OUTPUT = 16 * 1024;

let BENCH_WORKSPACE = '';
let BENCH_SANDBOX_ROOT = '';

function setBenchContext(workspace: string, sandboxRoot: string): void {
  BENCH_WORKSPACE = workspace;
  BENCH_SANDBOX_ROOT = sandboxRoot;
}

/** Resolve a workspace-relative path, refusing anything that escapes the root. */
async function safePath(input: unknown, options: { mustExist: boolean }): Promise<string> {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('path must be a non-empty string');
  if (isAbsolute(input)) throw new Error('path must be relative to the workspace');
  const candidate = resolve(BENCH_WORKSPACE, input);
  const rootReal = await realpath(BENCH_WORKSPACE);
  const anchor = options.mustExist ? await realpath(candidate) : await realpath(dirname(candidate));
  const relativeToRoot = relative(rootReal, anchor);
  if (relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
    throw new Error('path escapes the benchmark workspace');
  }
  return candidate;
}

const IBenchListTool = createDecorator<BenchListFilesTool>('benchListFilesTool');
const IBenchReadTool = createDecorator<BenchReadFileTool>('benchReadFileTool');
const IBenchWriteTool = createDecorator<BenchWriteFileTool>('benchWriteFileTool');
const IBenchTestsTool = createDecorator<BenchRunTestsTool>('benchRunTestsTool');

class BenchListFilesTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'bench_list_files';
  readonly description =
    'List files inside the benchmark project. Optional relative subdirectory. Directories are suffixed with "/".';
  readonly parameters = {
    type: 'object',
    properties: { path: { type: 'string', description: 'Relative subdirectory, default "."' } },
  };

  async resolveExecution(args: { path?: string }): Promise<ToolExecution> {
    const start = await safePath(args.path ?? '.', { mustExist: true });
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (out.length >= MAX_LIST_ENTRIES) return;
        const full = join(dir, entry.name);
        const rel = relative(BENCH_WORKSPACE, full).split(sep).join('/');
        if (entry.isDirectory()) {
          out.push(`${rel}/`);
          if (entry.name !== 'node_modules') await walk(full);
        } else {
          out.push(rel);
        }
      }
    };
    try {
      await walk(start);
      return {
        approvalRule: this.name,
        execute: () =>
          Promise.resolve({
            isError: false as const,
            output: out.length === 0 ? '(empty)' : out.join('\n'),
          }),
      };
    } catch (error) {
      return {
        approvalRule: this.name,
        execute: () =>
          Promise.resolve({ isError: true as const, output: `list failed: ${describeError(error)}` }),
      };
    }
  }
}

class BenchReadFileTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'bench_read_file';
  readonly description = 'Read a text file from the benchmark project, with line numbers.';
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path, e.g. src/index.ts' },
      offset: { type: 'number', description: 'Optional 1-based first line' },
      limit: { type: 'number', description: 'Optional maximum number of lines' },
    },
    required: ['path'],
  };

  async resolveExecution(args: { path: string; offset?: number; limit?: number }): Promise<ToolExecution> {
    try {
      const file = await safePath(args.path, { mustExist: true });
      const buffer = await readFile(file);
      const truncated = buffer.byteLength > MAX_READ_BYTES;
      const text = buffer.subarray(0, MAX_READ_BYTES).toString('utf8');
      const all = text.split('\n');
      const offset = Math.max(1, Math.floor(args.offset ?? 1));
      const limit = Math.max(1, Math.floor(args.limit ?? 400));
      const slice = all.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((line, index) => `${String(offset + index)}\t${line}`).join('\n');
      return {
        approvalRule: this.name,
        execute: () =>
          Promise.resolve({
            isError: false as const,
            output: truncated ? `${numbered}\n[file truncated at ${String(MAX_READ_BYTES)} bytes]` : numbered,
          }),
      };
    } catch (error) {
      return {
        approvalRule: this.name,
        execute: () =>
          Promise.resolve({ isError: true as const, output: `read failed: ${describeError(error)}` }),
      };
    }
  }
}

class BenchWriteFileTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'bench_write_file';
  readonly description =
    'Create or overwrite a text file in the benchmark project. Parent directories are created.';
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path' },
      content: { type: 'string', description: 'Full new file contents' },
    },
    required: ['path', 'content'],
  };

  async resolveExecution(args: { path: string; content: string }): Promise<ToolExecution> {
    try {
      if (typeof args.content !== 'string') throw new Error('content must be a string');
      const file = await safePath(args.path, { mustExist: false });
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, args.content, 'utf8');
      return {
        approvalRule: this.name,
        execute: () =>
          Promise.resolve({
            isError: false as const,
            output: `wrote ${args.path} (${String(Buffer.byteLength(args.content))} bytes)`,
          }),
      };
    } catch (error) {
      return {
        approvalRule: this.name,
        execute: () =>
          Promise.resolve({ isError: true as const, output: `write failed: ${describeError(error)}` }),
      };
    }
  }
}

class BenchRunTestsTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'bench_run_tests';
  readonly description =
    'Run the benchmark project test suite (test/**/*.test.ts) in a sandbox and return the output. ' +
    'The sandbox can only see this project directory; network access and every other file are unavailable.';
  readonly parameters = { type: 'object', properties: {} };

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async () => {
        const files = await collectTestFiles(join(BENCH_WORKSPACE, 'test'));
        if (files.length === 0) {
          return { isError: true as const, output: 'no test files found under test/' };
        }
        const result = await runSandboxed({
          workspaceDir: BENCH_WORKSPACE,
          innerArgv: [process.execPath, '--test', '--test-reporter=tap', ...files],
          scratchRoot: BENCH_SANDBOX_ROOT,
          timeoutMs: 120_000,
          label: `tests-${String(Date.now())}`,
        });
        if (!result.isolated) {
          return {
            isError: true as const,
            output:
              'refusing to run tests: the sandbox could not be established ' +
              `(${result.reason ?? 'unknown reason'}). The benchmark never runs project tests unsandboxed.`,
          };
        }
        const output = `${result.stdout}\n${result.stderr}`.slice(0, MAX_TEST_OUTPUT);
        return {
          isError: result.exitCode !== 0,
          output: `exit=${String(result.exitCode)}\n${output}`,
        };
      },
    };
  }
}

async function collectTestFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.js')) {
        out.push(relative(BENCH_WORKSPACE, full));
      }
    }
  };
  await walk(root);
  return out.sort();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function registerBenchTools(): void {
  registerAgentToolService(IBenchListTool, BenchListFilesTool, {
    name: 'bench_list_files',
    source: 'builtin',
    domain: 'bench',
  });
  registerAgentToolService(IBenchReadTool, BenchReadFileTool, {
    name: 'bench_read_file',
    source: 'builtin',
    domain: 'bench',
  });
  registerAgentToolService(IBenchWriteTool, BenchWriteFileTool, {
    name: 'bench_write_file',
    source: 'builtin',
    domain: 'bench',
  });
  registerAgentToolService(IBenchTestsTool, BenchRunTestsTool, {
    name: 'bench_run_tests',
    source: 'builtin',
    domain: 'bench',
  });
}

// ---------------------------------------------------------------------------
// Engine bootstrap
// ---------------------------------------------------------------------------

/**
 * The synthetic profile replaces the builtin default profile (`agent`) so the
 * main agent starts with exactly the benchmark tool set and no host
 * instructions; a differently named file would only register an unused
 * profile.
 */
export const BENCH_AGENT_PROFILE_NAME = 'agent';

const BENCH_SYSTEM_PROMPT = `You are a benchmark worker inside a synthetic TypeScript project.

Rules:
- Work only inside the provided project. Use bench_list_files, bench_read_file, bench_write_file and bench_run_tests.
- Read before you write, and run the tests after changing code.
- Never invent files or paths that do not exist; check with bench_list_files when unsure.
- When the task is complete, reply with a short final answer. Do not describe your plan at length.`;

export const BENCH_PROFILE_FILE = 'bench-agent.md';

/**
 * Write the per-run engine home (stub config + the synthetic agent profile).
 *
 * In live mode only the profile is written (to the caller-provided path, i.e.
 * inside the benchmark workspace) — the managed engine home is never written.
 */
export async function prepareRunHome(options: {
  homeDir: string;
  endpoint: ArmPlan['endpoint'];
  model: ArmPlan['model'];
  profilePath: string;
}): Promise<{ profilePath: string; configPath: string }> {
  await mkdir(options.homeDir, { recursive: true, mode: 0o700 });
  const configPath = join(options.homeDir, 'config.toml');
  if (options.endpoint.mode === 'fixture') {
    const lines = [
      `[models.${options.model.id}]`,
      `name = ${JSON.stringify(options.model.name)}`,
      'protocol = "openai_responses"',
      `base_url = ${JSON.stringify(`http://127.0.0.1:${String(options.endpoint.port)}`)}`,
      `api_key = ${JSON.stringify(options.endpoint.apiKey)}`,
      `display_name = "Bench Stub Model"`,
      `max_context_size = ${String(options.model.maxContextSize)}`,
      `support_efforts = ${JSON.stringify(options.model.supportEfforts)}`,
      `default_effort = ${JSON.stringify(options.model.defaultEffort)}`,
      '',
    ];
    await writeFile(configPath, lines.join('\n'), 'utf8');
  }
  const profilePath = options.profilePath;
  await mkdir(dirname(profilePath), { recursive: true });
  await writeFile(
    profilePath,
    [
      '---',
      `name: ${BENCH_AGENT_PROFILE_NAME}`,
      `description: Bounded benchmark worker profile`,
      'override: true',
      `tools: ${BENCH_WORKSPACE_ALLOWED_TOOLS.join(', ')}`,
      '---',
      BENCH_SYSTEM_PROMPT,
      '',
    ].join('\n'),
    'utf8',
  );
  return { profilePath, configPath };
}

// ---------------------------------------------------------------------------
// Fixture backend (in-process, loopback, deterministic)
// ---------------------------------------------------------------------------

/** Written by the orchestrator; the arm renders these responses for its own turn. */
export interface FixtureHandshake {
  readonly port: number;
  readonly engineFingerprint: string;
  /**
   * Whether the arm's tool projection must match `engineFingerprint`. Runs that
   * never project tools (the cache probe and the preflight ping call
   * `generate` directly) cannot be checked this way and set this to false.
   */
  readonly enforceToolFingerprint: boolean;
  readonly turns: readonly { readonly responses: readonly ScriptedResponse[] }[];
}

interface FixtureState {
  readonly requests: {
    readonly index: number;
    readonly turn: number;
    readonly bodyDigest: string;
    readonly messageItems: number;
    readonly messageItemsWithId: number;
    readonly messageItemsWithPhase: number;
    readonly reasoningItems: number;
    readonly reasoningWithEncrypted: number;
    readonly toolCallItems: number;
    readonly toolNames: readonly string[];
    readonly model: string | null;
    readonly stream: boolean;
    readonly store: boolean | null;
    readonly includesEncryptedReasoning: boolean;
    readonly promptCacheKey: string | null;
    readonly instructionsDigest: string | null;
    readonly sessionIdHeaderPresent: boolean;
  }[];
  readonly fingerprints: string[];
  turn: number;
  readonly counts: number[];
  readonly exhausted: boolean[];
  fingerprintMismatch: boolean;
}

/** md5 of the sorted 5-character tool-name prefixes — mirrors the parent's computation. */
export function engineFingerprint(toolNames: readonly string[]): string {
  const joined = toolNames
    .map((name) => name.slice(0, 5))
    .sort()
    .join('|');
  return createHash('md5').update(joined).digest('hex').slice(0, 10);
}

function fixtureRequestFacts(body: unknown, headers: NodeJS.Dict<string | string[]>, turn: number, index: number): FixtureState['requests'][number] {
  const record = (body ?? {}) as Record<string, unknown>;
  const input = Array.isArray(record['input']) ? record['input'] : [];
  const tools = Array.isArray(record['tools']) ? record['tools'] : [];
  const toolNames = tools
    .map((tool) => (tool as { name?: unknown }).name)
    .filter((name): name is string => typeof name === 'string');
  let messageItems = 0;
  let messageItemsWithId = 0;
  let messageItemsWithPhase = 0;
  let reasoningItems = 0;
  let reasoningWithEncrypted = 0;
  let toolCallItems = 0;
  for (const raw of input) {
    const item = (raw ?? {}) as Record<string, unknown>;
    if (item['type'] === 'message') {
      messageItems += 1;
      if (typeof item['id'] === 'string') messageItemsWithId += 1;
      if (typeof item['phase'] === 'string') messageItemsWithPhase += 1;
    } else if (item['type'] === 'reasoning') {
      reasoningItems += 1;
      if (typeof item['encrypted_content'] === 'string' && item['encrypted_content'] !== '') {
        reasoningWithEncrypted += 1;
      }
    } else if (item['type'] === 'function_call') {
      toolCallItems += 1;
    }
  }
  const bodyText = JSON.stringify(body ?? null);
  const cacheKey = record['prompt_cache_key'];
  const instructions = record['instructions'];
  return {
    index,
    turn,
    bodyDigest: createHash('sha256').update(bodyText).digest('hex'),
    messageItems,
    messageItemsWithId,
    messageItemsWithPhase,
    reasoningItems,
    reasoningWithEncrypted,
    toolCallItems,
    toolNames: [...toolNames].sort(),
    model: typeof record['model'] === 'string' ? record['model'] : null,
    stream: record['stream'] === true,
    store: typeof record['store'] === 'boolean' ? record['store'] : null,
    includesEncryptedReasoning:
      Array.isArray(record['include']) && record['include'].includes('reasoning.encrypted_content'),
    promptCacheKey: typeof cacheKey === 'string' ? cacheKey : null,
    instructionsDigest: typeof instructions === 'string' ? createHash('sha256').update(instructions).digest('hex') : null,
    sessionIdHeaderPresent: Object.keys(headers).some(
      (name) => name.toLowerCase() === 'session-id' && headers[name] !== undefined,
    ),
  };
}

function createFixtureState(turns: number): FixtureState {
  return {
    requests: [],
    fingerprints: [],
    turn: 0,
    counts: Array.from({ length: turns }, () => 0),
    exhausted: Array.from({ length: turns }, () => false),
    fingerprintMismatch: false,
  };
}

async function startFixtureServer(
  handshake: FixtureHandshake,
  state: FixtureState,
): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = undefined;
      }
      const turn = state.turn;
      const turnPlan = handshake.turns[turn];
      const position = state.counts[turn] ?? 0;
      const response = turnPlan?.responses[position];
      const facts = {
        ...fixtureRequestFacts(body, req.headers, turn, state.requests.length),
        terminalEventServed: response?.hasTerminalEvent ?? false,
      };
      (state.requests as FixtureState['requests'][number][]).push(facts);
      const fingerprint = engineFingerprint(facts.toolNames);
      (state.fingerprints as string[]).push(fingerprint);
      const fingerprintOk = !handshake.enforceToolFingerprint || fingerprint === handshake.engineFingerprint;
      if (!fingerprintOk) state.fingerprintMismatch = true;

      if (!fingerprintOk || response === undefined) {
        state.exhausted[turn] = true;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: !fingerprintOk
                ? `engine fingerprint mismatch: got ${fingerprint}, expected ${handshake.engineFingerprint}`
                : `turn ${String(turn)} exhausted its ${String(state.counts[turn] ?? 0)}-request fixture budget`,
              type: 'fixture_refused',
            },
          }),
        );
        return;
      }
      state.counts[turn] = position + 1;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.end(renderSse(response));
    });
  });
  await new Promise<void>((resolvePromise) => {
    server.listen(handshake.port, '127.0.0.1', () => resolvePromise());
  });
  return server;
}

// ---------------------------------------------------------------------------
// Driving the real loop
// ---------------------------------------------------------------------------

interface EventCollector {
  readonly dispose: () => void;
}

async function drivePlan(plan: ArmPlan): Promise<RunResult> {
  const startedAt = Date.now();
  setBenchContext(plan.workspaceDir, plan.sandboxRoot);
  registerBenchTools();

  const { profilePath } = await prepareRunHome({
    homeDir: plan.homeDir,
    endpoint: plan.endpoint,
    model: plan.model,
    profilePath: plan.profilePath,
  });

  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '',
    HOME: plan.homeDir,
    KIMI_LOOP_MAX_STEPS_PER_TURN: String(plan.maxStepsPerTurn),
    KIMI_LOOP_MAX_ATTEMPTS_PER_STEP: String(plan.maxAttemptsPerStep),
    KIMI_BENCH_ARM_ROOT: plan.armRoot,
  };

  let fixtureServer: Server | undefined;
  let fixtureState: FixtureState | undefined;
  let handshake: FixtureHandshake | undefined;
  if (plan.endpoint.mode === 'fixture' && plan.handshakePath !== undefined) {
    handshake = JSON.parse(await readFile(plan.handshakePath, 'utf8')) as FixtureHandshake;
    fixtureState = createFixtureState(handshake.turns.length);
    fixtureServer = await startFixtureServer(handshake, fixtureState);
  }

  const { app } = bootstrap(
    {
      homeDir: plan.homeDir,
      cwd: plan.workspaceDir,
      env,
      clientIdentity: { productName: 'gpt-adaptation-bench', version: '0.0.1-bench', platform: 'bench' },
      args: { agentFiles: [profilePath] },
    },
    [...logSeed(resolveLoggingConfig({ homeDir: plan.homeDir, env }))],
  );

  const sandboxProbe = await probeSandbox();
  const resolvedEngineIndex = import.meta.resolve('@moonshot-ai/agent-core-v2');
  const resolvedOpenAIResponses = import.meta.resolve(
    '@moonshot-ai/agent-core-v2/kosong/provider/bases/openai/openai-responses',
  );
  const expectedRoot = join(plan.armRoot, 'packages', 'agent-core-v2');
  const armRootVerified = resolvedEngineIndex.startsWith(`file://${expectedRoot}/`);

  const klient = createKlient({ scope: app });
  const partial: RunResult = {
    runId: plan.runId,
    kind: plan.kind,
    arm: plan.arm,
    resolvedEngineIndex,
    resolvedOpenAIResponses,
    armRootVerified,
    modelId: plan.model.id,
    effort: plan.effort,
    status: 'ok',
    prompts: [],
    sandbox: { supported: sandboxProbe.supported, detail: sandboxProbe.detail ?? sandboxProbe.reason },
    startedAt,
    endedAt: startedAt,
  };

  try {
    await app.accessor.get(IConfigService).ready;
    // The offline fixture model is registered by this run's own config.toml.
    // Live mode must never write configuration (the managed home is read-only
    // for the benchmark and its digest is verified after every run).
    if (plan.endpoint.mode === 'fixture') await klient.global.kosong.setDefaultModel(plan.model.id);
    const session = await klient.global.sessions.create({
      workDir: plan.workspaceDir,
      title: `bench ${plan.runId}`,
    });
    (partial as { sessionId?: string }).sessionId = session.id;
    const handle = klient.session(session.id);
    const agent = handle.agent('main');

    if (plan.kind === 'preflight') {
      const preflight = await runPreflight(klient, plan);
      return { ...partial, preflight, status: preflight.responded ? 'ok' : 'error', endedAt: Date.now() };
    }

    if (plan.kind === 'cache') {
      const cache = await driveCache(klient, plan);
      (partial as { cacheRequests?: unknown }).cacheRequests = cache;
      return { ...partial, endedAt: Date.now() };
    }

    await agent.setModel(plan.model.id);
    if (plan.effort !== '') await agent.setThinking(plan.effort);
    await agent.setPermission('yolo');

    const prompts: PromptMetrics[] = [];
    const resumeRequired = plan.resumeAfter !== undefined;
    let resumePerformed = false;
    let restored: boolean | undefined;
    let modelAfterRestore: string | undefined;
    for (const [index, text] of plan.prompts.entries()) {
      if (fixtureState !== undefined) fixtureState.turn = index;
      // The engine reads env bindings on every config read, so this is the
      // authoritative per-turn step budget (== model requests for the turn).
      const turnBudget = plan.turnBudgets[index];
      if (turnBudget !== undefined) {
        env['KIMI_LOOP_MAX_STEPS_PER_TURN'] = String(turnBudget);
        process.env['KIMI_LOOP_MAX_STEPS_PER_TURN'] = String(turnBudget);
      }
      // `resumeAfter` names the turn after which the session is closed and
      // restored; the next turn therefore runs against the restored session.
      const restoreBefore = plan.resumeAfter !== undefined && index === plan.resumeAfter + 1;
      if (restoreBefore) {
        resumePerformed = true;
        await handle.close();
        await new Promise((resolve) => setTimeout(resolve, 500));
        restored = await handle.restore();
        await agent.setPermission('yolo');
        if (restored) {
          modelAfterRestore = await agent.getModel();
          if (plan.effort !== '') await agent.setThinking(plan.effort);
        }
      }
      const metrics = await runPrompt(agent, index, text, plan, restoreBefore, fixtureState);
      prompts.push(metrics);
      if (metrics.endedReason !== 'completed') break;
    }

    const context = await agent.getContext();
    const contract = {
      resumeRequired,
      resumePerformed,
      restored,
      modelAfterRestore,
      turnsLaunched: prompts.filter((prompt) => prompt.launched).length,
      turnsCompleted: prompts.filter((prompt) => prompt.endedReason === 'completed').length,
      continuedAfterResume:
        !resumeRequired ||
        prompts.some((prompt, index) => index > 0 && prompt.restoreBefore === true && prompt.endedReason === 'completed'),
    };
    return {
      ...partial,
      prompts,
      contract,
      requests: fixtureState?.requests,
      fixture:
        fixtureState === undefined || handshake === undefined
          ? undefined
          : {
              fingerprintVerified: !fixtureState.fingerprintMismatch,
              fingerprint: fixtureState.fingerprints[0] ?? '',
              expectedFingerprint: handshake.engineFingerprint,
              requests: fixtureState.requests.length,
              exhaustedTurns: fixtureState.exhausted.flatMap((exhausted, index) => (exhausted ? [index] : [])),
            },
      contextMessageCount: context.history.length,
      usage: await agent.getUsage(),
      endedAt: Date.now(),
    };
  } catch (error) {
    return {
      ...partial,
      status: 'error',
      errorText: describeError(error).slice(0, 2000),
      requests: fixtureState?.requests,
      endedAt: Date.now(),
    };
  } finally {
    await klient.close().catch(() => undefined);
    app.dispose();
    if (fixtureServer !== undefined) {
      fixtureServer.closeAllConnections();
      await new Promise<void>((resolvePromise) => fixtureServer?.close(() => resolvePromise()));
    }
  }
}

async function runPrompt(
  agent: AgentHandle,
  index: number,
  text: string,
  plan: ArmPlan,
  restoreBefore: boolean,
  fixtureState: FixtureState | undefined,
): Promise<PromptMetrics> {
  const budget = plan.turnBudgets[index] ?? 0;
  const requestsBeforeTurn = fixtureState?.requests.length ?? 0;
  const startedAt = Date.now();
  let firstVisibleTokenMs: number | undefined;
  let endedReason: string | undefined;
  let aborted = false;
  let turnId: number | undefined;
  const toolCalls: { name: string; id: string; ok?: boolean; error?: string }[] = [];

  const subs: EventCollector[] = [
    agent.events.on('assistant.delta', () => {
      firstVisibleTokenMs ??= Date.now() - startedAt;
    }),
    agent.events.on('thinking.delta', () => {
      firstVisibleTokenMs ??= Date.now() - startedAt;
    }),
    agent.events.on('tool.call.started', (event) => {
      toolCalls.push({ name: event.name, id: event.toolCallId });
    }),
    agent.events.on('tool.result', (event) => {
      const call = toolCalls.findLast((candidate) => candidate.id === event.toolCallId);
      if (call !== undefined) {
        call.ok = event.isError !== true;
        if (event.isError === true) {
          call.error = typeof event.output === 'string' ? event.output.slice(0, 300) : 'tool error';
        }
      }
    }),
    agent.events.on('turn.started', (event) => {
      turnId = event.turnId;
    }),
    agent.events.on('turn.ended', (event) => {
      endedReason = event.reason;
    }),
    agent.events.on('prompt.aborted', () => {
      aborted = true;
    }),
    agent.events.on('prompt.completed', (event) => {
      // `turn.ended` carries the reason; a failed prompt.completed still ends the turn.
      if (event.reason === 'failed' && endedReason === undefined) endedReason = 'failed';
    }),
  ];

  let launched = false;
  let submitError: string | undefined;
  try {
    const launch = await agent.prompt({ input: [{ type: 'text', text }] });
    launched = launch !== undefined;
  } catch (error) {
    submitError = describeError(error).slice(0, 1000);
  }

  const deadline = Date.now() + plan.runTimeoutMs;
  const settled = (): boolean => endedReason !== undefined || aborted || submitError !== undefined;
  while (!settled() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const errorText =
    submitError ?? (settled() ? undefined : 'prompt did not settle before the run deadline');
  for (const sub of subs) sub.dispose();

  return {
    index,
    launched,
    turnId,
    endedReason,
    aborted,
    errorText,
    restoreBefore,
    firstVisibleTokenMs,
    durationMs: Date.now() - startedAt,
    modelRequests: fixtureState === undefined ? 0 : fixtureState.requests.length - requestsBeforeTurn,
    turnBudget: budget,
    budgetExhausted:
      fixtureState !== undefined && fixtureState.exhausted[index] === true && endedReason !== 'completed',
    toolCalls,
  };
}


async function driveCache(
  klient: Klient,
  plan: ArmPlan,
): Promise<RunResult['cacheRequests']> {
  const cache = plan.cache;
  if (cache === undefined) throw new Error('cache plan missing');
  const out: {
    index: number;
    inputTokens: number | null;
    cachedTokens: number | null;
    outputTokens: number | null;
    firstTokenLatencyMs: number | null;
    streamDurationMs: number | null;
    usageObserved: boolean;
    timingObserved: boolean;
  }[] = [];
  for (let request = 0; request < cache.requests; request += 1) {
    let usageObserved = false;
    let timingObserved = false;
    let inputTokens: number | null = null;
    let cachedTokens: number | null = null;
    let outputTokens: number | null = null;
    let firstTokenLatencyMs: number | null = null;
    let streamDurationMs: number | null = null;
    for await (const event of klient.global.kosong.generate(
      plan.model.id,
      {
        systemPrompt: cache.systemPrompt,
        messages: [{ role: 'user', content: [{ type: 'text', text: cache.userText }], toolCalls: [] }],
        tools: [],
      },
      { cacheKey: cache.sessionKey, thinkingEffort: plan.effort === '' ? undefined : plan.effort },
    )) {
      const typed = event as {
        type: string;
        usage?: { inputOther?: number; inputCacheRead?: number; output?: number };
        firstTokenLatencyMs?: number;
        streamDurationMs?: number;
      };
      if (typed.type === 'usage' && typed.usage !== undefined) {
        const other = typed.usage.inputOther;
        const cacheRead = typed.usage.inputCacheRead;
        inputTokens = (other ?? 0) + (cacheRead ?? 0);
        cachedTokens = cacheRead ?? null;
        outputTokens = typed.usage.output ?? null;
        usageObserved = other !== undefined || cacheRead !== undefined || typed.usage.output !== undefined;
      }
      if (typed.type === 'timing') {
        firstTokenLatencyMs = typed.firstTokenLatencyMs ?? null;
        streamDurationMs = typed.streamDurationMs ?? null;
        timingObserved = true;
      }
    }
    out.push({
      index: request,
      inputTokens,
      cachedTokens,
      outputTokens,
      firstTokenLatencyMs,
      streamDurationMs,
      usageObserved,
      timingObserved,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/**
 * Availability probe: the engine's own auth-readiness check for the bound
 * model plus a single tiny round trip. Counted against the request budget by
 * the orchestrator, never part of the measured results.
 */
async function runPreflight(
  klient: Klient,
  plan: ArmPlan,
): Promise<NonNullable<RunResult['preflight']>> {
  try {
    await klient.global.auth.ensureReady(plan.model.id);
  } catch (error) {
    return { authReady: false, responded: false, errorText: describeError(error).slice(0, 500) };
  }
  let text = '';
  try {
    for await (const event of klient.global.kosong.generate(
      plan.model.id,
      {
        systemPrompt: 'You are a connectivity probe. Answer with the single word "pong".',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }], toolCalls: [] }],
        tools: [],
      },
      { maxCompletionTokens: 16 },
    )) {
      if (event.type === 'part' && event.part.type === 'text') text += event.part.text;
    }
  } catch (error) {
    return {
      authReady: true,
      responded: false,
      text,
      errorText: describeError(error).slice(0, 500),
    };
  }
  return { authReady: true, responded: text.trim().length > 0, text: text.slice(0, 120) };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runArmFromPlanFile(planPath: string): Promise<RunResult> {
  const raw = await readFile(planPath, 'utf8');
  const plan = JSON.parse(raw) as ArmPlan;
  const result = await drivePlan(plan);
  await mkdir(dirname(plan.resultPath), { recursive: true });
  await writeFile(plan.resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

/** Create the isolated per-run workspace with the given file tree. */
export async function materializeWorkspace(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  await rm(root, { recursive: true, force: true });
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
  return root;
}

export async function makeTempHome(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
