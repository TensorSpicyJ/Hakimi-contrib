/**
 * Scenario (v1 `tool-select.e2e.test.ts` headline parity): progressive tool
 * disclosure converges the provider-visible table for MCP and opted-in user
 * tools, keeps it byte-stable across loads, makes a loaded tool dispatchable
 * the next step, and self-heals the loaded-ledger across undo.
 *
 * Responsibilities: assert v1 contract at the provider wire, not via service
 * internals: the manifest announcement reaches the model, `select_tools`
 * loads a schema into the next request, the top-level table never changes
 * across loads, the record carries the disclosure gate (v1 recorder parity,
 * F2), and a tail-slicing undo re-enables re-injection (F1). Wiring:
 * testAgent harness with scripted provider, real toolSelect / executor /
 * projector / announcer services; harness builds the Agent scope without
 * `AgentLifecycleService.create`, so the eager-instantiation production
 * would do (agentLifecycleService create) is forced here the same way.
 * The flag env is stubbed before `createTestAgent` snapshots it into
 * bootstrap, and module imports register the flag / tool contributions the
 * way `src/index.ts` does in production.
 * Run: ../../node_modules/.bin/vitest run test/toolSelect/toolSelect.e2e.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { contextContinuityFlag } from '#/agent/fullCompaction/flag';
import { IAgentConversationUndoService } from '#/agent/undo/undo';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ExecutableTool, ToolExecution } from '#/tool/toolContract';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { TOOL_CATALOG_FLAG_ENV, TOOL_SELECT_FLAG_ENV } from '#/agent/toolSelect/flag';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IAgentToolSelectAnnouncementsService } from '#/agent/toolSelect/toolSelectAnnouncements';
import { IAgentToolSelectSchemasService } from '#/agent/toolSelect/toolSelectSchemas';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import '#/agent/tools/select-tools/selectToolsTool';

import { createTestAgent, InMemoryWireRecordPersistence, type TestAgentContext } from '../../harness';

const MCP_ALPHA = 'mcp__srv__alpha';
const DASHBOARD_TOOL = 'dashboard_create';

const DISCLOSURE_CAPABILITIES = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: 128_000,
  dynamically_loaded_tools: true,
} as const;

type WireEvent = Extract<
  TestAgentContext['allEvents'][number],
  { readonly type: '[wire]' }
>;

class StubMcpTool implements ExecutableTool<Record<string, unknown>> {
  readonly description: string;
  readonly parameters: Record<string, unknown> = {
    type: 'object',
    properties: { query: { type: 'string' } },
    additionalProperties: false,
  };
  calls = 0;

  constructor(readonly name: string, description = `${name} desc`) {
    this.description = description;
  }

  resolveExecution(): ToolExecution {
    return {
      description: `stub ${this.name}`,
      approvalRule: this.name,
      execute: async () => {
        this.calls += 1;
        return { output: 'mcp ok' };
      },
    };
  }
}

function wireEvents(ctx: TestAgentContext, eventName: string): readonly WireEvent[] {
  return ctx.allEvents.filter(
    (event): event is WireEvent => event.type === '[wire]' && event.event === eventName,
  );
}

function selectToolsCall(id: string, names: readonly string[]) {
  return {
    type: 'function' as const,
    id,
    name: 'select_tools',
    arguments: JSON.stringify({ names }),
  };
}

function toolNames(tools: readonly { readonly name: string }[]): string[] {
  return tools.map((tool) => tool.name);
}

function historyText(history: readonly ContextMessage[]): string {
  return history
    .flatMap((message) => message.content)
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

describe('ordinary tool catalog end-to-end', () => {
  it('runs a common workspace tool directly while keeping specialized schemas out of the request', async () => {
    vi.stubEnv(TOOL_CATALOG_FLAG_ENV, '1');
    const ctx = createTestAgent();
    const registrations: Array<{ dispose(): void }> = [];
    try {
      ctx.get(IAgentToolSelectService);
      ctx.get(IAgentToolSelectAnnouncementsService);
      ctx.get(IAgentToolSelectSchemasService);
      ctx.configure({ modelCapabilities: { ...DISCLOSURE_CAPABILITIES, dynamically_loaded_tools: false } });
      await ctx.rpc.setPermission({ mode: 'yolo' });
      const read = new StubMcpTool('Read', 'Read workspace text.');
      const specialized = new StubMcpTool(MCP_ALPHA, 'Search research articles by topic.');
      const registry = ctx.get(IAgentToolRegistryService);
      registrations.push(registry.register(read, { source: 'builtin' }), registry.register(specialized, { source: 'mcp' }));
      ctx.mockNextResponse({ type: 'function', id: 'read_file', name: 'Read', arguments: '{"query":"example.txt"}' });
      ctx.mockNextResponse({ type: 'text', text: 'done' });

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Read the workspace text.' }] });
      await ctx.untilTurnEnd();

      expect(ctx.llmCalls).toHaveLength(2);
      expect(read.calls).toBe(1);
      expect(specialized.calls).toBe(0);
      for (const call of ctx.llmCalls) {
        expect(toolNames(call.tools)).toContain('Read');
        expect(toolNames(call.tools)).not.toContain(MCP_ALPHA);
      }
      expect(historyText(ctx.get(IAgentContextMemoryService).get())).not.toContain('Loaded:');
    } finally {
      for (const registration of registrations) registration.dispose();
      await ctx.dispose();
      vi.unstubAllEnvs();
    }
  });

  it.each([false, true])('discovers, loads and rediscovers after full compaction with continuity=%s', async (continuity) => {
    vi.stubEnv(TOOL_CATALOG_FLAG_ENV, '1');
    vi.stubEnv(contextContinuityFlag.env, continuity ? '1' : '0');
    const ctx = createTestAgent();
    let registration: { dispose(): void } | undefined;
    try {
      ctx.get(IAgentToolSelectService);
      ctx.get(IAgentToolSelectAnnouncementsService);
      ctx.get(IAgentToolSelectSchemasService);
      ctx.configure({ modelCapabilities: { ...DISCLOSURE_CAPABILITIES, dynamically_loaded_tools: false } });
      await ctx.rpc.setPermission({ mode: 'yolo' });
      const earlyConstraint = 'Do not modify raw measurements; use read-only searches.';
      ctx.get(IAgentContextMemoryService).append({
        role: 'user', content: [{ type: 'text', text: earlyConstraint }], toolCalls: [], origin: { kind: 'user' },
      });
      const alpha = new StubMcpTool(MCP_ALPHA, 'Search research articles by topic.\n\nFull usage details that belong only in a loaded definition.');
      registration = ctx.get(IAgentToolRegistryService).register(alpha, { source: 'mcp' });
      ctx.mockNextResponse(selectToolsCall('catalog_select', [MCP_ALPHA]));
      ctx.mockNextResponse({ type: 'function', id: 'catalog_call', name: MCP_ALPHA, arguments: '{"query":"example"}' });
      ctx.mockNextResponse({ type: 'text', text: 'done' });

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Find research articles about superconductivity.' }] });
      await ctx.untilTurnEnd();

      expect(ctx.llmCalls).toHaveLength(3);
      expect(toolNames(ctx.llmCalls[0]!.tools)).toContain('select_tools');
      expect(toolNames(ctx.llmCalls[0]!.tools)).not.toContain(MCP_ALPHA);
      expect(historyText(ctx.llmCalls[0]!.history)).toContain(MCP_ALPHA);
      expect(historyText(ctx.llmCalls[0]!.history)).toContain('Search research articles by topic.');
      expect(historyText(ctx.llmCalls[0]!.history)).not.toContain('Full usage details');
      expect(ctx.llmCalls[1]!.tools.find((tool) => tool.name === MCP_ALPHA)?.parameters).toEqual(alpha.parameters);
      expect(ctx.llmCalls[1]!.history.some((message) => message.tools !== undefined)).toBe(false);
      expect(alpha.calls).toBe(1);
      expect(ctx.get(IAgentContextMemoryService).get().some((message) => message.tools?.some((tool) => tool.name === MCP_ALPHA))).toBe(true);

      const memory = ctx.get(IAgentContextMemoryService);
      ctx.mockNextResponse({ type: 'text', text: 'Continue finding articles about superconductivity.' });
      const compaction = ctx.get(IAgentFullCompactionService);
      expect(compaction.begin({ source: 'manual' })).toBe(true);
      const pending = compaction.compacting;
      expect(pending).not.toBeNull();
      await pending!.promise;
      expect(compaction.diagnostics()).toMatchObject({ enabled: continuity, lastRun: { outcome: 'completed' } });
      expect(historyText(memory.get())).toContain(earlyConstraint);
      expect(memory.get().some((message) => message.tools !== undefined)).toBe(false);
      expect(ctx.get(IAgentToolSelectService).shapeTools(ctx.get(IAgentToolRegistryService).list()).some((tool) => tool.name === MCP_ALPHA)).toBe(false);
      const postCompactionCallIndex = ctx.llmCalls.length;
      ctx.mockNextResponse(selectToolsCall('catalog_select_again', [MCP_ALPHA]));
      ctx.mockNextResponse({ type: 'function', id: 'catalog_call_again', name: MCP_ALPHA, arguments: '{"query":"example"}' });
      ctx.mockNextResponse({ type: 'text', text: 'done again' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Continue the article search.' }] });
      await ctx.untilTurnEnd();
      expect(historyText(ctx.llmCalls[postCompactionCallIndex]!.history)).toContain(earlyConstraint);
      expect(historyText(ctx.llmCalls[postCompactionCallIndex]!.history)).toContain('Search research articles by topic.');
      expect(toolNames(ctx.llmCalls[postCompactionCallIndex]!.tools)).not.toContain(MCP_ALPHA);
      expect(toolNames(ctx.llmCalls[postCompactionCallIndex + 1]!.tools)).toContain(MCP_ALPHA);
      expect(alpha.calls).toBe(2);
    } finally {
      registration?.dispose();
      await ctx.dispose();
      vi.unstubAllEnvs();
    }
  });

  it('keeps denied capabilities out of discovery and rejects a direct call under the same policy', async () => {
    vi.stubEnv(TOOL_CATALOG_FLAG_ENV, '1');
    const ctx = createTestAgent();
    let registration: { dispose(): void } | undefined;
    try {
      ctx.get(IAgentToolSelectService);
      ctx.get(IAgentToolSelectAnnouncementsService);
      ctx.get(IAgentToolSelectSchemasService);
      ctx.configure({ modelCapabilities: { ...DISCLOSURE_CAPABILITIES, dynamically_loaded_tools: false } });
      await ctx.rpc.setPermission({ mode: 'yolo' });
      const alpha = new StubMcpTool(MCP_ALPHA, 'Search research articles by topic.');
      registration = ctx.get(IAgentToolRegistryService).register(alpha, { source: 'mcp' });
      await ctx.get(ISessionToolPolicy).setDisabledTools([MCP_ALPHA]);
      ctx.mockNextResponse({ type: 'function', id: 'denied_call', name: MCP_ALPHA, arguments: '{"query":"example"}' });
      ctx.mockNextResponse({ type: 'text', text: 'unavailable' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Find research articles.' }] });
      await ctx.untilTurnEnd();
      expect(toolNames(ctx.llmCalls[0]!.tools)).not.toContain(MCP_ALPHA);
      expect(historyText(ctx.llmCalls[0]!.history)).not.toContain(MCP_ALPHA);
      expect(historyText(ctx.llmCalls[0]!.history)).not.toContain('Search research articles by topic.');
      expect(historyText(ctx.llmCalls[1]!.history)).toContain('disabled by the active tool policy');
      expect(alpha.calls).toBe(0);
    } finally {
      registration?.dispose();
      await ctx.dispose();
      vi.unstubAllEnvs();
    }
  });

  it('restores selected tools from persisted conversation records and applies current session restrictions', async () => {
    vi.stubEnv(TOOL_CATALOG_FLAG_ENV, '1');
    const persistence = new InMemoryWireRecordPersistence();
    const ctx = createTestAgent({ persistence });
    let resumed: TestAgentContext | undefined;
    const registrations: Array<{ dispose(): void }> = [];
    try {
      ctx.get(IAgentToolSelectService);
      ctx.get(IAgentToolSelectAnnouncementsService);
      ctx.get(IAgentToolSelectSchemasService);
      ctx.configure({ modelCapabilities: { ...DISCLOSURE_CAPABILITIES, dynamically_loaded_tools: false } });
      await ctx.rpc.setPermission({ mode: 'yolo' });
      registrations.push(ctx.get(IAgentToolRegistryService).register(new StubMcpTool(MCP_ALPHA), { source: 'mcp' }));
      ctx.mockNextResponse(selectToolsCall('persisted_select', [MCP_ALPHA]));
      ctx.mockNextResponse({ type: 'text', text: 'loaded' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Load the research search tool.' }] });
      await ctx.untilTurnEnd();

      await ctx.wire.flush();
      resumed = createTestAgent({ autoConfigure: false, persistence: new InMemoryWireRecordPersistence(persistence.records) });
      await resumed.restorePersisted();
      resumed.configure({ modelCapabilities: { ...DISCLOSURE_CAPABILITIES, dynamically_loaded_tools: false } });
      resumed.get(IAgentToolSelectAnnouncementsService);
      resumed.get(IAgentToolSelectSchemasService);
      const alpha = new StubMcpTool(MCP_ALPHA);
      registrations.push(resumed.get(IAgentToolRegistryService).register(alpha, { source: 'mcp' }));
      resumed.mockNextResponse({ type: 'function', id: 'resumed_call', name: MCP_ALPHA, arguments: '{"query":"example"}' });
      resumed.mockNextResponse({ type: 'text', text: 'continued' });
      await resumed.rpc.prompt({ input: [{ type: 'text', text: 'Continue searching.' }] });
      await resumed.untilTurnEnd();
      expect(toolNames(resumed.llmCalls[0]!.tools)).toContain(MCP_ALPHA);
      expect(alpha.calls).toBe(1);
      expect(resumed.get(IAgentToolSelectService).load([MCP_ALPHA]).alreadyAvailable).toEqual([MCP_ALPHA]);

      await resumed.get(ISessionToolPolicy).setDisabledTools([MCP_ALPHA]);
      expect(resumed.get(IAgentToolSelectService).shapeTools(resumed.get(IAgentToolRegistryService).list()).map((entry) => entry.name)).not.toContain(MCP_ALPHA);
      expect(resumed.get(IAgentToolSelectService).load([MCP_ALPHA]).unknown).toEqual([MCP_ALPHA]);
    } finally {
      for (const registration of registrations) registration.dispose();
      await resumed?.dispose();
      await ctx.dispose();
      vi.unstubAllEnvs();
    }
  });
});

describe('progressive tool disclosure end-to-end', () => {
  let ctx: TestAgentContext;
  let alpha: StubMcpTool;
  let registration: { dispose(): void } | undefined;

  beforeEach(async () => {
    vi.stubEnv(TOOL_SELECT_FLAG_ENV, '1');
    ctx = createTestAgent();
    ctx.get(IAgentToolSelectService);
    ctx.get(IAgentToolSelectAnnouncementsService);
    ctx.get(IAgentToolSelectSchemasService);
    ctx.get(IAgentToolExecutorService);
    ctx.configure({ modelCapabilities: DISCLOSURE_CAPABILITIES });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    alpha = new StubMcpTool(MCP_ALPHA);
    registration = ctx.get(IAgentToolRegistryService).register(alpha, { source: 'mcp' });
  });

  afterEach(async () => {
    registration?.dispose();
    vi.unstubAllEnvs();
    await ctx.dispose();
  });

  it('announces the manifest, loads by name, keeps the top-level table byte-stable, and dispatches on the next step', async () => {
    ctx.mockNextResponse(selectToolsCall('call_select_1', [MCP_ALPHA]));
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_alpha_1',
      name: MCP_ALPHA,
      arguments: JSON.stringify({ query: 'moon' }),
    });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'try the srv alpha tool' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(3);

    const firstWire = ctx.llmCalls[0]!;
    expect(toolNames(firstWire.tools)).not.toContain(MCP_ALPHA);
    expect(toolNames(firstWire.tools)).toContain('select_tools');
    const announcementText = firstWire.history
      .map((message) =>
        message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
      )
      .join('\n');
    expect(announcementText).toContain('<tools_added>');
    expect(announcementText).toContain(MCP_ALPHA);

    const requests = wireEvents(ctx, 'llm.request').filter(
      (event) => (event.args as { kind?: string }).kind === 'loop',
    );
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect((request.args as { toolSelect?: boolean }).toolSelect).toBe(true);
    }

    const secondWire = ctx.llmCalls[1]!;
    const schemaMessages = secondWire.history.filter(
      (message) => message.tools?.some((tool) => tool.name === MCP_ALPHA),
    );
    expect(schemaMessages).toHaveLength(1);

    const alphaFromSchema = schemaMessages[0]!.tools!.find((tool) => tool.name === MCP_ALPHA)!;
    expect(alphaFromSchema.parameters).toEqual(alpha.parameters);

    expect(secondWire.tools).toEqual(firstWire.tools);
    expect(wireEvents(ctx, 'llm.tools_snapshot')).toHaveLength(1);

    expect(alpha.calls).toBe(1);
  });

  it('loads and dispatches a user tool registered through the domain service', async () => {
    ctx.get(IAgentUserToolService).register({
      name: DASHBOARD_TOOL,
      description: 'Create a dashboard.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false,
      },
      disclosure: 'deferred',
    });
    ctx.mockNextResponse(selectToolsCall('call_select_1', [DASHBOARD_TOOL]));
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_dashboard_1',
      name: DASHBOARD_TOOL,
      arguments: JSON.stringify({ title: 'Operations' }),
    });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'create a dashboard' }] });
    await ctx.untilToolCall({ output: 'dashboard-created' });
    await ctx.untilTurnEnd();

    const firstWire = ctx.llmCalls[0]!;
    expect(toolNames(firstWire.tools)).not.toContain(DASHBOARD_TOOL);
    expect(historyText(firstWire.history)).toContain(DASHBOARD_TOOL);

    const secondWire = ctx.llmCalls[1]!;
    const injected = secondWire.history.find((message) =>
      message.tools?.some((tool) => tool.name === DASHBOARD_TOOL),
    );
    expect(injected?.tools?.find((tool) => tool.name === DASHBOARD_TOOL)?.parameters).toEqual({
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    });
    expect(secondWire.tools).toEqual(firstWire.tools);
    expect(historyText(ctx.get(IAgentContextMemoryService).get())).toContain(
      `Loaded: ${DASHBOARD_TOOL}`,
    );
    expect(historyText(ctx.get(IAgentContextMemoryService).get())).toContain(
      'dashboard-created',
    );
  });

  it('re-injects a selected schema after undo slices the tail of the loaded exchange', async () => {
    ctx.get(IAgentContextMemoryService).append({
      role: 'user',
      content: [{ type: 'text', text: 'earlier question' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });

    ctx.mockNextResponse(selectToolsCall('call_select_1', [MCP_ALPHA]));
    ctx.mockNextResponse({ type: 'text', text: 'alpha is loaded' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load alpha' }] });
    await ctx.untilTurnEnd();

    await ctx.get(IAgentConversationUndoService).undo(1);
    const afterUndo = ctx.get(IAgentContextMemoryService).get();
    expect(afterUndo.some((message) => message.tools?.some((tool) => tool.name === MCP_ALPHA))).toBe(
      false,
    );

    ctx.mockNextResponse(selectToolsCall('call_select_2', [MCP_ALPHA]));
    ctx.mockNextResponse({ type: 'text', text: 'reloaded' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load alpha again' }] });
    await ctx.untilTurnEnd();

    const afterReload = ctx.get(IAgentContextMemoryService).get();
    expect(
      afterReload.some((message) => message.tools?.some((tool) => tool.name === MCP_ALPHA)),
    ).toBe(true);
    expect(historyText(afterReload)).toContain('Loaded: mcp__srv__alpha');
    expect(historyText(afterReload)).not.toContain('Already available: mcp__srv__alpha');
  });
});
