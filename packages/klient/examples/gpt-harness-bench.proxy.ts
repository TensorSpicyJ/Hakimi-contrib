/**
 * Shared Responses boundary for the Codex/Hakimi harness benchmark.
 *
 * Dispatches only to the configured upstream, checks the frozen model/effort,
 * and reserves request quota before asynchronous authentication. Request quota
 * is hard; total-token quota is observed after responses and cannot undo tokens
 * already consumed by concurrent requests. The optional output-token limit is
 * sent only when configured, since the managed Codex backend does not accept it.
 * Response bytes are relayed unchanged. Measurements contain no prompts,
 * generated text, item ids, request headers, credentials, or raw error messages.
 */

import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface ProxyUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export type ProxyTerminal = 'completed' | 'incomplete' | 'failed';

export interface ProxyRequestMetrics {
  sequence: number;
  httpStatus?: number;
  transportKind?: 'sse' | 'json' | 'other';
  observedBytes: number;
  sseDataEvents: number;
  knownEventTypes: Record<string, number>;
  unknownEventTypes: number;
  terminal?: ProxyTerminal;
  finishReason?: 'completed' | 'failed' | 'max_output_tokens' | 'content_filter' | 'steered' | 'unknown';
  usage?: ProxyUsage;
  /** Absence of cache details is unknown, not evidence of zero cache hits. */
  cacheUsageObserved?: boolean;
  toolTypes: Record<string, number>;
  toolNames: Record<string, number>;
  malformedEvents: number;
  failure?: 'upstream_http_error' | 'transport_error' | 'client_aborted' | 'missing_terminal';
}

export interface ProxyMetrics {
  upstreamRequests: number;
  rejectedRequests: number;
  authenticationFailures: number;
  /** Present only when a host readiness validator is enabled. Rejected before quota/auth/network. */
  requestValidationFailures?: number;
  droppedOutputCapRequests: number;
  usageObservedRequests: number;
  observedBytes: number;
  sseDataEvents: number;
  knownEventTypes: Record<string, number>;
  unknownEventTypes: number;
  usage: ProxyUsage;
  terminalEvents: Record<ProxyTerminal, number>;
  toolTypes: Record<string, number>;
  toolNames: Record<string, number>;
  requests: ProxyRequestMetrics[];
  budgetExceeded: boolean;
  requestBudgetExhausted: boolean;
  tokenBudgetExhausted: boolean;
  limits: {
    maxRequests: number;
    maxOutputTokens?: number;
    maxTotalTokens?: number;
    totalTokenPolicy: 'observed-after-response';
  };
}

export interface ProxyOptions {
  model: string;
  effort: string;
  maxRequests: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  upstreamUrl: string;
  getHeaders: () => Promise<Record<string, string>>;
  /** Host-only readiness check on the actual outbound body; never receives credential headers. */
  validateRequest?: (body: Readonly<Record<string, unknown>>) => boolean;
  /** Host-only durable ticket, reserved before authentication or network I/O. */
  reserveRequest?: () => boolean;
  /** Host-only accounting hook; never receives credentials or request content. */
  requestFinished?: (record: ProxyRequestMetrics) => void;
  listen?: {
    port?: number;
    unixSocketPath?: string;
  };
}

export interface ResponsesProxy {
  url: string;
  unixSocketPath?: string;
  metrics: ProxyMetrics;
  close: () => Promise<void>;
}

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_OBSERVED_EVENT_CHARS = 8 * 1024 * 1024;
const TOOL_TYPES = new Set([
  'function_call', 'custom_tool_call', 'local_shell_call', 'shell_call',
  'web_search_call', 'file_search_call', 'computer_call', 'code_interpreter_call',
  'image_generation_call', 'mcp_call', 'mcp_list_tools', 'mcp_approval_request',
  'apply_patch_call', 'tool_search_call',
]);
const CLIENT_HEADER_ALLOWLIST = ['session-id', 'x-codex-turn-metadata', 'openai-beta'];
const KNOWN_EVENT_TYPES = new Set([
  'response.created', 'response.in_progress', 'response.completed', 'response.incomplete', 'response.failed',
  'response.output_item.added', 'response.output_item.done',
  'response.content_part.added', 'response.content_part.done',
  'response.output_text.delta', 'response.output_text.done',
  'response.refusal.delta', 'response.refusal.done',
  'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done',
  'response.reasoning_text.delta', 'response.reasoning_text.done',
  'response.function_call_arguments.delta', 'response.function_call_arguments.done',
  'response.custom_tool_call_input.delta', 'response.custom_tool_call_input.done', 'error',
]);
const TOOL_NAMES = new Set([
  'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash', 'apply_patch', 'exec_command', 'select_tools', 'TodoList',
  'write_stdin', 'shell', 'shell_command', 'read_file', 'update_plan', 'multi_tool_use',
]);

function publicToolName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.replace(/^functions\./, '');
  if (name === 'multi_tool_use.parallel') return 'multi_tool_use';
  return TOOL_NAMES.has(name) ? name : undefined;
}

function emptyUsage(): ProxyUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readUsage(value: unknown): ProxyUsage | undefined {
  const usage = object(value);
  if (usage === undefined) return undefined;
  const input = count(usage['input_tokens']);
  const output = count(usage['output_tokens']);
  if (input === undefined || output === undefined) return undefined;
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: count(object(usage['input_tokens_details'])?.['cached_tokens']) ?? 0,
    reasoningTokens: count(object(usage['output_tokens_details'])?.['reasoning_tokens']) ?? 0,
    totalTokens: count(usage['total_tokens']) ?? input + output,
  };
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function responseObserver(record: ProxyRequestMetrics, metrics: ProxyMetrics): (event: unknown) => void {
  const seenTools = new Set<string>();
  const seenToolNames = new Set<string>();
  const observeTool = (value: unknown, outputIndex?: unknown): void => {
    const item = object(value);
    const type = item?.['type'];
    if (typeof type !== 'string' || !TOOL_TYPES.has(type)) return;
    const key = typeof item?.['id'] === 'string'
      ? `id:${item['id']}`
      : typeof outputIndex === 'number' ? `index:${outputIndex}` : undefined;
    if (key === undefined) return;
    if (!seenTools.has(key)) {
      seenTools.add(key);
      increment(record.toolTypes, type);
      increment(metrics.toolTypes, type);
    }
    const name = publicToolName(item?.['name']);
    if (name !== undefined && !seenToolNames.has(key)) {
      seenToolNames.add(key);
      increment(record.toolNames, name);
      increment(metrics.toolNames, name);
    }
  };
  return (value) => {
    const event = object(value);
    if (event === undefined) return;
    const type = event['type'];
    if (typeof type === 'string' && KNOWN_EVENT_TYPES.has(type)) {
      increment(record.knownEventTypes, type);
      increment(metrics.knownEventTypes, type);
    } else {
      record.unknownEventTypes += 1;
      metrics.unknownEventTypes += 1;
    }
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      observeTool(event['item'], event['output_index']);
    }
    const terminal = type === 'response.completed' ? 'completed'
      : type === 'response.incomplete' ? 'incomplete'
      : type === 'response.failed' ? 'failed' : undefined;
    if (terminal === undefined || record.terminal !== undefined) return;
    record.terminal = terminal;
    metrics.terminalEvents[terminal] += 1;
    const response = object(event['response']);
    const reason = object(response?.['incomplete_details'])?.['reason'];
    record.finishReason = terminal !== 'incomplete' ? terminal
      : reason === 'max_output_tokens' || reason === 'content_filter' || reason === 'steered'
        ? reason : 'unknown';
    if (Array.isArray(response?.['output'])) response['output'].forEach(observeTool);
    const usage = readUsage(response?.['usage']);
    if (usage === undefined) return;
    record.usage = usage;
    const cached = count(object(object(response?.['usage'])?.['input_tokens_details'])?.['cached_tokens']);
    record.cacheUsageObserved = cached !== undefined && cached <= usage.inputTokens;
    metrics.usageObservedRequests += 1;
    for (const key of Object.keys(usage) as (keyof ProxyUsage)[]) metrics.usage[key] += usage[key];
    const limit = metrics.limits.maxTotalTokens;
    if (limit !== undefined) {
      metrics.tokenBudgetExhausted = metrics.usage.totalTokens >= limit;
      metrics.budgetExceeded = metrics.usage.totalTokens > limit;
    }
  };
}

function sseObserver(observe: (event: unknown) => void, record: ProxyRequestMetrics, metrics: ProxyMetrics) {
  const decoder = new TextDecoder();
  let pending = '';
  let data: string[] = [];
  let dataLength = 0;
  let discard = false;
  const dispatch = (): void => {
    if (!discard && data.length > 0) {
      record.sseDataEvents += 1;
      metrics.sseDataEvents += 1;
      const payload = data.join('\n');
      if (payload !== '[DONE]') {
        try { observe(JSON.parse(payload)); } catch { record.malformedEvents += 1; }
      }
    }
    data = [];
    dataLength = 0;
    discard = false;
  };
  const line = (text: string): void => {
    if (text === '') { dispatch(); return; }
    if (!text.startsWith('data:') || discard) return;
    const value = text.slice(5).replace(/^ /, '');
    dataLength += value.length;
    if (dataLength > MAX_OBSERVED_EVENT_CHARS) {
      discard = true;
      data = [];
      record.malformedEvents += 1;
      return;
    }
    data.push(value);
  };
  const consume = (text: string, final: boolean): void => {
    pending += text;
    let start = 0;
    for (let index = 0; index < pending.length; index += 1) {
      const char = pending[index];
      if (char !== '\r' && char !== '\n') continue;
      if (char === '\r' && index + 1 === pending.length && !final) break;
      line(pending.slice(start, index));
      if (char === '\r' && pending[index + 1] === '\n') index += 1;
      start = index + 1;
    }
    pending = pending.slice(start);
    if (pending.length > MAX_OBSERVED_EVENT_CHARS) {
      pending = '';
      discard = true;
      record.malformedEvents += 1;
    }
    if (final) {
      if (pending !== '') line(pending);
      pending = '';
      dispatch();
    }
  };
  return {
    write: (bytes: Uint8Array) =>{  consume(decoder.decode(bytes, { stream: true }), false); },
    end: () =>{  consume(decoder.decode(), true); },
  };
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new Error('request too large');
    chunks.push(bytes);
  }
  const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if (body === undefined) throw new Error('expected an object');
  return body;
}

function reject(response: ServerResponse, status: number, code: string): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { type: 'benchmark_proxy_error', code, message: code } }));
}

async function listen(server: Server, address: number | string): Promise<void> {
  const listening = once(server, 'listening');
  if (typeof address === 'string') server.listen(address);
  else server.listen(address, '127.0.0.1');
  await listening;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  server.closeAllConnections();
  await closed;
}

export async function startProxy(options: ProxyOptions): Promise<ResponsesProxy> {
  const upstream = new URL(options.upstreamUrl);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username !== '' || upstream.password !== '') {
    throw new Error('upstreamUrl must be an HTTP URL without embedded credentials');
  }
  for (const limit of [options.maxRequests, options.maxOutputTokens, options.maxTotalTokens]) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('limits must be positive integers');
  }
  const metrics: ProxyMetrics = {
    upstreamRequests: 0, rejectedRequests: 0, authenticationFailures: 0,
    requestValidationFailures: options.validateRequest === undefined ? undefined : 0,
    droppedOutputCapRequests: 0, usageObservedRequests: 0,
    observedBytes: 0, sseDataEvents: 0, knownEventTypes: {}, unknownEventTypes: 0,
    usage: emptyUsage(), terminalEvents: { completed: 0, incomplete: 0, failed: 0 },
    toolTypes: {}, toolNames: {}, requests: [], budgetExceeded: false,
    requestBudgetExhausted: false, tokenBudgetExhausted: false,
    limits: {
      maxRequests: options.maxRequests, maxOutputTokens: options.maxOutputTokens,
      maxTotalTokens: options.maxTotalTokens, totalTokenPolicy: 'observed-after-response',
    },
  };
  let reservations = 0;
  let closing = false;
  const controllers = new Set<AbortController>();
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const fail = (status: number, code: string): void => {
      metrics.rejectedRequests += 1;
      reject(response, status, code);
    };
    if (request.url !== '/responses' && request.url !== '/v1/responses'
      && request.url !== '/backend-api/codex/responses') {
      fail(404, 'path_not_allowed'); return;
    }
    if (request.method !== 'POST') { fail(405, 'method_not_allowed'); return; }
    let body: Record<string, unknown>;
    try { body = await readBody(request); } catch { fail(400, 'invalid_json_body'); return; }
    if (body['model'] !== options.model) { fail(400, 'model_mismatch'); return; }
    if (object(body['reasoning'])?.['effort'] !== options.effort) { fail(400, 'effort_mismatch'); return; }
    if (body['store'] !== undefined && body['store'] !== false) { fail(400, 'store_must_be_false'); return; }
    if (options.validateRequest !== undefined) {
      let ready = false;
      try { ready = options.validateRequest(body); } catch { /* A broken readiness check is never permission to dispatch. */ }
      if (!ready) {
        metrics.requestValidationFailures = (metrics.requestValidationFailures ?? 0) + 1;
        fail(503, 'benchmark_request_not_ready'); return;
      }
    }
    body['store'] = false;
    if (options.maxOutputTokens !== undefined) {
      const requested = body['max_output_tokens'];
      if (requested !== undefined && (count(requested) === undefined || requested === 0)) {
        fail(400, 'invalid_output_limit'); return;
      }
      body['max_output_tokens'] = Math.min(options.maxOutputTokens, requested as number | undefined ?? options.maxOutputTokens);
    }
    const isManagedCodex = (upstream.hostname === 'chatgpt.com' || upstream.hostname === 'chat.openai.com')
      && upstream.pathname === '/backend-api/codex/responses';
    const droppedOutputCap = isManagedCodex
      && (body['max_output_tokens'] !== undefined || body['max_completion_tokens'] !== undefined);
    if (isManagedCodex) {
      delete body['max_output_tokens'];
      delete body['max_completion_tokens'];
    }
    if (closing || metrics.tokenBudgetExhausted || metrics.upstreamRequests + reservations >= options.maxRequests) {
      fail(429, 'benchmark_budget_exhausted'); return;
    }
    if (options.reserveRequest !== undefined && !options.reserveRequest()) {
      metrics.requestBudgetExhausted = true;
      metrics.budgetExceeded = true;
      fail(429, 'benchmark_budget_exhausted'); return;
    }
    reservations += 1;
    const controller = new AbortController();
    controllers.add(controller);
    const onClose = (): void => { if (!response.writableEnded) controller.abort(); };
    response.on('close', onClose);
    let headers: Record<string, string>;
    try { headers = await options.getHeaders(); } catch {
      reservations -= 1;
      controllers.delete(controller);
      response.off('close', onClose);
      metrics.authenticationFailures += 1;
      reject(response, 502, 'upstream_authentication_failed');
      return;
    }
    reservations -= 1;
    if (controller.signal.aborted || closing || metrics.tokenBudgetExhausted) {
      controllers.delete(controller);
      response.off('close', onClose);
      if (!controller.signal.aborted) fail(429, 'benchmark_budget_exhausted');
      return;
    }
    metrics.upstreamRequests += 1;
    if (droppedOutputCap) metrics.droppedOutputCapRequests += 1;
    metrics.requestBudgetExhausted = metrics.upstreamRequests >= options.maxRequests;
    const record: ProxyRequestMetrics = {
      sequence: metrics.upstreamRequests, toolTypes: {}, toolNames: {}, malformedEvents: 0,
      observedBytes: 0, sseDataEvents: 0, knownEventTypes: {}, unknownEventTypes: 0,
    };
    metrics.requests.push(record);
    const observe = responseObserver(record, metrics);
    const observer = sseObserver(observe, record, metrics);
    try {
      const upstreamHeaders = new Headers();
      for (const name of CLIENT_HEADER_ALLOWLIST) {
        const value = request.headers[name];
        if (typeof value === 'string') upstreamHeaders.set(name, value);
      }
      for (const [name, value] of Object.entries(headers)) upstreamHeaders.set(name, value);
      upstreamHeaders.set('content-type', 'application/json');
      const result = await fetch(upstream, {
        method: 'POST', headers: upstreamHeaders,
        body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
      });
      record.httpStatus = result.status;
      if (!result.ok) record.failure = 'upstream_http_error';
      const contentType = result.headers.get('content-type') ?? 'application/octet-stream';
      response.writeHead(result.status, { 'content-type': contentType, 'cache-control': 'no-store' });
      record.transportKind = contentType.toLowerCase().includes('text/event-stream') ? 'sse'
        : contentType.toLowerCase().includes('application/json') ? 'json' : 'other';
      const isSse = record.transportKind === 'sse' || (result.ok && body['stream'] === true);
      const jsonChunks: Uint8Array[] = [];
      let jsonSize = 0;
      if (result.body !== null) {
        for await (const bytes of result.body) {
          record.observedBytes += bytes.byteLength;
          metrics.observedBytes += bytes.byteLength;
          if (isSse) observer.write(bytes);
          else if (contentType.includes('application/json') && jsonSize <= MAX_OBSERVED_EVENT_CHARS) {
            jsonSize += bytes.byteLength;
            if (jsonSize <= MAX_OBSERVED_EVENT_CHARS) jsonChunks.push(bytes);
            else jsonChunks.length = 0;
          }
          if (!response.write(bytes)) await once(response, 'drain', { signal: controller.signal });
        }
      }
      if (isSse) observer.end();
      else if (jsonChunks.length > 0) {
        try {
          const json = object(JSON.parse(Buffer.concat(jsonChunks).toString('utf8')));
          const status = json?.['status'];
          if (status === 'completed' || status === 'incomplete' || status === 'failed') {
            observe({ type: `response.${status}`, response: json });
          }
        } catch { record.malformedEvents += 1; }
      }
      if (result.ok && record.terminal === undefined) record.failure = 'missing_terminal';
      response.end();
    } catch {
      if (record.terminal === undefined) {
        record.failure = controller.signal.aborted ? 'client_aborted' : 'transport_error';
      }
      if (response.headersSent) response.destroy();
      else reject(response, 502, 'upstream_transport_failed');
    } finally {
      controller.abort();
      controllers.delete(controller);
      response.off('close', onClose);
      options.requestFinished?.(record);
    }
  };
  const createListener = (): Server => createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else reject(response, 500, 'proxy_internal_error');
    });
  });
  const tcp = createListener();
  const unix = options.listen?.unixSocketPath === undefined ? undefined : createListener();
  try {
    await listen(tcp, options.listen?.port ?? 0);
    if (unix !== undefined) await listen(unix, options.listen!.unixSocketPath!);
  } catch (error) {
    await Promise.all([closeServer(tcp), unix === undefined ? Promise.resolve() : closeServer(unix)]);
    throw error;
  }
  const address = tcp.address();
  if (address === null || typeof address === 'string') throw new Error('TCP listener has no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    unixSocketPath: options.listen?.unixSocketPath,
    metrics,
    close: async () => {
      closing = true;
      for (const controller of controllers) controller.abort();
      await Promise.all([closeServer(tcp), unix === undefined ? Promise.resolve() : closeServer(unix)]);
    },
  };
}
