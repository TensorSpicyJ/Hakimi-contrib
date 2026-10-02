/**
 * `BackgroundSessionsController` — the session this process adopted from a
 * cross-project handoff (agent-core-v2's `StartSession` host side).
 *
 * Covers the guarantees the TUI relies on: the process becomes a handoff host
 * only when the engine can host one, the adopted session's approval / question
 * handlers and event subscription are installed before the engine submits its
 * first prompt, the viewer is read-only (opening or closing it never touches
 * the session), pending requests are scoped to their session and dropped when
 * the engine stops waiting for them, and the exit hint says the session stops
 * with this process.
 *
 * The last block drives the same guarantees against a REAL agent-core-v2 engine
 * with a scripted in-process model (no HTTP, no external LLM), so the bridge
 * from the engine's first-turn approval through the controller to the
 * reverse-rpc UI hooks is exercised end to end.
 *
 * Run: pnpm exec vitest run test/tui/controllers/background-sessions.test.ts
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KimiHarness,
  SDKRpcClientV2,
  type ApprovalRequest,
  type ApprovalResponse,
  type HandoffSessionInfo,
  type QuestionRequest,
  type QuestionResult,
  type Session,
  type SessionSummary,
} from '@bhjia-phys/hakimi-sdk';
import {
  IProtocolAdapterRegistry,
  ISessionHandoffCoordinator,
  UNKNOWN_CAPABILITY,
  type ChatProvider,
  type FinishReason,
  type ScopeSeed,
  type StreamedMessage,
  type StreamedMessagePart,
  type TokenUsage,
} from '@moonshot-ai/agent-core-v2';
import type { Component, TUI } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BackgroundSessionsController,
  type BackgroundSessionsHost,
} from '#/tui/controllers/background-sessions';
import { ApprovalController } from '#/tui/reverse-rpc/approval/controller';
import { QuestionController } from '#/tui/reverse-rpc/question/controller';
import { registerReverseRPCHandlers } from '#/tui/reverse-rpc/index';
import type { ApprovalPanelData } from '#/tui/reverse-rpc/types';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Mirrors the real `Session` facade's closed-state behavior: once closed, the
 * handler setters throw (the SDK's `ensureOpen`), and `isClosed` reports it.
 */
class FakeSession {
  readonly summary: SessionSummary;
  approvalHandler: ((request: ApprovalRequest) => Promise<ApprovalResponse>) | undefined;
  questionHandler: ((request: QuestionRequest) => Promise<QuestionResult>) | undefined;
  readonly eventListeners = new Set<(event: unknown) => void>();
  readonly close = vi.fn(async () => undefined);
  closed = false;

  constructor(
    readonly id: string,
    workDir: string,
    title?: string,
  ) {
    this.summary = { id, workDir, title } as unknown as SessionSummary;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  setApprovalHandler(handler: ((request: ApprovalRequest) => Promise<ApprovalResponse>) | undefined): void {
    if (this.closed) throw new Error('Session is closed');
    this.approvalHandler = handler;
  }

  setQuestionHandler(handler: ((request: QuestionRequest) => Promise<QuestionResult>) | undefined): void {
    if (this.closed) throw new Error('Session is closed');
    this.questionHandler = handler;
  }

  onEvent(listener: (event: unknown) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  emit(event: unknown): void {
    for (const listener of [...this.eventListeners]) listener(event);
  }

  asSession(): Session {
    return this as unknown as Session;
  }
}

class FakeHarness {
  readonly sessions = new Map<string, FakeSession>();
  handoffOptions:
    | { onSessionReady: (session: Session, info: HandoffSessionInfo) => void | Promise<void> }
    | undefined;
  enableCalls = 0;

  constructor(private readonly supportsHandoff = true) {}

  supportsSessionHandoff(): boolean {
    return this.supportsHandoff;
  }

  enableSessionHandoff(options: {
    onSessionReady: (session: Session, info: HandoffSessionInfo) => void | Promise<void>;
  }): boolean {
    this.enableCalls += 1;
    this.handoffOptions = options;
    return true;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id)?.asSession();
  }

  asHarness(): KimiHarness {
    return this as unknown as KimiHarness;
  }
}

function fakeUI(): { ui: TUI; children: Component[]; focus: unknown[] } {
  const children: Component[] = [];
  const focus: unknown[] = [];
  const ui = {
    clear: () => {
      children.length = 0;
    },
    addChild: (child: Component) => {
      children.push(child);
    },
    setFocus: (component: unknown) => {
      focus.push(component);
    },
    requestRender: () => undefined,
  };
  Object.defineProperty(ui, 'children', { get: () => children });
  return { ui: ui as unknown as TUI, children, focus };
}

interface Harness {
  readonly controller: BackgroundSessionsController;
  readonly harness: FakeHarness;
  readonly approvals: ApprovalController;
  readonly questions: QuestionController;
  readonly statuses: string[];
  readonly editor: unknown;
  readonly uiChildren: Component[];
}

function makeController(supportsHandoff = true): Harness {
  const harness = new FakeHarness(supportsHandoff);
  const approvals = new ApprovalController();
  const questions = new QuestionController();
  const statuses: string[] = [];
  const editor = {};
  const { ui, children: uiChildren } = fakeUI();
  const host: BackgroundSessionsHost = {
    harness: harness.asHarness(),
    state: {
      ui,
      editor: editor as never,
      terminal: { rows: 24, columns: 80 } as never,
    },
    showStatus: (message) => {
      statuses.push(message);
    },
  };
  const controller = new BackgroundSessionsController(host, { approval: approvals, question: questions });
  return { controller, harness, approvals, questions, statuses, editor, uiChildren };
}

async function adopt(
  fixture: Harness,
  session: FakeSession,
  info: Partial<HandoffSessionInfo> = {},
): Promise<void> {
  const options = fixture.harness.handoffOptions;
  if (options === undefined) throw new Error('handoff was not enabled');
  await options.onSessionReady(session.asSession(), {
    sessionId: session.id,
    workspaceId: 'ws-b',
    workDir: '/tmp/project-b',
    sourceSessionId: 'ses_a',
    sourceWorkDir: '/tmp/project-a',
    prompt: 'port the parser and run its tests',
    ...info,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BackgroundSessionsController host opt-in', () => {
  it('registers a host on a supporting engine and stays out on an unsupported one', () => {
    const supported = makeController(true);
    expect(supported.controller.attach()).toBe(true);
    expect(supported.harness.handoffOptions).toBeDefined();

    // The legacy v1 engine: no host, so the engine reports the handoff tool as
    // unavailable instead of parking a request nobody can answer.
    const unsupported = makeController(false);
    expect(unsupported.controller.attach()).toBe(false);
    expect(unsupported.harness.handoffOptions).toBeUndefined();
  });

  it('is idempotent: a second attach keeps the first registration', () => {
    const fixture = makeController();
    expect(fixture.controller.attach()).toBe(true);
    const first = fixture.harness.handoffOptions;
    expect(first).toBeDefined();

    // The controller owns one host registration; the second call does not
    // replace the options in force and still reports that it is hosting.
    expect(fixture.controller.attach()).toBe(true);
    expect(fixture.harness.enableCalls).toBe(1);
    expect(fixture.harness.handoffOptions).toBe(first);
  });

  it('installs the handlers and event subscription before the first prompt', async () => {
    const fixture = makeController();
    fixture.controller.attach();
    const session = new FakeSession('ses_b', '/tmp/project-b', 'Port the parser');
    fixture.harness.sessions.set(session.id, session);

    await adopt(fixture, session);

    // `onSessionReady` resolves only after the bridge is in place — the engine
    // enqueues the first prompt after it, so the first approval already has a
    // handler (no "No approval handler registered." cancellation).
    expect(session.approvalHandler).toBeDefined();
    expect(session.questionHandler).toBeDefined();
    expect(session.eventListeners.size).toBe(1);
    expect(fixture.statuses).toEqual([
      'Background session started in /tmp/project-b (ses_b) — press /sessions to view it',
    ]);
    // Nothing in the foreground: neither the session on screen nor its cwd
    // changes because a session was handed off.
    expect(fixture.harness.sessions.get(session.id)).toBe(session);
  });

  it('routes the adopted session\u2019s approval through the shared controller with its identity', async () => {
    const fixture = makeController();
    fixture.controller.attach();
    const session = new FakeSession('ses_b', '/tmp/project-b', 'Port the parser');
    fixture.harness.sessions.set(session.id, session);
    await adopt(fixture, session);

    const response = session.approvalHandler?.({
      toolCallId: 'tc-b',
      toolName: 'Bash',
      action: 'run command: pnpm test',
      display: { kind: 'generic', summary: 'pnpm test' },
    });

    expect(fixture.approvals.pendingCountForSession('ses_b')).toBe(1);
    expect(fixture.controller.pickerRows()).toEqual([
      {
        sessionId: 'ses_b',
        workDir: '/tmp/project-b',
        title: 'Port the parser',
        status: 'waiting',
        pendingRequests: 1,
      },
    ]);
    fixture.approvals.respond({ decision: 'approved' });
    await expect(response).resolves.toEqual({ decision: 'approved' });
    expect(fixture.approvals.pendingCountForSession('ses_b')).toBe(0);
  });

  it('does not claim progress before a turn exists', async () => {
    const fixture = makeController();
    fixture.controller.attach();
    const session = new FakeSession('ses_b', '/tmp/project-b');
    fixture.harness.sessions.set(session.id, session);
    await adopt(fixture, session);

    // A handoff whose first prompt never ran (blocked / failed / cancelled
    // before submission) produces no turn events at all: the session must not
    // sit on a "starting" label forever. `idle` is the honest label, and the
    // accurate failure stays in the `StartSession` tool result.
    expect(fixture.controller.pickerRows()[0]?.status).toBe('idle');

    session.emit({
      type: 'turn.started',
      sessionId: 'ses_b',
      agentId: 'main',
      turnId: 1,
      origin: 'user',
    });
    expect(fixture.controller.pickerRows()[0]?.status).toBe('running');
  });

  it('keeps an adopted session idempotent: a re-adopt releases the old subscription', async () => {
    const fixture = makeController();
    fixture.controller.attach();
    const session = new FakeSession('ses_b', '/tmp/project-b');
    fixture.harness.sessions.set(session.id, session);
    await adopt(fixture, session);

    const pending = session.approvalHandler?.({
      toolCallId: 'tc-old',
      toolName: 'Bash',
      action: 'run command: old',
      display: { kind: 'generic', summary: 'old' },
    });
    expect(fixture.controller.pickerRows()).toHaveLength(1);

    await adopt(fixture, session, { prompt: 'the second task' });

    // Exactly one entry and one live subscription: the superseded entry's
    // listener was released instead of leaking, and its request was answered.
    expect(fixture.controller.pickerRows()).toHaveLength(1);
    expect(session.eventListeners.size).toBe(1);
    await expect(pending).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'session re-adopted',
    });
    expect(fixture.statuses).toHaveLength(2);
  });
});

describe('BackgroundSessionsController viewer', () => {
  it('opens and closes the viewer without touching the running session', async () => {
    const fixture = makeController();
    fixture.controller.attach();
    const session = new FakeSession('ses_b', '/tmp/project-b');
    fixture.harness.sessions.set(session.id, session);
    await adopt(fixture, session);

    expect(fixture.controller.view('ses_b')).toBe(true);
    expect(fixture.controller.viewingSessionId).toBe('ses_b');
    // The screen-takeover swap mounted the viewer over the TUI's children.
    expect(fixture.uiChildren).toHaveLength(1);

    fixture.controller.dismissView();

    expect(fixture.controller.viewingSessionId).toBeUndefined();
    expect(fixture.uiChildren).toHaveLength(0);
    // Esc returns to the foreground: the handoff session keeps running, keeps
    // its handlers, and is still listed.
    expect(session.close).not.toHaveBeenCalled();
    expect(session.approvalHandler).toBeDefined();
    expect(fixture.controller.pickerRows()).toHaveLength(1);
  });

  it('refuses to open a viewer for a session this process did not adopt', () => {
    const fixture = makeController();
    fixture.controller.attach();

    expect(fixture.controller.view('ses_elsewhere')).toBe(false);
    expect(fixture.controller.viewingSessionId).toBeUndefined();
  });

  it('reflects the session\u2019s own output and status in the viewer props', async () => {
    const fixture = makeController();
    fixture.controller.attach();
    const session = new FakeSession('ses_b', '/tmp/project-b');
    fixture.harness.sessions.set(session.id, session);
    await adopt(fixture, session);

    session.emit({
      type: 'turn.started',
      sessionId: 'ses_b',
      agentId: 'main',
      turnId: 1,
      origin: 'user',
    });
    session.emit({
      type: 'assistant.delta',
      sessionId: 'ses_b',
      agentId: 'main',
      turnId: 1,
      delta: 'running the tests',
    });
    // A subagent's output never enters the session's own log.
    session.emit({
      type: 'assistant.delta',
      sessionId: 'ses_b',
      agentId: 'sub-1',
      turnId: 1,
      delta: 'subagent noise',
    });

    fixture.controller.view('ses_b');
    const viewer = fixture.uiChildren[0] as unknown as { props: { output: string; status: string } };
    expect(viewer.props.status).toBe('running');
    expect(viewer.props.output).toContain('Task: port the parser and run its tests');
    expect(viewer.props.output).toContain('running the tests');
    expect(viewer.props.output).not.toContain('subagent noise');
  });
});

describe('BackgroundSessionsController request lifecycle', () => {
  it('releases handlers and drops the entry when the host shuts down', async () => {
    const fixture = makeController();
    fixture.controller.attach();
    const session = new FakeSession('ses_b', '/tmp/project-b');
    fixture.harness.sessions.set(session.id, session);
    await adopt(fixture, session);

    fixture.controller.dispose();

    expect(fixture.controller.hasSessions()).toBe(false);
    expect(session.approvalHandler).toBeUndefined();
    expect(session.questionHandler).toBeUndefined();
    expect(session.eventListeners.size).toBe(0);
    // Disposal never closes the session: the harness owns that at shutdown,
    // and the exit hint is what tells the user it is about to happen.
    expect(session.close).not.toHaveBeenCalled();
  });

  it('announces on exit that background sessions stop with the process', async () => {
    const fixture = makeController();
    fixture.controller.attach();
    expect(fixture.controller.exitHint()).toBeUndefined();

    const first = new FakeSession('ses_b', '/tmp/project-b');
    fixture.harness.sessions.set(first.id, first);
    await adopt(fixture, first);
    expect(fixture.controller.exitHint()).toBe(
      'Background session will stop with this process: ses_b',
    );

    const second = new FakeSession('ses_c', '/tmp/project-c');
    fixture.harness.sessions.set(second.id, second);
    await adopt(fixture, second);
    expect(fixture.controller.exitHint()).toBe(
      'Background sessions will stop with this process: ses_b, ses_c',
    );
  });

  it('still reports the exit hint after disposal dropped the entries', async () => {
    const fixture = makeController();
    fixture.controller.attach();
    const session = new FakeSession('ses_b', '/tmp/project-b');
    fixture.harness.sessions.set(session.id, session);
    await adopt(fixture, session);

    fixture.controller.dispose();

    // The host reads the hint from its exit handler, which runs after the
    // shutdown path disposed this controller — so the message is snapshotted,
    // not recomputed from an empty entry map.
    expect(fixture.controller.exitHint()).toBe(
      'Background session will stop with this process: ses_b',
    );
  });

  it('drops an already-closed session without leaving its request behind', async () => {
    const fixture = makeController();
    fixture.controller.attach();
    const background = new FakeSession('ses_b', '/tmp/project-b');
    const other = new FakeSession('ses_c', '/tmp/project-c');
    fixture.harness.sessions.set(background.id, background);
    fixture.harness.sessions.set(other.id, other);
    await adopt(fixture, background);
    await adopt(fixture, other);

    const stale = background.approvalHandler?.({
      toolCallId: 'tc-b',
      toolName: 'Bash',
      action: 'run command: pnpm test',
      display: { kind: 'generic', summary: 'pnpm test' },
    });
    const kept = other.approvalHandler?.({
      toolCallId: 'tc-c',
      toolName: 'Bash',
      action: 'run command: pnpm test',
      display: { kind: 'generic', summary: 'pnpm test' },
    });
    expect(fixture.approvals.pendingCountForSession('ses_b')).toBe(1);

    // The engine closed the session and the harness released the facade: its
    // handler setters now throw, and only the surrounding guard keeps the drop
    // — cancellation included — from being cut short.
    background.closed = true;
    fixture.harness.sessions.delete(background.id);

    expect(() => fixture.controller.pickerRows()).not.toThrow();

    expect(fixture.controller.hasSessions()).toBe(true);
    expect(fixture.controller.pickerRows().map((row) => row.sessionId)).toEqual(['ses_c']);
    // The closed session's request was answered instead of being orphaned...
    await expect(stale).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'session closed',
    });
    // ...while the live session's request is untouched.
    expect(fixture.approvals.pendingCountForSession('ses_c')).toBe(1);
    fixture.approvals.respond({ decision: 'approved' });
    await expect(kept).resolves.toEqual({ decision: 'approved' });
  });
});

// ---------------------------------------------------------------------------
// Integration: the real engine, the real reverse-rpc handler chain, and this
// controller — a scripted in-process model (no HTTP, no external LLM) runs the
// handed-off session's first turn, its approval travels through the controller
// into the UI hooks, and answering it finishes the turn.
// ---------------------------------------------------------------------------

const integrationTempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of integrationTempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/** The one provider the seeded registry returns: first request writes the
 *  approval-gated file, every later request answers in text. */
class ScriptedProvider implements ChatProvider {
  readonly name = 'scripted';
  readonly modelName = 'stub';
  readonly thinkingEffort = null;
  private requests = 0;

  constructor(private readonly notePath: string) {}

  get requestCount(): number {
    return this.requests;
  }

  async generate(): Promise<StreamedMessage> {
    this.requests += 1;
    const parts: StreamedMessagePart[] =
      this.requests === 1
        ? [
            {
              type: 'function',
              id: 'call_note',
              name: 'Write',
              arguments: JSON.stringify({
                path: this.notePath,
                content: 'written by the handoff target',
              }),
            },
          ]
        : [{ type: 'text', text: 'done' }];
    const finishReason: FinishReason = this.requests === 1 ? 'tool_calls' : 'completed';
    const usage: TokenUsage = { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 };
    return {
      id: 'scripted-response',
      usage,
      finishReason,
      rawFinishReason: finishReason,
      async *[Symbol.asyncIterator]() {
        for (const part of parts) yield part;
      },
    };
  }

  withThinking(): ChatProvider {
    return this;
  }
}

function scriptedRegistry(provider: ChatProvider): IProtocolAdapterRegistry {
  return {
    _serviceBrand: undefined,
    supportedProtocols: () => ['openai'],
    resolveAdapterIdentity: (protocol: string) => ({ baseId: protocol, traits: [] }),
    resolveProviderBaseId: (protocol: string) => protocol,
    resolveCapability: () => UNKNOWN_CAPABILITY,
    explainCapability: () => ({ capability: UNKNOWN_CAPABILITY, source: { kind: 'none' } }),
    createChatProvider: () => provider,
  } as unknown as IProtocolAdapterRegistry;
}

describe('BackgroundSessionsController on a real engine', () => {
  it(
    'serves the handed-off session\u2019s first-turn approval through the UI hooks and finishes its turn',
    async () => {
      vi.stubEnv('KIMI_CODE_EXPERIMENTAL_CROSS_PROJECT_SESSIONS', 'true');
      const homeDir = await mkdtemp(join(tmpdir(), 'kimi-tui-handoff-'));
      const sourceDir = await mkdtemp(join(tmpdir(), 'kimi-tui-handoff-src-'));
      const targetDir = await mkdtemp(join(tmpdir(), 'kimi-tui-handoff-dst-'));
      integrationTempDirs.push(homeDir, sourceDir, targetDir);
      await mkdir(targetDir, { recursive: true });
      await writeFile(
        join(homeDir, 'config.toml'),
        [
          'default_model = "stub"',
          'default_permission_mode = "manual"',
          '',
          '[providers.stub]',
          'type = "openai"',
          'base_url = "http://127.0.0.1:1"',
          'api_key = "stub"',
          '',
          '[models.stub]',
          'provider = "stub"',
          'model = "stub"',
          'max_context_size = 131072',
          'capabilities = ["tool_use"]',
          '',
        ].join('\n'),
        'utf-8',
      );

      const noteName = 'handoff-note.txt';
      const provider = new ScriptedProvider(join(targetDir, noteName));
      const client = new SDKRpcClientV2({
        homeDir,
        identity: { productName: 'kimi-code-cli', version: '0.0.0-test', platform: 'kimi_code_cli' },
        seeds: [[IProtocolAdapterRegistry, scriptedRegistry(provider)]] as ScopeSeed,
      });
      const harness = new KimiHarness(client, {
        homeDir,
        configPath: join(homeDir, 'config.toml'),
        auth: client.auth,
        telemetry: client.telemetry,
        ensureConfigFile: () => client.ensureConfigFile(),
        onClose: () => client.close(),
      });

      // The TUI's reverse-rpc UI hooks, as `KimiTUI` wires them.
      const approvals = new ApprovalController();
      const questions = new QuestionController();
      const panels: ApprovalPanelData[] = [];
      const hideApprovalPanel = vi.fn();
      registerReverseRPCHandlers(approvals, questions, {
        showApprovalPanel: (payload) => {
          panels.push(payload);
        },
        hideApprovalPanel,
        showQuestionDialog: () => undefined,
        hideQuestionDialog: () => undefined,
      });

      const { ui, children: uiChildren } = fakeUI();
      const statuses: string[] = [];
      const controller = new BackgroundSessionsController(
        {
          harness: harness as unknown as KimiHarness,
          state: {
            ui,
            editor: {} as never,
            terminal: { rows: 24, columns: 80 } as never,
          },
          showStatus: (message) => {
            statuses.push(message);
          },
        },
        { approval: approvals, question: questions },
      );

      try {
        expect(controller.attach()).toBe(true);
        const source = await harness.createSession({ id: 'ses_source', workDir: sourceDir });
        expect(source.id).toBe('ses_source');
        await harness.trustWorkspace(targetDir);

        const coordinator = client.engineAccessor.get(ISessionHandoffCoordinator);
        const result = await coordinator.start({
          sourceSessionId: 'ses_source',
          sourceAgentId: 'main',
          sourceWorkDir: sourceDir,
          workDir: targetDir,
          prompt: 'Write the handoff note in this project and report back.',
          title: 'Handoff target',
          signal: new AbortController().signal,
        });
        expect(result.failure).toBeUndefined();

        // The first turn's Write parks a real approval; it travels through the
        // controller's adopted handler and reaches the UI hooks carrying the
        // target session's identity and project label.
        await waitFor(() => panels.length > 0, 'the first-turn approval panel');
        const panel = panels[0]!;
        expect(panel.tool_call_id).toBeTypeOf('string');
        expect(panel.session_id).toBe(result.sessionId);
        expect(panel.session_label).toContain(targetDir);
        expect(controller.pickerRows()).toEqual([
          {
            sessionId: result.sessionId,
            workDir: targetDir,
            title: 'Handoff target',
            status: 'waiting',
            pendingRequests: 1,
          },
        ]);

        // The viewer is read-only: closing it neither answers the pending
        // approval nor closes the session.
        expect(controller.view(result.sessionId)).toBe(true);
        expect(uiChildren).toHaveLength(1);
        controller.dismissView();
        expect(uiChildren).toHaveLength(0);
        expect(approvals.pendingCountForSession(result.sessionId)).toBe(1);
        expect(harness.getSession(result.sessionId)).toBeDefined();

        approvals.respond({ decision: 'approved' });

        await waitFor(
          async () =>
            (await readFile(join(targetDir, noteName), 'utf-8').catch(() => '')) ===
            'written by the handoff target',
          'the approved Write to land on disk',
        );
        await waitFor(() => provider.requestCount >= 2, 'the target turn to continue');
        // The session outlived the viewer and the answered request.
        expect(harness.getSession(result.sessionId)).toBeDefined();
        expect(controller.pickerRows()[0]?.status).not.toBe('waiting');
        expect(statuses[0]).toContain(targetDir);
      } finally {
        await harness.close();
      }
    },
    30_000,
  );
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out: ${message}`);
}
