/**
 * `tools` domain — session attachment and runtime file read sources.
 *
 * Adapts host files and Session media-store references to the common source
 * shape used by Read-family tools without exposing storage implementation.
 */

import { decodeTextWithErrors } from '#/_base/execEnv/decodeText';
import type { HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import { parseMediaFileReference } from '#/agent/media/mediaRef';
import type { ISessionMediaStore } from '#/agent/media/sessionMediaStore';

export interface FileReadSource {
  readonly name: string;
  readonly localPath?: string;
  stat(): Promise<HostFileStat>;
  readBytes(n?: number): Promise<Uint8Array>;
  readLines(): AsyncIterable<string>;
}

function* splitLinesKeepingTerminator(text: string): Generator<string> {
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.codePointAt(index) === 0x0a) {
      yield text.slice(start, index + 1);
      start = index + 1;
    }
  }
  if (start < text.length) yield text.slice(start);
}

export function runtimeFileSource(fs: IHostFileSystem, path: string): FileReadSource {
  return {
    name: path,
    stat: () => fs.stat(path),
    readBytes: (n) => (n === undefined ? fs.readBytes(path) : fs.readBytes(path, n)),
    readLines: () => fs.readLines(path, { errors: 'strict' }),
  };
}

export async function attachmentFileSource(
  reference: string,
  store?: ISessionMediaStore,
): Promise<FileReadSource> {
  const ref = parseMediaFileReference(reference);
  const open = async () => {
    const file = ref === undefined ? undefined : await store?.open(ref.fileId);
    if (file === undefined) {
      throw new Error(
        `Attachment ${JSON.stringify(reference)} is not available in the current session.`,
      );
    }
    return file;
  };
  const initial = await open();
  return {
    name: initial.name,
    localPath: initial.path,
    stat: async () => ({ isFile: true, isDirectory: false, size: (await open()).size }),
    readBytes: async (n) => {
      const file = await open();
      const size = Math.min(n ?? file.size, file.size);
      if (size === 0) return new Uint8Array();
      const chunks: Buffer[] = [];
      for await (const chunk of file.stream({ start: 0, end: size - 1 })) {
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== size) {
        throw new Error('Attachment changed or became unavailable while reading.');
      }
      return bytes;
    },
    readLines: async function* () {
      const file = await open();
      const checkedStream = async function* () {
        let size = 0;
        for await (const chunk of file.stream()) {
          size += chunk.length;
          yield chunk;
        }
        if (size !== file.size) {
          throw new Error('Attachment changed or became unavailable while reading.');
        }
      };
      const chunks: Buffer[] = [];
      for await (const chunk of checkedStream()) chunks.push(Buffer.from(chunk));
      const text = decodeTextWithErrors(Buffer.concat(chunks), 'utf8', 'strict');
      yield* splitLinesKeepingTerminator(text);
    },
  };
}

export function builtinFileSource(path: string, content: string): FileReadSource {
  const bytes = Buffer.from(content, 'utf8');
  return {
    name: path,
    stat: async () => ({ isFile: true, isDirectory: false, size: bytes.length }),
    readBytes: async (n) => n === undefined ? bytes : bytes.subarray(0, n),
    readLines: async function* () { yield* splitLinesKeepingTerminator(content); },
  };
}
