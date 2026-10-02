// apps/kimi-web/src/lib/startSessionResult.ts
// Parser for the `StartSession` (cross-project handoff) tool result. The tool
// renders a `<session_handoff session_id="…" workspace_id="…" work_dir="…"
// status="…">` block; the Web client only needs enough of it to offer a link
// into the started session. Pure and defensive — an unrecognised shape yields
// an empty result rather than throwing.

export interface StartSessionResult {
  /** Real id of the session the handoff created, when the tool reported one. */
  sessionId?: string;
  /** Target project directory the new session runs in. */
  workDir?: string;
  /** `running` | `pending` | `completed` | `blocked` | `failed` | `aborted`. */
  status?: string;
  /** Set when the handoff reported an error (`error="…"`). */
  error?: string;
}

/** Decode the XML entities the tool escapes attribute values with. */
function unescapeAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/** Attribute name → result field, for the `<session_handoff>` opening tag. */
const ATTRIBUTES: Record<string, (result: StartSessionResult, value: string) => void> = {
  session_id: (result, value) => (result.sessionId ??= value),
  work_dir: (result, value) => (result.workDir ??= value),
  status: (result, value) => (result.status ??= value),
  error: (result, value) => (result.error ??= value),
};

const ATTRIBUTE_PATTERN = /(\w+)="([^"]*)"/g;

export function parseStartSessionResult(output?: readonly string[]): StartSessionResult {
  const result: StartSessionResult = {};
  if (!output || output.length === 0) return result;
  // Read only the opening tag, never attribute-looking text in an error or body.
  const openingTag = /^\s*<session_handoff\b([^>]*)>/.exec(output.join('\n'));
  if (openingTag === null) return result;
  for (const match of (openingTag[1] ?? '').matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1] ?? '';
    if (!Object.hasOwn(ATTRIBUTES, name)) continue;
    const value = unescapeAttribute(match[2] ?? '');
    if (value.length > 0) ATTRIBUTES[name]?.(result, value);
  }
  return result;
}
