/**
 * `SessionEventWiring` — the in-process v1 edge over the v2 per-agent event
 * bus. Covers the status-snapshot fold: v2 emits `agent.status.updated` in
 * slices and the model slice rides only the bind-time emission, so the
 * wiring merges a consistent usage + context + model snapshot into every
 * status event (mirrors kap-server's broadcaster bridge).
 * Run: pnpm exec vitest run test/session-event-wiring.test.ts
 */
import { describe, expect, it } from 'vitest';

import type { Event } from '@moonshot-ai/agent-core';
import {
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentTokenCountingService,
  IAgentUsageService,
  IEventBus,
  ISessionInteractionService,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
} from '@moonshot-ai/agent-core-v2';

import { SessionEventWiring, type SessionEventSink } from '#/v2/session-wiring';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type FakeBusEvent = { type: string } & Record<string, unknown>;

class FakeAgentBus {
  private handlers: Array<(e: FakeBusEvent) => void> = [];
  subscribe(handler: (e: FakeBusEvent) => void): { dispose(): void } {
    this.handlers.push(handler);
    return {
      dispose: () => {
        const i = this.handlers.indexOf(handler);
        if (i >= 0) this.handlers.splice(i, 1);
      },
    };
  }
  emit(e: FakeBusEvent): void {
    for (const h of [...this.handlers]) h(e);
  }
}

class FakeAgentHandle {
  readonly kind = 2;
  readonly bus = new FakeAgentBus();
  readonly accessor;
  private readonly services = new Map<unknown, unknown>();
  constructor(readonly id: string) {
    this.services.set(IEventBus, this.bus);
    this.accessor = {
      get: (token: unknown) => this.services.get(token),
    };
  }
  set(token: unknown, service: unknown): void {
    this.services.set(token, service);
  }
  dispose(): void {}
}

function makeSession(agents: FakeAgentHandle[]): ISessionScopeHandle {
  const lifecycle = {
    list: () => agents,
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
  };
  const interactions = {
    onDidChangePending: () => ({ dispose: () => {} }),
    listPending: () => [],
  };
  const accessor = {
    get: (token: unknown): unknown => {
      if (token === IAgentLifecycleService) return lifecycle;
      if (token === ISessionInteractionService) return interactions;
      return undefined;
    },
  };
  return { id: 's1', kind: 1, accessor, dispose: () => {} } as unknown as ISessionScopeHandle;
}

function collectingSink(): { sink: SessionEventSink; events: Event[] } {
  const events: Event[] = [];
  return {
    events,
    sink: {
      receiveEvent: (event) => {
        events.push(event);
      },
      requestApproval: () => Promise.resolve('cancelled' as never),
      requestQuestion: () => Promise.resolve(null),
      toolCall: () => Promise.resolve({ output: 'not supported', isError: true }),
    },
  };
}

const USAGE = {
  total: { inputOther: 1, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
};

function bindStatusServices(agent: FakeAgentHandle, model: string): void {
  agent.set(IAgentTokenCountingService, { statusSize: () => 10 });
  agent.set(IAgentProfileService, {
    getModel: () => model,
    getModelCapabilities: () => ({ max_context_tokens: 128_000 }),
  });
  agent.set(IAgentUsageService, { status: () => USAGE });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionEventWiring status snapshot fold', () => {
  it('folds a consistent usage + context + model snapshot into every status event', () => {
    const sub = new FakeAgentHandle('agent-1');
    bindStatusServices(sub, 'sub-model');
    const { sink, events } = collectingSink();
    const wiring = new SessionEventWiring(makeSession([sub]), sink);
    try {
      // The v2 model slice rides only the subagent's bind-time emission, which
      // reaches clients before `subagent.spawned` and is dropped there; a
      // later usage-only slice must still carry the model at this edge.
      sub.bus.emit({ type: 'agent.status.updated', usage: USAGE });
      // Non-status events pass through untouched.
      sub.bus.emit({ type: 'assistant.delta', delta: 'Hi' });
    } finally {
      wiring.dispose();
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'agent.status.updated',
      sessionId: 's1',
      agentId: 'agent-1',
      usage: USAGE,
      contextTokens: 10,
      maxContextTokens: 128_000,
      model: 'sub-model',
    });
    expect(events[1]).toMatchObject({ type: 'assistant.delta', delta: 'Hi' });
    expect(events[1]).not.toHaveProperty('model');
  });

  it('passes status events through unchanged when the agent services are incomplete', () => {
    const sub = new FakeAgentHandle('agent-1');
    // No profile/usage/context/wire services bound — nothing to fold in.
    const { sink, events } = collectingSink();
    const wiring = new SessionEventWiring(makeSession([sub]), sink);
    try {
      sub.bus.emit({ type: 'agent.status.updated', usage: USAGE });
    } finally {
      wiring.dispose();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'agent.status.updated', usage: USAGE });
    expect(events[0]).not.toHaveProperty('model');
  });
});

describe('SessionEventWiring pending interaction bridge', () => {
  it('bridges interactions already pending when the wiring is installed', async () => {
    const agent = new FakeAgentHandle('main');
    const approvals: string[] = [];
    const session = makeSessionWithInteractions(agent, [
      {
        id: 'ix-1',
        kind: 'approval',
        origin: { agentId: 'main' },
        payload: {
          toolCallId: 'tc-1',
          toolName: 'Bash',
          action: 'run command',
          display: { kind: 'generic', summary: 'run command' },
        },
      },
    ]);
    const wiring = new SessionEventWiring(session, {
      receiveEvent: () => undefined,
      requestApproval: (request) => {
        approvals.push(request.toolCallId);
        return Promise.resolve({ decision: 'approved' });
      },
      requestQuestion: () => Promise.resolve(null),
      toolCall: () => Promise.resolve({ output: 'not supported', isError: true }),
    });
    try {
      // The interaction was parked before the wiring existed (a handed-off
      // target adopted between creation and its first prompt): the bridge must
      // pick it up at construction instead of waiting for a change that may
      // never come — otherwise the engine request hangs and a no-handler
      // cancellation is the closest a host can get.
      await Promise.resolve();
      expect(approvals).toEqual(['tc-1']);
    } finally {
      wiring.dispose();
    }
  });

  it('bridges each pending interaction once and reports settled ones once', async () => {
    const agent = new FakeAgentHandle('main');
    const approvals: string[] = [];
    const settled: string[][] = [];
    const interactions = new FakeInteractions(agent);
    const wiring = new SessionEventWiring(interactions.session(), {
      receiveEvent: () => undefined,
      requestApproval: (request) => {
        approvals.push(request.toolCallId);
        return Promise.resolve({ decision: 'approved' });
      },
      requestQuestion: () => Promise.resolve(null),
      toolCall: () => Promise.resolve({ output: 'not supported', isError: true }),
      notifyInteractionSettled: (_sessionId, toolCallIds) => {
        settled.push([...toolCallIds]);
      },
    });
    try {
      interactions.park({
        id: 'ix-1',
        kind: 'approval',
        origin: { agentId: 'main' },
        payload: {
          toolCallId: 'tc-1',
          toolName: 'Bash',
          action: 'run command',
          display: { kind: 'generic', summary: 'run command' },
        },
      });
      interactions.notify();
      // The kernel re-fires the whole pending set on every change.
      interactions.notify();
      await Promise.resolve();
      expect(approvals).toEqual(['tc-1']);
      expect(settled).toEqual([]);

      // The kernel dropped it (turn cancelled): the host learns which panel to
      // discard, exactly once.
      interactions.settle('ix-1');
      interactions.notify();
      interactions.notify();
      expect(settled).toEqual([['tc-1']]);
      expect(approvals).toEqual(['tc-1']);
    } finally {
      wiring.dispose();
    }
  });
});

/**
 * A session fixture whose interaction kernel can park, settle and notify, so
 * the bridge's initial pickup / dedupe / settled reporting can be driven
 * without an engine.
 */
class FakeInteractions {
  private readonly pending = new Map<string, unknown>();
  private readonly listeners: Array<() => void> = [];

  constructor(private readonly agent: FakeAgentHandle) {}

  session(): ISessionScopeHandle {
    const lifecycle = {
      list: () => [this.agent],
      onDidCreate: () => ({ dispose: () => undefined }),
      onDidDispose: () => ({ dispose: () => undefined }),
    };
    const interactions = {
      onDidChangePending: (listener: () => void) => {
        this.listeners.push(listener);
        return {
          dispose: () => {
            const index = this.listeners.indexOf(listener);
            if (index >= 0) this.listeners.splice(index, 1);
          },
        };
      },
      listPending: () => [...this.pending.values()],
      decide: () => undefined,
    };
    const accessor = {
      get: (token: unknown): unknown => {
        if (token === IAgentLifecycleService) return lifecycle;
        if (token === ISessionInteractionService) return interactions;
        return undefined;
      },
    };
    return { id: 's1', kind: 1, accessor, dispose: () => undefined } as unknown as ISessionScopeHandle;
  }

  park(interaction: {
    id: string;
    kind: string;
    origin: { agentId: string };
    payload: Record<string, unknown>;
  }): void {
    this.pending.set(interaction.id, interaction);
  }

  settle(id: string): void {
    this.pending.delete(id);
  }

  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function makeSessionWithInteractions(
  agent: FakeAgentHandle,
  pending: readonly unknown[],
): ISessionScopeHandle {
  const lifecycle = {
    list: () => [agent],
    onDidCreate: () => ({ dispose: () => undefined }),
    onDidDispose: () => ({ dispose: () => undefined }),
  };
  const interactions = {
    onDidChangePending: () => ({ dispose: () => undefined }),
    listPending: () => pending,
    decide: () => undefined,
  };
  const accessor = {
    get: (token: unknown): unknown => {
      if (token === IAgentLifecycleService) return lifecycle;
      if (token === ISessionInteractionService) return interactions;
      return undefined;
    },
  };
  return { id: 's1', kind: 1, accessor, dispose: () => undefined } as unknown as ISessionScopeHandle;
}

describe('SessionEventWiring research / aitp_mode event forwarding', () => {
  it('drops the internal revision signal and keeps forwarding the public Research snapshot', () => {
    const agent = new FakeAgentHandle('main');
    const { sink, events } = collectingSink();
    const wiring = new SessionEventWiring(makeSession([agent]), sink);
    try {
      agent.bus.emit({ type: 'research.revision_advanced', notifyGoal: true });
      expect(events).toEqual([]);
      agent.bus.emit({
        type: 'research.updated',
        snapshot: { mode: 'ready', revision: 7 },
      });
    } finally {
      wiring.dispose();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'research.updated',
      snapshot: { mode: 'ready', revision: 7 },
    });
  });

  it('forwards research.updated with the full snapshot payload', () => {
    const agent = new FakeAgentHandle('main');
    const { sink, events } = collectingSink();
    const wiring = new SessionEventWiring(makeSession([agent]), sink);
    try {
      agent.bus.emit({
        type: 'research.updated',
        snapshot: {
          mode: 'ready',
          loopStatus: 'active',
          currentLineSlug: 'main',
          currentWorkstreamBinding: {
            lineSlug: 'main',
            status: 'bound',
            reason: 'Explicitly confirmed.',
            binding: {
              confirmationId: 'confirmation-main-1',
              lineSlug: 'main',
              workstream: 'verified-inputs',
              topicId: 'topic-1',
              observedRevision: 1,
              confirmedBy: 'user',
              confirmedAt: 1,
            },
          },
          lineWorkstreamBindings: [{
            confirmationId: 'confirmation-main-1',
            lineSlug: 'main',
            workstream: 'verified-inputs',
            topicId: 'topic-1',
            observedRevision: 1,
            confirmedBy: 'user',
            confirmedAt: 1,
          }],
          questions: [],
          lines: [],
          openQuestionCount: 0,
          activeQuestionCount: 0,
          blockedQuestionCount: 0,
          alerts: [],
          researchGoal: {
            schema: 'hakimi/research-goal-0.1',
            goalId: 'goal-1',
            objective: 'Validate the bounded stage.',
            scope: { programTopicId: 'topic-1', lineSlug: 'main', questionId: 'q1' },
            nonGoals: [],
            budget: {
              tokenBudget: null,
              turnBudget: 3,
              wallClockBudgetMs: null,
              remainingTokens: null,
              remainingTurns: 2,
              remainingWallClockMs: null,
              tokenBudgetReached: false,
              turnBudgetReached: false,
              wallClockBudgetReached: false,
              overBudget: false,
            },
            stopConditions: [],
            status: 'active',
            continuation: {
              state: 'held',
              owner: 'research',
              reason: 'A research checkpoint is pending commit.',
            },
            programRelation: {
              status: 'aligned',
              reason: 'Confirmed as goal_parent_of_program.',
            },
            humanGates: [],
            persistenceGuards: [{
              code: 'research.mode.ready',
              status: 'clear',
              reason: 'Research Mode is ready.',
            }],
            researchRevision: 3,
          },
          latestCommittedCheckpoint: {
            checkpointId: 'cp-distill',
            entryId: 'entry-distill',
            committedAt: 2,
          },
          distillationAttention: {
            schema: 'hakimi/research-distillation-attention-0.1',
            status: 'review_requested',
            checkpointId: 'cp-distill',
            entryId: 'entry-distill',
            recordedAt: 3,
          },
          aitpHealth: { phase: 'ready' },
          revision: 3,
        },
      });
    } finally {
      wiring.dispose();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'research.updated',
      sessionId: 's1',
      agentId: 'main',
      snapshot: {
        currentWorkstreamBinding: {
          status: 'bound',
          binding: { workstream: 'verified-inputs' },
        },
        lineWorkstreamBindings: [{ workstream: 'verified-inputs' }],
        researchGoal: {
          schema: 'hakimi/research-goal-0.1',
          goalId: 'goal-1',
          continuation: {
            state: 'held',
            owner: 'research',
            reason: 'A research checkpoint is pending commit.',
          },
        },
        distillationAttention: {
          status: 'review_requested',
          checkpointId: 'cp-distill',
          entryId: 'entry-distill',
        },
      },
    });
    // The snapshot payload must survive the translation intact.
    expect((events[0] as { snapshot?: { revision?: number } }).snapshot?.revision).toBe(3);
  });

  it('forwards a legacy Research Goal without inventing continuation state', () => {
    const agent = new FakeAgentHandle('main');
    const { sink, events } = collectingSink();
    const wiring = new SessionEventWiring(makeSession([agent]), sink);
    try {
      agent.bus.emit({
        type: 'research.updated',
        snapshot: {
          researchGoal: {
            schema: 'hakimi/research-goal-0.1',
            goalId: 'legacy-goal',
            objective: 'Resume one bounded legacy milestone.',
            status: 'active',
          },
          revision: 2,
        },
      });
    } finally {
      wiring.dispose();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'research.updated',
      sessionId: 's1',
      agentId: 'main',
      snapshot: {
        researchGoal: {
          goalId: 'legacy-goal',
          status: 'active',
        },
      },
    });
    expect((events[0] as {
      snapshot?: { researchGoal?: { continuation?: unknown } };
    }).snapshot?.researchGoal?.continuation).toBeUndefined();
  });

  it('forwards aitp_mode.updated as a bare signal', () => {
    const agent = new FakeAgentHandle('main');
    const { sink, events } = collectingSink();
    const wiring = new SessionEventWiring(makeSession([agent]), sink);
    try {
      agent.bus.emit({ type: 'aitp_mode.updated' });
    } finally {
      wiring.dispose();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'aitp_mode.updated',
      sessionId: 's1',
      agentId: 'main',
    });
  });
});
