/**
 * `kosong/contract` domain — wire message shapes and their pure helpers.
 *
 * `Message` / `ContentPart` / `ToolCall` are the provider-agnostic wire
 * content every protocol base encodes from and decodes into. The helpers
 * cover the whole lifecycle: construction (`create*Message`), inspection
 * (`is*` / `extractText`), and stream merge (`mergeInPlace` folds streamed
 * deltas into the pending part).
 *
 * A `text` / `think` part may carry `openaiResponses` — provider-private
 * replay metadata (`itemId` = the server-minted output-item id, `phase` = the
 * message phase the backend reported, `contentType` = a refusal content tag)
 * that only the Responses base writes and reads back; every other provider
 * sees an ordinary part and ignores it. Metadata describes only server-sent
 * items and content.
 *
 * `mergeInPlace` treats a declared Responses identity as a boundary. Two parts
 * merge only when their declared item ids agree — a part with no declared id
 * has its own identity rather than acting as a wildcard, so an anonymous part
 * is never folded into a server-named item (nor the reverse) — and two
 * declared phases must agree. Refusal text remains separate from ordinary
 * output text even within the same item. Metadata objects are shared by
 * reference, never cloned, so a late `itemId` / `phase` update stays visible
 * on a part that was already flushed into the message.
 *
 * A late Responses update (`isLateResponsesPart`) is a body-less `text` /
 * `think` part that only carries an item id plus a newly learned phase or
 * encrypted content. It is delivered as a real part so every consumer sees it
 * — including consumers holding a copy of the streamed parts rather than the
 * live objects — and `applyLateResponsesPart` / `applyLateResponsesPartTo`
 * fold it into the part already accumulated for that same declared item,
 * wherever it sits: never a duplicate item, an empty message, or a stray
 * item id without its payload.
 *
 * Pure types and pure functions only — no other domain, no I/O, no SDKs.
 */

import type { Tool } from './tool';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface OpenAIResponsesPartMetadata {
  itemId?: string;
  phase?: string;
  contentType?: 'refusal';
}

export interface TextPart {
  type: 'text';
  text: string;
  openaiResponses?: OpenAIResponsesPartMetadata;
}

export interface ThinkPart {
  type: 'think';
  think: string;
  encrypted?: string;
  openaiResponses?: OpenAIResponsesPartMetadata;
}

export interface ImageURLPart {
  type: 'image_url';
  imageUrl: { url: string; id?: string };
}

export interface AudioURLPart {
  type: 'audio_url';
  audioUrl: { url: string; id?: string };
}

export interface VideoURLPart {
  type: 'video_url';
  videoUrl: { url: string; id?: string | undefined };
}

export type ContentPart = TextPart | ThinkPart | ImageURLPart | AudioURLPart | VideoURLPart;

export interface ToolCall {
  type: 'function';
  id: string;
  name: string;
  arguments: string | null;
  extras?: Record<string, unknown>;
  _streamIndex?: number | string;
}

export interface ToolCallPart {
  type: 'tool_call_part';
  argumentsPart: string | null;
  index?: number | string;
}

export type StreamedMessagePart = ContentPart | ToolCall | ToolCallPart;

export interface Message {
  readonly role: Role;
  readonly name?: string;
  readonly content: ContentPart[];
  readonly toolCalls: ToolCall[];
  readonly toolCallId?: string;
  readonly partial?: boolean;
  readonly tools?: readonly Tool[];
}

export function isContentPart(part: StreamedMessagePart): part is ContentPart {
  const t = part.type;
  return (
    t === 'text' || t === 'think' || t === 'image_url' || t === 'audio_url' || t === 'video_url'
  );
}

export function isToolDeclarationOnlyMessage(message: Message): boolean {
  return (
    message.tools !== undefined &&
    message.tools.length > 0 &&
    message.content.length === 0 &&
    message.toolCalls.length === 0
  );
}

export function isToolCall(part: StreamedMessagePart): part is ToolCall {
  return part.type === 'function';
}

export function isToolCallPart(part: StreamedMessagePart): part is ToolCallPart {
  return part.type === 'tool_call_part';
}

function declaredResponsesItemId(part: TextPart | ThinkPart): string | undefined {
  return part.openaiResponses?.itemId;
}

function sharesResponsesItem(target: TextPart | ThinkPart, source: TextPart | ThinkPart): boolean {
  if (target.openaiResponses?.contentType !== source.openaiResponses?.contentType) return false;
  const targetId = declaredResponsesItemId(target);
  if (targetId !== declaredResponsesItemId(source)) return false;
  const targetPhase = target.openaiResponses?.phase;
  const sourcePhase = source.openaiResponses?.phase;
  return targetPhase === undefined || sourcePhase === undefined || targetPhase === sourcePhase;
}

function mergeResponsesMetadata(target: TextPart | ThinkPart, source: TextPart | ThinkPart): void {
  const from = source.openaiResponses;
  if (from === undefined) return;
  const into = target.openaiResponses;
  if (into === undefined) {
    target.openaiResponses = from;
    return;
  }
  into.itemId ??= from.itemId;
  into.phase ??= from.phase;
}

export function isLateResponsesPart(update: StreamedMessagePart): update is TextPart | ThinkPart {
  if (update.type !== 'text' && update.type !== 'think') return false;
  if (update.openaiResponses?.itemId === undefined) return false;
  return update.type === 'text' ? update.text === '' : update.think === '';
}

export function applyLateResponsesPart(
  target: StreamedMessagePart,
  update: StreamedMessagePart,
): boolean {
  if (!isLateResponsesPart(update)) return false;
  if (target.type !== update.type) return false;
  if (target.type !== 'text' && target.type !== 'think') return false;
  const itemId = update.openaiResponses?.itemId;
  if (itemId === undefined || target.openaiResponses?.itemId !== itemId) return false;
  if (target.type === 'think' && update.type === 'think' && update.encrypted !== undefined) {
    target.encrypted ??= update.encrypted;
  }
  mergeResponsesMetadata(target, update);
  return true;
}

export function applyLateResponsesPartTo(
  parts: ContentPart[],
  update: StreamedMessagePart,
): boolean {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const target = parts[index];
    if (target !== undefined && applyLateResponsesPart(target, update)) return true;
  }
  return false;
}

export function mergeInPlace(target: StreamedMessagePart, source: StreamedMessagePart): boolean {
  if (target.type === 'text' && source.type === 'text') {
    if (!sharesResponsesItem(target, source)) {
      return false;
    }
    target.text += source.text;
    mergeResponsesMetadata(target, source);
    return true;
  }

  if (target.type === 'think' && source.type === 'think') {
    if (!sharesResponsesItem(target, source)) {
      return false;
    }
    if (target.encrypted !== undefined) {
      return false;
    }
    target.think += source.think;
    if (source.encrypted !== undefined) {
      target.encrypted = source.encrypted;
    }
    mergeResponsesMetadata(target, source);
    return true;
  }

  if (target.type === 'function' && source.type === 'tool_call_part') {
    if (source.argumentsPart !== null) {
      target.arguments =
        target.arguments === null
          ? source.argumentsPart
          : target.arguments + source.argumentsPart;
    }
    return true;
  }

  return false;
}

export function extractText(message: Message, sep: string = ''): string {
  return message.content
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join(sep);
}

export function getTextContent(message: Message): string {
  return extractText(message);
}

export function createUserMessage(content: string): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text: content }],
    toolCalls: [],
  };
}

export function createAssistantMessage(content: ContentPart[], toolCalls?: ToolCall[]): Message {
  return {
    role: 'assistant',
    content,
    toolCalls: toolCalls ?? [],
  };
}

export function createToolMessage(toolCallId: string, output: string | ContentPart[]): Message {
  const content: ContentPart[] =
    typeof output === 'string' ? [{ type: 'text', text: output }] : output;
  return {
    role: 'tool',
    content,
    toolCalls: [],
    toolCallId,
  };
}
