/**
 * Compares production Codex and Hakimi harnesses on frozen synthetic tasks.
 * Credentials and hidden graders remain in the parent; agents see a fresh
 * filesystem and a quota-controlled Responses socket. Default mode is offline.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findTask, type BenchTask } from './gpt-adaptation-bench.tasks.js';
import { gradeWorkspace, runScorerSelfTest, sha256, writeTree } from './gpt-adaptation-bench.scorer.js';
import { startProxy, type ProxyMetrics } from './gpt-harness-bench.proxy.js';
import { REPO_ROOT, runAgentProcess, snapshotEngine, type AgentProcessResult } from './gpt-harness-bench.sandbox.js';

export type HarnessArm = 'codex' | 'hakimi' | 'hakimi-patch' | 'hakimi-catalog';
export const CATALOG_DISCOVERY_TASK_ID = 'H01-catalog-discovery';

export function findHarnessTask(id: string): BenchTask {
  if (id !== CATALOG_DISCOVERY_TASK_ID) return findTask(id);
  const task = findTask('T11-error-handling-edge');
  return {
    ...task,
    id,
    title: 'Discover a deferred planning tool before fixing a queue',
    prompts: ['First use the TodoList tool to track the work; keep it updated as you progress. ' + task.prompts[0]],
  };
}
export interface HarnessOptions {
  live: boolean;
  selftest: boolean;
  model: string;
  effort: string;
  tasks: string[];
  arms: HarnessArm[];
  repeats: number;
  maxRequests: number;
  maxTotalTokens: number;
  timeoutMs: number;
  out: string;
  codexRoot: string;
  authFile?: string;
}

export function parseHarnessArgs(args: readonly string[]): HarnessOptions {
  const result: HarnessOptions = {
    live: false, selftest: false, model: 'gpt-6-astra', effort: 'high',
    tasks: ['T01-cross-file-fix', 'T07-resume-continue', 'T10-refactor-constraint'],
    arms: ['codex', 'hakimi', 'hakimi-patch'], repeats: 1, maxRequests: 12,
    maxTotalTokens: 150_000, timeoutMs: 240_000,
    out: join(REPO_ROOT, '.tmp/gpt-harness-capability', `run-${Date.now()}`),
    codexRoot: join(REPO_ROOT, '.tmp/gpt-harness-capability/tooling'),
  };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--') continue;
    if (key === '--live') { result.live = true; continue; }
    if (key === '--dry-run') { result.live = false; continue; }
    if (key === '--selftest') { result.selftest = true; continue; }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} requires a value`);
    switch (key) {
      case '--model': result.model = value; break;
      case '--effort': result.effort = value; break;
      case '--tasks': result.tasks = value.split(','); break;
      case '--arms': {
        const arms = value.split(',');
        if (arms.some((arm) => !['codex', 'hakimi', 'hakimi-patch', 'hakimi-catalog'].includes(arm))) throw new Error('Unknown harness arm');
        result.arms = arms as HarnessArm[];
        break;
      }
      case '--out': result.out = resolve(value); break;
      case '--codex-root': result.codexRoot = resolve(value); break;
      case '--auth-file': result.authFile = resolve(value); break;
      case '--repeats': result.repeats = Number(value); break;
      case '--max-requests': result.maxRequests = Number(value); break;
      case '--max-total-tokens': result.maxTotalTokens = Number(value); break;
      case '--timeout-ms': result.timeoutMs = Number(value); break;
      default: throw new Error(`Unknown option ${key}`);
    }
  }
  for (const key of ['repeats', 'maxRequests', 'maxTotalTokens', 'timeoutMs'] as const) {
    if (!Number.isSafeInteger(result[key]) || result[key] <= 0) throw new Error(`${key} must be a positive integer`);
  }
  if (new Set(result.tasks).size !== result.tasks.length || new Set(result.arms).size !== result.arms.length) throw new Error('Duplicate task or arm');
  for (const id of result.tasks) findHarnessTask(id);
  if (result.tasks.includes(CATALOG_DISCOVERY_TASK_ID) && result.arms.includes('codex')) {
    throw new Error('H01 uses the Hakimi TodoList contract; compare Hakimi arms only');
  }
  if (result.live && result.authFile === undefined) throw new Error('--live requires --auth-file (host-only Codex login)');
  return result;
}

export function runOrder(options: Pick<HarnessOptions, 'tasks' | 'arms' | 'repeats'>) {
  return options.tasks.flatMap((task) => Array.from({ length: options.repeats }, (_, repeat) => {
    const offset = repeat % options.arms.length;
    return [...options.arms.slice(offset), ...options.arms.slice(0, offset)].map((arm) => ({ task, repeat, arm }));
  }).flat());
}

export function codexArguments(model: string, effort: string, sessionId?: string): string[] {
  const options = [
    '/codex/node_modules/.bin/codex', 'exec', '--json', '--color', 'never',
    '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox', '-C', '/workspace', '-m', model,
    '-c', `model_reasoning_effort=${JSON.stringify(effort)}`,
    '-c', 'model_supports_reasoning_summaries=true',
    '-c', 'model_catalog_json="/engine/codex-models.json"',
    '-c', 'model_provider="bench"', '-c', 'model_providers.bench.name="Benchmark"',
    '-c', 'model_providers.bench.base_url="http://127.0.0.1:48631/v1"',
    '-c', 'model_providers.bench.wire_api="responses"',
    '-c', 'model_providers.bench.env_key="BENCH_API_KEY"',
    '-c', 'model_providers.bench.supports_websockets=false',
    '-c', 'model_providers.bench.request_max_retries=0',
    '-c', 'model_providers.bench.stream_max_retries=0',
  ];
  return sessionId === undefined ? [...options, '-'] : [...options, 'resume', sessionId, '-'];
}

export function readCodexEvents(stdout: string): { sessionId?: string; completed: boolean; failed: boolean } {
  let sessionId: string | undefined;
  let completed = false;
  let failed = false;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event['type'] === 'thread.started' && typeof event['thread_id'] === 'string') sessionId = event['thread_id'];
      if (event['type'] === 'turn.completed') completed = true;
      if (event['type'] === 'turn.failed' || event['type'] === 'error') failed = true;
    } catch { /* Non-JSON diagnostics do not count as successful completion. */ }
  }
  return { sessionId, completed, failed };
}

export function readHakimiEvents(stdout: string): { sessionId?: string; completed: boolean; toolSuccesses?: Record<string, number> } {
  let sessionId: string | undefined;
  let toolSuccesses: Record<string, number> | undefined;
  let completed = false;
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event['type'] === 'session.started' && typeof event['sessionId'] === 'string') sessionId = event['sessionId'];
      if (event['type'] === 'turn.ended') completed = event['reason'] === 'completed';
      const counts = event['successes'];
      if (event['type'] === 'tools.completed' && counts !== null && typeof counts === 'object') {
        toolSuccesses = {};
        for (const name of ['TodoList', 'select_tools']) {
          const count = (counts as Record<string, unknown>)[name];
          if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) toolSuccesses[name] = count;
        }
      }
    } catch { /* Ignore diagnostics, never infer completion from prose. */ }
  }
  return { sessionId, completed, toolSuccesses };
}

export function classifyRun(input: { completed: boolean; gradePassed: boolean; sandboxed: boolean; timedOut: boolean; metrics: ProxyMetrics }) {
  const { metrics } = input;
  const measurementComplete = metrics.upstreamRequests > 0 && metrics.usageObservedRequests === metrics.upstreamRequests;
  const infrastructureFailure = !input.sandboxed || metrics.authenticationFailures > 0 ||
    metrics.requests.some((request) => request.httpStatus !== 200 && !(input.timedOut && request.httpStatus === undefined) || request.terminal === 'failed') ||
    metrics.rejectedRequests > 0 && !metrics.requestBudgetExhausted && !metrics.tokenBudgetExhausted;
  const outcome = infrastructureFailure ? 'invalid'
    : input.timedOut ? 'budget_exhausted'
      : !measurementComplete ? 'invalid'
        : input.completed && input.gradePassed ? 'passed'
          : metrics.requestBudgetExhausted || metrics.tokenBudgetExhausted ? 'budget_exhausted' : 'failed';
  return { outcome, scored: outcome !== 'invalid', measurementComplete, passed: outcome === 'passed' };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
}

async function authHeaders(file: string): Promise<Record<string, string>> {
  const auth = JSON.parse(await readFile(file, 'utf8')) as { tokens?: { access_token?: string; account_id?: string } };
  const token = auth.tokens?.access_token;
  const account = auth.tokens?.account_id;
  if (!token || !account) throw new Error('Codex login is unavailable; no fallback model or credentials will be used');
  return { authorization: `Bearer ${token}`, 'chatgpt-account-id': account, originator: 'codex_cli_rs', 'User-Agent': 'codex_cli_rs/0.155.1' };
}

async function prepareHome(home: string, options: HarnessOptions, contextWindow: number): Promise<void> {
  await mkdir(join(home, 'hakimi'), { recursive: true });
  await mkdir(join(home, 'codex'), { recursive: true });
  await writeFile(join(home, 'hakimi/config.toml'), [
    'default_model = "bench"', '[models.bench]',
    `name = ${JSON.stringify(options.model)}`, 'protocol = "openai_responses"',
    'base_url = "http://chatgpt.com:48631/backend-api/codex"', 'api_key = "benchmark-placeholder"',
    `max_context_size = ${contextWindow}`, 'support_efforts = ["low", "medium", "high", "xhigh", "max", "ultra"]',
    `default_effort = ${JSON.stringify(options.effort)}`, '',
  ].join('\n'));
}

async function runOne(options: HarnessOptions, engineRoot: string, contextWindow: number, task: BenchTask, arm: HarnessArm, repeat: number) {
  const id = `${task.id}-${repeat}-${arm}`;
  const runDir = join(options.out, id);
  await mkdir(runDir);
  const workspace = join(runDir, 'workspace');
  const home = join(runDir, 'home');
  await writeTree(workspace, task.files);
  await prepareHome(home, options, contextWindow);
  const socketRoot = join(REPO_ROOT, '.tmp/harness-sockets');
  await mkdir(socketRoot, { recursive: true });
  const proxy = await startProxy({
    model: options.model, effort: options.effort, maxRequests: options.maxRequests,
    maxTotalTokens: options.maxTotalTokens,
    upstreamUrl: 'https://chatgpt.com/backend-api/codex/responses',
    getHeaders: () => authHeaders(options.authFile!),
    listen: { unixSocketPath: join(socketRoot, `${sha256(runDir).slice(0, 16)}.sock`) },
  });
  const started = Date.now();
  const processes: AgentProcessResult[] = [];
  let completed = false;
  let toolSuccesses: Record<string, number> = {};
  try {
    let sessionId: string | undefined;
    for (const [index, prompt] of task.prompts.entries()) {
        await writeJson(join(runDir, 'plan.json'), {
          model: options.model, effort: options.effort, sessionId,
          patch: arm === 'hakimi-patch' || arm === 'hakimi-catalog', catalog: arm === 'hakimi-catalog', maxRequests: options.maxRequests,
        });
        const remaining = options.timeoutMs - (Date.now() - started);
        if (remaining <= 0) break;
        const processResult = await runAgentProcess({
          engineRoot, workspace, home, runDir, codexRoot: options.codexRoot,
          socketPath: proxy.unixSocketPath!,
          argv: arm === 'codex' ? codexArguments(options.model, options.effort, sessionId)
            : ['/runtime/bin/node', '--import', '/engine/node_modules/tsx/dist/loader.mjs', '--import', '/engine/build/register-raw-text-loader.mjs', '/engine/packages/klient/examples/gpt-harness-bench.hakimi.ts'],
          timeoutMs: remaining, stdin: prompt,
        });
        processes.push(processResult);
        const events = arm === 'codex' ? readCodexEvents(processResult.stdout) : readHakimiEvents(processResult.stdout);
        if ('toolSuccesses' in events && events.toolSuccesses !== undefined) toolSuccesses = events.toolSuccesses;
        sessionId = events.sessionId ?? sessionId;
        if (processResult.exitCode !== 0 || processResult.timedOut || !events.completed || ('failed' in events && events.failed)) break;
        completed = index === task.prompts.length - 1;
        if (index < task.prompts.length - 1 && sessionId === undefined) throw new Error('Harness did not supply a resumable session id');
    }
  } finally { await proxy.close(); }
  const agentElapsedMs = Date.now() - started;
  const gradeStarted = Date.now();
  const grade = await gradeWorkspace(task, workspace, { scratchDir: join(runDir, 'grade') });
  const gradeElapsedMs = Date.now() - gradeStarted;
  for (const [index, output] of processes.entries()) {
    await writeFile(join(runDir, `process-${index}.stdout.log`), output.stdout);
    await writeFile(join(runDir, `process-${index}.stderr.log`), output.stderr);
  }
  const capabilityChecks = task.id === CATALOG_DISCOVERY_TASK_ID
    ? [{ name: 'requested TodoList tool executed successfully', passed: (toolSuccesses['TodoList'] ?? 0) > 0 }]
    : [];
  const classification = classifyRun({ completed, gradePassed: grade.passed && capabilityChecks.every((check) => check.passed), sandboxed: grade.sandboxed, timedOut: processes.some((p) => p.timedOut), metrics: proxy.metrics });
  const result = {
    id, arm, task: task.id, repeat, model: options.model, effort: options.effort,
    completed, ...classification, grade, capabilityChecks, toolSuccesses,
    elapsedMs: agentElapsedMs, gradeElapsedMs, metrics: proxy.metrics,
    processes: processes.map(({ stdout, stderr, ...facts }) => ({ ...facts, stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr) })),
  };
  await writeJson(join(runDir, 'result.json'), result);
  process.stdout.write(JSON.stringify({ id, outcome: result.outcome, passed: result.passed, completed, elapsedMs: result.elapsedMs, metrics: result.metrics }) + '\n');
  return result;
}

export async function main(args: readonly string[]): Promise<void> {
  const options = parseHarnessArgs(args);
  const order = runOrder(options);
  if (!options.live && !options.selftest) {
    process.stdout.write(JSON.stringify({ mode: 'dry-run', options, order, totalRequestCap: order.length * options.maxRequests, tokenBudget: 'observed after each response; no hard in-flight token cap' }, null, 2) + '\n');
    return;
  }
  if (process.platform !== 'linux') throw new Error('Run all harness arms in the same Linux environment');
  if (existsSync(options.out)) throw new Error('Output directory already exists; choose a fresh run id');
  await mkdir(options.out, { recursive: true });
  if (options.selftest) {
    const results = [];
    for (const id of options.tasks) results.push(await runScorerSelfTest(findHarnessTask(id), { scratchDir: join(options.out, id) }));
    await writeJson(join(options.out, 'selftest.json'), results);
    process.stdout.write(JSON.stringify(results) + '\n');
    if (results.some((result) => !result.ok)) throw new Error('Hidden grader self-test failed');
    return;
  }
  await authHeaders(options.authFile!);
  const codexBin = join(options.codexRoot, 'node_modules/.bin/codex');
  const version = spawnSync(codexBin, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) throw new Error('Pinned Linux Codex CLI is unavailable');
  const binaryPath = join(options.codexRoot, 'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex');
  if (!existsSync(binaryPath)) throw new Error('Expected a pinned Linux x64 Codex distribution');
  const codexBinaryHash = createHash('sha256').update(await readFile(binaryPath)).digest('hex');
  const engineRoot = join(options.out, 'engine');
  const engineHash = await snapshotEngine(engineRoot);
  const clientVersion = /codex-cli (\S+)/.exec(version.stdout)?.[1];
  if (clientVersion === undefined) throw new Error('Cannot identify Codex CLI version');
  const catalogResponse = await fetch(`https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(clientVersion)}`, {
    headers: await authHeaders(options.authFile!), signal: AbortSignal.timeout(30_000),
  });
  if (!catalogResponse.ok) throw new Error(`Official model catalog unavailable: HTTP ${catalogResponse.status}`);
  const catalogText = await catalogResponse.text();
  const catalog = JSON.parse(catalogText) as { models: Array<{ slug: string; context_window: number }> };
  const model = catalog.models.find((entry) => entry.slug === options.model);
  if (model === undefined || !Number.isSafeInteger(model.context_window)) throw new Error('Requested model is absent from the official catalog; no fallback');
  await writeFile(join(engineRoot, 'codex-models.json'), catalogText);
  await writeJson(join(options.out, 'manifest.json'), {
    version: 1, model: options.model, effort: options.effort, order, engineHash,
    codexVersion: version.stdout.trim(), codexBinaryHash, nodeVersion: process.version,
    modelCatalogHash: sha256(catalogText), contextWindow: model.context_window,
    dependencyLockHash: sha256(await readFile(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8')),
    authentication: 'shared host-only Codex OAuth',
    managedBackendAlias: 'chatgpt.com resolves only to the isolated loopback proxy; production session affinity and output-cap rules remain active',
    maxRequestsPerRun: options.maxRequests, maxTotalTokensObservedPerRun: options.maxTotalTokens,
    timeoutMsPerRun: options.timeoutMs, tasks: options.tasks.map((id) => ({ id, hash: sha256(JSON.stringify(findHarnessTask(id))) })),
    variants: { hakimi: { apply_patch: false, tool_catalog: false }, 'hakimi-patch': { apply_patch: true, tool_catalog: false }, 'hakimi-catalog': { apply_patch: true, tool_catalog: true } },
    limitations: ['Synthetic diagnostic tasks, not a general capability benchmark', 'Token budget is checked after responses, not a hard generation cap', 'Hakimi arms share frozen source; only the declared experimental flags differ', 'Both harnesses restart and restore on each follow-up; future prompts remain host-only'],
  });
  const results = [];
  for (const item of order) {
    results.push(await runOne(options, engineRoot, model.context_window, findHarnessTask(item.task), item.arm, item.repeat));
    await writeJson(join(options.out, 'results.json'), results);
    if (results.at(-1)?.outcome === 'invalid') {
      await writeFile(join(options.out, 'report.md'), '# Incomplete harness experiment\n\nStopped after an infrastructure or measurement failure. See results.json; invalid runs are not capability scores.\n');
      throw new Error('Invalid experiment run; stopped before spending the remaining request budget');
    }
  }
  const report = ['# GPT harness comparison', '', `Model: ${options.model}; reasoning: ${options.effort}; ${version.stdout.trim()}`, '',
    '| Task | Repeat | Arm | Outcome | Requests | Input tokens | Output tokens | Agent duration (s) |',
    '| --- | ---: | --- | --- | ---: | ---: | ---: | ---: |',
    ...results.map((r) => `| ${r.task} | ${r.repeat} | ${r.arm} | ${r.outcome} | ${r.metrics.upstreamRequests} | ${r.metrics.usage.inputTokens} | ${r.metrics.usage.outputTokens} | ${(r.elapsedMs / 1000).toFixed(1)} |`),
    '', 'This is a small synthetic-task experiment. Passing these tasks does not establish general equivalence to Codex.', '',
  ];
  await writeFile(join(options.out, 'report.md'), report.join('\n'));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
