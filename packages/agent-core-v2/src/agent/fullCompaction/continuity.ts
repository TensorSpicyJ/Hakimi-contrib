/**
 * `fullCompaction` domain — prepares conservative, provider-neutral handoff input.
 *
 * Uses `contextMemory` message origins to protect instructions and prior handoffs.
 * Only plain text without provider identity is reduced; original history and
 * assistant reasoning are never rewritten. Shrink retries remove whole exchanges
 * and retain instructions, Skill exchanges, the latest tool exchange, and the
 * two newest groups of messages, or report no progress.
 */

import type { ContextMessage } from '#/agent/contextMemory/types';

export interface ContinuityPreparation {
  readonly messages: readonly ContextMessage[];
  readonly duplicateReminderCount: number;
  readonly repeatedToolLineCount: number;
}

export function prepareContinuityHistory(history: readonly ContextMessage[]): ContinuityPreparation {
  const messages: ContextMessage[] = [];
  const skillCallIds = new Set(history.flatMap((message) =>
    message.toolCalls.filter((call) => call.name === 'Skill').map((call) => call.id)));
  let duplicateReminderCount = 0;
  let repeatedToolLineCount = 0;
  for (const message of history) {
    const previous = messages.at(-1);
    if (previous !== undefined && identicalAdjacentReminder(previous, message)) {
      duplicateReminderCount += 1;
      continue;
    }
    if (message.role !== 'tool' || !hasPlainTextOnly(message) ||
      (message.toolCallId !== undefined && skillCallIds.has(message.toolCallId))) {
      messages.push(message);
      continue;
    }
    let removed = 0;
    const content = message.content.map((part) => {
      if (part.type !== 'text') return part;
      const lines = part.text.split('\n');
      const result: string[] = [];
      for (let start = 0; start < lines.length;) {
        let end = start + 1;
        while (end < lines.length && lines[end] === lines[start]) end += 1;
        const count = end - start;
        const marker = `[previous line repeated ${String(count - 1)} more times]`;
        if (count >= 4 && marker.length < (lines[start]!.length + 1) * (count - 1)) {
          result.push(lines[start]!, marker);
          removed += count - 1;
        } else {
          result.push(...lines.slice(start, end));
        }
        start = end;
      }
      return removed === 0 ? part : { ...part, text: result.join('\n') };
    });
    repeatedToolLineCount += removed;
    messages.push(removed === 0 ? message : { ...message, content });
  }
  return { messages, duplicateReminderCount, repeatedToolLineCount };
}

export function shrinkContinuityHistory(
  messages: readonly ContextMessage[],
  tokenBudget: number,
  estimateMessage: (message: ContextMessage) => number,
): readonly ContextMessage[] {
  const groups: ContextMessage[][] = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    const group = [message];
    index += 1;
    if (message.role === 'assistant' && message.toolCalls.length > 0) {
      const pending = new Set(message.toolCalls.map((call) => call.id));
      while (index < messages.length && pending.size > 0) {
        const next = messages[index]!;
        group.push(next);
        index += 1;
        if (next.role === 'tool' && next.toolCallId !== undefined) pending.delete(next.toolCallId);
      }
      if (pending.size > 0) return messages;
    }
    groups.push(group);
  }
  let tokens = messages.reduce((sum, message) => sum + estimateMessage(message), 0);
  const latestToolGroupIndex = groups.findLastIndex((group) =>
    group[0]?.role === 'assistant' && group[0].toolCalls.length > 0);
  let removed = false;
  const retained = groups.filter((group, index) => {
    const protectedGroup = index >= groups.length - 2 || index === latestToolGroupIndex || group.some((message) =>
      message.role === 'user' || message.role === 'system' ||
      message.toolCalls.some((call) => call.name === 'Skill') ||
      (message.role === 'tool' && group[0]?.role !== 'assistant'));
    if (protectedGroup || (removed && tokens <= tokenBudget)) return true;
    tokens -= group.reduce((sum, message) => sum + estimateMessage(message), 0);
    removed = true;
    return false;
  });
  return removed ? retained.flat() : messages;
}

function hasPlainTextOnly(message: ContextMessage): boolean {
  return message.providerMessageId === undefined && message.tools === undefined &&
    message.toolCalls.length === 0 && message.partial !== true &&
    message.content.every((part) => part.type === 'text' &&
      Object.keys(part).every((key) => key === 'type' || key === 'text'));
}

function identicalAdjacentReminder(left: ContextMessage, right: ContextMessage): boolean {
  return left.role === 'user' && right.role === 'user' &&
    left.origin?.kind === 'injection' && right.origin?.kind === 'injection' &&
    left.origin.variant === right.origin.variant &&
    left.origin.ownerPromptId === right.origin.ownerPromptId &&
    left.origin.disclosure === undefined && right.origin.disclosure === undefined &&
    hasPlainTextOnly(left) && hasPlainTextOnly(right) &&
    JSON.stringify(left.content) === JSON.stringify(right.content);
}
