/** Live REST checks for the file-backed research selection, without a model provider. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResearchSnapshot } from '@moonshot-ai/agent-core-v2';
import { startServer, type RunningServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

describe('research REST navigation', () => {
  let server: RunningServer;
  let home: string;
  let workspace: string;
  let sessionId: string;
  async function request(path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: authHeaders(server, { 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return await response.json() as { code: number; msg: string; data: ResearchSnapshot & { id: string } };
  }
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'research-rest-'));
    workspace = join(home, 'workspace');
    await mkdir(join(workspace, 'control'), { recursive: true });
    await writeFile(join(workspace, 'research.md'), '# Green functions and topology\n\nDetermine which invariant is justified by the available Green function.\n');
    await writeFile(join(workspace, 'control/research.md'), '# Noninteracting control\n\nCompare to a known two-band limit.\n');
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const created = await request('/sessions', { metadata: { cwd: workspace } });
    if (created.code !== 0) throw new Error(`Session fixture failed: ${created.msg}`);
    sessionId = created.data.id;
  });
  afterEach(async () => {
    await server?.close();
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  });

  it('reads the default topic from the workspace when a session is created', async () => {
    const result = await request(`/sessions/${sessionId}/research`);
    expect(result.code).toBe(0);
    expect(result.data).toMatchObject({ enabled: true, current: { title: 'Green functions and topology' } });
    expect(result.data.children).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Noninteracting control' })]));
  });

  it('reflects edited note content after selecting a child topic', async () => {
    const path = `/sessions/${sessionId}/research`;
    const selected = await request(path, { path: 'control/research.md' });
    expect(selected.code).toBe(0);
    expect(selected.data.parent?.title).toBe('Green functions and topology');
    await writeFile(join(workspace, 'control/research.md'), '# Verified control\n\nOnly the noninteracting limit is checked.\n');
    expect((await request(path)).data.current?.title).toBe('Verified control');
  });

  it('rejects generic memory as the main note without changing the selection', async () => {
    await writeFile(join(workspace, 'memory.md'), '# Unrelated memory\n');
    const path = `/sessions/${sessionId}/research`;
    expect((await request(path, { path: 'memory.md' })).code).toBe(40001);
    expect((await request(path)).data.current?.title).toBe('Green functions and topology');
  });

  it('reads only the selected main note through the note endpoint', async () => {
    const path = `/sessions/${sessionId}/research`;
    await request(path, { path: 'control/research.md' });
    const note = await request(`${path}/note`);
    expect(note.code).toBe(0);
    expect(note.data).toMatchObject({
      topic: { title: 'Noninteracting control' },
      content: '# Noninteracting control\n\nCompare to a known two-band limit.\n',
      truncated: false,
    });
  });

  it('rejects ambiguous mutation payloads without changing the enabled state', async () => {
    const path = `/sessions/${sessionId}/research`;
    expect((await request(path, { path: 'control', enabled: false })).code).toBe(40001);
    expect((await request(path)).data.enabled).toBe(true);
    expect((await request(path, { enabled: false })).data.enabled).toBe(false);
  });

  it('reports the missing session through the normal error envelope', async () => {
    expect((await request('/sessions/unknown/research')).code).toBe(40401);
  });
});
