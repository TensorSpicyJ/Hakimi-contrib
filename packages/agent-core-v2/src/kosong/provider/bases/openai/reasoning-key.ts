/**
 * The OpenAI-compatible Chat Completions ecosystem never standardized a wire
 * field for reasoning/thinking content. Three names circulate in the wild:
 *
 * - `reasoning_content` — DeepSeek's original convention, used by the Moonshot
 *   Kimi API, pre-rename vLLM, and most OpenAI-compatible gateways.
 * - `reasoning_details` — OpenRouter.
 * - `reasoning` — OpenAI's GPT-OSS guidance; current vLLM renamed to this
 *   (vllm-project/vllm#27752) and its request side accepts ONLY this name
 *   (vllm-project/vllm#38488).
 *
 * Inbound we accept any of them via a priority scan; outbound we echo back the
 * dialect the peer actually spoke, learned per endpoint by ReasoningKeyDialect.
 */

import type { StreamedMessagePart, ThinkPart } from '#/kosong/contract/message';

// Inbound scan order; the first entry doubles as the default outbound dialect
// before any observation. Both arms can be pinned by an explicit key (see
// ReasoningKeyDialect).
export const KNOWN_REASONING_KEYS = [
  'reasoning_content',
  'reasoning_details',
  'reasoning',
] as const;

export type ReasoningKey = (typeof KNOWN_REASONING_KEYS)[number];

export const DEFAULT_REASONING_KEY: ReasoningKey = KNOWN_REASONING_KEYS[0];

export function extractReasoning(
  source: unknown,
  explicitKey?: string,
): { key: string; value: string } | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const record = source as Record<string, unknown>;
  const keys: readonly string[] = explicitKey !== undefined ? [explicitKey] : KNOWN_REASONING_KEYS;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return { key, value };
  }
  return undefined;
}

export class ReasoningKeyDialect {
  private _detected: string | undefined;

  constructor(private readonly _explicitKey?: string) {}

  hasExplicitKey(): boolean {
    return this._explicitKey !== undefined;
  }

  observe(source: unknown): string | undefined {
    const found = extractReasoning(source, this._explicitKey);
    if (found === undefined) return undefined;
    if (this._explicitKey === undefined) {
      this._detected = found.key;
    }
    return found.value;
  }

  outboundKey(): string {
    return this._explicitKey ?? this._detected ?? DEFAULT_REASONING_KEY;
  }
}

export const REASONING_DETAILS_KEY = 'reasoning_details';

export interface ReasoningDetailsElement {
  readonly type?: string;
  readonly index: number;
  readonly summary?: string;
  readonly encrypted?: string;
}

function toReasoningDetailsElement(
  value: unknown,
  position: number,
): ReasoningDetailsElement | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const type = typeof record['type'] === 'string' ? record['type'] : undefined;
  if (type !== undefined && type !== 'summary' && type !== 'encrypted') return undefined;
  const index = typeof record['index'] === 'number' ? record['index'] : position;
  const summary = typeof record['summary'] === 'string' ? record['summary'] : undefined;
  const encrypted = typeof record['encrypted'] === 'string' ? record['encrypted'] : undefined;
  return { type, index, summary, encrypted };
}

export function extractReasoningDetails(
  source: unknown,
): ReasoningDetailsElement[] | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const value = (source as Record<string, unknown>)[REASONING_DETAILS_KEY];
  if (!Array.isArray(value)) return undefined;
  const elements: ReasoningDetailsElement[] = [];
  for (const [position, item] of value.entries()) {
    const element = toReasoningDetailsElement(item, position);
    if (element !== undefined) elements.push(element);
  }
  return elements;
}

export function convertReasoningDetails(
  elements: readonly ReasoningDetailsElement[],
): StreamedMessagePart[] {
  const parts: StreamedMessagePart[] = [];
  for (const element of elements) {
    if (element.type !== 'encrypted' && element.summary !== undefined && element.summary.length > 0) {
      parts.push({ type: 'think', think: element.summary, detailsIndex: element.index } satisfies ThinkPart);
    }
    if (element.type !== 'summary' && element.encrypted !== undefined && element.encrypted.length > 0) {
      parts.push({
        type: 'think',
        think: '',
        encrypted: element.encrypted,
        detailsIndex: element.index,
      } satisfies ThinkPart);
    }
  }
  return parts;
}
