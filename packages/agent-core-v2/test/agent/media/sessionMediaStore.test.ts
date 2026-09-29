import { Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';

import { SessionMediaStoreService } from '#/agent/media/sessionMediaStoreService';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';

function makeContext(): ISessionContext {
  return {
    _serviceBrand: undefined,
    sessionId: 'session',
    workspaceId: 'workspace',
    sessionDir: '/session',
    metaScope: 'session/meta',
    cwd: '/workspace',
    scope: (child) => child === undefined ? 'session' : `session/${child}`,
  };
}

function makeDocuments(): IAtomicDocumentStore {
  const values = new Map<string, unknown>();
  return {
    _serviceBrand: undefined,
    get: async <T>(_scope: string, key: string): Promise<T | undefined> => values.get(key) as T | undefined,
    set: async (_scope, key, value) => { values.set(key, value); },
    delete: async (_scope, key) => { values.delete(key); },
    list: async () => [],
    watch: () => () => ({ dispose: () => {} }),
    acquire: () => ({ dispose: () => {} }),
  };
}

describe('SessionMediaStoreService', () => {
  test('materializes idempotently and exposes no fake memory path', async () => {
    const storage = new InMemoryStorageService();
    const store = new SessionMediaStoreService(makeContext(), storage, makeDocuments());
    const bytes = new Uint8Array([1, 2, 3]);
    const input = {
      fileId: 'f_mcp_test',
      size: bytes.length,
      name: 'attachment.bin',
      mimeType: 'application/octet-stream',
      stream: () => Readable.from([bytes]),
    };
    expect(await store.materialize(input)).toBeUndefined();
    expect(await store.materialize(input)).toBeUndefined();
    await expect(store.read('f_mcp_test')).resolves.toEqual({
      data: bytes,
      name: 'f_mcp_test.bin',
    });
    await expect(store.open('f_mcp_test')).resolves.toMatchObject({
      path: undefined,
      name: 'attachment.bin',
      mediaType: 'application/octet-stream',
      size: 3,
    });
  });

  test('rejects cancellation before writing', async () => {
    const storage = new InMemoryStorageService();
    const store = new SessionMediaStoreService(makeContext(), storage, makeDocuments());
    const controller = new AbortController();
    controller.abort();
    await expect(store.materialize({
      fileId: 'f_mcp_cancel',
      size: 1,
      name: 'attachment.bin',
      mimeType: 'application/octet-stream',
      stream: () => Readable.from([new Uint8Array([1])]),
      signal: controller.signal,
    })).rejects.toThrow();
    expect(await storage.list('session/media')).toEqual([]);
  });
});
