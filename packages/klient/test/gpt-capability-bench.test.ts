import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, balancedOrder, validateVariants } from '../examples/gpt-capability-bench.config.js';
import { planMatrix, decodeEvidence, recoverObservations, frozenConfig, createMcpReadinessCheck, main } from '../examples/gpt-capability-bench.js';
import { archiveBenchmarkControl, benchmarkSourceHash, hashTree } from '../examples/gpt-capability-bench.runtime.js';
import { getSuite } from '../examples/gpt-capability-bench.suites.js';
import { sha256 } from '../examples/gpt-adaptation-bench.scorer.js';
import { BatchLedger } from '../examples/gpt-capability-bench.ledger.js';
import { REPO_ROOT, sandboxArguments } from '../examples/gpt-harness-bench.sandbox.js';
import { startProxy } from '../examples/gpt-harness-bench.proxy.js';

const root = join(REPO_ROOT, '.tmp/hakimi-benchmark-v2/tests');
async function scratch() { await mkdir(root, { recursive: true }); return mkdtemp(join(root, 'ledger-')); }
describe('capability batch contracts', () => {
  it('plans all 192 observations explicitly and excludes acceptance by default', () => {
    expect(parseArgs([]).suite).toBe('v3');
    expect(planMatrix(parseArgs(['--split', 'all']))).toHaveLength(192);
    const defaults = planMatrix(parseArgs([]));
    expect(defaults).toHaveLength(144);
    expect(defaults.every((p) => p.split === 'development')).toBe(true);
    expect(planMatrix(parseArgs(['--smoke']))).toHaveLength(4);
    expect(parseArgs(['--out', '.tmp/hakimi-benchmark-v2/example']).out).toBe(join(REPO_ROOT, '.tmp/hakimi-benchmark-v2/example'));
  });
  it('pins the selected suite and rejects obsolete ids instead of silently substituting corrected tasks', () => {
    const latest = parseArgs(['--split', 'all']);
    const older = parseArgs(['--suite', 'v1', '--split', 'all']);
    expect(planMatrix(latest).every((row) => row.suite === 'v3' && row.id.startsWith('v3-'))).toBe(true);
    expect(planMatrix(older).every((row) => row.suite === 'v1' && row.id.startsWith('v1-'))).toBe(true);
    expect(planMatrix(latest).some((row) => row.taskId === 'P02-reset-priority-v2')).toBe(true);
    expect(planMatrix(older).some((row) => row.taskId === 'P02-reset-priority')).toBe(true);
    expect(() => parseArgs(['--suite', 'unknown'])).toThrow('Unknown task suite');
    expect(() => planMatrix(parseArgs(['--tasks', 'P02-reset-priority']))).toThrow('in suite v3');
    expect(() => planMatrix(parseArgs(['--tasks', 'L02-durable-budget']))).toThrow('in suite v3');
    expect(planMatrix(latest).some((row) => row.taskId === 'L02-durable-budget-v3')).toBe(true);
    expect(planMatrix(parseArgs(['--suite', 'v2', '--split', 'all'])).some((row) => row.taskId === 'L02-durable-budget')).toBe(true);
    expect(() => planMatrix(parseArgs(['--suite', 'v1', '--tasks', 'R03-enumerate-spin-v2']))).toThrow('in suite v1');
    const frozen = frozenConfig(latest, planMatrix(latest));
    expect(frozen.suite).toMatchObject({ id: 'v3', version: getSuite('v3').version });
    expect(frozen.mcpReadinessPolicy).toMatchObject({ tasks: ['F02-mcp-calibration'], fixture: 'public-session-overlay', check: 'initial-main-request-before-quota-and-auth' });
    expect(JSON.parse(JSON.stringify(frozenConfig(older, planMatrix(older))))).not.toHaveProperty('mcpReadinessPolicy');
    expect(frozen.tasks.find((task) => task.id === 'P02-reset-priority-v2')?.hash).toBe(sha256(JSON.stringify(getSuite('v2').tasks.find((task) => task.id === 'P02-reset-priority-v2'))));
    expect(sha256(JSON.stringify(frozen))).not.toBe(sha256(JSON.stringify(frozenConfig(older, planMatrix(older)))));
  });
  it('refuses a resumed batch from another suite before execution and preserves its ledger', async () => {
    const dir = await scratch();
    const old = parseArgs(['--stub', '--suite', 'v1', '--tasks', 'S01-labels', '--repeats', '1']);
    const identity = sha256(JSON.stringify(frozenConfig(old, planMatrix(old))));
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ configHash: identity }));
    const caps = { maxRuns: 2, maxRequests: 120, timeoutMs: 1800000, maxObservedTokens: 2400000 };
    const ledger = new BatchLedger(dir, caps, identity);
    ledger.reserveRun('original'); ledger.reserveRequest('original');
    const before = await readFile(join(dir, 'ledger.jsonl'), 'utf8');
    await expect(main(['--stub', '--resume', '--suite', 'v2', '--tasks', 'S01-labels', '--repeats', '1', '--out', dir])).rejects.toThrow('Frozen inputs changed');
    expect(await readFile(join(dir, 'ledger.jsonl'), 'utf8')).toBe(before);
  });
  it('archives the exact host controls outside the mounted runtime and never overwrites an archive', async () => {
    const dir = await scratch();
    const hash = await benchmarkSourceHash();
    await expect(archiveBenchmarkControl(dir, 'wrong', getSuite('v2'))).rejects.toThrow('sources changed');
    const archive = await archiveBenchmarkControl(dir, hash, getSuite('v2'), '{"models":[]}');
    expect(archive.sourceHash).toBe(hash);
    expect(JSON.parse(await readFile(join(dir, 'control-source/selected-suite.json'), 'utf8')).id).toBe('v2');
    expect(sha256(await readFile(join(dir, 'control-source/packages/klient/examples/gpt-capability-bench.tasks.ts'), 'utf8'))).toBe('4656500eef118c8aa04ac0a322e78c702cdd88bbebeb8257e284ee9599aa181b');
    expect(archive.modelCatalogHash).toBe(sha256('{"models":[]}'));
    expect(archive.archiveHash).toBe(await hashTree(join(dir, 'control-source')));
    await writeFile(join(dir, 'control-source/selected-suite.json'), '{"id":"tampered"}');
    expect(archive.archiveHash).not.toBe(await hashTree(join(dir, 'control-source')));
    await expect(archiveBenchmarkControl(dir, hash, getSuite('v2'))).rejects.toMatchObject({ code: 'EEXIST' });
    const args = sandboxArguments({ engineRoot: join(dir, 'engine'), dependencyRoot: join(dir, 'engine'), workspace: join(dir, 'workspace'), home: join(dir, 'home'), runDir: dir, codexRoot: join(dir, 'engine'), socketPath: '/socket', argv: ['node'], timeoutMs: 1 });
    expect(args).not.toContain(join(dir, 'control-source'));
    expect(args).not.toContain(dir);
  });
  it('requires finite explicit paid caps before credentials, rejects contradictory modes', () => {
    expect(() => parseArgs(['--live'])).toThrow('explicit');
    expect(() => parseArgs(['--live', '--batch-max-runs', '4', '--batch-max-requests', '80', '--batch-timeout-ms', '1800000'])).toThrow('--auth-file');
    expect(() => parseArgs(['--stub', '--live'])).toThrow('one execution mode');
    expect(() => parseArgs(['--batch-max-runs', 'Infinity'])).toThrow('positive integer');
  });
  it('has deterministic balanced task blocks across repeats and seeds', () => {
    const order = balancedOrder(['a', 'b', 'c'], ['baseline', 'catalog'], 4, ['generous'], 10);
    expect(order).toEqual(balancedOrder(['a', 'b', 'c'], ['baseline', 'catalog'], 4, ['generous'], 10));
    for (const task of ['a', 'b', 'c']) {
      const first = order.filter((p) => p.taskId === task).filter((_, i) => i % 2 === 0);
      expect(first.filter((p) => p.variant === 'baseline')).toHaveLength(2);
      expect(first.filter((p) => p.variant === 'catalog')).toHaveLength(2);
    }
  });
  it('rejects unimplemented variant features instead of advertising them', () => {
    const defaults = parseArgs([]).variants;
    expect(() => validateVariants([defaults[0], { ...defaults[1], imaginaryFlag: true }])).toThrow('Unknown');
    expect(() => validateVariants([defaults[0], { ...defaults[1], adapter: 'pi' }])).toThrow('unimplemented');
  });
  it('never refunds request/run reservations on reopen, including interrupted runs', async () => {
    const dir = await scratch();
    const caps = { maxRuns: 2, maxRequests: 2, timeoutMs: 10000, maxObservedTokens: 100 };
    const first = new BatchLedger(dir, caps, 'freeze');
    expect(first.reserveRun('a')).toBe(true); expect(first.reserveRequest('a')).toBe(true);
    const restored = new BatchLedger(dir, caps, 'freeze');
    expect(restored.startedAt).toBe(first.startedAt);
    expect(restored.requests).toBe(1); expect(restored.reserveRequest('a')).toBe(true);
    expect(restored.reserveRequest('a')).toBe(false);
    expect(() => restored.reserveRun('a')).toThrow('already reserved');
    expect(() => new BatchLedger(dir, { ...caps, maxRequests: 3 }, 'freeze')).toThrow('mismatch');
  });
  it('fails closed on a truncated ledger and persists observed token exhaustion', async () => {
    const dir = await scratch();
    const caps = { maxRuns: 2, maxRequests: 20, timeoutMs: 10000, maxObservedTokens: 100 };
    const ledger = new BatchLedger(dir, caps, 'freeze'); ledger.reserveRun('a'); ledger.reserveRequest('a'); ledger.usage('a', 120);
    expect(new BatchLedger(dir, caps, 'freeze').reserveRequest('a')).toBe(false);
    const path = join(dir, 'ledger.jsonl'); await writeFile(path, (await readFile(path, 'utf8')).slice(0, -2));
    expect(() => new BatchLedger(dir, caps, 'freeze')).toThrow('Truncated');
  });
  it('refuses missing resume ledgers and invalid replay state rather than refunding quota', async () => {
    const dir = await scratch();
    const caps = { maxRuns: 2, maxRequests: 20, timeoutMs: 10000, maxObservedTokens: 100 };
    expect(() => new BatchLedger(dir, caps, 'freeze', true)).toThrow('missing');
    const ledger = new BatchLedger(dir, caps, 'freeze'); ledger.reserveRun('a'); ledger.reserveRequest('a'); ledger.usage('a', 20);
    const path = join(dir, 'ledger.jsonl'); const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('"tokens":20', '"tokens":-20'));
    expect(() => new BatchLedger(dir, caps, 'freeze', true)).toThrow('invalid usage');
    await writeFile(path, original.replace('"kind":"request","runId":"a"', '"kind":"request","runId":"missing"'));
    expect(() => new BatchLedger(dir, caps, 'freeze', true)).toThrow('invalid run lifecycle');
  });
  it('denies a request at the durable proxy boundary before reading authentication', async () => {
    let auth = 0;
    const proxy = await startProxy({ model: 'gpt-6-astra', effort: 'high', maxRequests: 10, upstreamUrl: 'http://127.0.0.1:1/responses',
      reserveRequest: () => false, getHeaders: async () => { auth++; return {}; } });
    try {
      const result = await fetch(proxy.url + '/responses', { method: 'POST', body: JSON.stringify({ model: 'gpt-6-astra', reasoning: { effort: 'high' } }) });
      expect(result.status).toBe(429); expect(auth).toBe(0); expect(proxy.metrics.requestBudgetExhausted).toBe(true);
    } finally { await proxy.close(); }
  });
  it('checks initial main readiness without falsely rejecting restricted subagents, and latches initial failures', () => {
    const valid = { tools: [{ type: 'function', name: 'mcp__bench__lookup', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } }] };
    const accepted = createMcpReadinessCheck(false);
    expect(accepted.validate(valid)).toBe(true);
    expect(accepted.validate({ tools: [] })).toBe(true);
    expect(accepted.checks).toHaveLength(1);
    const rejected = createMcpReadinessCheck(false);
    expect(rejected.validate({ tools: [] })).toBe(false);
    expect(rejected.validate(valid)).toBe(false);
    expect(rejected.checks).toHaveLength(1);
    expect(rejected.checks[0]?.reason).toBe('missing-schema');
  });
  it('reconstructs per-run commits and interrupted reservations without modifying the ledger', async () => {
    const dir = await scratch();
    const planned = planMatrix(parseArgs(['--stub', '--tasks', 'S01-labels', '--repeats', '1']));
    const caps = { maxRuns: 2, maxRequests: 20, timeoutMs: 10000, maxObservedTokens: 100 };
    const ledger = new BatchLedger(dir, caps, 'freeze');
    for (const row of planned) { ledger.reserveRun(row.id); ledger.reserveRequest(row.id); }
    const row = planned[0]!; await mkdir(join(dir, row.id));
    await writeFile(join(dir, row.id, 'result.json'), JSON.stringify({ ...row, outcome: 'failed', artifactCorrect: false, completeDelivery: true }));
    await writeFile(join(dir, 'results.json'), '[]');
    const before = await readFile(join(dir, 'ledger.jsonl'), 'utf8');
    const recovered = await recoverObservations(dir, planned, ledger);
    expect(recovered.map((r) => r.outcome)).toEqual(['failed', 'invalid']);
    expect(recovered[1]?.requests).toBe(1);
    expect(await readFile(join(dir, 'ledger.jsonl'), 'utf8')).toBe(before);
  });
  it('preserves real error evidence on abrupt termination and ignores prose success', () => {
    const data = [
      { type: 'capability.event', agentId: 'main', event: { toolCallId: 'a', name: 'Bash', args: { command: 'false' } } },
      { type: 'capability.event', agentId: 'main', event: { toolCallId: 'a', output: 'failed', isError: true } },
    ].map((event) => JSON.stringify(event)).join('\n') + '\nall tests passed';
    const decoded = decodeEvidence(data);
    expect(decoded.result).toBeUndefined(); expect(decoded.partial.toolErrors).toEqual({ Bash: 1 });
  });
  it('binds the frozen dependency tree and never mounts the result/hidden grader directory', () => {
    const args = sandboxArguments({ engineRoot: '/frozen', dependencyRoot: '/frozen', workspace: '/run/workspace', home: '/run/home', runDir: '/run/results', codexRoot: '/frozen', socketPath: '/socket', argv: ['node'], timeoutMs: 1 });
    expect(args).toContain('/frozen/node_modules'); expect(args).not.toContain(join(REPO_ROOT, 'node_modules'));
    expect(args).not.toContain('/run/results');
  });
});
