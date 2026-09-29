import type { Event } from '@bhjia-phys/hakimi-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentSwarmProgressComponent } from '#/tui/components/messages/agent-swarm-progress';
import {
  SubAgentEventHandler,
  type SubagentLifecycleEvent,
} from '#/tui/controllers/subagent-event-handler';

function makeSwarmHandler() {
  const requestRender = vi.fn();
  const transcriptContainer = { addChild: vi.fn(), children: [] as unknown[] };
  const dockChild = { render: vi.fn(() => ['dock line']) };
  const host = {
    state: {
      appState: { availableModels: {} },
      ui: {
        requestRender,
        terminal: { rows: 40, columns: 120 },
        children: [transcriptContainer, dockChild],
      },
      transcriptContainer,
      dockContainer: undefined,
    },
    streamingUI: {
      getToolComponent: vi.fn(() => undefined),
      getActiveToolCall: vi.fn(() => undefined),
      onToolCallStart: vi.fn(),
      getTurnContext: vi.fn(() => ({ turnId: 1, step: 0 })),
      removeToolComponentIfInactive: vi.fn(),
      finalizeLiveTextBuffers: vi.fn(),
    },
    appendTranscriptEntry: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    updateActivityPane: vi.fn(),
  };
  const handler = new SubAgentEventHandler(host as never, {
    backgroundTasks: new Map(),
    backgroundTaskTranscriptedTerminal: new Set(),
    syncBackgroundAgentBadge: vi.fn(),
  });
  return { handler, requestRender, transcriptContainer, dockChild };
}

function swarmComponentOf(transcriptContainer: { addChild: ReturnType<typeof vi.fn> }) {
  return transcriptContainer.addChild.mock.calls[0]?.[0] as AgentSwarmProgressComponent;
}

function lifecycleEvent(
  type: 'subagent.spawned' | 'subagent.started' | 'subagent.completed',
  subagentId: string,
  parentToolCallId: string,
): SubagentLifecycleEvent {
  return {
    sessionId: 's1',
    agentId: 'main',
    type,
    subagentId,
    subagentName: 'explore',
    parentToolCallId,
    description: `task ${subagentId}`,
    runInBackground: false,
    resultSummary: type === 'subagent.completed' ? 'done' : undefined,
  } as unknown as SubagentLifecycleEvent;
}

function childEvent(type: 'assistant.delta' | 'tool.call.started', subagentId: string): Event {
  return {
    sessionId: 's1',
    agentId: subagentId,
    type,
    delta: type === 'assistant.delta' ? 'hello' : undefined,
    toolCallId: type === 'tool.call.started' ? 'tool-1' : undefined,
    name: type === 'tool.call.started' ? 'Read' : undefined,
    args: {},
  } as unknown as Event;
}

function startSwarmWithChild(handler: SubAgentEventHandler): void {
  handler.handleAgentSwarmToolCallStarted('tc-1', {
    description: 'Review changed files',
    items: ['src/a.ts'],
  });
  handler.handleLifecycleEvent(lifecycleEvent('subagent.spawned', 'child-1', 'tc-1'));
  handler.handleLifecycleEvent(lifecycleEvent('subagent.started', 'child-1', 'tc-1'));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SubAgentEventHandler swarm render batching', () => {
  it('batches child deltas while preserving lifecycle renders', () => {
    vi.useFakeTimers();
    const { handler, requestRender } = makeSwarmHandler();
    startSwarmWithChild(handler);
    requestRender.mockClear();

    handler.routeChildAgentEvent(childEvent('assistant.delta', 'child-1'));
    handler.routeChildAgentEvent(childEvent('tool.call.started', 'child-1'));
    expect(requestRender).not.toHaveBeenCalled();

    vi.advanceTimersByTime(80);
    expect(requestRender).toHaveBeenCalledTimes(1);

    requestRender.mockClear();
    handler.handleLifecycleEvent(lifecycleEvent('subagent.completed', 'child-1', 'tc-1'));
    expect(requestRender).toHaveBeenCalled();
  });
});

describe('SubAgentEventHandler swarm grid height measurement', () => {
  it('reuses measurement once per microtask for unchanged terminal dimensions', async () => {
    const { handler, transcriptContainer, dockChild } = makeSwarmHandler();
    startSwarmWithChild(handler);
    const component = swarmComponentOf(transcriptContainer);

    component.render(120);
    component.render(120);
    expect(dockChild.render).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    component.render(120);
    expect(dockChild.render).toHaveBeenCalledTimes(2);
    handler.clearAgentSwarmProgress();
  });
});
