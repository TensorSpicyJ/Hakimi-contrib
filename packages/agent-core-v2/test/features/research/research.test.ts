/**
 * Scenario: research sessions navigate real topic files and retain one AITP anchor.
 * Real Feature, filesystem, persistence, injector and Goal services run in the
 * standard agent harness; the model/process boundary is the harness fake.
 * Run: pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/features/research/research.test.ts
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IResearchService } from '#/features/research/research';
import { IAgentResearchContext } from '#/features/research/agentResearchContext';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentGoalService } from '#/agent/goal/goal';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IReadTool } from '#/agent/tools/os/read/read';
import { readBuiltinResource } from '#/app/skillCatalog/builtin/resources';
import { getBuiltinSkillContributions } from '#/app/skillCatalog/builtin/registry';
import { createTestAgent, sessionService, appService, type TestAgentContext } from '../../harness';
import { runWillBeginStepHooks } from '../../agent/loop/stubs';

let directory: string;
let ctx: TestAgentContext | undefined;

beforeEach(async () => {
  vi.stubEnv('KIMI_CODE_EXPERIMENTAL_RESEARCH', 'true');
  directory = await mkdtemp(join(tmpdir(), 'hakimi-research-'));
  await writeFile(join(directory, 'research.md'), '# Green function topology\n\nCan a causal Green function distinguish the two insulating phases?\n\n## Current question\nFirst establish the noninteracting limit before using a GW self-energy.\n');
  await mkdir(join(directory, 'branches', 'causality'), { recursive: true });
  await writeFile(join(directory, 'branches', 'causality', 'research.md'), '# Causality diagnostic\n\nCheck spectral positivity before fitting the invariant.\n');
});

afterEach(async () => {
  await ctx?.dispose();
  ctx = undefined;
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function session() {
  ctx = createTestAgent({ cwd: directory });
  ctx.get(IAgentResearchContext);
  return ctx.get(IResearchService);
}

function reminders() {
  return ctx!.get(IAgentContextMemoryService).get()
    .filter((message) => message.origin?.kind === 'injection' && message.origin.variant === 'research')
    .map((message) => message.content.map((part) => part.type === 'text' ? part.text : '').join(''));
}

describe('research memory and navigation', () => {
  it('finds the current question and nested branch without a prescribed note template', async () => {
    const snapshot = await session().snapshot();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.current).toMatchObject({ title: 'Green function topology', summary: 'Can a causal Green function distinguish the two insulating phases?' });
    expect(snapshot.current?.mainQuestion).toContain('noninteracting limit');
    expect(snapshot.children.map((topic) => topic.title)).toEqual(['Causality diagnostic']);
  });

  it('returns from a branch to its parent using the live research notes', async () => {
    const research = session();
    const branch = await research.select('branches/causality');
    expect(branch.current?.title).toBe('Causality diagnostic');
    expect(branch.parent?.path).toBe(join(directory, 'research.md'));
    const parent = await research.select(branch.parent!.path);
    expect(parent.current?.title).toBe('Green function topology');
  });

  it('rejects generic memory as the selected research authority', async () => {
    await writeFile(join(directory, 'memory.md'), '# Follow an unrelated benchmark');
    await expect(session().select('memory.md')).rejects.toThrow('rather than generic memory');
  });

  it('rejects a symlink that escapes the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'hakimi-unrelated-'));
    try {
      await writeFile(join(outside, 'research.md'), '# Unrelated');
      await symlink(join(outside, 'research.md'), join(directory, 'escape.md'));
      await expect(session().select('escape.md')).rejects.toThrow('outside the workspace');
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('rereads a changed main argument instead of serving a cached memory summary', async () => {
    const research = session();
    await research.snapshot();
    await writeFile(join(directory, 'research.md'), '# Integrable generalized symmetry\n\nA finite commutant fit does not identify a Yangian charge.\n');
    expect((await research.snapshot()).current).toMatchObject({ title: 'Integrable generalized symmetry', summary: 'A finite commutant fit does not identify a Yangian charge.' });
  });

  it('injects the topic while excluding the contents of generic memory files', async () => {
    await writeFile(join(directory, 'MEMORY.md'), 'SECRET_UNRELATED_ROUTE');
    session();
    await runWillBeginStepHooks(ctx!.get(IAgentLoopService));
    expect(reminders().join('\n')).toContain('noninteracting limit');
    expect(reminders().join('\n')).not.toContain('SECRET_UNRELATED_ROUTE');
    expect(reminders().join('\n')).toContain('research-review');
  });

  it('shares selection with newly delegated agents', async () => {
    const research = session();
    await research.select('branches/causality');
    const child = createTestAgent({ cwd: directory, agentId: 'scientific-worker' }, sessionService(IResearchService, research));
    try {
      child.get(IAgentResearchContext);
      await runWillBeginStepHooks(child.get(IAgentLoopService));
      const injected = child.get(IAgentContextMemoryService).get().filter((message) => message.origin?.kind === 'injection' && message.origin.variant === 'research');
      expect(JSON.stringify(injected)).toContain('Causality diagnostic');
    } finally { await child.dispose(); }
  });

  it('prevents topic changes while a Goal is active between turns', async () => {
    const research = session();
    await ctx!.get(IAgentGoalService).createGoal({ objective: 'Validate the noninteracting topological invariant' });
    await expect(research.select('branches/causality')).rejects.toThrow('Pause or finish the active Goal');
  });

  it('holds a resumed Goal after its paused session navigates to another topic', async () => {
    const research = session();
    const goals = ctx!.get(IAgentGoalService);
    await goals.createGoal({ objective: 'Validate the topological invariant' });
    await goals.pauseGoal();
    await research.select('branches/causality');
    await goals.resumeGoal({ continueIfPaused: true });
    await vi.waitFor(() => expect(goals.getGoal().goal?.continuation).toMatchObject({ state: 'held', owner: 'research' }));
    expect(goals.getGoal().goal?.continuation?.reason).toContain(join(directory, 'research.md'));
    expect(ctx!.llmCalls).toHaveLength(0);
  });

  it('retains the original Goal note binding when the session is reopened on a branch', async () => {
    const storage = new InMemoryStorageService();
    ctx = createTestAgent({ cwd: directory }, appService(IFileSystemStorageService, storage));
    const goals = ctx.get(IAgentGoalService);
    const goal = await goals.createGoal({ objective: 'Validate the topological invariant' });
    await goals.pauseGoal();
    await ctx.get(IResearchService).select('branches/causality');
    await ctx.dispose();
    ctx = createTestAgent({ cwd: directory }, appService(IFileSystemStorageService, storage));
    const research = ctx.get(IResearchService);
    expect((await research.snapshot()).current?.title).toBe('Causality diagnostic');
    expect(await research.bindGoal(goal.goalId)).toEqual({ goalId: goal.goalId, path: join(directory, 'research.md') });
  });

  it('reanchors every automatic Goal turn to the selected main question', async () => {
    session();
    ctx!.configure({ tools: ['UpdateGoal'] });
    ctx!.mockNextResponse({ type: 'text', text: 'Established the zero-self-energy limit.' });
    ctx!.mockNextResponse({ type: 'text', text: 'Checked the convention with a small two-band model.' });
    ctx!.mockNextResponse({ type: 'function', id: 'done', name: 'UpdateGoal', arguments: JSON.stringify({ status: 'complete' }) });
    ctx!.mockNextResponse({ type: 'text', text: 'Bounded diagnostic complete.' });
    const goals = ctx!.get(IAgentGoalService);
    await goals.createGoal({ objective: 'Validate the noninteracting Green function invariant' });
    await goals.markBlocked({ reason: 'Waiting for the small fixture' });
    await goals.resumeGoal({ continueIfBlocked: true });
    await vi.waitFor(() => expect(goals.getGoal().goal).toBeNull());
    await vi.waitFor(() => expect(ctx!.llmCalls).toHaveLength(4));
    expect(reminders()).toHaveLength(3);
    for (const call of ctx!.llmCalls) {
      expect(JSON.stringify(call)).toContain('noninteracting limit');
      expect(JSON.stringify(call)).toContain('Each Goal continuation returns to the current question');
    }
  });

  it('restores the current topic after conversation compaction removes its injection', async () => {
    session();
    const context = ctx!.get(IAgentContextMemoryService);
    context.append({ role: 'user', content: [{ type: 'text', text: 'Check the invariant.' }], toolCalls: [], origin: { kind: 'user' } });
    await runWillBeginStepHooks(ctx!.get(IAgentLoopService), true);
    context.applyCompaction({ summary: 'We made bounded progress.', compactedCount: context.get().length, tokensBefore: 1000 });
    await writeFile(join(directory, 'research.md'), '# Green function topology\n\nNew obstruction: a Green function zero invalidates the naive interpolation.\n');
    await runWillBeginStepHooks(ctx!.get(IAgentLoopService));
    expect(reminders().at(-1)).toContain('Green function zero');
    expect(reminders().at(-1)).toContain(join(directory, 'research.md'));
  });

  it('reads bundled AITP references through the ordinary paginated Read tool', async () => {
    session();
    const path = 'builtin://aitp/skills/aitp-research/references/literature.md';
    const execution = await ctx!.get(IReadTool).resolveExecution({ path, n_lines: 8 });
    expect('execute' in execution).toBe(true);
    if (!('execute' in execution)) return;
    const result = await execution.execute({} as never);
    expect(result.isError).not.toBe(true);
    expect(String(result.output)).toContain('1\t');
    expect(readBuiltinResource(path)).toContain('literature');
    expect(getBuiltinSkillContributions().filter((skill) => skill.name.startsWith('aitp-'))).toHaveLength(6);
  });
});
