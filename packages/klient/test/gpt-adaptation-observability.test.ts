import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { summarize, taskPassed, type RunArtifact } from '../examples/gpt-adaptation-bench.report.js';
import {
  compareFileHashes,
  resolveItemMode,
  stopReasonForArtifact,
} from '../examples/gpt-adaptation-bench.js';

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, '../../..');
const guard = pathToFileURL(join(repo, 'packages/klient/examples/gpt-adaptation-bench.fetch-guard.mjs')).href;

async function probe(body: string, beforeGuard = '', cap = 1, extraEnv: Record<string, string> = {}): Promise<Record<string, any>> {
  const root = join(repo, '.tmp/gpt-adaptation-bench/observability-tests');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'probe-'));
  const script = `
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync, existsSync } from 'node:fs';
    import { join } from 'node:path';
    const dir = process.env.KIMI_BENCH_GUARD_DIR;
    const url = 'https://chatgpt.com/backend-api/codex/responses';
    const options = { method: 'POST', headers: { 'Session-Id': 'synthetic-session' }, body: JSON.stringify({ model: 'gpt-6-astra', input: [], tools: [] }) };
    const sent = [];
    const event = (value) => 'data:' + JSON.stringify(value) + '\\r\\n\\r\\n';
    const completed = { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 1 } } };
    globalThis.fetch = async (input, init) => {
      sent.push({ url: input instanceof Request ? input.url : String(input), session: new Headers(init?.headers).get('session-id') });
      return new Response(event({ type: 'response.output_text.delta', delta: 'ok' }) + event(completed), { headers: { 'content-type': 'text/event-stream' } });
    };
    ${beforeGuard}
    await import(${JSON.stringify(guard)});
    ${body}
    await globalThis[Symbol.for('hakimi.gptBenchFlush')]();
    const tickets = existsSync(join(dir, 'tickets.json')) ? JSON.parse(readFileSync(join(dir, 'tickets.json'), 'utf8')) : null;
    const records = existsSync(join(dir, 'requests.jsonl')) ? readFileSync(join(dir, 'requests.jsonl'), 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : [];
    console.log(JSON.stringify({ sent, tickets, records }));
  `;
  try {
    const result = await exec(process.execPath, ['--input-type=module', '-e', script], {
      cwd: repo,
      env: {
        PATH: process.env['PATH'],
        KIMI_BENCH_GUARD_DIR: dir,
        KIMI_BENCH_RUN_CAP: String(cap),
        KIMI_BENCH_STRIP_SESSION_ID: '1',
        KIMI_BENCH_EXPECTED_MODEL: 'gpt-6-astra',
        KIMI_BENCH_GUARD_HOSTS: '',
        ...extraEnv,
      },
      timeout: 15_000,
    });
    return JSON.parse(result.stdout) as Record<string, any>;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('GPT benchmark real-endpoint observation boundary', () => {
  it('tickets and strips the actual Codex SDK URL without an extra-host override', async () => {
    const result = await probe(`
      await (await fetch(url, options)).text();
      await assert.rejects(fetch(url, options), /exceeds the per-run cap/);
    `);
    expect(result['sent']).toEqual([{ url: 'https://chatgpt.com/backend-api/codex/responses', session: null }]);
    expect(result['tickets']).toMatchObject({ count: 1, exceeded: 1, cap: 1 });
    expect(result['records'].filter((record: any) => record.kind === 'responses')).toHaveLength(1);
  });

  it('observes streaming without delaying the response until the terminal event', async () => {
    const result = await probe(`
      const response = await fetch(url, options);
      assert.equal(finished, false, 'fetch must resolve before the response finishes');
      await new Promise(setImmediate);
      control.enqueue(new TextEncoder().encode(event({ type: 'response.output_text.delta', delta: 'visible' })));
      await new Promise(setImmediate);
      finished = true;
      control.enqueue(new TextEncoder().encode(event(completed)));
      control.close();
      await response.text();
    `, `
      let control;
      let finished = false;
      globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
        control = controller;
        controller.enqueue(new TextEncoder().encode(event({ type: 'response.created', response: { id: 'resp_example' } })));
      } }), { headers: { 'content-type': 'text/event-stream' } });
    `);
    const record = result['records'].find((entry: any) => entry.kind === 'responses');
    expect(record.terminalEventSeen).toBe('response.completed');
    expect(record.firstVisibleTokenMs).toBeTypeOf('number');
    expect(record.firstVisibleTokenMs).toBeGreaterThanOrEqual(record.firstByteMs);
    expect(record.usage.cachedTokens).toBeNull();
  });

  it('observes Responses SSE even when the server uses a nonstandard content type', async () => {
    const result = await probe(`await (await fetch(url, options)).text();`, `
      globalThis.fetch = async () => new Response(event(completed), { headers: { 'content-type': 'application/octet-stream' } });
    `);
    const record = result['records'].find((entry: any) => entry.kind === 'responses');
    expect(record.terminalEventSeen).toBe('response.completed');
    expect(record.usage.inputTokens).toBe(5);
  });

  it('fails closed on corrupted persisted tickets rather than resetting their count', async () => {
    const result = await probe(`
      await assert.rejects(fetch(url, options));
      assert.equal(sent.length, 0);
      writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ count: 1, cap: 1, exceeded: 0 }));
    `, `writeFileSync(join(dir, 'tickets.json'), '{truncated');`);
    expect(result['sent']).toEqual([]);
  });

  it('blocks model requests that would otherwise bypass the official-endpoint guard', async () => {
    const result = await probe(`
      await assert.rejects(fetch('https://api.example.test/v1/responses', options), /unapproved endpoint/);
      assert.equal(sent.length, 0);
    `);
    expect(result['tickets']).toBeNull();
    expect(result['sent']).toEqual([]);
  });

  it('rejects a model differing from the frozen selection before dispatch', async () => {
    const result = await probe(`
      await assert.rejects(fetch(url, { ...options, body: JSON.stringify({ model: 'other-model' }) }), /frozen model/);
      assert.equal(sent.length, 0);
    `);
    expect(result['sent']).toEqual([]);
  });

  it('tickets the URL and Request input shapes of the standard fetch signature', async () => {
    const result = await probe(`
      await (await fetch(new URL(url), options)).text();
      await (await fetch(new Request(url, options), options)).text();
      assert.equal(sent.length, 2);
    `, '', 2);
    expect(result['tickets']).toMatchObject({ count: 2, cap: 2, exceeded: 0 });
    expect(result['sent']).toEqual([
      { url: 'https://chatgpt.com/backend-api/codex/responses', session: null },
      { url: 'https://chatgpt.com/backend-api/codex/responses', session: null },
    ]);
    expect(result['records'].filter((record: any) => record.kind === 'responses')).toHaveLength(2);
  });

  it('records official auth traffic without spending a ticket', async () => {
    const result = await probe(`
      await fetch('https://auth.openai.com/oauth/token', { method: 'POST', body: JSON.stringify({ grant_type: 'refresh_token' }) });
      assert.equal(sent.length, 1);
    `);
    expect(result['tickets']).toBeNull();
    expect(result['records']).toEqual([
      expect.objectContaining({ kind: 'other', disposition: 'auth', host: 'auth.openai.com' }),
    ]);
  });

  it('records a refused endpoint so the orchestrator can fail the measurement', async () => {
    const result = await probe(`
      await assert.rejects(fetch('https://api.example.test/v1/responses', options), /unapproved endpoint/);
      assert.equal(sent.length, 0);
    `);
    expect(result['tickets']).toBeNull();
    expect(result['records']).toEqual([
      expect.objectContaining({ kind: 'other', disposition: 'refused', host: 'api.example.test' }),
    ]);
  });

  it('tickets an approved loopback fixture host in the offline plan', async () => {
    const result = await probe(`
      await (await fetch('http://127.0.0.1:9/v1/responses', options)).text();
      assert.equal(sent.length, 1);
    `, '', 1, { KIMI_BENCH_GUARD_HOSTS: '127.0.0.1:9' });
    expect(result['tickets']).toMatchObject({ count: 1, cap: 1, exceeded: 0 });
    expect(result['records'].filter((record: any) => record.kind === 'responses')).toHaveLength(1);
  });
});

function artifact(arm: 'baseline' | 'candidate', repeat: number): RunArtifact {
  return {
    runId: `T00__r${String(repeat)}__${arm}`, mode: 'live', kind: 'task', arm, taskId: 'T00', repeat,
    child: { status: 'ok' }, childExitCode: 0, childTimedOut: false,
    grade: { passed: true }, contractSatisfied: true, requestsObserved: 1,
    requestsObservedSource: 'guard', toolCalls: 1, toolFailures: 0,
    usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 0 },
    firstVisibleTokenMs: 10, durationMs: 20, testsSandboxed: true,
    startedAt: '2026-09-15T00:00:00Z', endedAt: '2026-09-15T00:00:01Z',
  } as RunArtifact;
}

describe('GPT benchmark outcome accounting', () => {
  it('never runs the deterministic replay plan as a live call', () => {
    expect(resolveItemMode('live', 'replay')).toBe('offline');
    expect(resolveItemMode('offline', 'replay')).toBe('offline');
    expect(resolveItemMode('live', 'task')).toBe('live');
    expect(resolveItemMode('live', 'cache')).toBe('live');
  });

  it('stops the run on a lost measurement or an auth/quota wall, but not on a graded failure', () => {
    const valid = artifact('baseline', 0);
    expect(stopReasonForArtifact(valid)).toBeNull();
    expect(stopReasonForArtifact({ ...valid, grade: { ...artifact('baseline', 0).grade!, passed: false } })).toBeNull();
    expect(stopReasonForArtifact({ ...valid, measurementFailed: 'no ticket was taken' })).toContain(
      'measurement failure',
    );
    expect(
      stopReasonForArtifact({
        ...valid,
        child: { ...valid.child!, status: 'error', errorText: 'provider.auth_error: 401 unauthorized' },
      }),
    ).toContain('auth/quota/rate-limit');
    expect(
      stopReasonForArtifact({
        ...valid,
        child: { ...valid.child!, status: 'error', errorText: '429 too many requests' },
      }),
    ).toContain('auth/quota/rate-limit');
  });

  it('rejects a drifted provenance file', () => {
    expect(compareFileHashes({ 'a.ts': 'x', 'b.ts': 'y' }, { 'a.ts': 'x', 'b.ts': 'y' })).toEqual([]);
    expect(compareFileHashes({ 'a.ts': 'x' }, { 'a.ts': 'z' })).toEqual(['a.ts']);
    expect(compareFileHashes({ 'a.ts': 'x' }, {})).toEqual(['a.ts']);
  });

  it('flags a directory that mixes offline and live artifacts', () => {
    const mixed = summarize('synthetic', [artifact('baseline', 0), { ...artifact('candidate', 0), mode: 'offline' }], 4);
    expect(mixed.mixedModes).toBe(true);
    expect(mixed.lines.join('\n')).toContain('MIXED');
  });

  it('reports the per-arm totals and the usage coverage instead of one pooled row', () => {
    const rows = [artifact('baseline', 0), artifact('candidate', 0)];
    const report = summarize('synthetic', rows, 2).lines.join('\n');
    expect(report).toContain('baseline (n=1, passed=1/1)');
    expect(report).toContain('candidate (n=1, passed=1/1)');
    expect(report).toContain('per-request coverage not recorded');
  });

  it('does not score a successful patch when the runtime or resume contract failed', () => {
    const valid = artifact('baseline', 0);
    expect(taskPassed(valid)).toBe(true);
    expect(taskPassed({ ...valid, contractSatisfied: false })).toBe(false);
    expect(taskPassed({ ...valid, contractSatisfied: null })).toBe(false);
    expect(taskPassed({ ...valid, childTimedOut: true })).toBe(false);
    expect(taskPassed({ ...valid, requestsObservedSource: 'none' })).toBe(false);
  });

  it('reports the both-successful paired subset rather than labelling a difference as a rate', () => {
    const rows = [artifact('baseline', 0), artifact('candidate', 0), artifact('baseline', 1), artifact('candidate', 1)];
    const report = summarize('synthetic', rows, 4).lines.join('\n');
    expect(report).toContain('baseline=1.000 candidate=1.000 diff=0.000');
    expect(report).toContain('both arms passed): pairs=2');
    expect(report).not.toContain('candidate-rate=0.000');
  });

  it('does not fabricate a paired estimate when one arm has not run', () => {
    const report = summarize('synthetic', [artifact('baseline', 0)], 1).lines.join('\n');
    expect(report).toContain('paired task-cluster: n/a');
    expect(report).toContain('missing=1/2');
  });
});
