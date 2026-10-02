/**
 * Background sessions — the session this process adopted from another
 * session's cross-project handoff.
 *
 * The engine's `StartSession` tool hands work to a session in another project;
 * the SDK adopts that session here (through `KimiHarness.enableSessionHandoff`)
 * and this controller owns everything the TUI does with it:
 *
 * - installing the adopted session's own approval / question handlers and
 *   event subscription, so the first interaction of its first turn already has
 *   a bridge (reusing the shared reverse-rpc controllers, which serialise
 *   panels and scope answers per session);
 * - keeping a bounded output log per session (`background-session-output`),
 *   never rendered into the session on screen — a background session's
 *   transcript must not mix with the foreground one;
 * - exposing the live marker the session picker renders, and opening the
 *   read-only viewer for one session through the screen-takeover swap.
 *
 * Lifecycle stays separate from UI focus: opening or closing the viewer never
 * closes, cancels, or switches a session, and closing the foreground session
 * leaves every background session running. Only the host's shutdown ends them,
 * together with `KimiHarness.close()`.
 */

import type { Event, HandoffSessionInfo, KimiHarness, Session } from '@bhjia-phys/hakimi-sdk';
import type { ProcessTerminal, TUI } from '@moonshot-ai/pi-tui';

import { BackgroundSessionViewer } from '../components/dialogs/background-session-viewer';
import type { CustomEditor } from '../components/editor/custom-editor';
import type { ApprovalController } from '../reverse-rpc/approval/controller';
import { createApprovalRequestHandler } from '../reverse-rpc/approval/handler';
import type { QuestionController } from '../reverse-rpc/question/controller';
import { createQuestionAskHandler } from '../reverse-rpc/question/handler';
import {
  backgroundSessionLabel,
  backgroundSessionStatusLabel,
  backgroundSessionText,
  createBackgroundSessionOutput,
  foldBackgroundSessionEvent,
  type BackgroundSessionOutput,
} from '../utils/background-session-output';
import {
  beginScreenTakeover,
  endScreenTakeover,
  type ScreenTakeover,
} from '../utils/screen-takeover';
import type { ColorToken } from '#/tui/theme';

/** How often the open viewer re-reads the session's log while it is shown. */
const VIEWER_POLL_MS = 500;

export interface BackgroundSessionsHost {
  readonly harness: KimiHarness;
  readonly state: {
    readonly ui: TUI;
    readonly editor: CustomEditor;
    readonly terminal: ProcessTerminal;
  };
  showStatus(message: string, color?: ColorToken): void;
}

/** The two reverse-rpc controllers the adopted sessions' handlers feed. */
export interface BackgroundSessionControllers {
  readonly approval: ApprovalController;
  readonly question: QuestionController;
}

export interface BackgroundSessionEntry {
  readonly session: Session;
  readonly info: HandoffSessionInfo;
  readonly label: string;
  readonly output: BackgroundSessionOutput;
  unsubscribe: (() => void) | undefined;
}

/** Row facts the session picker renders for a live background session. */
export interface BackgroundSessionRowInfo {
  readonly sessionId: string;
  readonly workDir: string;
  readonly title: string | undefined;
  readonly status: string;
  readonly pendingRequests: number;
}

export class BackgroundSessionsController {
  private readonly entries = new Map<string, BackgroundSessionEntry>();
  private viewer:
    | {
        readonly entry: BackgroundSessionEntry;
        readonly component: BackgroundSessionViewer;
        readonly takeover: ScreenTakeover;
        readonly poll: ReturnType<typeof setInterval>;
      }
    | undefined;
  /**
   * The exit hint as of {@link dispose}, which is the last moment the entries
   * still exist. The host reads the hint from its exit handler, after the
   * shutdown path has already dropped them, so without this snapshot the
   * message would always be empty.
   */
  private exitHintAfterDispose: string | undefined;
  private disposed = false;
  /** Whether this controller already owns a host registration. */
  private hosting = false;

  constructor(
    private readonly host: BackgroundSessionsHost,
    private readonly controllers: BackgroundSessionControllers,
  ) {}

  /**
   * Opt this process in as a handoff host. Called once at startup, before the
   * first session exists; returns false on an engine that cannot host one (the
   * legacy v1 engine), in which case no host is registered and the engine
   * reports the handoff tool as unavailable. A harness whose SDK predates the
   * handoff surface has no host either.
   *
   * Idempotent: a second call keeps the first registration and reports true
   * for this controller (the SDK's own `enableSessionHandoff` is first-wins
   * and reports false when it registers nothing new).
   */
  attach(): boolean {
    if (this.hosting) return true;
    const harness = this.host.harness;
    if (typeof harness.supportsSessionHandoff !== 'function') return false;
    if (typeof harness.enableSessionHandoff !== 'function') return false;
    if (!harness.supportsSessionHandoff()) return false;
    const registered = harness.enableSessionHandoff({
      onSessionReady: (session, info) => {
        this.adopt(session, info);
      },
    });
    if (registered) this.hosting = true;
    return registered;
  }

  /** Whether a session this process adopted is currently shown. */
  get viewingSessionId(): string | undefined {
    return this.viewer?.entry.session.id;
  }

  hasSessions(): boolean {
    return this.entries.size > 0;
  }

  /** The live background sessions, for the session picker's markers. */
  pickerRows(): readonly BackgroundSessionRowInfo[] {
    this.pruneClosedSessions();
    return [...this.entries.values()].map((entry) => ({
      sessionId: entry.session.id,
      workDir: entry.info.workDir,
      title: entry.session.summary?.title,
      status: this.statusLabel(entry),
      pendingRequests: this.pendingRequests(entry.session.id),
    }));
  }

  /**
   * Opens the read-only viewer for one background session. The session keeps
   * running; closing the viewer returns to the foreground session without
   * switching, cancelling, or closing anything.
   */
  view(sessionId: string): boolean {
    this.pruneClosedSessions();
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return false;
    if (this.viewer?.entry === entry) return true;
    this.closeViewer();
    const component = new BackgroundSessionViewer(this.viewerProps(entry), this.host.state.terminal);
    const takeover = beginScreenTakeover(this.host.state.ui, component);
    this.host.state.ui.setFocus(component);
    this.host.state.ui.requestRender(true);
    this.viewer = {
      entry,
      component,
      takeover,
      poll: setInterval(() => {
        this.refreshViewer();
      }, VIEWER_POLL_MS),
    };
    return true;
  }

  /** Closes the viewer if it is open, restoring the editor. */
  dismissView(): void {
    this.closeViewer();
  }

  /** Releases every subscription and drops the collected state. Never closes the sessions. */
  dispose(): void {
    if (this.disposed) return;
    // Snapshot before dropping the entries: the host reads the exit hint from
    // its exit handler, which runs after this teardown.
    this.exitHintAfterDispose = this.buildExitHint();
    this.disposed = true;
    this.closeViewer();
    for (const sessionId of Array.from(this.entries.keys())) {
      this.dropEntry(sessionId, 'host shutting down');
    }
  }

  /**
   * The one-line notice the host prints on exit: a background session lives
   * only as long as this process does. After {@link dispose} this reports the
   * sessions that existed at that moment, so the host can still tell the user
   * what it is about to end.
   */
  exitHint(): string | undefined {
    return this.disposed ? this.exitHintAfterDispose : this.buildExitHint();
  }

  private buildExitHint(): string | undefined {
    if (this.entries.size === 0) return undefined;
    const ids = [...this.entries.keys()];
    const noun = ids.length === 1 ? 'session' : 'sessions';
    return `Background ${noun} will stop with this process: ${ids.join(', ')}`;
  }

  // -------------------------------------------------------------------------

  private adopt(session: Session, info: HandoffSessionInfo): void {
    // Re-adoption of the same session id (not reachable through the
    // coordinator today, which always starts a fresh session) replaces the
    // previous entry: its subscription is released and its pending requests
    // are answered, so a re-adopt can neither leak a listener nor leave a
    // panel wired to a superseded entry.
    if (this.entries.has(session.id)) this.dropEntry(session.id, 'session re-adopted');
    const entry: BackgroundSessionEntry = {
      session,
      info,
      label: backgroundSessionLabel(session, info.workDir),
      output: createBackgroundSessionOutput(info.prompt),
      unsubscribe: undefined,
    };
    this.entries.set(session.id, entry);
    // Handlers first, then the event subscription: the engine submits the
    // first prompt only after `onSessionReady` resolves, so the very first
    // approval or question already has a panel and a bridge.
    this.installHandlers(entry);
    entry.unsubscribe = session.onEvent((event) => {
      this.handleEvent(entry, event);
    });
    this.host.showStatus(
      `Background session started in ${info.workDir} (${session.id}) — press /sessions to view it`,
    );
  }

  private installHandlers(entry: BackgroundSessionEntry): void {
    const context = { sessionId: entry.session.id, sessionLabel: entry.label };
    entry.session.setApprovalHandler(
      createApprovalRequestHandler(this.controllers.approval, undefined, context),
    );
    entry.session.setQuestionHandler(createQuestionAskHandler(this.controllers.question, context));
  }

  private handleEvent(entry: BackgroundSessionEntry, event: Event): void {
    foldBackgroundSessionEvent(entry.output, event);
    this.refreshViewer();
  }

  private refreshViewer(): void {
    const viewer = this.viewer;
    if (viewer === undefined) return;
    if (!this.entries.has(viewer.entry.session.id)) {
      this.closeViewer();
      return;
    }
    viewer.component.setProps(this.viewerProps(viewer.entry));
    this.host.state.ui.requestRender();
  }

  private viewerProps(entry: BackgroundSessionEntry): {
    sessionId: string;
    label: string;
    status: string;
    output: string;
    onClose: () => void;
  } {
    return {
      sessionId: entry.session.id,
      label: entry.label,
      status: this.statusLabel(entry),
      output: backgroundSessionText(entry.output),
      onClose: () => {
        this.closeViewer();
      },
    };
  }

  private closeViewer(): void {
    const viewer = this.viewer;
    if (viewer === undefined) return;
    this.viewer = undefined;
    clearInterval(viewer.poll);
    endScreenTakeover(this.host.state.ui, viewer.takeover);
    this.host.state.ui.setFocus(this.host.state.editor);
    this.host.state.ui.requestRender(true);
  }

  private statusLabel(entry: BackgroundSessionEntry): string {
    return backgroundSessionStatusLabel(entry.output, this.pendingRequests(entry.session.id));
  }

  private pendingRequests(sessionId: string): number {
    return (
      this.controllers.approval.pendingCountForSession(sessionId) +
      this.controllers.question.pendingCountForSession(sessionId)
    );
  }

  /**
   * Forgets one adopted session: its subscription, its pending requests, and
   * its handlers. Teardown order matters — the pending requests are answered
   * first, because clearing the handlers on a facade the engine already closed
   * throws (`Session.setApprovalHandler` requires an open session), and an
   * exception there used to skip the cancellation and leave the request panels
   * behind. Every step is therefore either ordered before the throwing one or
   * guarded, so a drop always completes.
   */
  private dropEntry(sessionId: string, reason: string): void {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return;
    this.entries.delete(sessionId);
    // Answer this session's requests first: this is what must happen even if
    // the facade is unusable below.
    this.controllers.approval.cancelForSession(sessionId, reason);
    this.controllers.question.cancelForSession(sessionId, reason);
    if (this.viewer?.entry === entry) this.closeViewer();
    entry.unsubscribe?.();
    entry.unsubscribe = undefined;
    if (entry.session.isClosed) return;
    entry.session.setApprovalHandler(undefined);
    entry.session.setQuestionHandler(undefined);
  }

  /**
   * Drops entries whose session no longer exists in this process (the harness
   * closed or deleted it). Best-effort and cheap — every entry is a facade the
   * harness either still holds or has released.
   */
  private pruneClosedSessions(): void {
    for (const sessionId of Array.from(this.entries.keys())) {
      if (this.host.harness.getSession(sessionId) === undefined) {
        this.dropEntry(sessionId, 'session closed');
      }
    }
  }
}
