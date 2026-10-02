/**
 * `media` domain — `ISessionMediaStore` implementation.
 *
 * Persists session media through `storage` and its metadata through
 * `documents`, using the session namespace from `sessionContext`. Bound at
 * Session scope.
 */

import { extname } from 'node:path';

import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import {
  AUDIO_MIME_BY_SUFFIX,
  IMAGE_MIME_BY_SUFFIX,
  mediaExtensionForMime,
  VIDEO_MIME_BY_SUFFIX,
} from './mediaRef';
import {
  ISessionMediaStore,
  type SessionMediaFile,
  type SessionMediaMaterializeInput,
} from './sessionMediaStore';

const FILE_ID_RE = /^f_[A-Za-z0-9][A-Za-z0-9_-]*$/;

function isFileId(value: string): boolean {
  return FILE_ID_RE.test(value);
}

interface SessionMediaMetadata {
  readonly version: 1;
  readonly key: string;
  readonly name: string;
  readonly mediaType: string;
}

export class SessionMediaStoreService implements ISessionMediaStore {
  declare readonly _serviceBrand: undefined;
  private readonly scope: string;

  constructor(
    @ISessionContext sessionContext: ISessionContext,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
  ) {
    this.scope = sessionContext.scope('media');
  }

  pathFor(fileId: string, ext: string): string | undefined {
    if (!isFileId(fileId)) return undefined;
    return this.storage.pathFor(this.scope, this.keyFor(fileId, ext));
  }

  async resolveDisplayPath(fileId: string): Promise<string | undefined> {
    if (!isFileId(fileId)) return undefined;
    const key = await this.findKey(fileId);
    return key === undefined ? undefined : this.storage.pathFor(this.scope, key);
  }

  async read(
    fileId: string,
  ): Promise<{ readonly data: Uint8Array; readonly name: string } | undefined> {
    if (!isFileId(fileId)) return undefined;
    const key = await this.findKey(fileId);
    if (key === undefined) return undefined;
    const data = await this.storage.read(this.scope, key);
    return data === undefined ? undefined : { data, name: key };
  }

  async open(fileId: string): Promise<SessionMediaFile | undefined> {
    if (!isFileId(fileId)) return undefined;
    const stored = await this.documents.get<unknown>(this.scope, this.metadataKey(fileId));
    const metadata = this.isMetadataFor(stored, fileId) ? stored : undefined;
    const key =
      metadata !== undefined && (await this.storage.size(this.scope, metadata.key)) !== undefined
        ? metadata.key
        : await this.findKey(fileId);
    if (key === undefined) return undefined;
    const size = await this.storage.size(this.scope, key);
    if (size === undefined) return undefined;
    return {
      path: this.storage.pathFor(this.scope, key),
      name: metadata?.name ?? key,
      mediaType: metadata?.mediaType ?? this.mediaTypeForKey(key),
      size,
      stream: (range) => this.storage.readStream(this.scope, key, range),
    };
  }

  async materialize(input: SessionMediaMaterializeInput): Promise<string | undefined> {
    if (!isFileId(input.fileId)) return undefined;
    input.signal?.throwIfAborted();
    const ext = extname(input.name) || mediaExtensionForMime(input.mimeType) || '.bin';
    const key = this.keyFor(input.fileId, ext);
    const existingSize = await this.storage.size(this.scope, key);
    if (existingSize !== input.size) {
      const source = input.stream() as NodeJS.ReadableStream & AsyncIterable<Uint8Array>;
      await this.storage.writeStream(this.scope, key, source, {
        atomic: true,
        signal: input.signal,
      });
    }
    input.signal?.throwIfAborted();
    await this.documents.set(this.scope, this.metadataKey(input.fileId), {
      version: 1,
      key,
      name: input.name,
      mediaType: input.mimeType,
    } satisfies SessionMediaMetadata);
    return this.storage.pathFor(this.scope, key);
  }

  private keyFor(fileId: string, ext: string): string {
    const safeExt = ext.startsWith('.') ? ext : `.${ext}`;
    return `${fileId}${safeExt}`;
  }

  private metadataKey(fileId: string): string {
    return `meta/${fileId}.json`;
  }

  private isMetadataFor(value: unknown, fileId: string): value is SessionMediaMetadata {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<SessionMediaMetadata>;
    return (
      candidate.version === 1 &&
      typeof candidate.key === 'string' &&
      (candidate.key === fileId || candidate.key.startsWith(`${fileId}.`)) &&
      !candidate.key.includes('/') &&
      !candidate.key.includes('\\') &&
      typeof candidate.name === 'string' &&
      candidate.name.length > 0 &&
      typeof candidate.mediaType === 'string' &&
      candidate.mediaType.length > 0
    );
  }

  private mediaTypeForKey(key: string): string {
    const ext = extname(key).toLowerCase();
    return (
      IMAGE_MIME_BY_SUFFIX[ext] ??
      VIDEO_MIME_BY_SUFFIX[ext] ??
      AUDIO_MIME_BY_SUFFIX[ext] ??
      'application/octet-stream'
    );
  }

  private async findKey(fileId: string): Promise<string | undefined> {
    const keys = await this.storage.list(this.scope, fileId);
    return keys.find(
      (key) => key === fileId || (key.startsWith(`${fileId}.`) && !key.includes('.tmp.')),
    );
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionMediaStore,
  SessionMediaStoreService,
  ScopeActivation.OnScopeCreated,
  'media',
);
