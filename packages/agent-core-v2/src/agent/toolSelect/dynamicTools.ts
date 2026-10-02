/**
 * `toolSelect` domain — predicates and shaping helpers for the
 * select_tools progressive-disclosure protocol context.
 *
 * Exposes pure helpers for recognizing injected tool-schema messages,
 * folding loadable-tool announcements and bounded purpose excerpts, rendering announcement text, and
 * stripping dynamic-tool protocol context from an outgoing history view.
 *
 * Two kinds of messages carry the protocol state in the history:
 *   - dynamic tool schema messages: `role: 'system'` messages whose `tools`
 *     field holds full tool definitions (origin
 *     `{kind: 'injection', variant: 'dynamic_tool_schema'}`) — tool loading is
 *     protocol context, not conversation. v2's undo cuts histories at the
 *     first real user prompt it finds regardless of origin: schema messages
 *     survive only when the cut lands before them.
 *   - loadable-tools announcements: `<tools_added>/<tools_removed>` system
 *     reminders (origin `{kind: 'injection', variant: 'loadable-tools'}`;
 *     legacy journals used `{kind: 'system_trigger', name: 'loadable-tools'}`
 *     and both are folded) — the next turn-boundary diff self-heals by
 *     re-announcing the folded delta whenever the ledger drifts.
 *
 * The loaded-tool ledger is the history itself: there is deliberately no
 * separate persisted ledger, so undo/compaction/resume all self-heal by
 * re-folding. Everything here anchors on `origin` or the `tools` field, so
 * callers that need to filter MUST run before `project()` — projection
 * strips `origin`.
 */

import type { ContextMessage } from '#/agent/contextMemory/types';

export const DYNAMIC_TOOL_SCHEMA_VARIANT = 'dynamic_tool_schema';

export const LOADABLE_TOOLS_VARIANT = 'loadable-tools';

export function isDynamicToolSchemaMessage(message: ContextMessage): boolean {
  return message.tools !== undefined && message.tools.length > 0;
}

export function isLoadableToolsAnnouncement(message: ContextMessage): boolean {
  const origin = message.origin;
  if (origin?.kind === 'injection') return origin.variant === LOADABLE_TOOLS_VARIANT;
  return origin?.kind === 'system_trigger' && origin.name === LOADABLE_TOOLS_VARIANT;
}

export function stripDynamicToolContext(
  history: readonly ContextMessage[],
): readonly ContextMessage[] {
  if (!history.some((m) => isDynamicToolSchemaMessage(m) || isLoadableToolsAnnouncement(m))) {
    return history;
  }
  const out: ContextMessage[] = [];
  for (const message of history) {
    if (isLoadableToolsAnnouncement(message)) continue;
    if (isDynamicToolSchemaMessage(message)) {
      const stripped = stripToolSchemasFromMessage(message);
      if (stripped !== undefined) out.push(stripped);
      continue;
    }
    out.push(message);
  }
  return out;
}

export function stripToolSchemaContext(
  history: readonly ContextMessage[],
): readonly ContextMessage[] {
  if (!history.some(isDynamicToolSchemaMessage)) return history;
  return history.flatMap((message) => {
    if (!isDynamicToolSchemaMessage(message)) return [message];
    const stripped = stripToolSchemasFromMessage(message);
    return stripped === undefined ? [] : [stripped];
  });
}

export function stripToolSchemasFromMessage(message: ContextMessage): ContextMessage | undefined {
  const { tools: _tools, ...rest } = message;
  void _tools;
  if (rest.role === 'system' && rest.content.length === 0 && rest.toolCalls.length === 0 &&
      rest.toolCallId === undefined && rest.providerMessageId === undefined &&
      rest.partial === undefined && rest.name === undefined) return undefined;
  return rest;
}

export function collectLoadedDynamicToolNames(
  history: readonly ContextMessage[],
): Set<string> {
  const names = new Set<string>();
  for (const message of history) {
    if (message.tools === undefined) continue;
    for (const tool of message.tools) {
      names.add(tool.name);
    }
  }
  return names;
}

const TOOLS_ADDED_BLOCK = /<tools_added>\n?([\s\S]*?)\n?<\/tools_added>/g;
const TOOLS_REMOVED_BLOCK = /<tools_removed>\n?([\s\S]*?)\n?<\/tools_removed>/g;
const TOOL_PURPOSES_BLOCK = /<tool_purposes>\n?([\s\S]*?)\n?<\/tool_purposes>/g;

export interface ToolPurpose {
  readonly name: string;
  readonly purpose: string;
}

export function summarizeToolPurpose(description: string): string {
  const paragraph = description.split(/\n\s*\n/).find(
    (part) => part.trim().length > 0 && !/^\s*#{1,6}\s+[^\n]+$/.test(part),
  ) ?? description;
  const compact = paragraph.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) return 'No description provided; load the definition to inspect its inputs.';
  return compact.length > 200 ? `${compact.slice(0, 199)}…` : compact;
}

export function foldAnnouncedToolPurposes(history: readonly ContextMessage[]): Map<string, string> {
  const purposes = new Map<string, string>();
  for (const message of history) {
    if (!isLoadableToolsAnnouncement(message)) continue;
    const text = message.content.map((part) => part.type === 'text' ? part.text : '').join('');
    for (const name of matchToolNameBlocks(text, TOOLS_REMOVED_BLOCK)) purposes.delete(name);
    TOOL_PURPOSES_BLOCK.lastIndex = 0;
    for (const match of text.matchAll(TOOL_PURPOSES_BLOCK)) {
      for (const line of (match[1] ?? '').split('\n')) {
        try {
          const value: unknown = JSON.parse(line);
          if (value !== null && typeof value === 'object' && 'name' in value && 'purpose' in value &&
              typeof value.name === 'string' && typeof value.purpose === 'string') {
            purposes.set(value.name, value.purpose);
          }
        } catch {
          continue;
        }
      }
    }
  }
  return purposes;
}

export function foldAnnouncedToolNames(history: readonly ContextMessage[]): Set<string> {
  const announced = new Set<string>();
  for (const message of history) {
    if (!isLoadableToolsAnnouncement(message)) continue;
    const text = message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
    for (const name of matchToolNameBlocks(text, TOOLS_REMOVED_BLOCK)) {
      announced.delete(name);
    }
    for (const name of matchToolNameBlocks(text, TOOLS_ADDED_BLOCK)) {
      announced.add(name);
    }
  }
  return announced;
}

function matchToolNameBlocks(text: string, pattern: RegExp): string[] {
  const names: string[] = [];
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const body = match[1] ?? '';
    for (const line of body.split('\n')) {
      const name = line.trim();
      if (name.length > 0) names.push(name);
    }
  }
  return names;
}

export function renderLoadableToolsAnnouncement(
  added: readonly string[],
  removed: readonly string[],
  purposes: readonly ToolPurpose[] = [],
): string {
  const sections: string[] = [];
  if (added.length > 0) {
    sections.push(`<tools_added>\n${added.join('\n')}\n</tools_added>`);
  }
  if (removed.length > 0) {
    sections.push(`<tools_removed>\n${removed.join('\n')}\n</tools_removed>`);
  }
  if (purposes.length > 0) {
    const entries = purposes.map((entry) => JSON.stringify(entry).replace(/</g, '\\u003c').replace(/>/g, '\\u003e'));
    sections.push(`<tool_purposes>\n${entries.join('\n')}\n</tool_purposes>`);
  }
  sections.push(
    'Use the select_tools tool with exact names to load full tool definitions before calling them. ' +
      'Names listed as removed are no longer loadable — do not select them. ' +
      'Fold all announcements in this conversation in order to get the current list.',
  );
  return sections.join('\n\n');
}
