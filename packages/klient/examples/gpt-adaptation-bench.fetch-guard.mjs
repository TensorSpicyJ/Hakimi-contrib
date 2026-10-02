/**
 * `gpt-adaptation-bench` fetch guard (Node ESM preload, plain JS).
 *
 * Loaded with `--import` BEFORE the engine is imported, so every outbound
 * request of an arm passes through one measurement point:
 *
 *   1. **Budget ticket.** For every request to the official Responses
 *      endpoint the guard takes a synchronous, durable ticket from a
 *      file-locked counter before the real `fetch` is dispatched. The
 *      per-run cap is therefore a hard cap on real HTTP dispatches
 *      (including turn retries and auth replays), not an estimate.
 *   2. **Ablation.** With `KIMI_BENCH_STRIP_SESSION_ID=1` it removes every
 *      header whose lowercased name is `session-id` from the outgoing
 *      request — header only, same code, no source rewriting.
 *   3. **Observation.** It records derived, redacted facts about the request
 *      and the streamed response (request count, usage, TTFT, phase/item-id/
 *      encrypted presence, tool list, instructions digest). Raw bodies and
 *      credential values are never written to disk.
 *
 * Only official authentication/usage traffic may bypass model tickets; other
 * endpoints fail closed. The SSE observer reads a tee concurrently, never
 * buffers the entire response before returning it to the SDK. The arm flushes
 * pending observations before exiting; TTFT means a non-empty output-text delta.
 *
 * Configuration (all optional; with no `KIMI_BENCH_GUARD_DIR` the module is
 * inert and `fetch` is untouched):
 *   KIMI_BENCH_GUARD_DIR        directory holding tickets.json + requests.jsonl
 *   KIMI_BENCH_RUN_CAP          per-run request cap (default 6)
 *   KIMI_BENCH_STRIP_SESSION_ID '1' to strip the session-id header
 *   KIMI_BENCH_GUARD_HOSTS      extra host[:port] values to intercept
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const GUARD_DIR = process.env['KIMI_BENCH_GUARD_DIR'];
const RUN_CAP = Number.parseInt(process.env['KIMI_BENCH_RUN_CAP'] ?? '6', 10);
const STRIP_SESSION_ID = process.env['KIMI_BENCH_STRIP_SESSION_ID'] === '1';
const EXTRA_HOSTS = (process.env['KIMI_BENCH_GUARD_HOSTS'] ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value !== '');

const CODEX_HOSTS = ['chatgpt.com', 'chat.openai.com'];
const CODEX_PATH_SUFFIX = '/backend-api/codex';
const SESSION_ID_HEADER = 'session-id';

const originalFetch = globalThis.fetch;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function digestOf(value) {
  return typeof value === 'string' ? sha256(value).slice(0, 32) : null;
}

/** Sync sleep so the lock retry loop stays synchronous (no async in dispatch). */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(lockPath, fn) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() > deadline) throw new Error('bench guard: ticket lock timeout');
      sleepMs(5);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

/**
 * Take one durable request ticket. Returns `{ index, count, cap }`, or throws
 * when this request would exceed the per-run cap.
 */
function takeTicket() {
  const statePath = join(GUARD_DIR, 'tickets.json');
  return withLock(join(GUARD_DIR, 'tickets.lock'), () => {
    const state = existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, 'utf8'))
      : { count: 0, cap: RUN_CAP, exceeded: 0 };
    if (!Number.isSafeInteger(RUN_CAP) || RUN_CAP <= 0 || state.cap !== RUN_CAP ||
        !Number.isSafeInteger(state.count) || state.count < 0 ||
        !Number.isSafeInteger(state.exceeded) || state.exceeded < 0) {
      throw new Error('bench guard: invalid ticket state; refusing to reset the budget');
    }
    if (state.count >= RUN_CAP) {
      state.exceeded += 1;
      writeFileSync(statePath, JSON.stringify(state), { mode: 0o600, flush: true });
      const error = new Error(`bench guard: request ${String(state.count + 1)} exceeds the per-run cap of ${String(RUN_CAP)}`);
      error.code = 'BENCH_REQUEST_CAP_EXCEEDED';
      throw error;
    }
    state.count += 1;
    writeFileSync(statePath, JSON.stringify(state), { mode: 0o600, flush: true });
    return { index: state.count, count: state.count, cap: RUN_CAP };
  });
}

function record(entry) {
  appendFileSync(join(GUARD_DIR, 'requests.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
}

function isResponsesEndpoint(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = url.port === '' ? url.hostname : `${url.hostname}:${url.port}`;
  if (EXTRA_HOSTS.includes(host) || EXTRA_HOSTS.includes(url.hostname)) return true;
  if (url.protocol !== 'https:' || !CODEX_HOSTS.includes(url.hostname)) return false;
  if (url.port !== '' && url.port !== '443') return false;
  return url.pathname.replace(/\/+$/, '') === `${CODEX_PATH_SUFFIX}/responses`;
}

/** Flatten any accepted `HeadersInit` shape into lowercase-keyed entries. */
function readHeaderEntries(headers) {
  const entries = [];
  if (headers === undefined || headers === null) return entries;
  if (Array.isArray(headers)) {
    for (const pair of headers) entries.push([String(pair[0]), String(pair[1])]);
    return entries;
  }
  if (typeof headers.entries === 'function') {
    for (const pair of headers.entries()) entries.push([String(pair[0]), String(pair[1])]);
    return entries;
  }
  for (const [key, value] of Object.entries(headers)) entries.push([key, String(value)]);
  return entries;
}

/** Rebuild the header container in the shape the caller used, minus stripped names. */
function stripSessionIdHeaders(init) {
  const headers = init?.headers;
  if (headers === undefined || headers === null) return { stripped: false, headers };
  const entries = readHeaderEntries(headers);
  const remaining = entries.filter(([key]) => key.toLowerCase() !== SESSION_ID_HEADER);
  const stripped = remaining.length !== entries.length;
  if (!stripped) return { stripped: false, headers };
  if (Array.isArray(headers)) return { stripped, headers: remaining };
  if (typeof headers.entries === 'function') {
    const rebuilt = new Headers();
    for (const [key, value] of remaining) rebuilt.append(key, value);
    return { stripped, headers: rebuilt };
  }
  return { stripped, headers: Object.fromEntries(remaining) };
}

function headerSummary(entries) {
  const names = [];
  let sessionIdPresent = false;
  for (const [key, value] of entries) {
    const lower = key.toLowerCase();
    names.push(lower);
    if (lower === SESSION_ID_HEADER) sessionIdPresent = value.length > 0;
  }
  return {
    // Explicit default-order comparator: the same UTF-16 lexicographic order
    // `sort()` uses by default, without the implicit string coercion.
    headerNames: [...new Set(names)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    sessionIdPresent,
  };
}

function parseRequestFacts(bodyText, bodyJson) {
  const record = bodyJson ?? {};
  const input = Array.isArray(record.input) ? record.input : [];
  let messageItems = 0;
  let messageItemsWithId = 0;
  let messageItemsWithPhase = 0;
  let reasoningItems = 0;
  let reasoningWithEncrypted = 0;
  let toolCallItems = 0;
  for (const raw of input) {
    const item = raw ?? {};
    if (item.type === 'message') {
      messageItems += 1;
      if (typeof item.id === 'string') messageItemsWithId += 1;
      if (typeof item.phase === 'string') messageItemsWithPhase += 1;
    } else if (item.type === 'reasoning') {
      reasoningItems += 1;
      if (typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0) {
        reasoningWithEncrypted += 1;
      }
    } else if (item.type === 'function_call') {
      toolCallItems += 1;
    }
  }
  const tools = Array.isArray(record.tools) ? record.tools : [];
  return {
    bodyBytes: bodyText === undefined ? 0 : Buffer.byteLength(bodyText),
    bodyDigest: digestOf(bodyText),
    model: typeof record.model === 'string' ? record.model : null,
    stream: record.stream === true,
    store: typeof record.store === 'boolean' ? record.store : null,
    includesEncryptedReasoning: Array.isArray(record.include)
      ? record.include.includes('reasoning.encrypted_content')
      : false,
    promptCacheKeyDigest: digestOf(record.prompt_cache_key),
    reasoningEffort:
      typeof record.reasoning === 'object' && record.reasoning !== null && typeof record.reasoning.effort === 'string'
        ? record.reasoning.effort
        : null,
    toolNames: tools.map((tool) => tool?.name).filter((name) => typeof name === 'string').sort(),
    instructionsDigest: digestOf(record.instructions),
    instructionsLength: typeof record.instructions === 'string' ? record.instructions.length : 0,
    inputItems: input.length,
    messageItems,
    messageItemsWithId,
    messageItemsWithPhase,
    reasoningItems,
    reasoningWithEncrypted,
    toolCallItems,
  };
}

/** Observe a tee without delaying the stream delivered to the production SDK. */
async function analyseResponse(response, startedAt) {
  if (response.body === null) {
    return { firstByteMs: null, firstVisibleTokenMs: null, streamedEvents: 0, terminalEventSeen: null, usage: null, metadata: null };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let firstByteMs = null;
  let firstVisibleTokenMs = null;
  let streamedEvents = 0;
  let terminalEventSeen = null;
  let finishStatus = null;
  let usage = null;
  const metadata = {
    outputTextEvents: 0, outputItemAdded: 0, outputItemDone: 0,
    reasoningItemsDone: 0, reasoningWithEncrypted: 0,
    messageItemsDone: 0, messageItemsWithId: 0, messageItemsWithPhase: 0,
    phases: [], toolCallsAnnounced: 0, responseFailed: false,
  };
  const count = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      firstByteMs ??= Date.now() - startedAt;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 4 * 1024 * 1024) throw new Error('oversized benchmark SSE frame');
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const payload = frame.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
        if (payload === '' || payload.trim() === '[DONE]') continue;
        let event;
        try { event = JSON.parse(payload); } catch { continue; }
        streamedEvents += 1;
        const type = event.type;
        if (type === 'response.output_text.delta') {
          metadata.outputTextEvents += 1;
          if (typeof event.delta === 'string' && event.delta.length > 0) {
            firstVisibleTokenMs ??= Date.now() - startedAt;
          }
        } else if (type === 'response.output_item.added') {
          metadata.outputItemAdded += 1;
          if (event.item?.type === 'function_call') metadata.toolCallsAnnounced += 1;
        } else if (type === 'response.output_item.done') {
          metadata.outputItemDone += 1;
          if (event.item?.type === 'reasoning') {
            metadata.reasoningItemsDone += 1;
            if (typeof event.item.encrypted_content === 'string' && event.item.encrypted_content !== '') metadata.reasoningWithEncrypted += 1;
          } else if (event.item?.type === 'message') {
            metadata.messageItemsDone += 1;
            if (typeof event.item.id === 'string') metadata.messageItemsWithId += 1;
            if (typeof event.item.phase === 'string') {
              metadata.messageItemsWithPhase += 1;
              metadata.phases.push(event.item.phase);
            }
          }
        } else if (type === 'response.completed' || type === 'response.incomplete') {
          terminalEventSeen = type;
          const completion = event.response ?? {};
          const raw = completion.usage;
          if (raw !== null && typeof raw === 'object') {
            usage = { inputTokens: count(raw.input_tokens), outputTokens: count(raw.output_tokens),
              cachedTokens: count(raw.input_tokens_details?.cached_tokens), totalTokens: count(raw.total_tokens) };
          }
          if (typeof completion.status === 'string') finishStatus = completion.status;
        } else if (type === 'response.failed') {
          terminalEventSeen = type;
          metadata.responseFailed = true;
        }
      }
    }
  } catch {
    // Keep partial observations; a missing terminal/usage remains explicit.
  } finally {
    reader.releaseLock();
  }
  return { firstByteMs, firstVisibleTokenMs, streamedEvents, terminalEventSeen, finishStatus, usage, metadata };
}

if (typeof GUARD_DIR === 'string' && GUARD_DIR !== '') {
  mkdirSync(GUARD_DIR, { recursive: true, mode: 0o700 });
  const pendingObservations = new Set();
  globalThis[Symbol.for('hakimi.gptBenchFlush')] = async () => {
    while (pendingObservations.size > 0) await Promise.all(pendingObservations);
  };
  globalThis.fetch = async function guardedFetch(input, init) {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    // fetch's own accepted shapes: a plain URL string, a `URL`, or a `Request`
    // (whose parsed `url` is authoritative).
    const rawUrl = isRequest ? input.url : typeof input === 'string' ? input : input.href;
    if (!isResponsesEndpoint(rawUrl)) {
      const url = new URL(rawUrl);
      const authOrigin = url.protocol === 'https:' && ['auth.openai.com', ...CODEX_HOSTS].includes(url.hostname);
      const bodyText = init !== undefined && typeof init.body === 'string'
        ? init.body
        : isRequest ? await input.clone().text().catch(() => undefined) : undefined;
      // Official auth/usage traffic may pass (~no ticket); anything else —
      // including a model-shaped request on a look-alike endpoint — fails
      // closed and is recorded so the orchestrator can refuse the run.
      const disposition = authOrigin && !looksLikeModelRequest(bodyText) ? 'auth' : 'refused';
      record({
        kind: 'other',
        disposition,
        ts: Date.now(),
        urlDigest: digestOf(rawUrl),
        host: safeHost(rawUrl),
      });
      if (disposition === 'refused') {
        throw new Error('bench guard: refusing an unapproved endpoint');
      }
      return originalFetch.call(this, input, init);
    }

    let url = rawUrl;
    let method = init?.method ?? (isRequest ? input.method : 'GET');
    let headerEntries = readHeaderEntries(init?.headers ?? (isRequest ? input.headers : undefined));
    let bodyText;
    if (init !== undefined && typeof init.body === 'string') bodyText = init.body;
    else if (isRequest) bodyText = await input.clone().text();
    let bodyJson;
    if (typeof bodyText === 'string') {
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {
        bodyJson = undefined;
      }
    }

    const expectedModel = process.env['KIMI_BENCH_EXPECTED_MODEL'];
    if (expectedModel && bodyJson?.model !== expectedModel) {
      throw new Error('bench guard: request does not use the frozen model');
    }
    const beforeStrip = headerSummary(headerEntries);
    let stripped = false;
    if (STRIP_SESSION_ID) {
      const result = stripSessionIdHeaders(init ?? (isRequest ? { headers: input.headers } : undefined));
      stripped = result.stripped;
      headerEntries = readHeaderEntries(result.headers);
    }

    let ticket;
    try {
      ticket = takeTicket();
    } catch (error) {
      record({
        kind: 'denied',
        ts: Date.now(),
        urlDigest: digestOf(url),
        reason: error.code ?? 'unknown',
        message: error.message,
        strip: stripped,
        ...beforeStrip,
      });
      throw error;
    }

    const startedAt = Date.now();
    const base = {
      kind: 'responses',
      ts: startedAt,
      index: ticket.index,
      runCount: ticket.count,
      cap: ticket.cap,
      urlDigest: digestOf(url),
      method: String(method).toUpperCase(),
      strip: stripped,
      sessionIdPresent: beforeStrip.sessionIdPresent,
      sessionIdSent: stripped ? false : beforeStrip.sessionIdPresent,
      headerNames: beforeStrip.headerNames,
      request: parseRequestFacts(bodyText, bodyJson),
    };

    let response;
    try {
      const forwardedInit = { ...init };
      if (STRIP_SESSION_ID) {
        const result = stripSessionIdHeaders(init ?? (isRequest ? { headers: input.headers } : undefined));
        if (result.headers === undefined) delete forwardedInit.headers;
        else forwardedInit.headers = result.headers;
      }
      response = await originalFetch.call(this, input, Object.keys(forwardedInit).length === 0 ? init : forwardedInit);
    } catch (error) {
      record({ ...base, ok: false, errorCode: error?.cause?.code ?? error?.code ?? 'unknown' });
      throw error;
    }

    const observation = analyseResponse(response.clone(), startedAt)
      .catch(() => null)
      .then((analysis) => record({
        ...base,
        ok: response.ok,
        status: response.status,
        wallMs: Date.now() - startedAt,
        firstByteMs: analysis?.firstByteMs ?? null,
        firstVisibleTokenMs: analysis?.firstVisibleTokenMs ?? null,
        streamedEvents: analysis?.streamedEvents ?? null,
        terminalEventSeen: analysis?.terminalEventSeen ?? null,
        finishStatus: analysis?.finishStatus ?? null,
        usage: analysis?.usage ?? null,
        responseMetadata: analysis?.metadata ?? null,
      }));
    pendingObservations.add(observation);
    void observation.finally(() => pendingObservations.delete(observation)).catch(() => undefined);
    return response;
  };
}

function safeHost(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return 'invalid';
  }
}

/**
 * A model request is recognized by its body, not its URL: an arm must not be
 * able to reach a real model endpoint (or a look-alike path) outside the
 * ticketed endpoint by dressing the URL differently.
 */
function looksLikeModelRequest(bodyText) {
  if (typeof bodyText !== 'string' || bodyText.length === 0) return false;
  try {
    const body = JSON.parse(bodyText);
    if (body === null || typeof body !== 'object') return false;
    return typeof body.model === 'string' ||
      Array.isArray(body.input) || Array.isArray(body.messages);
  } catch {
    return false;
  }
}
