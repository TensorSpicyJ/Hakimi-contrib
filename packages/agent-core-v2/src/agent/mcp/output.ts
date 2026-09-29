/**
 * MCP tool-call result → ExecutableTool output pipeline.
 *
 * Owns the full path from "MCP protocol content blocks" to "what the agent
 * loop feeds back to the model":
 *  1. Convert each {@link MCPContentBlock} to a kosong `ContentPart`
 *     (dropping unsupported shapes).
 *  2. Wrap media-only outputs in `<mcp_tool_result name="…">` tags so the
 *     model can attribute binary output when several tools return media.
 *  3. Serialize `structuredContent` and server `_meta` into a trailing
 *     `<mcp-structured-result>` text part — appended after the media wrap so
 *     a media-only result keeps its attribution tags, and before the text
 *     budget so oversized payloads stay bounded. Literal closing tags inside
 *     the serialized payload are stripped so server data cannot fake an
 *     early end of the block. `_meta` keys with a protocol-reserved prefix
 *     (per the spec's key-name rules: a `modelcontextprotocol` or `mcp`
 *     label followed by at least one more label, as in
 *     `modelcontextprotocol.io/…` or `tools.mcp.com/…`, but not a vendor
 *     namespace like `com.example.mcp/…`) are dropped first: they carry
 *     host/protocol plumbing rather than model-facing data, while unprefixed
 *     and vendor-prefixed keys pass through because their semantics belong
 *     to the server. Non-serialisable payloads drop the whole block rather
 *     than failing the call.
 *  4. Apply the 100K text/think character budget to the tool's own text.
 *     This runs BEFORE captions exist, so a chatty tool (page text + a
 *     screenshot) can never evict or slice the compression caption — that
 *     would silently reintroduce the very degradation the caption reports.
 *  5. Compress oversized inline images, announcing each compression with a
 *     model-visible caption (original vs. sent size, and a reference to the
 *     persisted original) so downsampling is never silent; `note` also retains
 *     the compression captions for callers that consume that side channel.
 *  6. Apply the per-part 10 MB binary cap: oversized binary parts
 *     (image/audio/video URLs) collapse to a notice, so a single
 *     screenshot cannot evict every text part.
 *  7. Collapse a single-text-part result to a plain string output; otherwise
 *     emit the `ContentPart[]` as-is.
 *
 * `mcpResultToExecutableOutput` is the single entry point; the per-step
 * helpers stay private so callers cannot bypass the limits.
 */

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import type { ContentPart } from '#/kosong/contract/message';
import type { ITelemetryService } from '#/app/telemetry/telemetry';

import { compressImageContentParts } from '#/agent/media/image-compress';
import {
  buildUnsupportedImageNotice,
  decodeBase64Prefix,
  isModelAcceptedImageMime,
  parseImageDataUrl,
  resolveEffectiveImageMime,
} from '#/agent/media/image-format-policy';
import { persistOriginalImage } from '#/agent/media/image-originals';
import type { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import {
  buildMediaFileReference,
  mediaExtensionForMime,
  normalizeMime,
  textExtensionForMime,
} from '#/agent/media/mediaRef';
import type { MCPContentBlock, MCPToolResult } from '#/mcpCore/types';

export interface McpOutputOptions {
  readonly signal?: AbortSignal;
  readonly attachmentStore?: ISessionMediaStore;
  readonly originalsDir?: string;
  readonly telemetry?: ITelemetryService;
  readonly providerType?: string;
}

export const MCP_MAX_OUTPUT_CHARS = 100_000;
const MCP_OUTPUT_TRUNCATED_TEXT = `\n\n[Output truncated: exceeded ${String(
  MCP_MAX_OUTPUT_CHARS,
)} character limit. Use pagination or more specific queries to get remaining content.]`;

export const MCP_MAX_BINARY_PART_BYTES = 10 * 1024 * 1024;
const MCP_MAX_BINARY_PART_CHARS = Math.ceil((MCP_MAX_BINARY_PART_BYTES * 4) / 3);

function binaryPartTooLargeNotice(kind: 'image' | 'audio' | 'video', urlLength: number): string {
  const approxMb = ((urlLength * 3) / 4 / (1024 * 1024)).toFixed(1);
  const capMb = String(MCP_MAX_BINARY_PART_BYTES / (1024 * 1024));
  return `[${kind}_url dropped: ~${approxMb} MB exceeds ${capMb} MB per-part limit. Try a smaller resource.]`;
}

export function convertMCPContentBlock(
  block: MCPContentBlock,
  providerType?: string,
): ContentPart | null {
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }

  if (block.type === 'image' && typeof block.data === 'string') {
    const mimeType = block.mimeType ?? 'image/png';
    return {
      type: 'image_url',
      imageUrl: { url: `data:${mimeType};base64,${block.data}` },
    };
  }

  if (block.type === 'audio' && typeof block.data === 'string') {
    const mimeType = block.mimeType ?? 'audio/mpeg';
    return {
      type: 'audio_url',
      audioUrl: { url: `data:${mimeType};base64,${block.data}` },
    };
  }

  if (block.type === 'resource' && typeof block.resource === 'object' && block.resource !== null) {
    const res = block.resource;
    if (typeof res.text === 'string') {
      return { type: 'text', text: res.text };
    }
    if (typeof res.blob === 'string') {
      const mimeType = res.mimeType ?? 'application/octet-stream';
      if (mimeType.startsWith('image/')) {
        return {
          type: 'image_url',
          imageUrl: { url: `data:${mimeType};base64,${res.blob}` },
        };
      }
      if (mimeType.startsWith('audio/')) {
        return {
          type: 'audio_url',
          audioUrl: { url: `data:${mimeType};base64,${res.blob}` },
        };
      }
      if (mimeType.startsWith('video/')) {
        return {
          type: 'video_url',
          videoUrl: { url: `data:${mimeType};base64,${res.blob}` },
        };
      }
      return null;
    }
    return null;
  }

  if (block.type === 'resource_link' && typeof block.uri === 'string') {
    const mimeType = block.mimeType ?? 'application/octet-stream';
    if (mimeType.startsWith('image/')) {
      if (!isModelAcceptedImageMime(mimeType, providerType)) {
        return {
          type: 'text',
          text: buildUnsupportedImageNotice(mimeType, block.uri, providerType),
        };
      }
      return { type: 'image_url', imageUrl: { url: block.uri } };
    }
    if (mimeType.startsWith('audio/')) {
      return { type: 'audio_url', audioUrl: { url: block.uri } };
    }
    if (mimeType.startsWith('video/')) {
      return { type: 'video_url', videoUrl: { url: block.uri } };
    }
    return null;
  }

  return null;
}

export async function mcpResultToExecutableOutput(
  result: MCPToolResult,
  qualifiedToolName: string,
  options: McpOutputOptions = {},
): Promise<{
  output: string | ContentPart[];
  isError: boolean;
  note?: string;
  truncated?: true;
}> {
  options.signal?.throwIfAborted();
  const converted: ContentPart[] = [];
  const attachmentNotices: string[] = [];
  const preservedUrls = new Set<string>();
  let omittedAttachment = false;

  const preserveInlineMedia = async (url: string): Promise<boolean> => {
    options.signal?.throwIfAborted();
    if (options.attachmentStore === undefined) return true;
    const parsed = parseImageDataUrl(url);
    if (parsed === null) return true;
    if (!isStrictBase64(parsed.base64)) {
      attachmentNotices.push('Original MCP attachment could not be saved: malformed base64 data URL; original attachment preservation is incomplete.');
      return false;
    }
    if (options.attachmentStore === undefined || preservedUrls.has(url)) return true;
    preservedUrls.add(url);
    const declared = normalizeMime(parsed.mimeType);
    const mimeType = declared.startsWith('image/')
      ? normalizeMime(resolveEffectiveImageMime(declared, decodeBase64Prefix(parsed.base64)))
      : declared;
    attachmentNotices.push(await preserveAttachment(parsed.base64, mimeType, options));
    return true;
  };

  for (const block of result.content) {
    options.signal?.throwIfAborted();
    const part = convertMCPContentBlock(block, options.providerType);
    if (part !== null) {
      if (part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url') {
        const url =
          part.type === 'image_url'
            ? part.imageUrl.url
            : part.type === 'audio_url'
              ? part.audioUrl.url
              : part.videoUrl.url;
        if (!(await preserveInlineMedia(url))) {
          omittedAttachment = true;
          converted.push({
            type: 'text',
            text: '[MCP attachment omitted: malformed base64 payload. Original attachment preservation is incomplete.]',
          });
          continue;
        }
      }
      converted.push(part);
      continue;
    }
    if (
      options.attachmentStore !== undefined &&
      block.type === 'resource' &&
      typeof block.resource === 'object' &&
      block.resource !== null &&
      typeof block.resource.blob === 'string' &&
      typeof block.resource.text !== 'string'
    ) {
      omittedAttachment = true;
      attachmentNotices.push(
        await preserveAttachment(
          block.resource.blob,
          normalizeMime(block.resource.mimeType ?? 'application/octet-stream'),
          options,
        ),
      );
    }
  }

  const wrapped = wrapMediaOnly(converted, qualifiedToolName);
  const structuredExtras: Record<string, unknown> = {};
  if (result.structuredContent !== undefined) structuredExtras['structuredContent'] = result.structuredContent;
  if (result._meta !== undefined) {
    const meta = stripReservedMetaKeys(result._meta);
    if (meta !== undefined) structuredExtras['_meta'] = meta;
  }
  if (Object.keys(structuredExtras).length > 0) {
    const serialized = serializeStructuredExtras(structuredExtras);
    if (serialized !== undefined) {
      wrapped.push({ type: 'text', text: `\n<mcp-structured-result>\n${serialized}\n</mcp-structured-result>` });
    }
  }

  const budgeted = applyTextBudget(wrapped);
  options.signal?.throwIfAborted();
  const compressed = await compressImageContentParts(budgeted.parts, {
    telemetry:
      options.telemetry === undefined
        ? undefined
        : { client: options.telemetry, source: 'mcp_tool_result' },
    providerType: options.providerType,
    annotate: {
      persistOriginal: async (bytes, mimeType) => {
        options.signal?.throwIfAborted();
        if (options.attachmentStore !== undefined) {
          const saved = await saveAttachment(bytes, mimeType, options.attachmentStore, options.signal);
          attachmentNotices.push(attachmentNotice(saved, mimeType, bytes.length));
          return saved.reference;
        }
        return persistOriginalImage(
          bytes,
          mimeType,
          options.originalsDir === undefined ? {} : { dir: options.originalsDir },
        );
      },
    },
  });
  options.signal?.throwIfAborted();
  const capped = await applyBinaryPartCap(compressed.parts, preserveInlineMedia);
  const notices = await attachmentDetails(
    [...compressed.captions, ...attachmentNotices],
    options,
  );
  const parts = [...capped.parts];
  if (notices.length > 0) parts.push({ type: 'text', text: notices });
  const truncated = budgeted.truncated || capped.truncated || omittedAttachment;
  return {
    output: collapseSingleText(parts),
    isError: result.isError,
    note: compressed.captions.length > 0 ? compressed.captions.join('\n') : undefined,
    truncated: truncated ? true : undefined,
  };
}

const MCP_MAX_INLINE_ATTACHMENT_DETAILS_CHARS = 4096;

async function attachmentDetails(
  notices: readonly string[],
  options: McpOutputOptions,
): Promise<string> {
  const content = [...new Set(notices)].filter((notice) => notice.length > 0).join('\n');
  if (content.length === 0) return '';
  if (content.length <= MCP_MAX_INLINE_ATTACHMENT_DETAILS_CHARS) return content;
  options.signal?.throwIfAborted();
  if (options.attachmentStore === undefined) {
    return `${content.slice(0, MCP_MAX_INLINE_ATTACHMENT_DETAILS_CHARS)}\n` +
      'The complete MCP attachment details could not be saved separately; preservation information may be truncated.';
  }
  try {
    const saved = await saveAttachment(
      Buffer.from(content, 'utf8'),
      'text/plain',
      options.attachmentStore,
      options.signal,
    );
    return [
      `MCP attachment details reference: ${JSON.stringify(saved.reference)}`,
      'Pass this reference to Read to retrieve the complete attachment preservation details.',
    ].join('\n');
  } catch (error) {
    options.signal?.throwIfAborted();
    return `${content.slice(0, MCP_MAX_INLINE_ATTACHMENT_DETAILS_CHARS)}\n` +
      `The complete MCP attachment details could not be saved separately (${error instanceof Error ? error.message : String(error)}); preservation information may be truncated.`;
  }
}

function isStrictBase64(value: string): boolean {
  const compact = value.replaceAll(/\s/g, '');
  if (compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return false;
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  if (padding > 0 && compact.length % 4 !== 0) return false;
  const unpadded = compact.slice(0, compact.length - padding);
  if (unpadded.length % 4 === 1) return false;
  const canonical = Buffer.from(compact, 'base64').toString('base64').replace(/=+$/, '');
  return canonical === unpadded;
}

async function preserveAttachment(
  base64: string,
  mimeType: string,
  options: McpOutputOptions,
): Promise<string> {
  options.signal?.throwIfAborted();
  if (options.attachmentStore === undefined) {
    return `Original MCP attachment (${JSON.stringify(mimeType)}) was omitted and no Session media store is available; original attachment preservation is incomplete.`;
  }
  try {
    const compact = base64.replaceAll(/\s/g, '');
    if (!isStrictBase64(compact)) throw new Error('malformed base64 payload');
    const bytes = Buffer.from(compact, 'base64');
    const saved = await saveAttachment(bytes, mimeType, options.attachmentStore, options.signal);
    return attachmentNotice(saved, mimeType, bytes.length);
  } catch (error) {
    options.signal?.throwIfAborted();
    return `Original MCP attachment could not be saved (${JSON.stringify(mimeType)}): ` +
      `${error instanceof Error ? error.message : String(error)}. No readable original path is available; original attachment preservation is incomplete.`;
  }
}

interface SavedAttachment {
  readonly reference: string;
}

function attachmentNotice(saved: SavedAttachment, mimeType: string, size: number): string {
  return [
    `Attachment reference: ${JSON.stringify(saved.reference)}`,
    `MIME: ${JSON.stringify(mimeType)}; size: ${String(size)} bytes.`,
  ].join('\n');
}

async function saveAttachment(
  bytes: Uint8Array,
  mimeType: string,
  store: ISessionMediaStore,
  signal?: AbortSignal,
): Promise<SavedAttachment> {
  signal?.throwIfAborted();
  const mime = normalizeMime(mimeType);
  const hash = createHash('sha256').update(mime).update('\0').update(bytes).digest('hex');
  const extension = extensionForAttachment(bytes, mime);
  const fileId = `f_mcp_${hash}`;
  await store.materialize({
    fileId,
    size: bytes.length,
    name: `attachment${extension}`,
    mimeType: mime,
    stream: () => Readable.from([bytes]),
    signal,
  });
  signal?.throwIfAborted();
  return { reference: buildMediaFileReference(fileId) };
}

function extensionForAttachment(bytes: Uint8Array, mimeType: string): string {
  if (mimeType === 'image/svg+xml') {
    return bytes[0] === 0x1f && bytes[1] === 0x8b ? '.svgz' : '.svg';
  }
  return textExtensionForMime(mimeType) ?? mediaExtensionForMime(mimeType) ?? '.bin';
}

function serializeStructuredExtras(extras: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(extras).replaceAll('</mcp-structured-result>', '');
  } catch {
    return undefined;
  }
}

function stripReservedMetaKeys(
  meta: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!isReservedMetaKey(key)) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isReservedMetaKey(key: string): boolean {
  const slash = key.indexOf('/');
  if (slash <= 0) return false;
  const labels = key.slice(0, slash).split('.');
  return labels.some(
    (label, i) =>
      (label === 'modelcontextprotocol' || label === 'mcp') && i < labels.length - 1,
  );
}

function wrapMediaOnly(parts: readonly ContentPart[], qualifiedToolName: string): ContentPart[] {
  const hasMedia = parts.some(
    (p) => p.type === 'image_url' || p.type === 'audio_url' || p.type === 'video_url',
  );
  const hasNonEmptyText = parts.some((p) => p.type === 'text' && p.text.length > 0);
  if (!hasMedia || hasNonEmptyText) return [...parts];
  return [
    { type: 'text', text: `<mcp_tool_result name="${qualifiedToolName}">` },
    ...parts,
    { type: 'text', text: '</mcp_tool_result>' },
  ];
}

function applyTextBudget(parts: readonly ContentPart[]): {
  readonly parts: ContentPart[];
  readonly truncated: boolean;
} {
  let remaining = MCP_MAX_OUTPUT_CHARS;
  let truncated = false;
  const out: ContentPart[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      if (remaining <= 0) {
        truncated = true;
        continue;
      }
      if (part.text.length > remaining) {
        out.push({ type: 'text', text: part.text.slice(0, remaining) });
        remaining = 0;
        truncated = true;
      } else {
        out.push(part);
        remaining -= part.text.length;
      }
      continue;
    }

    if (part.type === 'think') {
      const size = part.think.length + (part.encrypted?.length ?? 0);
      if (remaining <= 0) {
        truncated = true;
        continue;
      }
      if (size > remaining) {
        out.push({ type: 'think', think: part.think.slice(0, remaining) });
        remaining = 0;
        truncated = true;
      } else {
        out.push(part);
        remaining -= size;
      }
      continue;
    }

    out.push(part);
  }

  if (truncated) {
    appendTruncationNotice(out);
  }
  return { parts: out, truncated };
}

async function applyBinaryPartCap(
  parts: readonly ContentPart[],
  preserve: (url: string) => Promise<boolean>,
): Promise<{
  readonly parts: ContentPart[];
  readonly truncated: boolean;
}> {
  let truncated = false;
  const out: ContentPart[] = [];

  for (const part of parts) {
    if (part.type === 'text' || part.type === 'think') {
      out.push(part);
      continue;
    }

    const url =
      part.type === 'image_url'
        ? part.imageUrl.url
        : part.type === 'audio_url'
          ? part.audioUrl.url
          : part.videoUrl.url;
    if (url.length > MCP_MAX_BINARY_PART_CHARS) {
      const preserved = await preserve(url);
      if (!preserved) {
        truncated = true;
        out.push({ type: 'text', text: '[MCP attachment omitted: malformed base64 payload. Original attachment preservation is incomplete.]' });
        continue;
      }
      const kind =
        part.type === 'image_url' ? 'image' : part.type === 'audio_url' ? 'audio' : 'video';
      out.push({ type: 'text', text: binaryPartTooLargeNotice(kind, url.length) });
      truncated = true;
      continue;
    }
    out.push(part);
  }

  return { parts: out, truncated };
}

function appendTruncationNotice(out: ContentPart[]): void {
  for (let i = out.length - 1; i >= 0; i--) {
    const candidate = out[i];
    if (candidate?.type === 'text') {
      out[i] = { type: 'text', text: candidate.text + MCP_OUTPUT_TRUNCATED_TEXT };
      return;
    }
  }
  out.push({ type: 'text', text: MCP_OUTPUT_TRUNCATED_TEXT });
}

function collapseSingleText(parts: readonly ContentPart[]): string | ContentPart[] {
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text;
  }
  return [...parts];
}
