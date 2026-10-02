/**
 * Base class for promise-based reverse RPC dialog controllers.
 *
 * Approval and question flows wait for a UI action before returning a response.
 * Subclasses only need to define the default cancellation response.
 *
 * When concurrent requests arrive (e.g. multiple parallel subagents each
 * needing approval), only one panel is shown at a time; additional requests
 * are queued in arrival order and advance after the current one resolves.
 *
 * Requests carry the identity of the session they belong to (`sessionIdOf`):
 * reusing one session's answer and dropping one session's pending requests
 * must never leak into another session's requests, so `cancelForSession`
 * narrows `cancelAll` to the requests that session actually owns.
 */

export interface ReverseRpcUIHooks<TPayload> {
  showPanel(payload: TPayload): void;
  hidePanel(): void;
}

interface Pending<TPayload, TResponse> {
  readonly payload: TPayload;
  readonly resolve: (data: TResponse) => void;
}

export abstract class ReverseRpcController<TPayload, TResponse> {
  private uiHooks: ReverseRpcUIHooks<TPayload> | null = null;
  private current: Pending<TPayload, TResponse> | null = null;
  private queue: Array<Pending<TPayload, TResponse>> = [];

  setUIHooks(hooks: ReverseRpcUIHooks<TPayload>): void {
    this.uiHooks = hooks;
  }

  /**
   * Called when a reverse RPC request arrives from core. The returned promise
   * resolves after the user responds or `cancelAll` forces cancellation.
   */
  show(payload: TPayload): Promise<TResponse> {
    return new Promise<TResponse>((resolve) => {
      const entry: Pending<TPayload, TResponse> = { payload, resolve };
      if (this.current === null) {
        this.current = entry;
        this.uiHooks?.showPanel(payload);
      } else {
        this.queue.push(entry);
      }
    });
  }

  /** Called by the UI after the user makes a panel choice. */
  respond(data: TResponse): void {
    const pending = this.current;
    this.current = null;
    pending?.resolve(data);
    if (pending !== null) {
      this.drainAutoResolved(pending.payload, data);
    }
    this.advanceOrHide();
  }

  /** Cancels every pending request — shutdown only, never a session switch. */
  cancelAll(reason: string): void {
    const all = [...(this.current === null ? [] : [this.current]), ...this.queue];
    this.current = null;
    this.queue = [];
    this.uiHooks?.hidePanel();
    for (const entry of all) {
      entry.resolve(this.createCancelResponse(reason));
    }
  }

  /**
   * Cancels only the pending requests owned by `sessionId` — closing,
   * switching, or cancelling one session must not answer another session's
   * requests. The queue is drained of that session's entries BEFORE the shown
   * panel is cancelled: advancing first could promote another request of the
   * same session into the panel and leave it pending (and, without a session
   * label on a foreground panel, indistinguishable from the new session's own
   * request). When the shown panel is cancelled, the next queued request of
   * another session takes its place.
   */
  cancelForSession(sessionId: string, reason: string): void {
    const remaining: Array<Pending<TPayload, TResponse>> = [];
    for (const entry of this.queue) {
      if (this.sessionIdOf(entry.payload) === sessionId) {
        entry.resolve(this.createCancelResponse(reason));
      } else {
        remaining.push(entry);
      }
    }
    this.queue = remaining;
    if (this.current !== null && this.sessionIdOf(this.current.payload) === sessionId) {
      const pending = this.current;
      this.current = null;
      pending.resolve(this.createCancelResponse(reason));
      // The queue now holds no entry of this session, so this can only surface
      // another session's request.
      this.advanceOrHide();
    }
  }

  /**
   * Drops any pending request the host still tracks by tool-call id, optionally
   * narrowed to one session so a shared id can never cross sessions. Drained in
   * the same order as {@link cancelForSession}: a queued entry matching the id
   * is resolved without ever being promoted to the panel.
   */
  cancelByToolCallId(toolCallId: string, reason: string, sessionId?: string): void {
    const matches = (payload: TPayload): boolean => {
      if (sessionId !== undefined && this.sessionIdOf(payload) !== sessionId) return false;
      return this.toolCallIdOf(payload) === toolCallId;
    };
    const remaining: Array<Pending<TPayload, TResponse>> = [];
    for (const entry of this.queue) {
      if (matches(entry.payload)) {
        entry.resolve(this.createCancelResponse(reason));
      } else {
        remaining.push(entry);
      }
    }
    this.queue = remaining;
    if (this.current !== null && matches(this.current.payload)) {
      const pending = this.current;
      this.current = null;
      pending.resolve(this.createCancelResponse(reason));
      this.advanceOrHide();
    }
  }

  hasPending(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  /** How many pending requests belong to `sessionId` (shown or queued). */
  pendingCountForSession(sessionId: string): number {
    let count = 0;
    if (this.current !== null && this.sessionIdOf(this.current.payload) === sessionId) count += 1;
    for (const entry of this.queue) {
      if (this.sessionIdOf(entry.payload) === sessionId) count += 1;
    }
    return count;
  }

  private advanceOrHide(): void {
    const next = this.queue.shift();
    if (next === undefined) {
      this.uiHooks?.hidePanel();
      return;
    }
    this.current = next;
    this.uiHooks?.showPanel(next.payload);
  }

  private drainAutoResolved(resolvedPayload: TPayload, response: TResponse): void {
    const remaining: Array<Pending<TPayload, TResponse>> = [];
    for (const entry of this.queue) {
      const auto = this.autoResolveFor(resolvedPayload, response, entry.payload);
      if (auto === undefined) {
        remaining.push(entry);
      } else {
        entry.resolve(auto);
      }
    }
    this.queue = remaining;
  }

  /**
   * Subclasses override to short-circuit queued requests when an answer to the
   * just-resolved one (e.g. an approve-for-session) implies the same answer
   * for matching queued requests. Return `undefined` to leave the queued
   * request waiting for its own panel turn.
   */
  protected autoResolveFor(
    _resolvedPayload: TPayload,
    _response: TResponse,
    _queuedPayload: TPayload,
  ): TResponse | undefined {
    return undefined;
  }

  /** The session a payload belongs to, when the payload carries one. */
  protected sessionIdOf(_payload: TPayload): string | undefined {
    return undefined;
  }

  /** The tool-call id a payload is keyed by, when the payload carries one. */
  protected toolCallIdOf(_payload: TPayload): string | undefined {
    return undefined;
  }

  protected abstract createCancelResponse(reason: string): TResponse;
}
