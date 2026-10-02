/** Host-side evidence at the actual Responses request boundary. This proves
 * what the model is offered, not an internal registry barrier or tool success. */
import { createHash } from 'node:crypto';

export interface McpRequestInspectionOptions {
  readonly catalog: boolean;
  readonly requiredTool: string;
}

export interface McpRequestInspection {
  readonly ready: boolean;
  readonly reason: 'schema-visible' | 'catalog-loadable' | 'missing-schema' | 'malformed-schema' | 'missing-selector' | 'incomplete-history' | 'not-in-catalog';
  readonly requiredTool: string;
  readonly catalog: boolean;
  readonly toolNames: readonly string[];
  /** Required-tool schema when visible, otherwise the valid selector schema. */
  readonly schemaHash?: string;
  readonly catalogEvidence?: {
    readonly currentlyListed: boolean;
    readonly announcements: readonly { inputIndex: number; added: boolean; removed: boolean; textHash: string }[];
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = record(value);
  if (object) return `{${Object.keys(object).toSorted().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

function objectParameters(tool: Record<string, unknown>): Record<string, unknown> | undefined {
  if (tool['type'] !== 'function' || typeof tool['name'] !== 'string') return undefined;
  const parameters = record(tool['parameters']);
  if (parameters?.['type'] !== 'object' || !record(parameters['properties'])) return undefined;
  const required = parameters['required'];
  if (required !== undefined && (!Array.isArray(required) || required.some((key) => typeof key !== 'string' || !Object.hasOwn(parameters['properties'] as object, key)))) return undefined;
  return parameters;
}

function onlyKeys(object: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(object).every((key) => keys.includes(key));
}

/** This is deliberately a narrow frozen-fixture schema check, not a general
 * JSON Schema interpreter. Unknown constraints (enum/const/$ref/allOf/etc.)
 * fail closed rather than silently accepting a non-callable fixture. */
function fixedObjectField(parameters: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  if (!onlyKeys(parameters, ['$schema', 'type', 'properties', 'required', 'additionalProperties', 'description', 'title'])) return undefined;
  if (parameters['additionalProperties'] !== undefined && typeof parameters['additionalProperties'] !== 'boolean') return undefined;
  const properties = record(parameters['properties']);
  if (!properties || Object.keys(properties).length !== 1 || !Object.hasOwn(properties, name)) return undefined;
  if (!Array.isArray(parameters['required']) || parameters['required'].length !== 1 || parameters['required'][0] !== name) return undefined;
  return record(properties[name]);
}

function unrestrictedString(value: unknown): boolean {
  const schema = record(value);
  return schema?.['type'] === 'string' && onlyKeys(schema, ['type', 'description', 'title']);
}

function selectorSchema(tool: Record<string, unknown>): boolean {
  const parameters = objectParameters(tool);
  const names = parameters === undefined ? undefined : fixedObjectField(parameters, 'names');
  return names?.['type'] === 'array' && onlyKeys(names, ['type', 'description', 'title', 'items', 'minItems']) && unrestrictedString(names['items']) &&
    (names['minItems'] === undefined || typeof names['minItems'] === 'number' && Number.isInteger(names['minItems']) && names['minItems'] >= 0 && names['minItems'] <= 1);
}

function isRequiredSchema(tool: Record<string, unknown>): boolean {
  const parameters = objectParameters(tool);
  if (!parameters) return false;
  // This benchmark's fixed MCP fixture has a required string key. Do not certify
  // a name-only declaration or an unrelated schema as its callable definition.
  if (tool['name'] === 'mcp__bench__lookup') {
    return unrestrictedString(fixedObjectField(parameters, 'key'));
  }
  return true;
}

function announcementText(value: unknown): string | undefined {
  const message = record(value);
  if (message?.['role'] !== 'user') return undefined;
  if (message['type'] !== undefined && message['type'] !== 'message') return undefined;
  const content = message['content'];
  let text: string | undefined;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content) && content.length === 1) {
    const part = record(content[0]);
    if ((part?.['type'] === 'input_text' || part?.['type'] === 'text') && typeof part['text'] === 'string') text = part['text'];
  }
  const trimmed = text?.trim();
  if (!trimmed?.startsWith('<system-reminder>\n') || !trimmed.endsWith('\n</system-reminder>')) return undefined;
  if (!trimmed.includes('Use the select_tools tool with exact names to load full tool definitions before calling them.') ||
    !trimmed.includes('Fold all announcements in this conversation in order to get the current list.')) return undefined;
  return trimmed;
}

function namesIn(text: string, kind: 'added' | 'removed'): string[] {
  const pattern = new RegExp(`<tools_${kind}>\\n?([\\s\\S]*?)\\n?</tools_${kind}>`, 'g');
  return [...text.matchAll(pattern)].flatMap((match) => (match[1] ?? '').split('\n').map((name) => name.trim()).filter(Boolean));
}

/** Stateless inspection of one actual request; this helper cannot identify its
 * agent. The host uses a latched check on the first request of a fresh F02 main
 * turn, before tools can delegate to agents with different tool policies. There
 * is no empty-tools/compaction exemption. A missing or unsupported request shape
 * fails closed before upstream dispatch; callers must not misapply the main
 * agent's MCP requirement to later child requests.
 *
 * Catalog evidence is restricted to the runtime's complete user-role reminder
 * envelope and folded in history order. Arbitrary mentions, tool output, and
 * assistant claims cannot establish readiness. The host owns the frozen input
 * prompt, which must not impersonate this envelope. No internal service access
 * or trust in connected/toolCount is involved. */
export function inspectMcpRequest(body: Readonly<Record<string, unknown>>, options: McpRequestInspectionOptions): McpRequestInspection {
  if (!/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(options.requiredTool) || typeof options.catalog !== 'boolean') throw new Error('Invalid MCP request inspection contract');
  const tools: Record<string, unknown>[] = [];
  if (Array.isArray(body['tools'])) for (const value of body['tools']) {
    const tool = record(value);
    if (tool) tools.push(tool);
  }
  const toolNames = tools.flatMap((tool) => typeof tool['name'] === 'string' ? [tool['name']] : []).toSorted();
  const base = { requiredTool: options.requiredTool, catalog: options.catalog, toolNames };
  const required = tools.filter((tool) => tool['name'] === options.requiredTool);
  if (required.length > 0) {
    const tool = required[0];
    if (required.length !== 1 || tool === undefined || !isRequiredSchema(tool)) return { ...base, ready: false, reason: 'malformed-schema' };
    return { ...base, ready: true, reason: 'schema-visible', schemaHash: hash(tool) };
  }
  if (!options.catalog) return { ...base, ready: false, reason: 'missing-schema' };
  const selectors = tools.filter((tool) => tool['name'] === 'select_tools');
  const selector = selectors[0];
  if (selectors.length !== 1 || selector === undefined || !selectorSchema(selector)) return { ...base, ready: false, reason: 'missing-selector' };
  if (!Array.isArray(body['input']) || body['previous_response_id'] !== undefined && body['previous_response_id'] !== null) {
    return { ...base, ready: false, reason: 'incomplete-history' };
  }
  let currentlyListed = false;
  const announcements: { inputIndex: number; added: boolean; removed: boolean; textHash: string }[] = [];
  for (const [inputIndex, input] of body['input'].entries()) {
    const text = announcementText(input);
    if (text === undefined) continue;
    const removed = namesIn(text, 'removed').includes(options.requiredTool);
    const added = namesIn(text, 'added').includes(options.requiredTool);
    // Match the engine's fold: remove, then add for each announcement message.
    if (removed) currentlyListed = false;
    if (added) currentlyListed = true;
    if (added || removed) announcements.push({ inputIndex, added, removed, textHash: hash(text) });
  }
  return { ...base, ready: currentlyListed, reason: currentlyListed ? 'catalog-loadable' : 'not-in-catalog',
    schemaHash: hash(selectors[0]), catalogEvidence: { currentlyListed, announcements } };
}
