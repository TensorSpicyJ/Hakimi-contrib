/**
 * Shared Responses proxy contracts: quota, frozen request parameters, byte
 * streaming, redacted measurements, and TCP/Unix clients. The proxy is real;
 * only the upstream Responses server is replaced by a loopback fixture.
 * Run: pnpm --filter @moonshot-ai/klient test test/gpt-harness-bench.proxy.test.ts
 */

import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { startProxy, type ProxyOptions } from '../examples/gpt-harness-bench.proxy.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.toReversed()) await dispose();
  cleanup.length = 0;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const REQUEST = { model: 'gpt-6-astra', reasoning: { effort: 'high' }, stream: true, input: 'fixture prompt' };
const USAGE = {
  input_tokens: 10, output_tokens: 4, total_tokens: 14,
  input_tokens_details: { cached_tokens: 3 },
  output_tokens_details: { reasoning_tokens: 2 },
};

function completed(usage: unknown = USAGE): string {
  return `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage } })}\n\n`;
}

async function rig(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void> = (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(completed());
  },
  options: Partial<Omit<ProxyOptions, 'upstreamUrl'>> = {},
) {
  const upstream = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => response.destroy());
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  cleanup.push(async () => {
    const closed = new Promise<void>((resolve) => upstream.close(() =>{  resolve(); }));
    upstream.closeAllConnections();
    await closed;
  });
  const address = upstream.address();
  if (address === null || typeof address === 'string') throw new Error('missing upstream address');
  const proxy = await startProxy({
    model: 'gpt-6-astra', effort: 'high', maxRequests: 10,
    upstreamUrl: `http://127.0.0.1:${address.port}/fixed/responses`,
    getHeaders: async () => ({ authorization: 'Bearer example-upstream-key' }),
    ...options,
  });
  cleanup.push(proxy.close);
  return {
    proxy,
    send: (body: unknown = REQUEST, path = '/responses', headers: Record<string, string> = {}) => fetch(`${proxy.url}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    }),
  };
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

describe('shared Responses proxy', () => {
  it.each(['reject', 'throw'] as const)('blocks an unready request (%s) before quota, authentication or upstream access', async (mode) => {
    let tickets = 0; let authentication = 0; let upstream = 0;
    const { send, proxy } = await rig((_request, response) => { upstream++; response.end(completed()); }, {
      validateRequest: () => { if (mode === 'throw') throw new Error('private diagnostic'); return false; },
      reserveRequest: () => { tickets++; return true; },
      getHeaders: async () => { authentication++; return {}; },
    });
    const response = await send();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { type: 'benchmark_proxy_error', message: 'benchmark_request_not_ready', code: 'benchmark_request_not_ready' } });
    expect([tickets, authentication, upstream]).toEqual([0, 0, 0]);
    expect(proxy.metrics).toMatchObject({ upstreamRequests: 0, rejectedRequests: 1, requestValidationFailures: 1 });
    expect(JSON.stringify(proxy.metrics)).not.toContain('private diagnostic');
  });
  it('checks readiness on every request and preserves the last ticket after a rejected request', async () => {
    let checks = 0; let tickets = 0;
    const { send, proxy } = await rig(undefined, {
      maxRequests: 1,
      validateRequest: (body) => { checks++; return Array.isArray(body['tools']); },
      reserveRequest: () => { tickets++; return true; },
    });
    expect((await send()).status).toBe(503);
    await (await send({ ...REQUEST, tools: [] })).text();
    expect([checks, tickets]).toEqual([2, 1]);
    expect(proxy.metrics).toMatchObject({ upstreamRequests: 1, requestValidationFailures: 1, usageObservedRequests: 1 });
  });
  it('does not add readiness fields to serialized historical metrics when disabled', async () => {
    const { send, proxy } = await rig();
    await (await send()).text();
    expect(JSON.parse(JSON.stringify(proxy.metrics))).not.toHaveProperty('requestValidationFailures');
  });
  it('distinguishes absent cache partition measurements from measured zero hits', async () => {
    const { send, proxy } = await rig((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(completed({ input_tokens: 10, output_tokens: 4, total_tokens: 14 }));
    });
    await (await send()).text();
    expect(proxy.metrics.requests[0]?.cacheUsageObserved).toBe(false);
    expect(proxy.metrics.usageObservedRequests).toBe(1);
  });
  it('preserves SSE bytes while observing split UTF-8 events and terminal usage', async () => {
    const events = [
      { type: 'response.output_text.delta', delta: 'private output 你好' },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'call-private', type: 'function_call', name: 'private-name' } },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'call-private', type: 'function_call', name: 'private-name' } },
      { type: 'response.completed', response: { status: 'completed', usage: USAGE } },
    ];
    const payload = events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
    const { send, proxy } = await rig(async (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const bytes = Buffer.from(payload);
      for (let index = 0; index < bytes.length; index += 7) {
        response.write(bytes.subarray(index, index + 7));
        await setImmediate();
      }
      response.end();
    });

    expect(await (await send()).text()).toBe(payload);
    expect(proxy.metrics).toMatchObject({
      upstreamRequests: 1, usageObservedRequests: 1,
      usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 3, reasoningTokens: 2, totalTokens: 14 },
      terminalEvents: { completed: 1, incomplete: 0, failed: 0 },
      toolTypes: { function_call: 1 },
      requests: [{ httpStatus: 200, terminal: 'completed', finishReason: 'completed', malformedEvents: 0 }],
    });
    const measurements = JSON.stringify(proxy.metrics);
    for (const secret of ['private output', 'call-private', 'private-name', 'fixture prompt', 'example-upstream-key']) {
      expect(measurements).not.toContain(secret);
    }
  });

  it('consumes the request cap on an upstream HTTP failure without retrying', async () => {
    let calls = 0;
    const { send, proxy } = await rig((_request, response) => {
      calls += 1;
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"fixture unavailable"}}');
    }, { maxRequests: 1 });

    const first = await send();
    expect(first.status).toBe(503);
    await first.text();
    const rejected = await send();
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({ error: { code: 'benchmark_budget_exhausted' } });
    expect(calls).toBe(1);
    expect(proxy.metrics).toMatchObject({ upstreamRequests: 1, rejectedRequests: 1, requestBudgetExhausted: true });
    expect(proxy.metrics.requests[0]).toMatchObject({ httpStatus: 503, failure: 'upstream_http_error' });
  });

  it('observes requested SSE when the upstream labels it application/octet-stream', async () => {
    const payload = completed();
    const { send, proxy } = await rig((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(payload);
    });
    expect(await (await send()).text()).toBe(payload);
    expect(proxy.metrics).toMatchObject({
      usageObservedRequests: 1, sseDataEvents: 1,
      knownEventTypes: { 'response.completed': 1 }, unknownEventTypes: 0,
      requests: [{ transportKind: 'other', terminal: 'completed', sseDataEvents: 1 }],
    });
    expect(proxy.metrics.observedBytes).toBe(Buffer.byteLength(payload));
  });

  it('counts only normalized public tool names without retaining unknown names', async () => {
    const items = [
      { id: 'call_1', type: 'function_call', name: 'functions.Read' },
      { id: 'call_2', type: 'function_call', name: 'Read' },
      { id: 'call_3', type: 'custom_tool_call', name: 'functions.apply_patch' },
      { id: 'call_4', type: 'function_call', name: 'multi_tool_use.parallel' },
      { id: 'call_5', type: 'function_call', name: 'functions.private-example-tool' },
    ];
    const payload = items.flatMap((item, output_index) => [
      `data: ${JSON.stringify({ type: 'response.output_item.added', output_index, item })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.output_item.done', output_index, item })}\n\n`,
    ]).join('') + completed();
    const { send, proxy } = await rig((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(payload);
    });
    await (await send()).text();
    expect(proxy.metrics.toolNames).toEqual({ Read: 2, apply_patch: 1, multi_tool_use: 1 });
    expect(proxy.metrics.requests[0]?.toolNames).toEqual({ Read: 2, apply_patch: 1, multi_tool_use: 1 });
    expect(JSON.stringify(proxy.metrics)).not.toContain('private-example-tool');
  });

  it('consumes the request cap when the upstream closes without a response', async () => {
    let calls = 0;
    const { send, proxy } = await rig((request) => {
      calls += 1;
      request.socket.destroy();
    }, { maxRequests: 1 });
    const first = await send();
    expect(first.status).toBe(502);
    await first.text();
    const second = await send();
    expect(second.status).toBe(429);
    await second.text();
    expect(calls).toBe(1);
    expect(proxy.metrics.requests).toMatchObject([{ failure: 'transport_error' }]);
  });

  it.each([
    { status: 'incomplete', finishReason: 'max_output_tokens' },
    { status: 'failed', finishReason: 'failed' },
  ])('records the $status terminal without retaining raw error content', async ({ status, finishReason }) => {
    const payload = `data: ${JSON.stringify({
      type: `response.${status}`,
      response: {
        status, usage: USAGE, incomplete_details: { reason: 'max_output_tokens' },
        error: { message: 'private upstream error details' },
      },
    })}\n\n`;
    const { send, proxy } = await rig((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(payload);
    });
    expect(await (await send()).text()).toBe(payload);
    expect(proxy.metrics.requests).toMatchObject([{ terminal: status, finishReason, usage: { totalTokens: 14 } }]);
    expect(JSON.stringify(proxy.metrics)).not.toContain('private upstream error details');
  });

  it('marks successful HTTP streams with no terminal as incomplete measurements', async () => {
    const { send, proxy } = await rig((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
    });
    await (await send()).text();
    expect(proxy.metrics.requests).toMatchObject([{ failure: 'missing_terminal' }]);
    expect(proxy.metrics.usageObservedRequests).toBe(0);
  });

  it('keeps a terminal result successful when a client stops before transport EOF', async () => {
    const closed = deferred<void>();
    const { send, proxy } = await rig((_request, response) => {
      response.on('close', () =>{  closed.resolve(); });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(completed());
    });
    const result = await send();
    const reader = result.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(completed());
    await reader.cancel();
    await closed.promise;
    await setImmediate();
    expect(proxy.metrics.requests[0]).toMatchObject({ terminal: 'completed', usage: { totalTokens: 14 } });
    expect(proxy.metrics.requests[0]).not.toHaveProperty('failure');
  });

  it.each([
    { body: { ...REQUEST, model: 'different-model' }, code: 'model_mismatch' },
    { body: { ...REQUEST, reasoning: { effort: 'low' } }, code: 'effort_mismatch' },
    { body: { ...REQUEST, reasoning: {} }, code: 'effort_mismatch' },
    { body: { ...REQUEST, store: true }, code: 'store_must_be_false' },
  ])('rejects $code before dispatch', async ({ body, code }) => {
    const { send, proxy } = await rig();
    const result = await send(body);
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ error: { code } });
    expect(proxy.metrics.upstreamRequests).toBe(0);
  });

  it('reserves the last request slot while authentication is pending', async () => {
    const authenticated = deferred<Record<string, string>>();
    const entered = deferred<void>();
    const { send, proxy } = await rig(undefined, {
      maxRequests: 1,
      getHeaders: () => { entered.resolve(); return authenticated.promise; },
    });
    const first = send();
    await entered.promise;
    const second = await send();
    expect(second.status).toBe(429);
    await second.text();
    authenticated.resolve({ authorization: 'Bearer example-upstream-key' });
    expect((await first).status).toBe(200);
    await (await first).text();
    expect(proxy.metrics.upstreamRequests).toBe(1);
  });

  it('stops later requests when observed token usage exceeds the run limit', async () => {
    const { send, proxy } = await rig(undefined, { maxTotalTokens: 12 });
    const first = await send();
    expect(first.status).toBe(200);
    await first.text();
    const rejected = await send();
    expect(rejected.status).toBe(429);
    await rejected.text();
    expect(proxy.metrics).toMatchObject({
      upstreamRequests: 1, budgetExceeded: true, tokenBudgetExhausted: true,
      usage: { totalTokens: 14 }, limits: { totalTokenPolicy: 'observed-after-response' },
    });
  });

  it('applies an explicitly configured output limit to the fixed upstream only', async () => {
    let forwarded: Record<string, unknown> | undefined;
    let path: string | undefined;
    const { send, proxy } = await rig(async (request, response) => {
      path = request.url;
      forwarded = await jsonBody(request);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(completed());
    }, { maxOutputTokens: 50 });
    await (await send({ ...REQUEST, max_output_tokens: 100 }, '/v1/responses')).text();
    expect(path).toBe('/fixed/responses');
    expect(forwarded).toMatchObject({ model: 'gpt-6-astra', reasoning: { effort: 'high' }, store: false, max_output_tokens: 50 });
    expect(proxy.metrics.droppedOutputCapRequests).toBe(0);
  });

  it('keeps output limits absent when no limit was configured', async () => {
    let forwarded: Record<string, unknown> | undefined;
    const { send } = await rig(async (request, response) => {
      forwarded = await jsonBody(request);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(completed());
    });
    await (await send()).text();
    expect(forwarded).not.toHaveProperty('max_output_tokens');
    expect(forwarded).not.toHaveProperty('max_completion_tokens');
  });

  it('uses host identity headers while forwarding only allowed client metadata', async () => {
    let forwarded: IncomingMessage['headers'] | undefined;
    const { send, proxy } = await rig(async (request, response) => {
      forwarded = request.headers;
      await jsonBody(request);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'private-cookie' });
      response.end(completed());
    }, { getHeaders: async () => ({ Authorization: 'Bearer example-host-key', 'ChatGPT-Account-ID': 'example-host-account' }) });
    const result = await send(REQUEST, '/responses', {
      authorization: 'Bearer example-client-key', 'chatgpt-account-id': 'example-client-account',
      cookie: 'example-client-cookie', 'session-id': 'example-session',
      'x-codex-turn-metadata': '{"turn_id":"example-turn"}', 'OpenAI-Beta': 'responses=experimental',
    });
    await result.text();
    expect(forwarded).toMatchObject({
      authorization: 'Bearer example-host-key', 'chatgpt-account-id': 'example-host-account',
      'session-id': 'example-session', 'x-codex-turn-metadata': '{"turn_id":"example-turn"}',
      'openai-beta': 'responses=experimental',
    });
    expect(forwarded).not.toHaveProperty('cookie');
    expect(result.headers.get('set-cookie')).toBeNull();
    expect(JSON.stringify(proxy.metrics)).not.toContain('example-');
  });

  it('rejects other paths without contacting the configured upstream', async () => {
    const { send, proxy } = await rig();
    const result = await send(REQUEST, '/v1/models');
    expect(result.status).toBe(404);
    await result.text();
    expect(proxy.metrics.upstreamRequests).toBe(0);
  });

  it('forwards only the exact Codex Responses path while preserving session metadata', async () => {
    let sessionId: string | string[] | undefined;
    const { send, proxy } = await rig((request, response) => {
      sessionId = request.headers['session-id'];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(completed());
    });
    const accepted = await send(REQUEST, '/backend-api/codex/responses', { 'session-id': 'example-session' });
    expect(accepted.status).toBe(200);
    await accepted.text();
    expect(sessionId).toBe('example-session');
    for (const path of ['/backend-api/codex/models', '/backend-api/codex/responses/extra', '/backend-api/codex/responses?target=other']) {
      const rejected = await send(REQUEST, path);
      expect(rejected.status).toBe(404);
      await rejected.text();
    }
    expect(proxy.metrics.upstreamRequests).toBe(1);
    expect(proxy.metrics.rejectedRequests).toBe(3);
  });

  it('shares the same quota with a Unix socket listener', async () => {
    const scratch = join(import.meta.dirname, '..', '..', '..', '.tmp');
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(join(scratch, 'hproxy-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const socketPath = join(directory, 'proxy.sock');
    const { send, proxy } = await rig(undefined, { maxRequests: 1, listen: { unixSocketPath: socketPath } });
    const response = await new Promise<{ status: number | undefined; text: string }>((resolve, reject) => {
      const request = httpRequest({ socketPath, path: '/responses', method: 'POST', headers: { 'content-type': 'application/json' } }, (result) => {
        const chunks: Buffer[] = [];
        result.on('data', (bytes: Buffer) => chunks.push(bytes));
        result.on('end', () =>{  resolve({ status: result.statusCode, text: Buffer.concat(chunks).toString('utf8') }); });
        result.on('error', reject);
      });
      request.on('error', reject);
      request.end(JSON.stringify(REQUEST));
    });
    expect(response).toEqual({ status: 200, text: completed() });
    expect(proxy.unixSocketPath).toBe(socketPath);
    const rejected = await send();
    expect(rejected.status).toBe(429);
    await rejected.text();
    expect(proxy.metrics.upstreamRequests).toBe(1);
  });
});
