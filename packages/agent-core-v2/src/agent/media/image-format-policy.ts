/**
 * `media` domain — provider-accepted image formats, the single source
 * of truth.
 *
 * Model providers accept only PNG, JPEG, GIF, and WebP image blocks. An
 * `image_url` part carrying any other MIME (AVIF, HEIC, BMP, TIFF, ICO, …)
 * is rejected by the API — and because prompts and tool results persist in
 * the session history, that one part makes every subsequent request fail
 * too ("session poisoning"). Every ingestion point therefore refuses
 * unsupported formats instead of passing the bytes through.
 *
 * The policy is deliberately a closed set, not a denylist: a format is only
 * ever sent when it is known to be accepted. Supporting a new format means
 * adding it to {@link MODEL_ACCEPTED_IMAGE_MIMES}; tailoring the refusal
 * guidance for a newly-seen unsupported format means adding one row to
 * {@link UNSUPPORTED_IMAGE_FORMATS}.
 *
 * Inbound MIME strings are normalized for the DECISION
 * ({@link normalizeImageMime}: case, whitespace, `image/jpg`), but every
 * call site must forward the CANONICAL MIME into the session — strict
 * provider whitelists (e.g. Anthropic's) reject the raw alias, which would
 * re-create the very session poisoning this module exists to prevent.
 *
 * Scope: only inline `data:` images can be gated. A remote http(s) image URL
 * (an MCP `resource_link`, a REST `source.kind: 'url'` part) carries no
 * bytes to inspect, and providers that support URL images fetch them
 * server-side; those pass through unchanged.
 */

import { providerImagePolicy } from './providerImagePolicy';
import { IMAGE_MIME_BY_SUFFIX, sniffMediaFromMagic } from './file-type';

export const MODEL_ACCEPTED_IMAGE_MIMES = providerImagePolicy().acceptedMimes;

const IMAGE_FORMAT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/webp': 'WebP',
  'image/bmp': 'BMP',
  'image/heic': 'HEIC',
  'image/heif': 'HEIF',
});

function acceptedFormatsText(providerType?: string): string {
  const labels = [...providerImagePolicy(providerType).acceptedMimes].map(
    (mime) => IMAGE_FORMAT_LABELS[mime] ?? mime,
  );
  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`;
}

interface UnsupportedImageFormatInfo {
  readonly linuxDecoder?: { readonly command: string; readonly packageName: string };
}

const UNSUPPORTED_IMAGE_FORMATS: Readonly<Record<string, UnsupportedImageFormatInfo>> =
  Object.freeze({
    'image/avif': {},
    'image/heic': { linuxDecoder: { command: 'heif-convert', packageName: 'libheif-examples' } },
    'image/heif': { linuxDecoder: { command: 'heif-convert', packageName: 'libheif-examples' } },
    'image/bmp': {},
    'image/tiff': {},
    'image/x-icon': {},
  });

export function normalizeImageMime(mimeType: string): string {
  const lower = mimeType.trim().toLowerCase();
  const semi = lower.indexOf(';');
  const base = (semi === -1 ? lower : lower.slice(0, semi)).trim();
  return base === 'image/jpg' ? 'image/jpeg' : base;
}

const BASE64_SNIFF_CHARS = 48;

export function decodeBase64Prefix(base64: string): Buffer {
  return Buffer.from(base64.slice(0, BASE64_SNIFF_CHARS), 'base64');
}

export function resolveEffectiveImageMime(declaredMime: string, header: Uint8Array): string {
  const sniffed = sniffMediaFromMagic(header);
  return sniffed !== null ? sniffed.mimeType : declaredMime;
}

export function unsupportedImageMimeFromUrl(url: string, providerType?: string): string | null {
  let path = url;
  const query = path.indexOf('?');
  if (query !== -1) path = path.slice(0, query);
  const hash = path.indexOf('#');
  if (hash !== -1) path = path.slice(0, hash);
  const dot = path.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = path.slice(dot).toLowerCase();
  const mime = ext === '.svg' ? 'image/svg+xml' : IMAGE_MIME_BY_SUFFIX[ext];
  if (mime === undefined || isModelAcceptedImageMime(mime, providerType)) return null;
  return mime;
}

export function parseImageDataUrl(url: string): { mimeType: string; base64: string } | null {
  const match = /^data:([^;,]+)(?:;[^;,]+)*?;base64,(.*)$/si.exec(url);
  if (match === null) return null;
  return { mimeType: match[1]!, base64: match[2]! };
}

export function isDataUrl(url: string): boolean {
  return url.toLowerCase().startsWith('data:');
}

export function isModelAcceptedImageMime(mimeType: string, providerType?: string): boolean {
  return providerImagePolicy(providerType).acceptedMimes.has(normalizeImageMime(mimeType));
}

export function buildImageConversionGuidance(
  path: string,
  mimeType: string,
  osKind: string,
): string {
  const converted = path.replace(/\.[^./\\]+$/, '') + '.jpg';
  return (
    `"${path}" is an ${mimeType} image, which the provider does not accept. ` +
    'Convert it to JPEG first, then read the converted file. ' +
    imageConversionCommand(
      path,
      converted,
      osKind,
      UNSUPPORTED_IMAGE_FORMATS[normalizeImageMime(mimeType)],
    )
  );
}

export function buildOversizedImageConversionGuidance(
  path: string,
  mimeType: string,
  osKind: string,
  byteLength: number,
  inlineByteBudget: number,
): string {
  const converted = path.replace(/\.[^./\\]+$/, '') + '.jpg';
  return (
    `"${path}" is a ${String(byteLength)}-byte ${mimeType} image, over the ` +
    `${String(inlineByteBudget)}-byte per-image limit, and this format cannot be ` +
    'downsampled locally. Convert it to JPEG first, then read the converted file. ' +
    imageConversionCommand(
      path,
      converted,
      osKind,
      UNSUPPORTED_IMAGE_FORMATS[normalizeImageMime(mimeType)],
    )
  );
}

function imageConversionCommand(
  path: string,
  converted: string,
  osKind: string,
  format: UnsupportedImageFormatInfo | undefined,
): string {
  const magick = `magick "${path}" "${converted}"`;
  const linuxDecoder = format?.linuxDecoder;
  switch (osKind) {
    case 'macOS':
      return `On macOS: sips -s format jpeg "${path}" --out "${converted}"`;
    case 'Linux':
      return linuxDecoder === undefined
        ? `On Linux, with ImageMagick: ${magick}`
        : `On Linux: ${linuxDecoder.command} "${path}" "${converted}" ` +
            `(package ${linuxDecoder.packageName}), or with ImageMagick: ${magick}`;
    case 'Windows':
      return (
        `On Windows, with ImageMagick: ${magick} ` +
        '(install it first if missing: winget install ImageMagick.ImageMagick)'
      );
    default:
      return (
        `Options: sips -s format jpeg "${path}" --out "${converted}" (macOS)` +
        (linuxDecoder === undefined
          ? ''
          : `, ${linuxDecoder.command} "${path}" "${converted}" ` +
            `(Linux, package ${linuxDecoder.packageName})`) +
        `, or ${magick} (ImageMagick)`
      );
  }
}

export function buildUnsupportedImageNotice(
  mimeType: string,
  name?: string,
  providerType?: string,
): string {
  const what =
    name === undefined || name.length === 0
      ? `unsupported image format ${mimeType}`
      : `"${name}" uses unsupported image format ${mimeType}`;
  return (
    `[Image omitted: ${what}. The current model provider accepts only ` +
    `${acceptedFormatsText(providerType)} — convert it to PNG or JPEG and try again.]`
  );
}

export function buildMalformedImageNotice(url: string): string {
  const shown = url.length > 80 ? `${url.slice(0, 80)}…` : url;
  return (
    `[Image omitted: "${shown}" is not a valid data URL (its header or payload ` +
    'could not be parsed). Re-encode the image as PNG or JPEG and try again.]'
  );
}
