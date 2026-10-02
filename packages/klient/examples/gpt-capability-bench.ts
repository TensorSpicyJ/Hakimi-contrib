/** Reproducible Hakimi A/B matrix; remote execution always requires finite batch caps. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CapabilityTask } from './gpt-capability-bench.tasks.js';
import { getSuite } from './gpt-capability-bench.suites.js';
import { parseArgs, balancedOrder, PROFILES, type Options, type Profile } from './gpt-capability-bench.config.js';
import { BatchLedger, type BatchCaps } from './gpt-capability-bench.ledger.js';
import { buildReport, renderReport, type Observation, type PlannedObservation } from './gpt-capability-bench.report.js';
import { CapabilityEvidence, type CapabilityToolCall } from './gpt-capability-bench.hakimi.js';
import { checkCapabilityEvidence } from './gpt-capability-bench.scorer.js';
import { prepareCapabilityHome } from './gpt-capability-bench.setup.js';
import { inspectMcpRequest, type McpRequestInspection } from './gpt-capability-bench.mcp.js';
import { archiveBenchmarkControl, benchmarkSourceHash, freezeRuntime, hashTree, startFixture } from './gpt-capability-bench.runtime.js';
import { gradeWorkspace, runScorerSelfTest, sha256, writeTree } from './gpt-adaptation-bench.scorer.js';
import { useCapabilitySandbox, runEscapeProbes } from './gpt-adaptation-bench.sandbox.js';
import { classifyRun } from './gpt-harness-bench.js';
import { startProxy } from './gpt-harness-bench.proxy.js';
import { REPO_ROOT, runAgentProcess, type AgentProcessResult } from './gpt-harness-bench.sandbox.js';

const SCRATCH = join(REPO_ROOT, '.tmp/hakimi-benchmark-v2');
const EMPTY = { durationMs: null, requests: null, inputTokens: null, cachedInputTokens: null, nonCachedInputTokens: null, outputTokens: null, toolErrors: null, repeatedAttempts: null, manualInterventions: null };
export function selectTasks(options: Options): CapabilityTask[] {
  const suite = getSuite(options.suite);
  let tasks = options.tasks === undefined ? [...suite.tasks] : options.tasks.map((id) => {
    const task = suite.tasks.find((t) => t.id === id); if (!task) throw new Error(`Unknown task ${id} in suite ${suite.id}`); return task;
  });
  if (options.tasks === undefined && options.split !== 'all') tasks = tasks.filter((t) => t.split === options.split);
  if (options.smoke) tasks = [tasks.find((t) => t.category === 'simple'), tasks.find((t) => t.id.startsWith('F01'))].filter((t): t is CapabilityTask => t !== undefined);
  if (tasks.length === 0) throw new Error('Empty task selection');
  return tasks;
}
export function planMatrix(options: Options): PlannedObservation[] {
  const tasks = selectTasks(options);
  return balancedOrder(tasks.map((t) => t.id), options.variants.map((v) => v.id), options.repeats, options.profiles, options.seed).map((item) => {
    const task = tasks.find((t) => t.id === item.taskId)!;
    return { ...item, suite: options.suite, id: `${options.suite}-${item.taskId}-${item.budgetProfile}-${item.repeat}-${item.variant}`, category: task.category, split: task.split, discovery: task.discovery,
      mode: options.mode === 'live' ? 'live' : options.mode === 'dry-run' ? 'dry-run' : 'offline' };
  });
}
async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n'); await rename(`${path}.tmp`, path);
}
export function frozenConfig(options: Options, planned: readonly PlannedObservation[]) {
  const suite = getSuite(options.suite);
  return { version: 2, suite: { id: suite.id, version: suite.version, notes: suite.notes }, model: options.model, effort: options.effort, seed: options.seed, variants: options.variants, applyPatch: true,
    mcpReadinessPolicy: options.suite === 'v3' ? { version: 1, tasks: ['F02-mcp-calibration'], fixture: 'public-session-overlay', check: 'initial-main-request-before-quota-and-auth', requiredTool: 'mcp__bench__lookup', failure: 'latched-invalid-stop-no-automatic-retry' } : undefined,
    profiles: PROFILES, planned, tasks: selectTasks(options).map((task) => ({ id: task.id, hash: sha256(JSON.stringify(task)), provenance: task.provenance })),
    authentication: options.mode === 'live' ? 'host-only subscription OAuth; no dollar billing estimate' : 'none',
    pi: { status: 'not_implemented', rule: 'A future adapter must pin actual version/config and compare only mutually supported tasks; unsupported is not failed.' } };
}
async function authHeaders(file: string): Promise<Record<string, string>> {
  // Called only after explicit --live, inside the host-owned proxy. Never logged or mounted.
  const auth = JSON.parse(await readFile(file, 'utf8')) as { tokens?: { access_token?: string; account_id?: string } };
  if (!auth.tokens?.access_token || !auth.tokens.account_id) throw new Error('Host login unavailable');
  return { authorization: `Bearer ${auth.tokens.access_token}`, 'chatgpt-account-id': auth.tokens.account_id, originator: 'codex_cli_rs' };
}
async function batchLock(root: string): Promise<() => Promise<void>> {
  const file = join(root, 'batch.lock');
  if (existsSync(file)) {
    const pid = Number(await readFile(file, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid batch lock; inspect it before recovery');
    throw new Error(`Batch lock exists (PID ${pid}). Verify the owner has stopped and move the stale lock aside before resuming; it is never automatically removed.`);
  }
  const fd = await open(file, 'wx', 0o600); await fd.writeFile(String(process.pid)); await fd.close();
  return async () => { await unlink(file); };
}

/** F02 starts a fresh main agent with one prompt and no scheduled compaction.
 * Its first provider request therefore measures initial main-tool readiness.
 * Later requests may belong to restricted subagents; do not mistake their
 * legitimate tool sets for failed main setup. A failed first check is latched. */
export function createMcpReadinessCheck(catalog: boolean) {
  const checks: McpRequestInspection[] = [];
  let ready: boolean | undefined;
  return { checks, validate: (body: Readonly<Record<string, unknown>>): boolean => {
    if (ready !== undefined) return ready;
    ready = false; // An inspector exception also latches rejection.
    const inspection = inspectMcpRequest(body, { catalog, requiredTool: 'mcp__bench__lookup' });
    checks.push(inspection);
    ready = inspection.ready;
    return ready;
  } };
}

interface TurnEvidence {
  sessionId?: string;
  reason: string;
  finalText: string;
  toolSuccesses: Record<string, number>;
  toolErrors: Record<string, number>;
  repeatedAttempts: number;
  measurementErrors: string[];
  toolCalls: CapabilityToolCall[];
  agents: unknown[];
  tasks: unknown[];
  compactions: unknown[];
  interventions: unknown[];
}
export function decodeEvidence(stdout: string): { sessionId?: string; result?: TurnEvidence; partial: ReturnType<CapabilityEvidence['snapshot']> } {
  const evidence = new CapabilityEvidence();
  let sessionId: string | undefined;
  let result: TurnEvidence | undefined;
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event['type'] === 'session.started' && typeof event['sessionId'] === 'string') sessionId = event['sessionId'];
      if (event['type'] === 'capability.result') result = event as unknown as TurnEvidence;
      if (event['type'] === 'capability.event' && typeof event['agentId'] === 'string') {
        const body = event['event'] as Record<string, unknown>;
        if (typeof body['toolCallId'] !== 'string') continue;
        if (typeof body['name'] === 'string') evidence.started(event['agentId'], { toolCallId: body['toolCallId'], name: body['name'], args: body['args'] });
        else if (Object.hasOwn(body, 'output')) evidence.result(event['agentId'], { toolCallId: body['toolCallId'], output: body['output'], isError: body['isError'] === true, synthetic: body['synthetic'] === true });
      }
    } catch { /* Non-JSON engine diagnostics cannot certify success. */ }
  }
  return { sessionId, result, partial: evidence.snapshot() };
}

/** Read-only crash recovery also used by --report; never reclassifies a charged run as unattempted. */
export async function recoverObservations(root: string, planned: readonly PlannedObservation[], ledger: BatchLedger): Promise<Observation[]> {
  const results = existsSync(join(root, 'results.json')) ? JSON.parse(await readFile(join(root, 'results.json'), 'utf8')) as Observation[] : [];
  for (const item of planned) {
    if (results.some((r) => r.id === item.id)) continue;
    const file = join(root, item.id, 'result.json');
    if (existsSync(file)) results.push(JSON.parse(await readFile(file, 'utf8')) as Observation);
    else if (ledger.hasRun(item.id)) results.push({ ...item, ...EMPTY, outcome: 'invalid', artifactCorrect: null, completeDelivery: null,
      requests: ledger.requestsFor(item.id), reason: 'Reserved run has no committed observation (interrupted or still in progress); reservations remain charged' });
  }
  return results;
}

async function runOne(options: Options, planned: PlannedObservation, engineRoot: string, contextWindow: number, ledger: BatchLedger): Promise<Observation> {
  const task = getSuite(options.suite).tasks.find((t) => t.id === planned.taskId);
  if (task === undefined || planned.suite !== options.suite) throw new Error('Run task does not belong to the frozen suite');
  const variant = options.variants.find((v) => v.id === planned.variant)!;
  const budget = PROFILES[planned.budgetProfile as Profile];
  const runDir = join(options.out, planned.id);
  await mkdir(runDir);
  const workspace = join(runDir, 'workspace');
  const home = join(runDir, 'home');
  await writeTree(workspace, task.files);
  await prepareCapabilityHome(home, { model: options.model, effort: options.effort, contextWindow }, task);
  const checkMcpReadiness = options.suite === 'v3' && task.id.startsWith('F02');
  if (checkMcpReadiness && (task.prompts.length !== 1 || task.compactBeforeTurn !== undefined)) throw new Error('Initial MCP readiness requires the frozen single-turn F02 contract');
  const mcpReadinessCheck = checkMcpReadiness ? createMcpReadinessCheck(variant.toolCatalog) : undefined;
  const mcpReadiness = mcpReadinessCheck?.checks;
  const fixture = options.mode === 'stub' ? await startFixture(task) : undefined;
  const socketRoot = join(SCRATCH, 'sockets'); await mkdir(socketRoot, { recursive: true });
  const proxy = await startProxy({ model: options.model, effort: options.effort, maxRequests: budget.maxRequests, maxTotalTokens: budget.maxObservedTokens,
    upstreamUrl: fixture?.url ?? 'https://chatgpt.com/backend-api/codex/responses',
    getHeaders: fixture ? async () => ({}) : () => authHeaders(options.authFile!),
    validateRequest: mcpReadinessCheck?.validate,
    reserveRequest: () => ledger.reserveRequest(planned.id),
    requestFinished: (record) => { if (record.usage) ledger.usage(planned.id, record.usage.totalTokens); },
    listen: { unixSocketPath: join(socketRoot, `${sha256(runDir).slice(0, 16)}.sock`) },
  });
  const started = Date.now();
  const processes: AgentProcessResult[] = [];
  const turns: TurnEvidence[] = [];
  const partials: ReturnType<CapabilityEvidence['snapshot']>[] = [];
  let completed = false;
  let expired = false;
  let executionError: string | undefined;
  try {
    let sessionId: string | undefined;
    for (const [index, prompt] of task.prompts.entries()) {
      const remaining = Math.min(budget.timeoutMs - (Date.now() - started), ledger.remainingMs);
      if (remaining <= 0) { expired = true; break; }
      const compactBeforePrompt = index > 0 && (task.compactBeforeTurn === index || variant.contextPolicy === 'compact-before-followup');
      await writeJson(join(runDir, 'plan.json'), { model: options.model, effort: options.effort, sessionId, patch: true,
        catalog: variant.toolCatalog, maxRequests: budget.maxRequests, compactBeforePrompt, requiredMcpServer: task.id.startsWith('F02') ? 'bench' : undefined,
        mcpFixtureOverlay: checkMcpReadiness ? true : undefined });
      fixture?.setTurn(index);
      const output = await runAgentProcess({ engineRoot, dependencyRoot: engineRoot, workspace, home, runDir, codexRoot: engineRoot,
        socketPath: proxy.unixSocketPath!, timeoutMs: remaining, stdin: variant.promptPrefix + prompt,
        argv: ['/runtime/bin/node', '--import', '/engine/node_modules/tsx/dist/loader.mjs', '--import', '/engine/build/register-raw-text-loader.mjs', '/engine/packages/klient/examples/gpt-capability-bench.hakimi.ts'] });
      processes.push(output);
      await writeFile(join(runDir, `turn-${index}.stdout.log`), output.stdout);
      await writeFile(join(runDir, `turn-${index}.stderr.log`), output.stderr);
      const decoded = decodeEvidence(output.stdout);
      sessionId = decoded.sessionId ?? sessionId;
      if (decoded.result) turns.push(decoded.result); else partials.push(decoded.partial);
      if (output.timedOut || output.exitCode !== 0 || decoded.result?.reason !== 'completed') break;
      if (compactBeforePrompt && decoded.result.compactions.length === 0) throw new Error('Required compaction has no completion evidence');
      completed = index === task.prompts.length - 1;
      if (!sessionId && !completed) throw new Error('Missing resume session id');
    }
  } catch (error) { executionError = error instanceof Error ? error.message : String(error); }
  finally { await proxy.close(); await fixture?.close(); }
  const durationMs = Date.now() - started;
  const grade = await gradeWorkspace(task, workspace, { scratchDir: join(runDir, 'grade') });
  const capabilityChecks = checkCapabilityEvidence(task, turns);
  const completeDelivery = completed && Boolean(turns.at(-1)?.finalText.trim());
  const classification = classifyRun({ completed: completeDelivery, gradePassed: grade.passed && capabilityChecks.every((c) => c.passed), sandboxed: grade.sandboxed,
    timedOut: expired || processes.some((p) => p.timedOut), metrics: proxy.metrics });
  const measurementErrors = turns.flatMap((t) => t.measurementErrors);
  const readinessFailure = (proxy.metrics.requestValidationFailures ?? 0) > 0
    ? `MCP request readiness failed before upstream dispatch: ${mcpReadiness?.find((check) => !check.ready)?.reason ?? 'inspection-error'}` : undefined;
  const invalid = readinessFailure !== undefined || executionError !== undefined || processes.some((p) => p.outputTruncated) || measurementErrors.length > 0;
  const knownUsage = classification.measurementComplete;
  const knownCache = knownUsage && proxy.metrics.requests.every((request) => request.cacheUsageObserved === true);
  const observations = [...turns, ...partials];
  const toolMeasurementsComplete = turns.length === processes.length && turns.length > 0 && measurementErrors.length === 0 && !processes.some((p) => p.outputTruncated);
  const sum = (map: Record<string, number>) => Object.values(map).reduce((a, b) => a + b, 0);
  const result: Observation = { ...planned, outcome: invalid ? 'invalid' : classification.outcome === 'budget_exhausted' ? 'budget_exhausted' : classification.outcome === 'invalid' ? 'invalid' : classification.passed ? 'passed' : 'failed',
    artifactCorrect: grade.sandboxed ? grade.passed : null, completeDelivery, durationMs, requests: ledger.requestsFor(planned.id),
    inputTokens: knownUsage ? proxy.metrics.usage.inputTokens : null,
    cachedInputTokens: knownCache ? proxy.metrics.usage.cachedInputTokens : null,
    nonCachedInputTokens: knownCache ? proxy.metrics.usage.inputTokens - proxy.metrics.usage.cachedInputTokens : null,
    outputTokens: knownUsage ? proxy.metrics.usage.outputTokens : null,
    toolErrors: toolMeasurementsComplete ? observations.reduce((n, t) => n + sum(t.toolErrors), 0) : null,
    repeatedAttempts: toolMeasurementsComplete ? observations.reduce((n, t) => n + t.repeatedAttempts, 0) : null,
    manualInterventions: toolMeasurementsComplete ? turns.reduce((n, t) => n + t.interventions.length, 0) : null,
    reason: readinessFailure ?? executionError ?? (measurementErrors.length > 0 ? measurementErrors.join('; ') : undefined), evidence: [`${planned.id}/evidence.json`] };
  await writeJson(join(runDir, 'evidence.json'), { grade, capabilityChecks, turns, partials, metrics: proxy.metrics, mcpReadiness, measurementErrors, processes: processes.map(({ stdout, stderr, ...p }) => ({ ...p, stdoutHash: sha256(stdout), stderrHash: sha256(stderr) })) });
  await writeJson(join(runDir, 'result.json'), result);
  ledger.finish(planned.id);
  return result;
}

export async function main(args: readonly string[]): Promise<void> {
  const options = parseArgs(args);
  if (options.report) {
    const manifest = JSON.parse(await readFile(join(options.report, 'manifest.json'), 'utf8')) as { config: { planned: PlannedObservation[]; seed: number }; caps: BatchCaps; configHash: string };
    const ledger = new BatchLedger(options.report, manifest.caps, manifest.configHash, true);
    const observations = await recoverObservations(options.report, manifest.config.planned, ledger);
    process.stdout.write(renderReport(buildReport(observations, manifest.config.planned, manifest.config.seed))); return;
  }
  const planned = planMatrix(options);
  const config = frozenConfig(options, planned);
  const configHash = sha256(JSON.stringify(config));
  const budget = { plannedRuns: planned.length, maximumRequestsAtPerRunLimits: planned.reduce((n, p) => n + PROFILES[p.budgetProfile as Profile].maxRequests, 0),
    maximumSerialTimeMs: planned.reduce((n, p) => n + PROFILES[p.budgetProfile as Profile].timeoutMs, 0), caps: options.caps ?? null,
    tokenPolicy: 'Observed after responses, not a hard in-flight token/output cap. Missing usage stays unknown. No USD estimate for subscription OAuth.' };
  if (options.mode === 'dry-run') { process.stdout.write(JSON.stringify({ mode: options.mode, config, configHash, budget }, null, 2) + '\n'); return; }
  if (process.platform !== 'linux') throw new Error('Benchmark execution requires Linux');
  if (!options.out.startsWith(SCRATCH + sep)) throw new Error('Outputs must be under repository .tmp/hakimi-benchmark-v2/');
  useCapabilitySandbox();
  if (!options.resume && existsSync(options.out)) throw new Error('Output exists; choose a fresh id or explicitly --resume');
  if (options.resume && !existsSync(join(options.out, 'manifest.json'))) throw new Error('No resumable manifest');
  await mkdir(options.out, { recursive: true });
  const unlock = await batchLock(options.out);
  try {
    if (options.mode === 'selftest') {
      const tests = [];
      for (const task of selectTasks(options)) {
        const test = await runScorerSelfTest(task, { scratchDir: join(options.out, task.id) }); tests.push(test);
        process.stdout.write(JSON.stringify({ task: task.id, ok: test.ok }) + '\n');
      }
      const probes = await runEscapeProbes({ scratchRoot: join(options.out, 'sandbox'), runRoot: options.out });
      await writeJson(join(options.out, 'selftest.json'), { suite: config.suite, configHash, tests, probes });
      if (tests.some((t) => !t.ok) || probes.some((p) => !p.okay)) throw new Error('Offline scorer/isolation controls failed');
      return;
    }
    const engineRoot = join(options.out, 'engine');
    const sourceHash = await benchmarkSourceHash();
    const caps: BatchCaps = options.caps ?? { maxRuns: planned.length, maxRequests: budget.maximumRequestsAtPerRunLimits,
      timeoutMs: budget.maximumSerialTimeMs, maxObservedTokens: planned.reduce((n, p) => n + PROFILES[p.budgetProfile as Profile].maxObservedTokens, 0) };
    let contextWindow = 262144;
    let modelCatalogHash: string | undefined;
    let modelCatalogText: string | undefined;
    if (options.modelCatalog) {
      const text = await readFile(options.modelCatalog, 'utf8');
      const catalog = JSON.parse(text) as { models: { slug: string; context_window: number }[] };
      const model = catalog.models.find((m) => m.slug === options.model);
      if (!model || !Number.isSafeInteger(model.context_window) || model.context_window < 1) throw new Error('Frozen catalog lacks the exact requested model/context');
      contextWindow = model.context_window; modelCatalogHash = sha256(text);
      modelCatalogText = text;
    }
    if (!options.resume) {
      const snapshot = await freezeRuntime(engineRoot);
      if (sourceHash !== await benchmarkSourceHash()) throw new Error('Benchmark sources changed during freezing');
      const control = await archiveBenchmarkControl(options.out, sourceHash, { ...getSuite(options.suite), tasks: selectTasks(options) }, modelCatalogText);
      await writeJson(join(options.out, 'manifest.json'), { config, configHash, sourceHash, ...snapshot, modelCatalogHash, contextWindow,
        nodeVersion: process.version, nodeBinaryHash: createHash('sha256').update(await readFile(process.execPath)).digest('hex'),
        dependencyLockHash: control.dependencyLockHash, controlArchive: 'control-source/index.json', controlArchiveHash: control.archiveHash, caps, budget,
        gitHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim(),
        limitations: ['Task authors see acceptance fixtures; not a sealed external holdout.', 'Project fixtures are reduced reproductions, not full application tasks.', 'Stub measurements are fabricated fixture usage and never live model evidence.', 'A/B source and dependencies are frozen copies; OS binaries are shared.', 'Interrupted runs remain invalid; resume advances remaining runs without refund.'] });
      await writeJson(join(options.out, 'results.json'), []);
    } else {
      const frozen = JSON.parse(await readFile(join(options.out, 'manifest.json'), 'utf8')) as Record<string, unknown>;
      const nodeBinaryHash = createHash('sha256').update(await readFile(process.execPath)).digest('hex');
      if (frozen['configHash'] !== configHash || frozen['sourceHash'] !== sourceHash || frozen['modelCatalogHash'] !== modelCatalogHash || frozen['nodeVersion'] !== process.version || frozen['nodeBinaryHash'] !== nodeBinaryHash || frozen['engineHash'] !== await hashTree(engineRoot)) throw new Error('Frozen inputs changed; resume refused');
      if (typeof frozen['controlArchiveHash'] !== 'string' || frozen['controlArchiveHash'] !== await hashTree(join(options.out, 'control-source'))) throw new Error('Frozen control archive changed or missing; resume refused');
    }
    const ledger = new BatchLedger(options.out, caps, configHash, options.resume);
    const results = JSON.parse(await readFile(join(options.out, 'results.json'), 'utf8')) as Observation[];
    const save = async () => {
      const report = buildReport(results, planned, options.seed);
      await writeJson(join(options.out, 'results.json'), results);
      await writeJson(join(options.out, 'report.json'), report);
      await writeFile(join(options.out, 'report.md'), renderReport(report));
      await writeJson(join(options.out, 'budget.json'), ledger.summary());
    };
    for (const item of planned) {
      if (results.some((r) => r.id === item.id)) continue;
      if (ledger.hasRun(item.id)) {
        // Recover an already-committed observation after a crash between two atomic writes.
        const resultFile = join(options.out, item.id, 'result.json');
        if (existsSync(resultFile)) results.push(JSON.parse(await readFile(resultFile, 'utf8')) as Observation);
        else results.push({ ...item, ...EMPTY, outcome: 'invalid', artifactCorrect: null, completeDelivery: null, requests: ledger.requestsFor(item.id), reason: 'Interrupted run; its reservations remain charged; no automatic retry' });
        await save(); continue;
      }
      if (!ledger.reserveRun(item.id)) { await save(); break; }
      let result: Observation;
      try { result = await runOne(options, item, engineRoot, contextWindow, ledger); }
      catch { result = { ...item, ...EMPTY, outcome: 'invalid', artifactCorrect: null, completeDelivery: null, requests: ledger.requestsFor(item.id), reason: 'Host setup/grading failure; partial files and charged reservations retained' }; }
      results.push(result); await save();
      process.stdout.write(JSON.stringify({ id: item.id, outcome: result.outcome, artifactCorrect: result.artifactCorrect, completeDelivery: result.completeDelivery, requests: result.requests }) + '\n');
      if (result.outcome === 'invalid') break;
    }
    await save();
  } finally { await unlock(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
