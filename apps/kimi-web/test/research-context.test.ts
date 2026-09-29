// Scenario: session-scoped AITP topic navigation in the Web client.
// Responsibilities: server-authoritative focus, stale-response isolation, and note refresh.
// Wiring: real Vue effect scope/composable; only the daemon API boundary is stubbed.
// Run: pnpm --filter @bhjia-phys/hakimi-web exec vitest run test/research-context.test.ts
import { effectScope, nextTick, ref, type EffectScope } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useResearchContext } from '../src/composables/useResearchContext';
import type { AppResearchSnapshot } from '../src/api/types';

const api = vi.hoisted(() => ({ getSessionResearch: vi.fn(), updateSessionResearch: vi.fn() }));
vi.mock('../src/api', () => ({ getKimiWebApi: () => api }));
const scopes: EffectScope[] = [];
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop());
  vi.resetAllMocks();
});

function snapshot(title: string): AppResearchSnapshot {
  return {
    enabled: true, rootDirectory: '/research',
    current: { path: `/research/${title}/research.md`, directory: `/research/${title}`, title, summary: 'A bounded research question.' },
    parent: null, children: [], linkedTopics: [],
  };
}

function rig() {
  const scope = effectScope();
  scopes.push(scope);
  const sessionId = ref<string | undefined>('session-a');
  const running = ref(false);
  const ready = ref(false);
  const connected = ref(true);
  const context = scope.run(() => useResearchContext({ sessionId, ready, running, connected }))!;
  return { context, sessionId, running, ready, connected };
}

describe('Research context (authoritative topic navigation)', () => {
  it('keeps the current topic visible when a goal blocks navigation', async () => {
    api.getSessionResearch.mockResolvedValue(snapshot('topology'));
    api.updateSessionResearch.mockRejectedValue(new Error('Pause the active goal first.'));
    const { context, ready } = rig();
    ready.value = true;
    await nextTick();
    await context.refresh();

    await context.selectTopic('/research/topology/benchmark/research.md');

    expect(context.snapshot.value?.current?.title).toBe('topology');
    expect(context.error.value).toBe('Pause the active goal first.');
    expect(context.changing.value).toBe(false);
  });

  it('displays the selected note when the daemon accepts a subtopic', async () => {
    api.getSessionResearch.mockResolvedValue(snapshot('topology'));
    api.updateSessionResearch.mockResolvedValue(snapshot('benchmark'));
    const { context, ready } = rig();
    ready.value = true;
    await nextTick();
    await context.refresh();

    await context.selectTopic('/research/benchmark/research.md');

    expect(api.updateSessionResearch).toHaveBeenCalledWith('session-a', { path: '/research/benchmark/research.md' });
    expect(context.snapshot.value?.current?.title).toBe('benchmark');
  });

  it('rejects a late previous-session response after switching to another session', async () => {
    let finishPrevious!: (value: AppResearchSnapshot) => void;
    api.getSessionResearch.mockImplementation((id: string) => id === 'session-a'
      ? new Promise<AppResearchSnapshot>(resolve => { finishPrevious = resolve; })
      : Promise.resolve(snapshot('symmetry')));
    const { context, ready, sessionId } = rig();
    ready.value = true;
    await nextTick();
    sessionId.value = 'session-b';
    await nextTick();
    await context.refresh();

    finishPrevious(snapshot('topology'));
    await nextTick();

    expect(context.snapshot.value?.current?.title).toBe('symmetry');
    expect(context.loading.value).toBe(false);
  });

  it('refreshes the note when the last active agent finishes', async () => {
    api.getSessionResearch.mockResolvedValue(snapshot('topology'));
    const { context, ready, running } = rig();
    ready.value = true;
    await nextTick();
    await context.refresh();
    running.value = true;
    await nextTick();
    api.getSessionResearch.mockResolvedValue(snapshot('revised-question'));

    running.value = false;
    await nextTick();
    await nextTick();

    expect(context.snapshot.value?.current?.title).toBe('revised-question');
  });

  it('preserves enabled state when the daemon rejects disabling research', async () => {
    api.getSessionResearch.mockResolvedValue(snapshot('symmetry'));
    api.updateSessionResearch.mockRejectedValue(new Error('An agent is still working.'));
    const { context, ready } = rig();
    ready.value = true;
    await nextTick();
    await context.refresh();

    await context.setEnabled(false);

    expect(context.snapshot.value?.enabled).toBe(true);
    expect(context.error.value).toBe('An agent is still working.');
  });
});
