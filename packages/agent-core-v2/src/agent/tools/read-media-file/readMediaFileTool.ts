/**
 * `tools` domain — `ReadMediaFileTool` implementation.
 *
 * Reads image/video files as multi-modal content.
 *
 * Returns a 3-part wrap as `output`:
 * `[TextPart('<image|video path="…">'), ImageContent|VideoContent,
 *   TextPart('</image|video>')]`
 * plus a `note` side channel (rendered to the model, never to UIs), and
 * adapts its description and per-call behavior to the model's
 * `image_in` / `video_in` capability.
 *
 * The note — this tool wraps it in a `<system>` block as its own wording
 * choice — summarizes mime type, byte size and (for images) original pixel
 * dimensions, states exactly how the image was delivered (untouched,
 * downsampled, cropped, or native resolution) so compression is never
 * silent, guides the model to derive absolute coordinates from the original
 * size, and reminds it to re-read any media it generates or edits.
 *
 * Images support two opt-in delivery controls: `region` cuts a rectangle
 * (original-image pixel coordinates) out of the file so fine detail survives
 * at full fidelity, and `full_resolution` skips the default downscale when
 * the payload fits the per-image byte budget (refusing explicitly when it
 * does not, instead of silently degrading). Explicit region/native reads
 * refuse before loading a source that exceeds the safe decode allocation.
 * Default image reads also fail closed when compression cannot meet the
 * configured byte and longest-edge delivery budgets: the original bytes are
 * not emitted, and the tool result tells the model to create and re-read a
 * smaller copy.
 *
 * Path safety: goes through the shared path access resolver used by
 * Read/Write/Edit.
 *
 * Videos are delivered through the provider's upload channel when one is
 * bound, falling back to an inline base64 part when the channel exists but
 * fails at runtime (no files endpoint, network/server failure) — a failed
 * upload must not turn the whole read into an error. The same fallback
 * covers providers with no upload hook at all, as long as their protocol
 * converts `video_url` (`inlineVideoSupported`, computed from the model's
 * protocol at registration); when the wire would drop the inline payload
 * anyway (the OpenAI family), the by-design no-hook error
 * (`VideoUploadUnsupportedError`) surfaces instead. Auth rejections
 * (`provider.auth_error` / 401 / 403) always surface, because they drive
 * credential refresh rather than mask a bad token.
 *
 * Registration is capability-gated: this tool is
 * only registered when the active model supports image or video input.
 *
 * This tool is a deliberate exception to the `registerAgentToolService` contribution
 * table: its constructor depends on runtime model capabilities (capability
 * profile, video uploader, protocol flags), so it cannot be a static
 * Agent-scope Service and is instead instantiated
 * whenever the bound model changes. It still satisfies the `AgentTool`
 * contract.
 */

import type { ModelCapability } from '#/kosong/contract/capability';
import type { ContentPart } from '#/kosong/contract/message';
import { VideoUploadUnsupportedError } from '#/kosong/contract/errors';
import { inlineVideoPart, isVideoUploadAuthError } from '#/agent/media/videoUpload';
import type { ITelemetryService } from '#/app/telemetry/telemetry';

import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { isMediaFileReference } from '#/agent/media/mediaRef';
import {
  attachmentFileSource,
  runtimeFileSource,
  type FileReadSource,
} from '#/agent/tools/fileReadSource';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import type { RuntimePath } from '#/runtime/runtime';
import { canTranscodeHeic, isHeicMime, transcodeHeicToJpeg } from '#/agent/media/heicTranscode';
import { inspectAgentRuntime, type IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import {
  ToolAccesses,
  type AgentTool,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { resolvePathAccessPath, type WorkspaceConfig } from '#/tool/path-access';
import {
  MEDIA_SNIFF_BYTES,
  detectFileType,
  sniffImageDimensions,
} from '#/agent/media/file-type';
import {
  MAX_IMAGE_DECODE_BYTES,
  compressImageForModel,
  cropImageForModel,
  formatByteSize,
  isRecodableImage,
  resolveMaxImageEdgePx,
  resolveReadImageByteBudget,
  type ImageCompressionTelemetry,
  type ImageCropRegion,
} from '#/agent/media/image-compress';
import {
  buildImageConversionGuidance,
  buildOversizedImageConversionGuidance,
  isModelAcceptedImageMime,
} from '#/agent/media/image-format-policy';
import { providerImagePolicy } from '#/agent/media/providerImagePolicy';
import { toInputJsonSchema } from '#/tool/input-schema';
import {
  literalRulePattern,
  matchesGlobRuleSubject,
  matchesPathRuleSubject,
} from '#/tool/rule-match';
import { renderPrompt } from '#/_base/utils/render-prompt';
import {
  MAX_MEDIA_BYTES,
  MAX_MEDIA_MEGABYTES,
  ReadMediaFileInputSchema,
  type ReadMediaFileInput,
  type VideoUploader,
} from './read-media-file';
import readMediaDescriptionHead from './read-media.md?raw';


function buildDescription(capabilities: ModelCapability): string {
  const head = renderPrompt(readMediaDescriptionHead, { MAX_MEDIA_MEGABYTES });
  const lines: string[] = [head];
  const hasImage = capabilities.image_in;
  const hasVideo = capabilities.video_in;
  if (hasImage && hasVideo) {
    lines.push('- This tool supports image and video files for the current model.');
  } else if (hasImage) {
    lines.push(
      '- This tool supports image files for the current model.',
      '- Video files are not supported by the current model.',
    );
  } else if (hasVideo) {
    lines.push(
      '- This tool supports video files for the current model.',
      '- Image files are not supported by the current model.',
    );
  } else {
    lines.push('- The current model does not support image or video input.');
  }
  return lines.join('\n');
}


interface ImageDelivery {
  readonly kind: 'untouched' | 'downsampled' | 'crop' | 'full';
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly region?: ImageCropRegion;
  readonly resized?: boolean;
}

function buildMediaNote(input: {
  readonly kind: 'image' | 'video';
  readonly mimeType: string;
  readonly byteSize: number;
  readonly dimensions: { readonly width: number; readonly height: number } | null;
  readonly delivery?: ImageDelivery;
  readonly transcodedTo?: string;
}): string {
  const parts: string[] = [
    `Read ${input.kind} file.`,
    `Mime type: ${input.mimeType}.`,
    `Size: ${String(input.byteSize)} bytes.`,
  ];
  if (input.transcodedTo !== undefined) {
    parts.push(
      `The image was converted from ${input.mimeType} to ${input.transcodedTo} before delivery.`,
    );
  }
  if (input.kind === 'image' && input.dimensions) {
    parts.push(
      `Original dimensions: ${String(input.dimensions.width)}x${String(input.dimensions.height)} pixels.`,
    );
  }
  const delivery = input.delivery;
  if (delivery?.kind === 'downsampled') {
    parts.push(
      `The attached image was downsampled to ${String(delivery.width)}x${String(delivery.height)} pixels ` +
        `(${delivery.mimeType}, ${formatByteSize(delivery.byteLength)}) to fit model limits; ` +
        'fine detail may be lost.',
      'To inspect fine detail, call ReadMediaFile again with the region parameter ' +
        '(original-image pixel coordinates) to view a crop at full fidelity.',
    );
  } else if (delivery?.kind === 'crop' && delivery.region) {
    const { x, y, width, height } = delivery.region;
    parts.push(
      `Showing region (x=${String(x)}, y=${String(y)}, width=${String(width)}, height=${String(height)}) ` +
        `of the original image${
          delivery.resized === true
            ? `, downsampled to ${String(delivery.width)}x${String(delivery.height)} pixels`
            : ' at native resolution'
        }.`,
      'To output coordinates in original-image pixels, locate them within this crop and add ' +
        `the region offset (x=${String(x)}, y=${String(y)}).`,
    );
  } else if (delivery?.kind === 'full') {
    parts.push('Shown at native resolution; no downscaling applied.');
  }
  if (input.kind === 'image' && input.dimensions && delivery?.kind !== 'crop') {
    parts.push(
      'If you need to output coordinates, output relative coordinates first ' +
        'and compute absolute coordinates using the original image size.',
    );
  }
  parts.push(
    'If you generate or edit images or videos via commands or scripts, ' +
      'read the result back immediately before continuing.',
  );
  return `<system>${parts.join(' ')}</system>`;
}

function buildImageDeliveryLimitError(input: {
  readonly finalBytes: number;
  readonly readByteBudget: number;
  readonly maxEdge: number;
}): string {
  return (
    `Image is too large to send safely after compression (${String(input.finalBytes)} bytes; ` +
    `limit ${String(input.readByteBudget)} bytes and ${String(input.maxEdge)}px on the longest edge). ` +
    'The original image was not sent to the model. Do not retry the same file unchanged. ' +
    'Use Bash or an available image-processing tool to create a smaller copy within both limits, ' +
    'then call ReadMediaFile on the smaller copy.'
  );
}

function buildImageDecodeLimitError(finalBytes: number): string {
  return (
    `Image is too large to process safely for region or full_resolution (${String(finalBytes)} bytes; ` +
    `safe decode limit ${String(MAX_IMAGE_DECODE_BYTES)} bytes). ` +
    'The original image was not sent to the model. Do not retry the same file unchanged. ' +
    'Use Bash or an available image-processing tool to create a smaller copy or crop the needed ' +
    'region into a separate image, then call ReadMediaFile on the resulting file.'
  );
}

function buildFullResolutionLimitError(
  path: string,
  finalBytes: number,
  inlineByteBudget: number,
): string {
  return (
    `"${path}" is ${String(finalBytes)} bytes (${formatByteSize(finalBytes)}), ` +
    `over the ${String(inlineByteBudget)}-byte (${formatByteSize(inlineByteBudget)}) ` +
    'per-image limit, so full_resolution cannot be honored. ' +
    'Use region to view a crop at full fidelity instead.'
  );
}

function shouldSurfaceVideoUploadError(error: unknown, inlineVideoSupported: boolean): boolean {
  if (error instanceof VideoUploadUnsupportedError) return !inlineVideoSupported;
  return isVideoUploadAuthError(error);
}

export class ReadMediaFileTool implements AgentTool<ReadMediaFileInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'ReadMediaFile' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReadMediaFileInputSchema);
  private readonly telemetry: ITelemetryService | undefined;
  private readonly compressTelemetry: ImageCompressionTelemetry | undefined;
  private readonly inlineVideoSupported: boolean;
  private readonly providerType: string | undefined;
  private readonly inlineImageByteBudget: number;
  constructor(
    private readonly runtime: IAgentRuntimeService,
    private readonly workspace: WorkspaceConfig,
    private readonly capabilities: ModelCapability,
    private readonly videoUploader?: VideoUploader,
    telemetry?: ITelemetryService,
    inlineVideoSupported?: boolean,
    @ISessionMediaStore private readonly attachmentStore?: ISessionMediaStore,
    providerType?: string,
  ) {
    this.description = buildDescription(capabilities);
    this.telemetry = telemetry;
    this.compressTelemetry =
      telemetry === undefined ? undefined : { client: telemetry, source: 'read_media' };
    this.inlineVideoSupported = inlineVideoSupported ?? false;
    this.providerType = providerType;
    this.inlineImageByteBudget = providerImagePolicy(providerType).inlineByteBudget;
  }

  private async videoContentPart(
    data: Buffer,
    mimeType: string,
    safePath: string,
  ): Promise<ContentPart> {
    if (this.videoUploader !== undefined) {
      try {
        return await this.videoUploader({
          data,
          mimeType,
          filename: safePath.split(/[\\/]/).at(-1),
        });
      } catch (error) {
        if (shouldSurfaceVideoUploadError(error, this.inlineVideoSupported)) throw error;
      }
    }
    return inlineVideoPart(data, mimeType);
  }

  resolveExecution(args: ReadMediaFileInput): ToolExecution | Promise<ToolExecution> {
    if (!args.path) {
      return { isError: true, output: 'File path cannot be empty.' };
    }
    if (isMediaFileReference(args.path)) return this.attachmentExecution(args);
    const inspected = inspectAgentRuntime(this.runtime);
    const env = inspected.environment;
    const view = new RuntimeWorkspaceView(inspected, {
      workDir: this.workspace.workspaceDir,
      additionalDirs: this.workspace.additionalDirs,
    });
    const workspace = { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
    const path = resolvePathAccessPath(args.path, {
      env,
      workspace,
      operation: 'read',
    });
    return {
      accesses: ToolAccesses.readFile(path),
      description: `Reading media: ${args.path}`,
      display: { kind: 'file_io', operation: 'read', path },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspace.workspaceDir,
          pathClass: env.pathClass,
          homeDir: env.homeDir,
        }),
      execute: async () => {
        const lease = this.runtime.acquire(['fs']);
        try {
          if (lease.runtime.identity.generation !== inspected.identity.generation) {
            return { isError: true, output: 'Runtime changed before execution. Retry the tool call.' };
          }
          return await this.execution(
            args,
            runtimeFileSource(lease.runtime.fs!, path),
            env,
            lease.runtime.process,
            lease.runtime.fs,
            lease.runtime.path,
          );
        } finally {
          lease.dispose();
        }
      },
    };
  }

  private async attachmentExecution(args: ReadMediaFileInput): Promise<ToolExecution> {
    const source = await attachmentFileSource(args.path, this.attachmentStore);
    const path = source.localPath ?? args.path;
    return {
      accesses: ToolAccesses.readFile(path),
      description: `Reading media: ${args.path}`,
      display: { kind: 'file_io', operation: 'read', path },
      approvalRule: literalRulePattern(this.name, args.path),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.path),
      execute: async () =>
        this.execution(args, source, { osKind: 'unknown' }, undefined, undefined, undefined),
    };
  }

  private async execution(
    args: ReadMediaFileInput,
    source: FileReadSource,
    env: Pick<HostEnvironmentInfo, 'osKind'>,
    process?: IHostProcessService,
    fs?: IHostFileSystem,
    path?: Pick<RuntimePath, 'join'>,
  ): Promise<ExecutableToolResult> {
    if (!args.path) {
      return { isError: true, output: 'File path cannot be empty.' };
    }
    const safePath = source.name;

    try {
      const header = await source.readBytes(MEDIA_SNIFF_BYTES);
      const fileType = detectFileType(safePath, header, 'media');

      if (fileType.kind === 'text') {
        return {
          isError: true,
          output: `"${args.path}" is a text file. Use Read to read text files.`,
        };
      }
      if (fileType.kind === 'unknown') {
        return {
          isError: true,
          output:
            `"${args.path}" is not a supported image or video file. ` +
            'Use Read for text files, or Bash or an MCP tool for other binary formats.',
        };
      }

      if (fileType.kind === 'image' && !this.capabilities.image_in) {
        return {
          isError: true,
          output:
            'The current model does not support image input. ' +
            'Tell the user to use a model with image input capability.',
        };
      }
      const heicTranscodable =
        fileType.kind === 'image' &&
        isHeicMime(fileType.mimeType) &&
        canTranscodeHeic({ osKind: env.osKind, process, fs });
      if (
        fileType.kind === 'image' &&
        !isModelAcceptedImageMime(fileType.mimeType, this.providerType) &&
        !heicTranscodable
      ) {
        return {
          isError: true,
          output: buildImageConversionGuidance(args.path, fileType.mimeType, env.osKind),
        };
      }
      if (fileType.kind === 'video' && !this.capabilities.video_in) {
        return {
          isError: true,
          output:
            'The current model does not support video input. ' +
            'Tell the user to use a model with video input capability.',
        };
      }

      const stat = await source.stat();
      if (stat.size === 0) {
        return { isError: true, output: `"${args.path}" is empty.` };
      }
      if (stat.size > MAX_MEDIA_BYTES) {
        return {
          isError: true,
          output:
            `"${args.path}" is ${String(stat.size)} bytes, which exceeds the ` +
            `maximum ${String(MAX_MEDIA_MEGABYTES)}MB for media files.`,
        };
      }

      if (fileType.kind === 'video' && (args.region !== undefined || args.full_resolution === true)) {
        return {
          isError: true,
          output: 'region and full_resolution apply only to image files.',
        };
      }

      if (
        fileType.kind === 'image' &&
        stat.size > MAX_IMAGE_DECODE_BYTES &&
        (args.region !== undefined || args.full_resolution === true)
      ) {
        return {
          isError: true,
          output: buildImageDecodeLimitError(stat.size),
        };
      }

      if (
        fileType.kind === 'image' &&
        args.region === undefined &&
        args.full_resolution === true &&
        stat.size > this.inlineImageByteBudget
      ) {
        return {
          isError: true,
          output: buildFullResolutionLimitError(
            args.path,
            stat.size,
            this.inlineImageByteBudget,
          ),
        };
      }

      const imageDeliveryLimits = {
        readByteBudget: resolveReadImageByteBudget(),
        maxEdge: resolveMaxImageEdgePx(),
      };
      if (
        fileType.kind === 'image' &&
        args.region === undefined &&
        args.full_resolution !== true &&
        stat.size > MAX_IMAGE_DECODE_BYTES &&
        stat.size > imageDeliveryLimits.readByteBudget
      ) {
        return {
          isError: true,
          output: buildImageDeliveryLimitError({
            finalBytes: stat.size,
            ...imageDeliveryLimits,
          }),
        };
      }

      const transcoded = heicTranscodable
        ? await transcodeHeicToJpeg(
            source.localPath === undefined
              ? { bytes: await source.readBytes() }
              : { path: source.localPath },
            fileType.mimeType,
            {
              osKind: env.osKind,
              process,
              fs,
              path,
              telemetry: this.telemetry,
              telemetrySource: 'read_media',
            },
          )
        : null;
      if (heicTranscodable && transcoded === null) {
        return {
          isError: true,
          output: buildImageConversionGuidance(args.path, fileType.mimeType, env.osKind),
        };
      }
      const data = transcoded?.data ?? Buffer.from(await source.readBytes());
      const imageMime = transcoded?.mimeType ?? fileType.mimeType;
      let dimensions = fileType.kind === 'image' ? sniffImageDimensions(data) : null;
      let mediaPart: ContentPart;
      let delivery: ImageDelivery | undefined;
      if (fileType.kind === 'image') {
        if (args.region !== undefined) {
          const outcome = await cropImageForModel(data, imageMime, args.region, {
            skipResize: args.full_resolution === true,
            telemetry: this.compressTelemetry,
          });
          if (!outcome.ok) {
            return { isError: true, output: `Cannot read region from "${args.path}": ${outcome.error}` };
          }
          const base64 = Buffer.from(outcome.data).toString('base64');
          mediaPart = {
            type: 'image_url',
            imageUrl: { url: `data:${outcome.mimeType};base64,${base64}` },
          };
          delivery = {
            kind: 'crop',
            width: outcome.width,
            height: outcome.height,
            byteLength: outcome.finalByteLength,
            mimeType: outcome.mimeType,
            region: outcome.region,
            resized: outcome.resized,
          };
          dimensions = { width: outcome.originalWidth, height: outcome.originalHeight };
        } else if (args.full_resolution === true) {
          if (data.length > this.inlineImageByteBudget) {
            return {
              isError: true,
              output: buildFullResolutionLimitError(
                args.path,
                data.length,
                this.inlineImageByteBudget,
              ),
            };
          }
          const base64 = data.toString('base64');
          mediaPart = {
            type: 'image_url',
            imageUrl: { url: `data:${imageMime};base64,${base64}` },
          };
          delivery = {
            kind: 'full',
            width: dimensions?.width ?? 0,
            height: dimensions?.height ?? 0,
            byteLength: data.length,
            mimeType: imageMime,
          };
        } else {
          const { readByteBudget, maxEdge } = imageDeliveryLimits;
          const inlineOnly = !isRecodableImage(data, imageMime);
          const compressed = await compressImageForModel(data, imageMime, {
            byteBudget: readByteBudget,
            maxEdge,
            telemetry: this.compressTelemetry,
          });
          if (inlineOnly) {
            const inlineLimit = Math.max(readByteBudget, this.inlineImageByteBudget);
            if (compressed.finalByteLength > inlineLimit) {
              return {
                isError: true,
                output: buildOversizedImageConversionGuidance(
                  args.path,
                  fileType.mimeType,
                  env.osKind,
                  compressed.finalByteLength,
                  inlineLimit,
                ),
              };
            }
          } else if (
            compressed.finalByteLength > readByteBudget ||
            Math.max(compressed.width, compressed.height) > maxEdge
          ) {
            return {
              isError: true,
              output: buildImageDeliveryLimitError({
                finalBytes: compressed.finalByteLength,
                readByteBudget,
                maxEdge,
              }),
            };
          }
          const base64 = Buffer.from(compressed.data).toString('base64');
          mediaPart = {
            type: 'image_url',
            imageUrl: { url: `data:${compressed.mimeType};base64,${base64}` },
          };
          delivery = {
            kind: compressed.changed ? 'downsampled' : 'untouched',
            width: compressed.width,
            height: compressed.height,
            byteLength: compressed.finalByteLength,
            mimeType: compressed.mimeType,
          };
          if (compressed.changed) {
            dimensions = { width: compressed.originalWidth, height: compressed.originalHeight };
          }
        }
      } else {
        mediaPart = await this.videoContentPart(data, fileType.mimeType, safePath);
      }

      const tag = fileType.kind === 'image' ? 'image' : 'video';
      const displayPath = isMediaFileReference(args.path) ? args.path : safePath;
      const openText = `<${tag} path="${displayPath}">`;
      const closeText = `</${tag}>`;

      const note = buildMediaNote({
        kind: fileType.kind,
        mimeType: fileType.mimeType,
        byteSize: stat.size,
        dimensions,
        delivery,
        transcodedTo: transcoded?.mimeType,
      });

      const output: ContentPart[] = [
        { type: 'text', text: openText },
        mediaPart,
        { type: 'text', text: closeText },
      ];

      return { output, note, isError: false };
    } catch (error) {
      return {
        isError: true,
        output: `Failed to read ${args.path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
