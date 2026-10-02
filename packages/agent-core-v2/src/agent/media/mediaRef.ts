/**
 * `media` domain — canonical attachment references and MIME extension helpers.
 *
 * Keeps session-owned file references independent of a storage backend so
 * model-facing callers can use the same `kimi-file://` contract everywhere.
 */

export const IMAGE_MIME_BY_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.svgz': 'image/svg+xml',
});

export const VIDEO_MIME_BY_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  '.mp4': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.wmv': 'video/x-ms-wmv',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.flv': 'video/x-flv',
  '.3gp': 'video/3gpp',
});

export const AUDIO_MIME_BY_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.wma': 'audio/x-ms-wma',
});

export function mediaExtensionForMime(mimeType: string): string | undefined {
  const normalized = mimeType.trim().toLowerCase().split(';', 1)[0];
  for (const [suffix, mime] of Object.entries({
    ...IMAGE_MIME_BY_SUFFIX,
    ...VIDEO_MIME_BY_SUFFIX,
    ...AUDIO_MIME_BY_SUFFIX,
  })) {
    if (mime === normalized) return suffix;
  }
  if (normalized === 'application/pdf') return '.pdf';
  if (normalized === 'text/plain') return '.txt';
  if (normalized === 'text/csv') return '.csv';
  if (normalized === 'application/json') return '.json';
  return undefined;
}

const TEXT_MIME_TO_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  'text/plain': '.txt',
  'text/xml': '.xml',
  'application/xml': '.xml',
  'text/yaml': '.yaml',
  'application/yaml': '.yaml',
  'text/csv': '.csv',
  'text/javascript': '.js',
  'application/javascript': '.js',
  'text/js': '.js',
  'text/x-toml': '.toml',
  'application/toml': '.toml',
  'application/json': '.json',
});

export function textExtensionForMime(mimeType: string): string | undefined {
  const normalized = normalizeMime(mimeType);
  const known = TEXT_MIME_TO_EXTENSION[normalized];
  if (known !== undefined) return known;
  if (normalized.endsWith('+json')) return '.json';
  if (normalized.endsWith('+xml')) return '.xml';
  if (normalized.endsWith('+yaml') || normalized.endsWith('+yml')) return '.yaml';
  return normalized.startsWith('text/') ? '.txt' : undefined;
}

export function normalizeMime(mimeType: string): string {
  return mimeType.trim().toLowerCase().split(';', 1)[0]!;
}

export type MediaKind = 'image' | 'audio' | 'video' | 'file';

export function mediaKindForMime(mimeType: string): MediaKind {
  const normalized = normalizeMime(mimeType);
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('video/')) return 'video';
  return 'file';
}

export interface MediaFileReference {
  readonly fileId: string;
  readonly path?: string;
}

export function isMediaFileReference(value: string): boolean {
  return value.startsWith('kimi-file://');
}

export function buildMediaFileReference(fileId: string, path?: string): string {
  const base = `kimi-file://${fileId}`;
  return path === undefined || path.length === 0 ? base : `${base}?path=${encodeURIComponent(path)}`;
}

export function parseMediaFileReference(value: string): MediaFileReference | undefined {
  if (!isMediaFileReference(value)) return undefined;
  const rest = value.slice('kimi-file://'.length);
  const queryAt = rest.indexOf('?path=');
  if (queryAt < 0) return rest.length > 0 ? { fileId: rest } : undefined;
  const fileId = rest.slice(0, queryAt);
  if (fileId.length === 0) return undefined;
  const encoded = rest.slice(queryAt + '?path='.length);
  if (encoded.length === 0) return { fileId };
  try {
    return { fileId, path: decodeURIComponent(encoded) };
  } catch {
    return { fileId };
  }
}

export const isGenericFileReference = isMediaFileReference;
export const buildGenericFileReference = buildMediaFileReference;
export const parseGenericFileReference = parseMediaFileReference;
