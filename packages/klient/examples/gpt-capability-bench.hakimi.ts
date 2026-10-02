/** Production Hakimi adapter. Model calls, including subagents and compaction,
 * share the host proxy's persistent budget; this process never owns that budget. */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentHandle, SessionHandle } from '../src/core/klient.js';
import type { AgentContextData } from '../src/core/facade/agent.js';
import { mcpServerConfigSchema, type McpServerConfig } from '../src/contract/mcp.js';

export interface CapabilityPlan {
  model: string;
  effort: string;
  sessionId?: string;
  patch: boolean;
  catalog?: boolean;
  maxRequests: number;
  compactBeforePrompt?: boolean;
  promptProfile?: string;
  contextStrategy?: string;
  requiredMcpServer?: string;
  /** v3 fixture-only setup; known overlay names are part of the session baseline.
   * Request-boundary schema validation is still required separately by the host. */
  mcpFixtureOverlay?: boolean;
}

export function validateCapabilityPlan(plan: CapabilityPlan): void {
  if (!plan.model || !plan.effort || !Number.isSafeInteger(plan.maxRequests) || plan.maxRequests <= 0) throw new Error('Invalid capability plan');
  if (typeof plan.patch !== 'boolean' || !plan.patch) throw new Error('Capability A/B requires apply_patch=true in both arms');
  if (plan.catalog !== undefined && typeof plan.catalog !== 'boolean') throw new Error('Invalid catalog switch');
  if (plan.promptProfile !== undefined && plan.promptProfile !== 'production') throw new Error('Prompt experiments are not implemented');
  if (plan.contextStrategy !== undefined && plan.contextStrategy !== 'production') throw new Error('Context experiments are not implemented');
  if (plan.compactBeforePrompt === true && !plan.sessionId) throw new Error('Compaction requires a restored session');
  if (plan.mcpFixtureOverlay !== undefined && typeof plan.mcpFixtureOverlay !== 'boolean') throw new Error('Invalid MCP fixture overlay switch');
  if (plan.mcpFixtureOverlay === true && !plan.requiredMcpServer) throw new Error('MCP fixture overlay requires a named server');
}

/** The fixture stays sourced from the home file prepared by the host. Passing it
 * through the public session overlay API pins its name before agent creation;
 * it does not expose private registry state or certify model-visible readiness. */
export function capabilityMcpOverlay(serverName: string, file: unknown): Readonly<Record<string, McpServerConfig>> {
  if (file === null || typeof file !== 'object' || Array.isArray(file)) throw new Error('Invalid MCP fixture config');
  const servers = (file as Record<string, unknown>)['mcpServers'];
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers) || !Object.hasOwn(servers, serverName)) throw new Error('Named MCP fixture config is missing');
  const config = mcpServerConfigSchema.parse((servers as Record<string, unknown>)[serverName]);
  if (config.transport !== 'stdio' || config.enabled === false || config.executor === 'kaos' || config.runtime_id !== undefined && config.runtime_id !== 'local') throw new Error('MCP fixture overlay requires enabled local stdio');
  return { [serverName]: { ...config, runtime_id: 'local' } };
}

export interface CapabilityToolCall {
  agentId: string;
  toolCallId: string;
  name: string;
  args: unknown;
  output?: unknown;
  isError?: boolean;
  synthetic?: boolean;
  status: 'started' | 'succeeded' | 'failed' | 'synthetic' | 'unverified';
  source: 'event' | 'context';
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

/** Only matched, non-synthetic execution result events establish success. Context
 * fallback preserves missed child calls but cannot certify synthetic provenance. */
export class CapabilityEvidence {
  private readonly calls = new Map<string, CapabilityToolCall>();
  private readonly ignored = new Set<string>();
  readonly measurementErrors: string[] = [];

  ignoreHistory(agentId: string, history: AgentContextData['history']): void {
    for (const message of history) for (const call of message.toolCalls) this.ignored.add(`${agentId}:${call.id}`);
  }

  started(agentId: string, event: { toolCallId: string; name: string; args: unknown }): void {
    const key = `${agentId}:${event.toolCallId}`;
    if (this.ignored.has(key) || this.calls.has(key)) return;
    this.calls.set(key, { agentId, toolCallId: event.toolCallId, name: event.name, args: event.args, status: 'started', source: 'event' });
  }

  result(agentId: string, event: { toolCallId: string; output: unknown; isError?: boolean; synthetic?: boolean }): void {
    const key = `${agentId}:${event.toolCallId}`;
    if (this.ignored.has(key)) return;
    const call = this.calls.get(key);
    if (!call) {
      this.measurementErrors.push(`Unmatched tool result: ${key}`);
      return;
    }
    Object.assign(call, { output: event.output, isError: event.isError === true, synthetic: event.synthetic === true,
      status: event.synthetic === true ? 'synthetic' : event.isError === true ? 'failed' : 'succeeded' });
  }

  recoverContext(agentId: string, history: AgentContextData['history']): void {
    for (const message of history) {
      for (const call of message.toolCalls) {
        const key = `${agentId}:${call.id}`;
        if (this.ignored.has(key) || this.calls.has(key)) continue;
        let args: unknown = call.arguments;
        try { args = JSON.parse(call.arguments ?? 'null'); } catch { /* preserve malformed arguments */ }
        this.calls.set(key, { agentId, toolCallId: call.id, name: call.name, args, status: 'unverified', source: 'context' });
      }
      if (message.role === 'tool' && message.toolCallId !== undefined) {
        const call = this.calls.get(`${agentId}:${message.toolCallId}`);
        if (call?.source === 'context') Object.assign(call, { output: message.content, isError: message.isError === true });
      }
    }
  }

  snapshot(): { toolCalls: CapabilityToolCall[]; toolSuccesses: Record<string, number>; toolErrors: Record<string, number>; repeatedAttempts: number; measurementErrors: string[] } {
    const toolCalls = [...this.calls.values()];
    const toolSuccesses: Record<string, number> = {};
    const toolErrors: Record<string, number> = {};
    const signatures = new Set<string>();
    let repeatedAttempts = 0;
    for (const call of toolCalls) {
      if (call.status === 'succeeded') toolSuccesses[call.name] = (toolSuccesses[call.name] ?? 0) + 1;
      if (call.status === 'failed') toolErrors[call.name] = (toolErrors[call.name] ?? 0) + 1;
      const signature = `${call.agentId}:${call.name}:${canonical(call.args)}`;
      if (signatures.has(signature)) repeatedAttempts++;
      signatures.add(signature);
    }
    return { toolCalls, toolSuccesses, toolErrors, repeatedAttempts, measurementErrors: [...this.measurementErrors] };
  }
}

export function finalAssistantText(history: AgentContextData['history']): string {
  // The final assistant message is kept in full, including all text parts. Earlier
  // commentary is still retained in the context snapshot, but is not the delivery.
  const last = history.findLast((message) => message.role === 'assistant');
  if (!last || last.toolCalls.length > 0) return '';
  return last.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
}

/** Assistant messages need not have IDs and identical text can be newly emitted.
 * Slice from the first new durable prompt anchor; never deduplicate by content. */
export function incrementalHistory(history: AgentContextData['history'], previousIds?: ReadonlySet<string>): AgentContextData['history'] {
  if (previousIds === undefined) return history;
  const firstNew = history.findIndex((message) => message.id !== undefined && !previousIds.has(message.id));
  return firstNew === -1 ? [] : history.slice(firstNew);
}

type Sink = (event: Record<string, unknown>) => void;

async function compact(agent: AgentHandle, emit: Sink): Promise<void> {
  let settle: (error?: Error) => void = () => {};
  const done = new Promise<void>((yes, no) => { settle = (error) => { if (error) no(error); else yes(); }; });
  const subscriptions = [
    agent.events.on('compaction.completed', (event) => { emit({ type: 'capability.compaction', event }); settle(); }),
    agent.events.on('compaction.cancelled', () => { settle(new Error('Compaction cancelled')); }),
    agent.events.on('compaction.blocked', () => { settle(new Error('Compaction blocked')); }),
    agent.events.on('error', (event) => { settle(new Error(`Compaction failed: ${event.message}`)); }),
  ];
  try {
    if (!(await agent.compact())) throw new Error('Compaction was already active');
    // The outer sandbox owns the remaining task wall-clock limit, including this
    // request. Do not create a separate budget that resets after restoration.
    await done;
  } finally {
    for (const sub of subscriptions) sub.dispose();
  }
}

/** This only observes the shared/session connection view. It is deliberately
 * not called a tool-readiness barrier: the public facade exposes no registry
 * or schema-ready interface. The host verifies F02's initial main request. */
export async function waitForMcpConnection(agent: Pick<AgentHandle, 'getMcpServers'>, name: string): Promise<{ name: string; status: 'connected'; toolCount: number }> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const server = (await agent.getMcpServers()).find((entry) => entry.name === name);
    if (server?.status === 'connected' && server.toolCount > 0) return { name, status: 'connected', toolCount: server.toolCount };
    if (server && !['pending', 'connected'].includes(server.status)) throw new Error(`MCP ${name} ${server.status}: ${server.error ?? ''}`);
    await new Promise((done) => { setTimeout(done, 25); });
  }
  throw new Error(`MCP fixture did not become available: ${name}`);
}

/** Public-facade-only recording, also usable by the offline integration harness. */
export async function runCapabilityTurn(handle: SessionHandle, plan: CapabilityPlan, prompt: string, emit: Sink): Promise<Record<string, unknown>> {
  const evidence = new CapabilityEvidence();
  const agentHandles = new Map<string, AgentHandle>();
  const beforeHistory = new Map<string, Set<string>>();
  const beforeTasks = new Map<string, Set<string>>();
  const subscriptions: { dispose(): void }[] = [];
  const existing = await handle.agents();
  const compactions: unknown[] = [];
  const interventions: unknown[] = [];
  const interventionIds = new Set<string>();
  let refresh: Promise<void> = Promise.resolve();
  function attach(agentId: string): AgentHandle {
    const found = agentHandles.get(agentId);
    if (found) return found;
    const agent = handle.agent(agentId);
    agentHandles.set(agentId, agent);
    subscriptions.push(
      agent.events.onError((error) => { evidence.measurementErrors.push(`Agent ${agentId} event stream: ${error.message}`); }),
      agent.events.on('tool.call.started', (event) => { evidence.started(agentId, event); emit({ type: 'capability.event', agentId, event }); }),
      agent.events.on('tool.result', (event) => { evidence.result(agentId, event); emit({ type: 'capability.event', agentId, event }); }),
      agent.events.on('turn.started', (event) => { emit({ type: 'capability.event', agentId, event }); }),
      agent.events.on('turn.ended', (event) => { emit({ type: 'capability.event', agentId, event }); }),
      agent.events.on('compaction.completed', (event) => { compactions.push(event); }),
      agent.events.on('error', (event) => { emit({ type: 'capability.event', agentId, event }); }),
    );
    return agent;
  }
  const refreshAgents = async (): Promise<void> => {
    for (const id of Object.keys(await handle.agents())) attach(id);
  };
  try {
    subscriptions.push(handle.events.onError((error) => { evidence.measurementErrors.push(`Session event stream: ${error.message}`); }));
    for (const id of new Set(['main', ...Object.keys(existing)])) {
      const agent = attach(id);
      const history = (await agent.getContext()).history;
      evidence.ignoreHistory(id, history);
      beforeHistory.set(id, new Set(history.flatMap((message) => message.id === undefined ? [] : [message.id])));
      beforeTasks.set(id, new Set((await agent.getTasks()).map((task) => task.taskId)));
    }
    subscriptions.push(handle.events.on('metadata.changed', () => {
      refresh = refresh.then(refreshAgents).catch((error: unknown) => { evidence.measurementErrors.push(`Agent observation: ${String(error)}`); });
    }));
    subscriptions.push(handle.events.on('interactions.changed', (pending) => {
      // Required interventions, not fabricated human replies. Re-emitting the
      // pending list does not count the same interaction more than once.
      const added = pending.filter((interaction) => !interventionIds.has(interaction.id));
      for (const interaction of added) interventionIds.add(interaction.id);
      if (added.length > 0) { interventions.push(...added); emit({ type: 'capability.intervention', pending: added }); }
    }));
    const main = agentHandles.get('main')!;
    if (plan.requiredMcpServer) {
      const connection = await waitForMcpConnection(main, plan.requiredMcpServer);
      if (plan.mcpFixtureOverlay === true) emit({ type: 'capability.mcp.connection', connection, proofScope: 'connection-only', requestBoundaryValidationRequired: true });
    }
    if (plan.compactBeforePrompt === true) await compact(main, emit);
    let finish: (reason: string) => void = () => {};
    const ended = new Promise<string>((done) => { finish = done; });
    subscriptions.push(main.events.on('turn.ended', (event) => { finish(event.reason); }));
    subscriptions.push(main.events.on('prompt.aborted', () => { finish('aborted'); }));
    await main.prompt({ input: [{ type: 'text', text: prompt }] });
    const reason = await ended;
    await refresh;
    await refreshAgents();
    const agents: unknown[] = [];
    const tasks: unknown[] = [];
    let finalText = '';
    for (const [agentId, agent] of agentHandles) {
      try {
        const context = await agent.getContext();
        evidence.recoverContext(agentId, context.history);
        const history = incrementalHistory(context.history, beforeHistory.get(agentId));
        const text = finalAssistantText(history);
        if (agentId === 'main') finalText = text;
        agents.push({ agentId, newAgent: !Object.hasOwn(existing, agentId), finalText: text, context: { ...context, history } });
        for (const task of await agent.getTasks()) {
          if (beforeTasks.get(agentId)?.has(task.taskId)) continue;
          tasks.push({ ...task, agentId, output: await agent.getTaskOutput({ taskId: task.taskId }) });
        }
      } catch (error) { evidence.measurementErrors.push(`Agent ${agentId} snapshot: ${String(error)}`); }
    }
    const result = { type: 'capability.result', sessionId: plan.sessionId, reason, finalText, ...evidence.snapshot(), agents, tasks, compactions, interventions };
    emit(result);
    return result;
  } finally { for (const sub of subscriptions) sub.dispose(); }
}

export async function main(): Promise<void> {
  const plan = JSON.parse(await readFile('/run/plan.json', 'utf8')) as CapabilityPlan;
  validateCapabilityPlan(plan);
  let prompt = '';
  for await (const chunk of process.stdin) prompt += String(chunk);
  if (!prompt) throw new Error('A current-turn prompt is required on stdin');
  const { bootstrap, logSeed, resolveLoggingConfig } = await import('@moonshot-ai/agent-core-v2');
  const { createKlient } = await import('@moonshot-ai/klient/memory');
  const homeDir = '/home/bench/hakimi';
  const env = {
    PATH: process.env['PATH'], HOME: '/home/bench',
    KIMI_CODE_EXPERIMENTAL_APPLY_PATCH: 'true',
    KIMI_CODE_EXPERIMENTAL_TOOL_CATALOG: String(plan.catalog === true),
    KIMI_CODE_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL: 'false',
    KIMI_LOOP_MAX_STEPS_PER_TURN: String(plan.maxRequests),
    KIMI_LOOP_MAX_ATTEMPTS_PER_STEP: '1',
  };
  const { app } = bootstrap({ homeDir, cwd: '/workspace', env,
    clientIdentity: { productName: 'Hakimi', version: 'capability-bench-v1', platform: 'linux' } }, [...logSeed(resolveLoggingConfig({ homeDir, env }))]);
  const klient = createKlient({ scope: app });
  const emit: Sink = (event) => { process.stdout.write(JSON.stringify(event) + '\n'); };
  try {
    const mcpServers = plan.mcpFixtureOverlay === true
      ? capabilityMcpOverlay(plan.requiredMcpServer!, JSON.parse(await readFile(join(homeDir, 'mcp.json'), 'utf8')))
      : undefined;
    const sessionId = plan.sessionId ?? (await klient.global.sessions.create({ workDir: '/workspace', title: 'Capability evaluation', mcpServers })).id;
    const handle = klient.session(sessionId);
    if (plan.sessionId !== undefined && !(await handle.restore({ mcpServers }))) throw new Error('Session restore failed');
    const agent = handle.agent('main');
    if (plan.sessionId === undefined) {
      await agent.setModel('bench');
      await agent.setThinking(plan.effort);
      await agent.setPermission('yolo');
    } else if (await agent.getModel() !== 'bench' || await agent.getThinking() !== plan.effort) {
      throw new Error('Restored session model/effort differs from the frozen plan');
    }
    emit({ type: 'session.started', sessionId, resumed: plan.sessionId !== undefined });
    try {
      const result = await runCapabilityTurn(handle, { ...plan, sessionId }, prompt, emit);
      if (result['reason'] !== 'completed') process.exitCode = 1;
    } finally { await handle.close(); }
  } finally { await klient.close(); app.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
