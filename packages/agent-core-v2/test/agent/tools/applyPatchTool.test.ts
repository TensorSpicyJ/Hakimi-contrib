/**
 * Scenario: opt-in patch editing through the public Agent tool contract.
 * Responsibilities: multi-file preflight, context matching, line endings,
 * path/permission declarations, flag visibility and explicit partial failure.
 * Wiring: tool resolved by interface; real patch/TextModel and temporary local
 * filesystem, stub runtime/flag boundaries. I/O faults use the filesystem seam.
 * Run: pnpm --filter @moonshot-ai/agent-core-v2 test test/agent/tools/applyPatchTool.test.ts
 */

import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { APPLY_PATCH_TOOL_NAME, IApplyPatchTool } from '#/agent/tools/apply-patch/apply-patch';
import { ApplyPatchTool } from '#/agent/tools/apply-patch/applyPatchTool';
import { IFlagService } from '#/app/flag/flag';
import { MASTER_ENV } from '#/app/flag/flagService';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import type { Runtime } from '#/runtime/runtime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import type { ExecutableToolResult } from '#/tool/toolContract';
import { stubFlag } from '../../app/flag/stubs';
import { testAgent } from '../../harness';
import { stubWorkspaceContext } from '../../session/workspaceContext/stub-workspace-context';

describe('apply_patch (file changes and boundaries)', () => {
  let directory: string;
  let container: TestInstantiationService;
  let fs: HostFileSystem;
  let tool: IApplyPatchTool;
  let enabled: boolean;
  let activeRuntime: Runtime;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hakimi-apply-patch-'));
    container = new TestInstantiationService();
    fs = new HostFileSystem();
    const fake = new FakeRuntime({ workspaceId: 'workspace', runtimeId: 'test', generation: 'first' }, { capabilities: ['fs'] });
    activeRuntime = Object.assign(fake, { fs }) as Runtime;
    enabled = true;
    container.stub(IAgentRuntimeService, {
      inspect: () => activeRuntime,
      isAvailable: () => true,
      onDidChange: () => ({ dispose() {} }),
      acquire: () => ({ runtime: activeRuntime, track: (resource) => resource, dispose() {} }),
    });
    container.stub(ISessionWorkspaceContext, stubWorkspaceContext(directory));
    container.stub(IFlagService, stubFlag(() => enabled));
    container.stub(ISessionSkillCatalog, {
      catalog: {
        getSkill: () => undefined,
        getPluginSkill: () => undefined,
        renderSkillPrompt: () => '',
        listSkills: () => [],
        listInvocableSkills: () => [],
        getSkillRoots: () => [],
        getSkippedByPolicy: () => [],
        getModelSkillListing: () => '',
      },
    });
    container.set(IApplyPatchTool, new SyncDescriptor(ApplyPatchTool));
    tool = container.get(IApplyPatchTool);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    container.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  async function apply(input: string, signal = new AbortController().signal): Promise<ExecutableToolResult> {
    const execution = await tool.resolveExecution({ input });
    if (execution.isError === true) return execution;
    return execution.execute({ turnId: 0, toolCallId: 'patch_test', signal });
  }

  it('applies Add, Update and Delete sections after all files pass preflight', async () => {
    await writeFile(join(directory, 'existing.ts'), 'const value = 1;\n');
    await writeFile(join(directory, 'obsolete.ts'), 'old\n');

    const result = await apply('*** Begin Patch\n*** Add File: nested/new.ts\n+export const answer = 42;\n*** Update File: existing.ts\n@@\n-const value = 1;\n+const value = 2;\n*** Delete File: obsolete.ts\n*** End Patch');

    expect(result.isError).not.toBe(true);
    expect(await readFile(join(directory, 'nested/new.ts'), 'utf8')).toBe('export const answer = 42;\n');
    expect(await readFile(join(directory, 'existing.ts'), 'utf8')).toBe('const value = 2;\n');
    await expect(readFile(join(directory, 'obsolete.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('applies ordered hunks without replacing unrelated content between them', async () => {
    await writeFile(join(directory, 'code.ts'), 'first\nold one\nuser change\nlast\nold two\n');

    await apply('*** Begin Patch\n*** Update File: code.ts\n@@\n first\n-old one\n+new one\n@@\n last\n-old two\n+new two\n*** End of File\n*** End Patch');

    expect(await readFile(join(directory, 'code.ts'), 'utf8')).toBe('first\nnew one\nuser change\nlast\nnew two\n');
  });

  it('uses a section anchor to select otherwise repeated content', async () => {
    await writeFile(join(directory, 'code.ts'), 'function first() {\n  return 1;\n}\nfunction second() {\n  return 1;\n}\n');

    await apply('*** Begin Patch\n*** Update File: code.ts\n@@ function second() {\n-  return 1;\n+  return 2;\n*** End Patch');

    expect(await readFile(join(directory, 'code.ts'), 'utf8')).toBe('function first() {\n  return 1;\n}\nfunction second() {\n  return 2;\n}\n');
  });

  it('preserves CRLF when LF patch text updates a CRLF file', async () => {
    await writeFile(join(directory, 'code.ts'), 'alpha\r\nbeta\r\n');

    await apply('*** Begin Patch\n*** Update File: code.ts\n@@\n alpha\n-beta\n+gamma\n*** End Patch');

    expect(await readFile(join(directory, 'code.ts'), 'utf8')).toBe('alpha\r\ngamma\r\n');
  });

  it('preserves the missing final newline when updating an unterminated file', async () => {
    await writeFile(join(directory, 'code.ts'), 'before');

    await apply('*** Begin Patch\n*** Update File: code.ts\n@@\n-before\n+after\n*** End of File\n*** End Patch');

    expect(await readFile(join(directory, 'code.ts'), 'utf8')).toBe('after');
  });

  it('creates an empty file when Add File has no content lines', async () => {
    const result = await apply('*** Begin Patch\n*** Add File: empty.txt\n*** End Patch');

    expect(result.isError).not.toBe(true);
    expect(await readFile(join(directory, 'empty.txt'), 'utf8')).toBe('');
  });

  it('appends an insertion-only hunk at the end of an existing file', async () => {
    await writeFile(join(directory, 'code.ts'), 'first\n');

    await apply('*** Begin Patch\n*** Update File: code.ts\n@@\n+second\n*** End Patch');

    expect(await readFile(join(directory, 'code.ts'), 'utf8')).toBe('first\nsecond\n');
  });

  it('uses End of File to disambiguate a repeated final line', async () => {
    await writeFile(join(directory, 'code.ts'), 'same\nkeep\nsame\n');

    await apply('*** Begin Patch\n*** Update File: code.ts\n@@\n-same\n+last\n*** End of File\n*** End Patch');

    expect(await readFile(join(directory, 'code.ts'), 'utf8')).toBe('same\nkeep\nlast\n');
  });

  it('inserts at End of File when an insertion-only hunk also names an earlier section', async () => {
    await writeFile(join(directory, 'code.ts'), 'anchor\nmiddle\nlast\n');

    await apply('*** Begin Patch\n*** Update File: code.ts\n@@ anchor\n+inserted\n*** End of File\n*** End Patch');

    expect(await readFile(join(directory, 'code.ts'), 'utf8')).toBe('anchor\nmiddle\nlast\ninserted\n');
  });

  it('keeps every file unchanged when a later hunk does not match', async () => {
    await writeFile(join(directory, 'one.txt'), 'one\n');
    await writeFile(join(directory, 'two.txt'), 'two\n');

    const result = await apply('*** Begin Patch\n*** Update File: one.txt\n@@\n-one\n+changed\n*** Update File: two.txt\n@@\n-missing\n+changed\n*** End Patch');

    expect(result).toMatchObject({ isError: true, output: expect.stringContaining('no files changed') });
    expect(await readFile(join(directory, 'one.txt'), 'utf8')).toBe('one\n');
    expect(await readFile(join(directory, 'two.txt'), 'utf8')).toBe('two\n');
  });

  it('rejects ambiguous context instead of choosing a matching location', async () => {
    await writeFile(join(directory, 'code.ts'), 'same\nsame\n');

    const result = await apply('*** Begin Patch\n*** Update File: code.ts\n@@\n-same\n+different\n*** End Patch');

    expect(result).toMatchObject({ isError: true, output: expect.stringContaining('ambiguous') });
    expect(await readFile(join(directory, 'code.ts'), 'utf8')).toBe('same\nsame\n');
  });

  it('rejects Add File when the path already exists', async () => {
    await writeFile(join(directory, 'keep.txt'), 'user work\n');

    const result = await apply('*** Begin Patch\n*** Add File: keep.txt\n+replacement\n*** End Patch');

    expect(result).toMatchObject({ isError: true, output: expect.stringContaining('already exists') });
    expect(await readFile(join(directory, 'keep.txt'), 'utf8')).toBe('user work\n');
  });

  it('rejects duplicate normalized paths before starting the patch', async () => {
    const result = await apply('*** Begin Patch\n*** Add File: new.txt\n+one\n*** Add File: sub/../new.txt\n+two\n*** End Patch');

    expect(result).toMatchObject({ isError: true, output: expect.stringContaining('overlap') });
    await expect(readFile(join(directory, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects unsupported directives before performing earlier valid operations', async () => {
    const result = await apply('*** Begin Patch\n*** Add File: new.txt\n+new\n*** Move to: other.txt\n*** End Patch');

    expect(result.isError).toBe(true);
    await expect(readFile(join(directory, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps mixed line endings unchanged when their update is unsupported', async () => {
    await writeFile(join(directory, 'mixed.txt'), 'one\r\ntwo\n');

    const result = await apply('*** Begin Patch\n*** Update File: mixed.txt\n@@\n one\n-two\n+new\n*** End Patch');

    expect(result).toMatchObject({ isError: true, output: expect.stringContaining('mixed line endings') });
    expect(await readFile(join(directory, 'mixed.txt'), 'utf8')).toBe('one\r\ntwo\n');
  });

  it('refuses symlink targets without modifying the referenced file', async () => {
    await writeFile(join(directory, 'target.txt'), 'keep\n');
    await symlink(join(directory, 'target.txt'), join(directory, 'link.txt'));

    const result = await apply('*** Begin Patch\n*** Delete File: link.txt\n*** End Patch');

    expect(result.isError).toBe(true);
    expect(await readFile(join(directory, 'target.txt'), 'utf8')).toBe('keep\n');
  });

  it('refuses directory deletion without removing its contents', async () => {
    await mkdir(join(directory, 'keep'));
    await writeFile(join(directory, 'keep/data.txt'), 'keep');

    const result = await apply('*** Begin Patch\n*** Delete File: keep\n*** End Patch');

    expect(result.isError).toBe(true);
    expect(await readFile(join(directory, 'keep/data.txt'), 'utf8')).toBe('keep');
  });

  it('rejects sensitive paths through the shared path policy', () => {
    expect(() => tool.resolveExecution({ input: '*** Begin Patch\n*** Add File: .env\n+secret\n*** End Patch' })).toThrow('sensitive-file');
  });

  it('rejects relative workspace traversal through the shared path policy', () => {
    expect(() => tool.resolveExecution({ input: '*** Begin Patch\n*** Add File: ../outside.txt\n+outside\n*** End Patch' })).toThrow('absolute path');
  });

  it('declares all edited paths so scheduling and permission checks see every target', async () => {
    const execution = await tool.resolveExecution({ input: '*** Begin Patch\n*** Add File: one.txt\n+one\n*** Delete File: two.txt\n*** End Patch' });
    if (execution.isError === true) throw new Error(execution.output as string);

    expect(execution.accesses).toEqual([
      { kind: 'file', operation: 'readwrite', path: join(directory, 'one.txt') },
      { kind: 'file', operation: 'readwrite', path: join(directory, 'two.txt') },
    ]);
    expect(execution.matchesRule?.(join(directory, 'one.txt'))).toBe(false);
    expect(execution.matchesRule?.(join(directory, '*.txt'))).toBe(true);
  });

  it('reports completed and unattempted files when a later write fails', async () => {
    for (const name of ['one', 'two', 'three']) await writeFile(join(directory, `${name}.txt`), `${name}\n`);
    const realWrite = fs.writeText.bind(fs);
    vi.spyOn(fs, 'writeText').mockImplementation(async (path, content) => {
      if (path.endsWith('/two.txt')) throw new Error('disk full');
      return realWrite(path, content);
    });

    const result = await apply('*** Begin Patch\n*** Update File: one.txt\n@@\n-one\n+changed\n*** Update File: two.txt\n@@\n-two\n+changed\n*** Update File: three.txt\n@@\n-three\n+changed\n*** End Patch');

    expect(result).toMatchObject({ isError: true, output: expect.stringContaining('Completed files: update: one.txt') });
    expect(result.output).toContain('Patch stopped at two.txt: disk full');
    expect(result.output).toContain('Not attempted: three.txt');
    expect(await readFile(join(directory, 'one.txt'), 'utf8')).toBe('changed\n');
    expect(await readFile(join(directory, 'three.txt'), 'utf8')).toBe('three\n');
  });

  it('preserves an external edit made after preflight instead of overwriting it', async () => {
    const path = join(directory, 'code.ts');
    await writeFile(path, 'before\n');
    const realRead = fs.readText.bind(fs);
    let reads = 0;
    vi.spyOn(fs, 'readText').mockImplementation(async (target, options) => {
      if (target === path && ++reads === 2) await writeFile(path, 'external change\n');
      return realRead(target, options);
    });

    const result = await apply('*** Begin Patch\n*** Update File: code.ts\n@@\n-before\n+after\n*** End Patch');

    expect(result).toMatchObject({ isError: true, output: expect.stringContaining('file changed after preflight') });
    expect(await readFile(path, 'utf8')).toBe('external change\n');
  });

  it('rejects execution after the runtime generation changes', async () => {
    const execution = await tool.resolveExecution({ input: '*** Begin Patch\n*** Add File: new.txt\n+new\n*** End Patch' });
    if (execution.isError === true) throw new Error(execution.output as string);
    activeRuntime = { ...activeRuntime, identity: { ...activeRuntime.identity, generation: 'second' } };

    const result = await execution.execute({ turnId: 0, toolCallId: 'patch_test', signal: new AbortController().signal });

    expect(result).toMatchObject({ isError: true, output: expect.stringContaining('Runtime changed') });
    await expect(readFile(join(directory, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects execution when the feature flag is switched off after approval', async () => {
    const execution = await tool.resolveExecution({ input: '*** Begin Patch\n*** Add File: new.txt\n+new\n*** End Patch' });
    if (execution.isError === true) throw new Error(execution.output as string);
    enabled = false;

    const result = await execution.execute({ turnId: 0, toolCallId: 'patch_test', signal: new AbortController().signal });

    expect(result).toMatchObject({ isError: true, output: expect.stringContaining('flag is disabled') });
    await expect(readFile(join(directory, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps files unchanged when cancellation precedes preflight', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await apply('*** Begin Patch\n*** Add File: new.txt\n+new\n*** End Patch', controller.signal);

    expect(result).toMatchObject({ isError: true, output: expect.stringContaining('no files changed') });
    await expect(readFile(join(directory, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not write when cancellation arrives during the final file read', async () => {
    const path = join(directory, 'code.ts');
    await writeFile(path, 'before\n');
    const controller = new AbortController();
    const realRead = fs.readText.bind(fs);
    let reads = 0;
    vi.spyOn(fs, 'readText').mockImplementation(async (target, options) => {
      if (++reads === 2) controller.abort();
      return realRead(target, options);
    });

    const result = await apply('*** Begin Patch\n*** Update File: code.ts\n@@\n-before\n+after\n*** End Patch', controller.signal);

    expect(result.isError).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('before\n');
  });

  it('does not create the file when cancellation arrives during parent-directory creation', async () => {
    const controller = new AbortController();
    const realMkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, 'mkdir').mockImplementation(async (path, options) => {
      await realMkdir(path, options);
      controller.abort();
    });

    const result = await apply('*** Begin Patch\n*** Add File: nested/new.txt\n+new\n*** End Patch', controller.signal);

    expect(result.isError).toBe(true);
    await expect(readFile(join(directory, 'nested/new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('activates the production tool only after its default-off flag is enabled', async () => {
    vi.stubEnv(MASTER_ENV, '');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_APPLY_PATCH', '');
    const ctx = testAgent();
    ctx.configure({ tools: [APPLY_PATCH_TOOL_NAME] });
    const registry = ctx.get(IAgentToolRegistryService);
    expect(registry.resolve(APPLY_PATCH_TOOL_NAME)).toBeUndefined();

    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_APPLY_PATCH', 'true');
    await ctx.get(IAgentToolActivationService).activate();

    expect(registry.resolve(APPLY_PATCH_TOOL_NAME)?.name).toBe(APPLY_PATCH_TOOL_NAME);
  });
});
