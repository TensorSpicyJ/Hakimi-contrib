/**
 * `research` domain — bounded discovery of ordinary AITP topic files.
 *
 * Reads workspace content through hostFileSystem without an index, metadata
 * schema, background writer or prescribed research-note headings.
 */

import { basename, dirname, isAbsolute, join, relative, resolve } from 'pathe';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { unwrapErrorCause } from '#/_base/errors/errors';
import type { ResearchNote, ResearchSnapshot, ResearchTopic } from './research';

const MAX_NOTE_BYTES = 256 * 1024;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', '__pycache__']);

export function withinResearchRoot(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}

export async function readResearchNote(
  fs: IHostFileSystem,
  path: string,
): Promise<ResearchNote | null> {
  try {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink || !stat.isFile) return null;
    const bytes = await fs.readBytes(path, MAX_NOTE_BYTES);
    const content = new TextDecoder().decode(bytes);
    return { topic: describeResearchNote(path, content), content, truncated: stat.size > bytes.length };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export function describeResearchNote(path: string, content: string): ResearchTopic {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? basename(dirname(path));
  const paragraphs = body.split(/\r?\n\s*\r?\n/).map((part) => part.trim());
  const opening = paragraphs.find((part) => part !== '' && !/^(?:#|```|\||<!--)/.test(part));
  const question = /^#{1,4}\s+(?:.*(?:question|objective|当前主线|核心问题|研究问题|研究目标).*?)\r?\n([^#]+?)(?=\r?\n#{1,4}\s|$)/im.exec(body)?.[1];
  return {
    path,
    directory: dirname(path),
    title: plainText(title),
    summary: plainText(opening ?? '').slice(0, 600),
    mainQuestion: question === undefined ? undefined : plainText(question).slice(0, 900),
  };
}

function plainText(value: string): string {
  return value.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
}

export async function nearestResearchNote(
  fs: IHostFileSystem,
  directory: string,
): Promise<ResearchNote | null> {
  let current = resolve(directory);
  for (let depth = 0; depth < 8; depth += 1) {
    const found = await readResearchNote(fs, join(current, 'research.md'));
    if (found !== null) return found;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export async function discoverResearch(
  fs: IHostFileSystem,
  directory: string,
  additionalDirs: readonly string[] = [],
  selectedPath?: string,
): Promise<ResearchSnapshot> {
  const note = selectedPath === undefined
    ? await nearestResearchNote(fs, directory)
    : await readResearchNote(fs, selectedPath);
  const current = note?.topic ?? null;
  const home = current?.directory ?? resolve(directory);
  const parentNote = await nearestResearchNote(fs, dirname(home));
  const parent = parentNote?.topic.path === current?.path ? null : parentNote?.topic ?? null;
  const children: ResearchTopic[] = [];
  const pending = [{ directory: home, depth: 0 }];
  let visited = 0;
  let probed = 0;
  while (pending.length > 0 && visited < 96 && children.length < 32) {
    const item = pending.shift()!;
    visited += 1;
    let entries;
    try {
      entries = await fs.readdir(item.directory);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (probed >= 96) break;
      if (!entry.isDirectory || entry.isSymbolicLink || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      probed += 1;
      const childDir = join(item.directory, entry.name);
      const child = await readResearchNote(fs, join(childDir, 'research.md'));
      if (child !== null) children.push(child.topic);
      else if (item.depth < 2) pending.push({ directory: childDir, depth: item.depth + 1 });
      if (children.length >= 32) break;
    }
  }
  const linkedTopics: ResearchTopic[] = [];
  const seen = new Set([current?.path, parent?.path, ...children.map((child) => child.path)]);
  for (const match of (note?.content ?? '').matchAll(/\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)) {
    if (linkedTopics.length >= 16) break;
    const target = match[1]?.split('#')[0];
    if (!target || /^[a-z][a-z\d+.-]*:/i.test(target) || !/(?:^|\/)research\.md$/.test(target)) continue;
    let decoded: string;
    try { decoded = decodeURIComponent(target); } catch { continue; }
    const path = resolve(home, decoded);
    if (seen.has(path) || ![home, directory, ...additionalDirs].some((root) => withinResearchRoot(path, root))) continue;
    const real = await fs.realpath(path).catch(() => null);
    if (real === null || !(await withinCanonicalRoots(fs, real, [home, directory, ...additionalDirs]))) continue;
    seen.add(path);
    const linked = await readResearchNote(fs, path);
    if (linked !== null) linkedTopics.push(linked.topic);
  }
  return {
    enabled: true,
    rootDirectory: resolve(directory),
    current,
    parent,
    children: children.sort((a, b) => a.title.localeCompare(b.title)),
    linkedTopics,
    warning: selectedPath !== undefined && note === null
      ? `Selected research note is unavailable: ${selectedPath}`
      : note?.truncated ? 'Research note preview is truncated; read the full file before revising its argument.' : undefined,
  };
}

export async function withinCanonicalRoots(fs: IHostFileSystem, path: string, roots: readonly string[]): Promise<boolean> {
  for (const root of roots) {
    const canonical = await fs.realpath(root);
    if (withinResearchRoot(path, canonical)) return true;
  }
  return false;
}

function isMissing(error: unknown): boolean {
  const cause = unwrapErrorCause(error);
  const code = cause !== null && typeof cause === 'object' ? (cause as { code?: string }).code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'os.fs.not_found';
}
