/**
 * `gpt-adaptation-bench` deterministic Responses event scripts.
 *
 * These are hand-written Responses-wire event sequences (no paid inference)
 * replayed through the real provider + requester + loop of both arms. Each
 * script declares whether it contains a valid terminal event, so the
 * benchmark can score "was this run wrongly reported as a success" and
 * "did an incomplete tool call get executed" objectively.
 *
 * The same script bytes are served to both arms, in the same order.
 */

import { createHash } from 'node:crypto';

export interface ResponseEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface ScriptedResponse {
  readonly events: readonly ResponseEvent[];
  /** `false` means the stream ends without a terminal event (truncation). */
  readonly hasTerminalEvent: boolean;
  /** Tool calls the script legitimately completes (arities the model may run). */
  readonly completeToolCalls: number;
}

export interface ReplayScript {
  readonly id: string;
  readonly description: string;
  /** How many prompts the driver must send for this script. */
  readonly prompts: number;
  /**
   * How many of `responses` each turn consumes, in order. The sum must equal
   * `responses.length`; a turn's budget is its share plus one spare request, so
   * a truncated response can still reach a natural end (and an engine that
   * misbehaves is refused instead of looping).
   */
  readonly responsesPerTurn: readonly number[];
  readonly responses: readonly ScriptedResponse[];
}

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

export const textDelta = (delta: string, itemId = 'msg_1', outputIndex = 0): ResponseEvent => ({
  type: 'response.output_text.delta',
  item_id: itemId,
  output_index: outputIndex,
  delta,
});

export const outputItemAdded = (
  item: Record<string, unknown>,
  outputIndex = 0,
): ResponseEvent => ({
  type: 'response.output_item.added',
  output_index: outputIndex,
  item,
});

export const outputItemDone = (
  item: Record<string, unknown>,
  outputIndex = 0,
): ResponseEvent => ({
  type: 'response.output_item.done',
  output_index: outputIndex,
  item,
});

export const argsDelta = (delta: string, itemId: string, outputIndex = 0): ResponseEvent => ({
  type: 'response.function_call_arguments.delta',
  item_id: itemId,
  output_index: outputIndex,
  delta,
});

export const argsDone = (args: string, itemId: string, outputIndex = 0): ResponseEvent => ({
  type: 'response.function_call_arguments.done',
  item_id: itemId,
  output_index: outputIndex,
  arguments: args,
});

export const reasoningDelta = (delta: string, itemId: string, outputIndex = 0): ResponseEvent => ({
  type: 'response.reasoning_summary_text.delta',
  item_id: itemId,
  output_index: outputIndex,
  delta,
});

export const created = (id: string): ResponseEvent => ({
  type: 'response.created',
  response: { id },
});

export const completed = (id: string, usage?: Record<string, unknown>): ResponseEvent => ({
  type: 'response.completed',
  response: { id, status: 'completed', usage },
});

export const FAILURE_SAMPLE_USAGE = {
  input_tokens: 900,
  output_tokens: 40,
  total_tokens: 940,
  input_tokens_details: { cached_tokens: 0 },
} as const;

const functionCallItem = (
  itemId: string,
  callId: string,
  name: string,
  args: string,
): Record<string, unknown> => ({
  type: 'function_call',
  id: itemId,
  call_id: callId,
  name,
  arguments: args,
});

const messageItem = (
  itemId: string,
  text: string,
  phase?: string,
): Record<string, unknown> => ({
  type: 'message',
  id: itemId,
  role: 'assistant',
  ...(phase === undefined ? {} : { phase }),
  content: [{ type: 'output_text', text, annotations: [] }],
});

const reasoningItem = (
  itemId: string,
  encrypted: string,
  summaryText = 'thinking about the task',
): Record<string, unknown> => ({
  type: 'reasoning',
  id: itemId,
  summary: [{ type: 'summary_text', text: summaryText }],
  encrypted_content: encrypted,
});

/**
 * `BENCH_READ_TOOL` is the tool every script calls: a bounded read of the
 * synthetic workspace, so a truncated script that gets executed leaves a
 * visible, checkable side effect.
 */
export const BENCH_READ_TOOL = 'bench_read_file';
export const BENCH_WRITE_TOOL = 'bench_write_file';
export const BENCH_TESTS_TOOL = 'bench_run_tests';

export const BENCH_READ_ARGS = '{"path":"src/cart.ts"}';

// ---------------------------------------------------------------------------
// The frozen scripts
// ---------------------------------------------------------------------------

export const REPLAY_SCRIPTS: readonly ReplayScript[] = [
  {
    id: 'clean-text',
    description: 'plain text then a terminal event (control)',
    prompts: 1,
    responsesPerTurn: [1],
    responses: [
      {
        hasTerminalEvent: true,
        completeToolCalls: 0,
        events: [
          created('resp_clean'),
          textDelta('Nothing to do.'),
          outputItemDone(messageItem('msg_clean', 'Nothing to do.')),
          completed('resp_clean', FAILURE_SAMPLE_USAGE),
        ],
      },
    ],
  },
  {
    id: 'reasoning-then-text',
    description: 'encrypted reasoning + phased message, then a second turn replays the history',
    prompts: 2,
    responsesPerTurn: [1, 1],
    responses: [
      {
        hasTerminalEvent: true,
        completeToolCalls: 0,
        events: [
          created('resp_reason'),
          reasoningDelta('weighing options', 'rs_1'),
          outputItemDone(reasoningItem('rs_1', 'ENCRYPTED-REASONING-BLOB-ONE')),
          textDelta('First answer.', 'msg_1'),
          outputItemDone(messageItem('msg_1', 'First answer.', 'commentary')),
          completed('resp_reason', FAILURE_SAMPLE_USAGE),
        ],
      },
      {
        hasTerminalEvent: true,
        completeToolCalls: 0,
        events: [
          created('resp_reason_2'),
          textDelta('Second answer.', 'msg_2'),
          outputItemDone(messageItem('msg_2', 'Second answer.', 'final_answer')),
          completed('resp_reason_2', FAILURE_SAMPLE_USAGE),
        ],
      },
    ],
  },
  {
    id: 'tool-then-final',
    description: 'one complete tool call then a final answer in the same turn',
    prompts: 1,
    responsesPerTurn: [2],
    responses: [
      {
        hasTerminalEvent: true,
        completeToolCalls: 1,
        events: [
          created('resp_tool'),
          outputItemAdded(functionCallItem('fc_1', 'call_1', BENCH_READ_TOOL, '')),
          argsDelta(BENCH_READ_ARGS, 'fc_1'),
          argsDone(BENCH_READ_ARGS, 'fc_1'),
          outputItemDone(functionCallItem('fc_1', 'call_1', BENCH_READ_TOOL, BENCH_READ_ARGS)),
          completed('resp_tool', FAILURE_SAMPLE_USAGE),
        ],
      },
      {
        hasTerminalEvent: true,
        completeToolCalls: 0,
        events: [
          created('resp_tool_final'),
          textDelta('Read it.'),
          outputItemDone(messageItem('msg_3', 'Read it.', 'final_answer')),
          completed('resp_tool_final', FAILURE_SAMPLE_USAGE),
        ],
      },
    ],
  },
  {
    id: 'multi-item-mixed',
    description: 'reasoning + text + two tool calls, then a final answer in the same turn',
    prompts: 1,
    responsesPerTurn: [2],
    responses: [
      {
        hasTerminalEvent: true,
        completeToolCalls: 2,
        events: [
          created('resp_multi'),
          outputItemDone(reasoningItem('rs_multi', 'ENCRYPTED-REASONING-BLOB-TWO')),
          textDelta('Working.', 'msg_multi'),
          outputItemAdded(functionCallItem('fc_a', 'call_a', BENCH_READ_TOOL, ''), 1),
          argsDelta('{"path":"src/', 'fc_a', 1),
          argsDelta('cart.ts"}', 'fc_a', 1),
          argsDone(BENCH_READ_ARGS, 'fc_a', 1),
          outputItemDone(functionCallItem('fc_a', 'call_a', BENCH_READ_TOOL, BENCH_READ_ARGS), 1),
          outputItemAdded(functionCallItem('fc_b', 'call_b', BENCH_READ_TOOL, ''), 2),
          argsDelta(BENCH_READ_ARGS, 'fc_b', 2),
          argsDone(BENCH_READ_ARGS, 'fc_b', 2),
          outputItemDone(functionCallItem('fc_b', 'call_b', BENCH_READ_TOOL, BENCH_READ_ARGS), 2),
          completed('resp_multi', FAILURE_SAMPLE_USAGE),
        ],
      },
      {
        hasTerminalEvent: true,
        completeToolCalls: 0,
        events: [
          created('resp_multi_final'),
          textDelta('Both read.'),
          outputItemDone(messageItem('msg_multi_final', 'Both read.', 'final_answer')),
          completed('resp_multi_final', FAILURE_SAMPLE_USAGE),
        ],
      },
    ],
  },
  {
    id: 'late-phase',
    description: 'phase is only present on the terminal output_item.done, after the deltas',
    prompts: 2,
    responsesPerTurn: [1, 1],
    responses: [
      {
        hasTerminalEvent: true,
        completeToolCalls: 0,
        events: [
          created('resp_late'),
          textDelta('Late metadata.', 'msg_late'),
          outputItemDone(messageItem('msg_late', 'Late metadata.', 'commentary')),
          completed('resp_late', FAILURE_SAMPLE_USAGE),
        ],
      },
      {
        hasTerminalEvent: true,
        completeToolCalls: 0,
        events: [
          created('resp_late_2'),
          textDelta('Follow up.', 'msg_late_2'),
          outputItemDone(messageItem('msg_late_2', 'Follow up.', 'final_answer')),
          completed('resp_late_2', FAILURE_SAMPLE_USAGE),
        ],
      },
    ],
  },
  {
    id: 'truncate-after-text',
    description: 'text streamed, then a clean end of stream with no terminal event',
    prompts: 1,
    responsesPerTurn: [1],
    responses: [
      {
        hasTerminalEvent: false,
        completeToolCalls: 0,
        events: [
          created('resp_cut_text'),
          textDelta('partial answer that never finishes', 'msg_cut'),
        ],
      },
    ],
  },
  {
    id: 'truncate-mid-tool-args',
    description: 'tool call announced with half its arguments, then no terminal event',
    prompts: 1,
    responsesPerTurn: [1],
    responses: [
      {
        hasTerminalEvent: false,
        completeToolCalls: 0,
        events: [
          created('resp_cut_args'),
          outputItemAdded(functionCallItem('fc_cut', 'call_cut', BENCH_READ_TOOL, '')),
          argsDelta('{"path":"sr', 'fc_cut'),
        ],
      },
    ],
  },
  {
    id: 'truncate-after-args',
    description: 'complete tool arguments, no terminal event, no output_item.done',
    prompts: 1,
    responsesPerTurn: [1],
    responses: [
      {
        hasTerminalEvent: false,
        completeToolCalls: 1,
        events: [
          created('resp_cut_done'),
          outputItemAdded(functionCallItem('fc_cut2', 'call_cut2', BENCH_READ_TOOL, '')),
          argsDelta(BENCH_READ_ARGS, 'fc_cut2'),
          argsDone(BENCH_READ_ARGS, 'fc_cut2'),
        ],
      },
    ],
  },
  {
    id: 'failed-response',
    description: 'response.failed surfaces as a typed provider failure',
    prompts: 1,
    responsesPerTurn: [1],
    responses: [
      {
        hasTerminalEvent: true,
        completeToolCalls: 0,
        events: [
          created('resp_failed'),
          {
            type: 'response.failed',
            response: {
              id: 'resp_failed',
              status: 'failed',
              error: { code: 'server_error', message: 'upstream exploded' },
            },
          },
        ],
      },
    ],
  },
];

export function findReplayScript(id: string): ReplayScript {
  const script = REPLAY_SCRIPTS.find((candidate) => candidate.id === id);
  if (script === undefined) throw new Error(`unknown replay script: ${id}`);
  return script;
}

// ---------------------------------------------------------------------------
// SSE rendering (stub-server side)
// ---------------------------------------------------------------------------

/** Render one scripted response as a text/event-stream body. */
export function renderSse(response: ScriptedResponse, options: { done?: boolean } = {}): string {
  const lines = response.events.map(
    (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
  if (options.done !== false) lines.push('data: [DONE]\n\n');
  return lines.join('');
}

export function scriptDigest(script: ReplayScript): string {
  return createHash('sha256').update(JSON.stringify(script)).digest('hex');
}

/**
 * How many pieces of replayed metadata the script's first response carries,
 * so coverage can be computed against a fixed expectation.
 */
export function expectedMetadata(script: ReplayScript): {
  readonly phases: number;
  readonly itemIds: number;
  readonly encrypted: number;
  readonly toolCallIds: number;
} {
  return expectedMetadataBefore(script, script.responses.length);
}

/**
 * Metadata a request at `requestIndex` (0-based) could possibly replay: only
 * responses that already completed before it. Scoring a request against
 * responses it has not received yet is unreachable by construction, and a
 * request at index 0 has no replay opportunity at all.
 */
export function expectedMetadataBefore(
  script: ReplayScript,
  requestIndex: number,
): {
  readonly phases: number;
  readonly itemIds: number;
  readonly encrypted: number;
  readonly toolCallIds: number;
} {
  let phases = 0;
  let itemIds = 0;
  let encrypted = 0;
  let toolCallIds = 0;
  for (const response of script.responses.slice(0, Math.max(0, requestIndex))) {
    for (const event of response.events) {
      if (event['type'] !== 'response.output_item.done') continue;
      const item = event['item'];
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      if (record['type'] === 'message') {
        if (typeof record['phase'] === 'string') phases += 1;
        if (typeof record['id'] === 'string') itemIds += 1;
      }
      if (record['type'] === 'reasoning' && typeof record['encrypted_content'] === 'string') {
        encrypted += 1;
      }
      if (record['type'] === 'function_call' && typeof record['id'] === 'string') {
        toolCallIds += 1;
      }
    }
  }
  return { phases, itemIds, encrypted, toolCallIds };
}

// ---------------------------------------------------------------------------
// Fidelity extraction from captured follow-up requests
// ---------------------------------------------------------------------------

/**
 * Derived, non-sensitive facts about one captured Responses request body.
 * Raw bodies (and encrypted reasoning blobs) are never persisted: only
 * presence flags, counts, and sha256 digests leave the analysis function.
 */
export interface RequestFidelity {
  readonly requestIndex: number;
  readonly inputItems: number;
  readonly messageItems: number;
  /** message items that carried an `id`. */
  readonly messageItemsWithId: number;
  /** message items that carried a `phase`. */
  readonly messageItemsWithPhase: number;
  readonly reasoningItems: number;
  readonly reasoningWithEncrypted: number;
  readonly reasoningDigests: readonly string[];
  readonly toolCallItems: number;
  readonly toolCallItemsWithId: number;
  readonly bodyDigest: string;
  readonly headers: Readonly<Record<string, string>>;
}

const SENSITIVE_HEADER_NAMES = new Set(['authorization', 'cookie', 'set-cookie', 'session-id', 'chatgpt-account-id']);

/** Header names only, with values replaced by presence + digest. */
export function summarizeHeaders(headers: Readonly<Record<string, string | string[] | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const text = Array.isArray(value) ? value.join(',') : value;
    out[name] = SENSITIVE_HEADER_NAMES.has(name.toLowerCase())
      ? `<present:${String(createHash('sha256').update(text).digest('hex').slice(0, 12))}>`
      : text.slice(0, 200);
  }
  return out;
}

export function extractFidelity(
  body: unknown,
  requestIndex: number,
  headers: Readonly<Record<string, string | string[] | undefined>>,
): RequestFidelity {
  const record = (body ?? {}) as Record<string, unknown>;
  const input = Array.isArray(record['input']) ? record['input'] : [];
  let messageItems = 0;
  let messageItemsWithId = 0;
  let messageItemsWithPhase = 0;
  let reasoningItems = 0;
  let reasoningWithEncrypted = 0;
  const reasoningDigests: string[] = [];
  let toolCallItems = 0;
  let toolCallItemsWithId = 0;

  for (const raw of input) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const type = item['type'];
    if (type === 'message') {
      messageItems += 1;
      if (typeof item['id'] === 'string') messageItemsWithId += 1;
      if (typeof item['phase'] === 'string') messageItemsWithPhase += 1;
    } else if (type === 'reasoning') {
      reasoningItems += 1;
      const encrypted = item['encrypted_content'];
      if (typeof encrypted === 'string' && encrypted.length > 0) {
        reasoningWithEncrypted += 1;
        reasoningDigests.push(createHash('sha256').update(encrypted).digest('hex').slice(0, 16));
      }
    } else if (type === 'function_call') {
      toolCallItems += 1;
      if (typeof item['id'] === 'string') toolCallItemsWithId += 1;
    }
  }

  return {
    requestIndex,
    inputItems: input.length,
    messageItems,
    messageItemsWithId,
    messageItemsWithPhase,
    reasoningItems,
    reasoningWithEncrypted,
    reasoningDigests,
    toolCallItems,
    toolCallItemsWithId,
    bodyDigest: createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex'),
    headers: summarizeHeaders(headers),
  };
}

/** Coverage numbers a report can compare between arms without raw bodies. */
export interface FidelityCoverage {
  readonly phaseCoverage: number;
  readonly itemIdCoverage: number;
  readonly encryptedCoverage: number;
  readonly reasoningReplayed: boolean;
}

export function fidelityCoverage(
  request: RequestFidelity | undefined,
  expected: { readonly phases: number; readonly itemIds: number; readonly encrypted: number },
): FidelityCoverage {
  const ratio = (got: number, want: number): number => (want === 0 ? 1 : Math.min(1, got / want));
  if (request === undefined) {
    return {
      phaseCoverage: ratio(0, expected.phases),
      itemIdCoverage: ratio(0, expected.itemIds),
      encryptedCoverage: ratio(0, expected.encrypted),
      reasoningReplayed: false,
    };
  }
  return {
    phaseCoverage: ratio(request.messageItemsWithPhase, expected.phases),
    itemIdCoverage: ratio(request.messageItemsWithId, expected.itemIds),
    encryptedCoverage: ratio(request.reasoningWithEncrypted, expected.encrypted),
    reasoningReplayed: request.reasoningItems > 0,
  };
}
