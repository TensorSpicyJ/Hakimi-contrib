import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CapabilityEvidence,
  capabilityMcpOverlay,
  finalAssistantText,
  incrementalHistory,
  validateCapabilityPlan,
  waitForMcpConnection,
  runCapabilityTurn,
} from '../examples/gpt-capability-bench.hakimi.js';
import { BENCH_MCP_SOURCE, prepareCapabilityHome } from '../examples/gpt-capability-bench.setup.js';
import { startFixture } from '../examples/gpt-capability-bench.runtime.js';
import { CAPABILITY_TASKS } from '../examples/gpt-capability-bench.tasks.js';
import { inspectMcpRequest, type McpRequestInspection } from '../examples/gpt-capability-bench.mcp.js';
import { startProxy } from '../examples/gpt-harness-bench.proxy.js';
import type { AgentContextData } from '../src/core/facade/agent.js';

const history: AgentContextData['history'] = [
  { role: 'assistant', content: [], toolCalls: [{ type: 'function', id: 'old', name: 'Bash', arguments: '{"command":"true"}' }] },
  { role: 'tool', toolCallId: 'old', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
];

describe('capability adapter execution evidence', () => {
  it('rejects unsupported variants and unequal patch configuration', () => {
    const plan = { model: 'gpt-6-astra', effort: 'high', patch: true, maxRequests: 20 };
    expect(() => { validateCapabilityPlan(plan); }).not.toThrow();
    expect(() => { validateCapabilityPlan({ ...plan, patch: false }); }).toThrow('apply_patch=true');
    expect(() => { validateCapabilityPlan({ ...plan, promptProfile: 'short' }); }).toThrow('not implemented');
    expect(() => { validateCapabilityPlan({ ...plan, contextStrategy: 'light' }); }).toThrow('not implemented');
    expect(() => { validateCapabilityPlan({ ...plan, compactBeforePrompt: true }); }).toThrow('restored');
  });

  it('does not count names, pending calls, synthetic results, or unmatched results as success', () => {
    const evidence = new CapabilityEvidence();
    evidence.started('main', { toolCallId: 'a', name: 'Skill', args: { skill: 'bench-normalize' } });
    evidence.started('main', { toolCallId: 'b', name: 'Agent', args: {} });
    evidence.result('main', { toolCallId: 'b', output: 'pretend execution', synthetic: true });
    evidence.result('main', { toolCallId: 'missing', output: 'success' });
    expect(evidence.snapshot().toolSuccesses).toEqual({});
    expect(evidence.snapshot().measurementErrors).toHaveLength(1);
    evidence.result('main', { toolCallId: 'a', output: 'real skill content', isError: false });
    expect(evidence.snapshot().toolSuccesses).toEqual({ Skill: 1 });
  });

  it('counts true errors, duplicate argument attempts, and child calls independently', () => {
    const evidence = new CapabilityEvidence();
    evidence.started('main', { toolCallId: 'a', name: 'Bash', args: { command: 'test', timeout: 5 } });
    evidence.result('main', { toolCallId: 'a', output: 'exit 1', isError: true });
    evidence.started('main', { toolCallId: 'b', name: 'Bash', args: { timeout: 5, command: 'test' } });
    evidence.result('main', { toolCallId: 'b', output: 'exit 0' });
    evidence.started('child', { toolCallId: 'a', name: 'Read', args: { path: 'x' } });
    evidence.result('child', { toolCallId: 'a', output: 'source' });
    expect(evidence.snapshot()).toMatchObject({ toolErrors: { Bash: 1 }, toolSuccesses: { Bash: 1, Read: 1 }, repeatedAttempts: 1 });
    expect(evidence.snapshot().toolCalls).toHaveLength(3);
  });

  it('excludes pre-restart history and preserves late-observed child history as unverified', () => {
    const evidence = new CapabilityEvidence();
    evidence.ignoreHistory('main', history);
    evidence.recoverContext('main', history);
    evidence.started('main', { toolCallId: 'old', name: 'Bash', args: {} });
    evidence.result('main', { toolCallId: 'old', output: 'old success' });
    expect(evidence.snapshot().toolCalls).toEqual([]);
    evidence.recoverContext('child', history);
    expect(evidence.snapshot().toolCalls[0]).toMatchObject({ agentId: 'child', status: 'unverified', source: 'context' });
    expect(evidence.snapshot().toolSuccesses).toEqual({});
  });

  it('retains the entire final delivery while excluding tool-bearing commentary', () => {
    expect(finalAssistantText(history)).toBe('');
    expect(finalAssistantText([...history, { role: 'assistant', toolCalls: [], content: [{ type: 'text', text: 'Report\n' }, { type: 'text', text: 'with all details.' }] }])).toBe('Report\nwith all details.');
  });

  it('preserves a newly emitted identical final after restart and compaction', () => {
    const final = { role: 'assistant' as const, toolCalls: [], content: [{ type: 'text' as const, text: 'Done.' }] };
    const current: AgentContextData['history'] = [
      { role: 'user', id: 'old', content: [{ type: 'text', text: 'Before restart' }], toolCalls: [] }, final,
      { role: 'user', id: 'new', content: [{ type: 'text', text: 'After restart' }], toolCalls: [] }, final,
    ];
    expect(incrementalHistory(current, new Set(['old']))).toHaveLength(2);
    expect(finalAssistantText(incrementalHistory(current, new Set(['old'])))).toBe('Done.');
    expect(incrementalHistory(current.slice(2), new Set(['old']))).toHaveLength(2);
  });
});

describe('fixed local MCP fixture', () => {
  it('pins a local fixture through the existing session-overlay contract without mutating its source config', () => {
    const file = { mcpServers: { bench: { transport: 'stdio', command: '/runtime/bin/node', args: ['/home/bench/hakimi/bench-mcp.mjs'], startupTimeoutMs: 10000 } } };
    expect(capabilityMcpOverlay('bench', file)).toEqual({ bench: { ...file.mcpServers.bench, runtime_id: 'local' } });
    expect(file.mcpServers.bench).not.toHaveProperty('runtime_id');
    expect(() => capabilityMcpOverlay('missing', file)).toThrow('missing');
    expect(() => capabilityMcpOverlay('bench', { mcpServers: { bench: { transport: 'http', url: 'https://example.test/mcp' } } })).toThrow('local stdio');
  });

  it('does not confuse a connected public server entry with a visible model schema', async () => {
    const connection = await waitForMcpConnection({ getMcpServers: async () => [{ name: 'bench', status: 'connected', transport: 'stdio', toolCount: 1 }] }, 'bench');
    expect(connection.toolCount).toBe(1);
    expect(inspectMcpRequest({ tools: [], input: [] }, { catalog: false, requiredTool: 'mcp__bench__lookup' }).ready).toBe(false);
  });
  it('performs initialization, discovery, successful lookup, and a real tool error over stdio', async () => {
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lookup', arguments: { key: 'calibration-v1' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'lookup', arguments: { key: 'missing' } } },
    ];
    const output = await new Promise<string>((yes, no) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', BENCH_MCP_SOURCE], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      child.once('error', no);
      child.once('close', (code) => { if (code === 0) yes(stdout); else no(new Error(stderr)); });
      child.stdin.end(requests.map((request) => JSON.stringify(request)).join('\n') + '\n');
    });
    const responses = output.trim().split('\n').map((line) => JSON.parse(line));
    expect(responses).toHaveLength(4);
    expect(responses[0].result.serverInfo.version).toBe('1.0.0');
    expect(responses[1].result.tools[0].name).toBe('lookup');
    expect(JSON.parse(responses[2].result.content[0].text)).toEqual({ id: 'calibration-v1', unit: 'mV', slope: 2.5, intercept: -1, source: 'bench-calibration-2026-01' });
    expect(responses[2].result.isError).toBe(false);
    expect(responses[3].result.isError).toBe(true);
  });

  it('prepares an isolated model configuration and sandbox-local fixture paths', async () => {
    const root = resolve(import.meta.dirname, '../../../.tmp/hakimi-benchmark-v2/adapter-tests');
    await mkdir(root, { recursive: true });
    const home = await mkdtemp(join(root, 'home-'));
    await prepareCapabilityHome(home, { model: 'gpt-6-astra', effort: 'high', contextWindow: 272000 }, { id: 'F02-mcp-discovery' });
    expect(await readFile(join(home, 'hakimi/config.toml'), 'utf8')).toContain('enabled = false');
    const mcp = JSON.parse(await readFile(join(home, 'hakimi/mcp.json'), 'utf8'));
    expect(mcp.mcpServers.bench.command).toBe('/runtime/bin/node');
    expect(mcp.mcpServers.bench.args).toEqual(['/home/bench/hakimi/bench-mcp.mjs']);
    expect(await readFile(join(home, 'hakimi/bench-mcp.mjs'), 'utf8')).toBe(BENCH_MCP_SOURCE);
  });
});

describe('MCP request-boundary evidence', () => {
  const requiredTool = 'mcp__bench__lookup';
  const lookup = { type: 'function', name: requiredTool, parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } };
  const selector = { type: 'function', name: 'select_tools', parameters: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } }, required: ['names'] } };
  const announce = (kind = 'added', name = requiredTool) => ({ role: 'user', content: [{ type: 'input_text', text: `<system-reminder>\n<tools_${kind}>\n${name}\n</tools_${kind}>\n\nUse the select_tools tool with exact names to load full tool definitions before calling them. Names listed as removed are no longer loadable — do not select them. Fold all announcements in this conversation in order to get the current list.\n</system-reminder>` }] });

  it('requires a real, nonambiguous function schema for the baseline', () => {
    expect(inspectMcpRequest({ tools: [lookup] }, { catalog: false, requiredTool })).toMatchObject({ ready: true, reason: 'schema-visible', schemaHash: expect.any(String) });
    for (const tools of [[], [{ name: requiredTool }], [{ ...lookup, parameters: {} }], [{ ...lookup, parameters: { type: 'object', properties: {}, required: [] } }], [lookup, lookup]]) {
      expect(inspectMcpRequest({ tools, input: [announce()] }, { catalog: false, requiredTool }).ready).toBe(false);
    }
    expect(inspectMcpRequest({ tools: [{ ...lookup, parameters: { ...lookup.parameters, properties: { key: { type: 'string', enum: ['wrong'] } } } }] }, { catalog: false, requiredTool }).ready).toBe(false);
    expect(inspectMcpRequest({ tools: [{ ...lookup, parameters: { ...lookup.parameters, allOf: [{ not: {} }] } }] }, { catalog: false, requiredTool }).ready).toBe(false);
  });

  it('accepts a complete current catalog plus a callable selector and the subsequently loaded MCP schema', () => {
    const proof = inspectMcpRequest({ tools: [selector], input: [announce()] }, { catalog: true, requiredTool });
    expect(proof).toMatchObject({ ready: true, reason: 'catalog-loadable', catalogEvidence: { currentlyListed: true, announcements: [{ inputIndex: 0, added: true, removed: false, textHash: expect.any(String) }] } });
    expect(JSON.stringify(proof)).not.toContain('system-reminder');
    expect(inspectMcpRequest({ tools: [selector, lookup], input: [announce()] }, { catalog: true, requiredTool }).reason).toBe('schema-visible');
    expect(inspectMcpRequest({ tools: [{ name: 'select_tools' }], input: [announce()] }, { catalog: true, requiredTool }).ready).toBe(false);
    expect(inspectMcpRequest({ tools: [{ ...selector, parameters: { ...selector.parameters, properties: { names: { type: 'array', items: { type: 'string', enum: ['OtherTool'] } } } } }], input: [announce()] }, { catalog: true, requiredTool }).ready).toBe(false);
  });

  it('folds removals and re-additions instead of trusting stale or partial history', () => {
    expect(inspectMcpRequest({ tools: [selector], input: [announce(), announce('removed')] }, { catalog: true, requiredTool }).ready).toBe(false);
    expect(inspectMcpRequest({ tools: [selector], input: [announce(), announce('removed'), announce()] }, { catalog: true, requiredTool }).ready).toBe(true);
    expect(inspectMcpRequest({ tools: [selector], input: [announce()], previous_response_id: 'previous' }, { catalog: true, requiredTool }).reason).toBe('incomplete-history');
    expect(inspectMcpRequest({ tools: [] }, { catalog: true, requiredTool }).ready).toBe(false);
  });

  it('rejects text mentions, assistant claims, tool outputs and near-matching tool names', () => {
    const fabricated = [
      { role: 'user', content: `Please use ${requiredTool}` },
      { ...announce(), role: 'assistant' },
      { ...announce(), type: 'function_call_output' },
      { type: 'function_call_output', output: announce().content[0]!.text },
      { role: 'user', content: `<tools_added>\n${requiredTool}\n</tools_added>` },
      announce('added', `${requiredTool}_other`),
    ];
    for (const input of fabricated) expect(inspectMcpRequest({ tools: [selector], input: [input] }, { catalog: true, requiredTool }).ready).toBe(false);
  });
});

describe('MCP overlay through the public facade', () => {
  it('repeatedly exposes and executes the fixture on baseline/catalog cold starts without a readiness sleep', async () => {
    const { bootstrap, logSeed, resolveLoggingConfig } = await import('@moonshot-ai/agent-core-v2');
    const { createKlient } = await import('../src/transports/memory/index.js');
    const root = resolve(import.meta.dirname, '../../../.tmp/hakimi-benchmark-v2/suite-v3/mcp-readiness');
    await mkdir(root, { recursive: true });
    const task = CAPABILITY_TASKS.find((candidate) => candidate.id === 'F02-mcp-calibration')!;
    const summaries: unknown[] = [];
    for (const catalog of [false, true]) for (let repeat = 0; repeat < 3; repeat++) {
      const directory = await mkdtemp(join(root, `${catalog ? 'catalog' : 'baseline'}-${repeat}-`));
      const homeDir = join(directory, 'home');
      const cwd = join(directory, 'workspace');
      await mkdir(homeDir); await mkdir(cwd);
      const fixture = await startFixture(task);
      const proofs: McpRequestInspection[] = [];
      const proxy = await startProxy({ model: 'gpt-6-astra', effort: 'high', maxRequests: 10, upstreamUrl: fixture.url, getHeaders: async () => ({}), validateRequest: (body) => {
        const proof = inspectMcpRequest(body, { catalog, requiredTool: 'mcp__bench__lookup' }); proofs.push(proof); return proof.ready;
      } });
      await writeFile(join(homeDir, 'config.toml'), `default_model="bench"\n[models.bench]\nname="gpt-6-astra"\nprotocol="openai_responses"\nbase_url="${proxy.url}"\napi_key="benchmark-placeholder"\nmax_context_size=262144\nsupport_efforts=["high"]\ndefault_effort="high"\n[subagent.auto_preset]\nenabled=false\n`);
      // Vary only fixture startup scheduling, not a sleep used as a readiness test.
      const source = BENCH_MCP_SOURCE.replace('let result;', `if (request.method === 'tools/list') await new Promise(done => setTimeout(done, ${repeat * 15}));\n  let result;`);
      const config = { mcpServers: { bench: { transport: 'stdio', command: process.execPath, args: ['--input-type=module', '-e', source], startupTimeoutMs: 10000, toolTimeoutMs: 10000 } } };
      await writeFile(join(homeDir, 'mcp.json'), JSON.stringify(config));
      const mcpServers = capabilityMcpOverlay('bench', config);
      const env = { PATH: process.env['PATH'], HOME: directory, KIMI_CODE_EXPERIMENTAL_APPLY_PATCH: 'true', KIMI_CODE_EXPERIMENTAL_TOOL_CATALOG: String(catalog), KIMI_CODE_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL: 'false', KIMI_LOOP_MAX_STEPS_PER_TURN: '10', KIMI_LOOP_MAX_ATTEMPTS_PER_STEP: '1' };
      const { app } = bootstrap({ homeDir, cwd, env, clientIdentity: { productName: 'Hakimi', version: 'offline-mcp-fixture', platform: 'linux' } }, [...logSeed(resolveLoggingConfig({ homeDir, env }))]);
      const klient = createKlient({ scope: app });
      try {
        const created = await klient.global.sessions.create({ workDir: cwd, title: 'Offline MCP startup proof', mcpServers });
        const handle = klient.session(created.id);
        await handle.agent('main').setModel('bench'); await handle.agent('main').setThinking('high'); await handle.agent('main').setPermission('yolo');
        const result = await runCapabilityTurn(handle, { model: 'gpt-6-astra', effort: 'high', patch: true, catalog, maxRequests: 10, sessionId: created.id, requiredMcpServer: 'bench', mcpFixtureOverlay: true }, task.prompts[0]!, () => {});
        const summary = { catalog, repeat, proofs, requests: proxy.metrics.upstreamRequests, toolSuccesses: result['toolSuccesses'], reason: result['reason'] };
        summaries.push(summary);
        await writeFile(join(directory, 'proof.json'), JSON.stringify(summary, null, 2));
        expect(result).toMatchObject({ reason: 'completed', toolSuccesses: { mcp__bench__lookup: 1 } });
        expect(proofs.length).toBeGreaterThanOrEqual(3);
        expect(proofs.every((proof) => proof.ready)).toBe(true);
        expect(proofs[0]!.reason).toBe(catalog ? 'catalog-loadable' : 'schema-visible');
        expect(proxy.metrics.requestValidationFailures).toBe(0);
        await handle.close();
      } finally { await klient.close(); app.dispose(); await proxy.close(); await fixture.close(); }
    }
    process.stdout.write(JSON.stringify({ case: 'capability-mcp-public-overlay', localOnly: true, startups: summaries.length, summaries }) + '\n');
  }, 120000);
});

describe('offline Responses fixture scripts', () => {
  async function request(url: string, names: string[], input: unknown[] = []) {
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ tools: names.map((name) => ({ type: 'function', name })), input }) });
    expect(response.status).toBe(200);
    const events = (await response.text()).trim().split('\n\n').map((line) => JSON.parse(line.slice(6)));
    return events.find((event) => event.type === 'response.completed').response.output[0] as { type: string; name?: string; arguments?: string; content?: { text: string }[] };
  }

  it('selects the actual deferred Skill before invoking it; compaction does not consume a turn step', async () => {
    const fixture = await startFixture(CAPABILITY_TASKS.find((task) => task.id.startsWith('F01'))!);
    try {
      expect((await request(fixture.url, [])).type).toBe('message');
      expect((await request(fixture.url, ['Bash', 'Skill'], [{ role: 'user', content: 'You are about to run out of context. Write a handoff.' }])).type).toBe('message');
      expect(await request(fixture.url, ['Bash', 'select_tools'])).toMatchObject({ name: 'select_tools', arguments: '{"names":["Skill"]}' });
      expect(await request(fixture.url, ['Bash', 'select_tools', 'Skill'])).toMatchObject({ name: 'Skill', arguments: '{"skill":"bench-normalize"}' });
      expect((await request(fixture.url, ['Bash', 'Skill'])).name).toBe('Bash');
      expect((await request(fixture.url, ['Bash', 'Skill'])).type).toBe('message');
    } finally { await fixture.close(); }
  });

  it('distinguishes real child requests from the parent and returns a substantive handoff', async () => {
    const fixture = await startFixture(CAPABILITY_TASKS.find((task) => task.id.startsWith('F03'))!);
    try {
      const parentCall = await request(fixture.url, ['Agent', 'Bash']);
      expect(parentCall.name).toBe('Agent');
      const childPrompt = (JSON.parse(parentCall.arguments!) as { prompt: string }).prompt;
      const childInput = [{ role: 'user', content: [{ type: 'input_text', text: childPrompt }] }, { role: 'user', content: '<system-reminder>Deferred tools catalog</system-reminder>' }];
      expect((await request(fixture.url, ['Bash'], childInput)).name).toBe('Bash');
      expect((await request(fixture.url, ['Bash'], childInput)).content![0]!.text.length).toBeGreaterThan(200);
      expect((await request(fixture.url, ['Agent', 'Bash'])).name).toBe('Bash');
    } finally { await fixture.close(); }
  });

  it('uses the actual background task id and never writes a reference artifact for the worker', async () => {
    const fixture = await startFixture(CAPABILITY_TASKS.find((task) => task.id.startsWith('F04'))!);
    try {
      const start = await request(fixture.url, ['Bash', 'TaskOutput']);
      expect(JSON.parse(start.arguments!)).toMatchObject({ command: 'node scripts/worker.mjs', run_in_background: true });
      const input = [{ type: 'function_call_output', output: 'task_id: task-real-123\nstatus: running' }];
      expect(await request(fixture.url, ['Bash', 'TaskOutput'], input)).toMatchObject({ name: 'TaskOutput', arguments: '{"task_id":"task-real-123"}' });
      const verify = await request(fixture.url, ['Bash', 'TaskOutput'], input);
      expect(JSON.parse(verify.arguments!).command).toBe('test -f result.json && cat result.json');
    } finally { await fixture.close(); }
  });
});
