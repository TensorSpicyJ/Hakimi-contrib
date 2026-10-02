/**
 * `applyPatch` domain — pure Codex patch parsing and text updates.
 *
 * Accepts Add, Update and Delete sections with ordered context-based hunks.
 * Updates use the edit domain's TextModel to preserve LF / CRLF files;
 * ambiguous context and mixed line endings fail without changing text.
 */

import { TextModel } from '#/app/edit/textModel';

export interface PatchHunk {
  readonly anchors: readonly string[];
  readonly lines: readonly string[];
  readonly endOfFile: boolean;
}

export type PatchOperation =
  | { readonly type: 'add'; readonly path: string; readonly content: string }
  | { readonly type: 'update'; readonly path: string; readonly hunks: readonly PatchHunk[] }
  | { readonly type: 'delete'; readonly path: string };

export type PatchResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export function parsePatch(input: string): PatchResult<readonly PatchOperation[]> {
  const lines = input.replaceAll('\r\n', '\n').split('\n');
  while (lines.at(-1) === '') lines.pop();
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') {
    return { ok: false, error: 'Patch must start with *** Begin Patch and end with *** End Patch.' };
  }
  const operations: PatchOperation[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[index]!);
    if (header === null) return { ok: false, error: `Invalid patch header at line ${String(index + 1)}.` };
    const path = header[2]!;
    if (path.trim() !== path || path.includes('\0') || path.includes('\r')) {
      return { ok: false, error: 'Patch paths must be nonblank paths without control characters.' };
    }
    index += 1;
    const body: string[] = [];
    while (index < lines.length - 1 && !lines[index]!.startsWith('*** ')) {
      body.push(lines[index]!);
      index += 1;
    }
    if (header[1] === 'Add') {
      if (body.some((line) => !line.startsWith('+'))) {
        return { ok: false, error: `Every added line in ${path} must start with +.` };
      }
      operations.push({ type: 'add', path, content: body.length === 0 ? '' : body.map((line) => line.slice(1)).join('\n') + '\n' });
    } else if (header[1] === 'Delete') {
      if (body.length > 0) return { ok: false, error: `Delete File ${path} must not contain a body.` };
      operations.push({ type: 'delete', path });
    } else {
      if (lines[index] === '*** End of File') {
        body.push('*** End of File');
        index += 1;
      }
      const parsed = parseHunks(body, path);
      if (!parsed.ok) return parsed;
      operations.push({ type: 'update', path, hunks: parsed.value });
    }
  }
  return operations.length === 0
    ? { ok: false, error: 'Patch contains no file operations.' }
    : { ok: true, value: operations };
}

function parseHunks(body: readonly string[], path: string): PatchResult<readonly PatchHunk[]> {
  const hunks: PatchHunk[] = [];
  let anchors: string[] = [];
  let lines: string[] = [];
  let endOfFile = false;
  const flush = (): void => {
    if (lines.length === 0) return;
    hunks.push({ anchors, lines, endOfFile });
    anchors = [];
    lines = [];
    endOfFile = false;
  };
  for (const line of body) {
    if (endOfFile) return { ok: false, error: `No hunk may follow *** End of File in ${path}.` };
    if (line === '@@' || line.startsWith('@@ ')) {
      flush();
      if (line.length > 3) anchors.push(line.slice(3));
    } else if (line === '*** End of File') {
      endOfFile = true;
    } else if (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-')) {
      lines.push(line);
    } else {
      return { ok: false, error: `Invalid hunk line in ${path}: lines must start with a space, +, or -.` };
    }
  }
  if (lines.length === 0) return { ok: false, error: `Update File ${path} has an empty hunk.` };
  flush();
  if (hunks.some((hunk) => !hunk.lines.some((line) => line.startsWith('+') || line.startsWith('-')))) {
    return { ok: false, error: `Update File ${path} contains a hunk without changes.` };
  }
  return { ok: true, value: hunks };
}

export function applyUpdate(raw: string, operation: Extract<PatchOperation, { type: 'update' }>): PatchResult<string> {
  const model = new TextModel(raw);
  if (model.lineEndingStyle === 'mixed') {
    return { ok: false, error: `${operation.path} has mixed line endings; use Edit with exact raw content.` };
  }
  const lines = model.text.length === 0 ? [] : model.text.split('\n');
  const trailingNewline = model.text.endsWith('\n');
  if (trailingNewline) lines.pop();
  let cursor = 0;
  const output: string[] = [];
  for (const [ordinal, hunk] of operation.hunks.entries()) {
    let searchFrom = cursor;
    for (const anchor of hunk.anchors) {
      const anchorStart = searchFrom;
      const found = lines.findIndex((line, index) => index >= anchorStart && line.trim() === anchor.trim());
      if (found < 0) return { ok: false, error: `Context ${JSON.stringify(anchor)} not found in ${operation.path}.` };
      searchFrom = found + 1;
    }
    const before = hunk.lines.filter((line) => !line.startsWith('+')).map((line) => line.slice(1));
    const after = hunk.lines.filter((line) => !line.startsWith('-')).map((line) => line.slice(1));
    const candidates: number[] = [];
    if (before.length === 0) {
      candidates.push(hunk.endOfFile || hunk.anchors.length === 0 ? lines.length : searchFrom);
    } else {
      for (let at = searchFrom; at <= lines.length - before.length; at += 1) {
        if (hunk.endOfFile && at + before.length !== lines.length) continue;
        if (before.every((line, offset) => line === lines[at + offset])) candidates.push(at);
      }
    }
    if (candidates.length !== 1) {
      return {
        ok: false,
        error: candidates.length === 0
          ? `Hunk ${String(ordinal + 1)} does not match ${operation.path}. Read the current file and retry.`
          : `Hunk ${String(ordinal + 1)} is ambiguous in ${operation.path}. Include more context.`,
      };
    }
    const at = candidates[0]!;
    output.push(...lines.slice(cursor, at), ...after);
    cursor = at + before.length;
  }
  output.push(...lines.slice(cursor));
  const text = output.join('\n') + (output.length > 0 && (trailingNewline || raw.length === 0) ? '\n' : '');
  return { ok: true, value: model.materialize(text) };
}
