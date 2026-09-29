/**
 * `media` domain — HEIC/HEIF conversion for model ingestion.
 *
 * Converts macOS-supported HEIC/HEIF inputs through the host process service
 * and reports registered `image_transcode` events through telemetry.
 */

import { runCommand } from '#/app/capability/host';
import type { ImageTranscodeEvent } from '#/app/telemetry/events';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import type { RuntimePath } from '#/runtime/runtime';

import { normalizeImageMime } from './image-format-policy';

const HEIC_MIMES: ReadonlySet<string> = new Set(['image/heic', 'image/heif']);
const TRANSCODED_MIME = 'image/jpeg';
const SIPS_JPEG_QUALITY = '90';
const SIPS_TIMEOUT_MS = 15_000;

export interface HeicTranscodeDeps {
  readonly osKind: string;
  readonly process: IHostProcessService | undefined;
  readonly fs: IHostFileSystem | undefined;
  readonly path: Pick<RuntimePath, 'join'> | undefined;
  readonly telemetry?: ITelemetryService;
  readonly telemetrySource?: string;
}

export type HeicTranscodeInput =
  | { readonly path: string }
  | { readonly bytes: Uint8Array };

export interface TranscodedImage {
  readonly data: Buffer;
  readonly mimeType: string;
}

export function isHeicMime(mimeType: string): boolean {
  return HEIC_MIMES.has(normalizeImageMime(mimeType));
}

export function canTranscodeHeic(
  deps: Pick<HeicTranscodeDeps, 'osKind' | 'process' | 'fs'>,
): boolean {
  return deps.osKind === 'macOS' && deps.process !== undefined && deps.fs !== undefined;
}

export async function transcodeHeicToJpeg(
  input: HeicTranscodeInput,
  mimeType: string,
  deps: HeicTranscodeDeps,
): Promise<TranscodedImage | null> {
  if (
    !isHeicMime(mimeType) ||
    !canTranscodeHeic(deps) ||
    deps.fs === undefined ||
    deps.process === undefined ||
    deps.path === undefined
  ) return null;
  const fs = deps.fs;
  const process = deps.process;
  const path = deps.path;
  const startedAt = Date.now();
  const originalBytes = 'bytes' in input ? input.bytes.length : undefined;
  const finish = (
    outcome: ImageTranscodeEvent['outcome'],
    result: TranscodedImage | null,
  ): TranscodedImage | null => {
    reportTranscodeEvent(deps.telemetry, deps.telemetrySource, {
      outcome,
      startedAt,
      inputMime: normalizeImageMime(mimeType),
      originalBytes,
      finalBytes: result?.data.length,
    });
    return result;
  };

  let scratchDir: Awaited<ReturnType<IHostFileSystem['createTempDirectory']>> | undefined;
  try {
    scratchDir = await fs.createTempDirectory('kimi-heic-');
    const source = path.join(scratchDir.path, 'source.heic');
    const target = path.join(scratchDir.path, 'converted.jpg');
    const sourceBytes = 'bytes' in input ? input.bytes : await fs.readBytes(input.path);
    await fs.writeBytes(source, sourceBytes);
    const result = await runCommand(
      process,
      'sips',
      ['-s', 'format', 'jpeg', '-s', 'formatOptions', SIPS_JPEG_QUALITY, source, '--out', target],
      { timeout: SIPS_TIMEOUT_MS },
    );
    if (result.code !== 0) return finish('command_failed', null);
    const data = await fs.readBytes(target).catch(() => new Uint8Array());
    if (data.length === 0) return finish('empty_output', null);
    return finish('converted', { data: Buffer.from(data), mimeType: TRANSCODED_MIME });
  } catch {
    return finish('error', null);
  } finally {
    if (scratchDir !== undefined) {
      await scratchDir.dispose().catch(() => undefined);
    }
  }
}

function reportTranscodeEvent(
  telemetry: ITelemetryService | undefined,
  source: string | undefined,
  input: {
    readonly outcome: ImageTranscodeEvent['outcome'];
    readonly startedAt: number;
    readonly inputMime: string;
    readonly originalBytes: number | undefined;
    readonly finalBytes: number | undefined;
  },
): void {
  if (telemetry === undefined || source === undefined) return;
  try {
    const properties: ImageTranscodeEvent = {
      source,
      outcome: input.outcome,
      input_mime: input.inputMime,
      output_mime: TRANSCODED_MIME,
      original_bytes: input.originalBytes,
      final_bytes: input.finalBytes,
      duration_ms: Date.now() - input.startedAt,
    };
    telemetry.track2('image_transcode', properties);
  } catch {
  }
}
