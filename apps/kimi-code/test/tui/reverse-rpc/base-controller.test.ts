import { describe, expect, it, vi } from 'vitest';

import { ReverseRpcController } from '#/tui/reverse-rpc/base-controller';

class TestController extends ReverseRpcController<string, string> {
  protected createCancelResponse(reason: string): string {
    return `cancel:${reason}`;
  }
}

describe('ReverseRpcController', () => {
  it('shows a payload, resolves the pending promise on respond, and hides the panel', async () => {
    const controller = new TestController();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    controller.setUIHooks({ showPanel, hidePanel });

    const pending = controller.show('payload');
    expect(controller.hasPending()).toBe(true);
    expect(showPanel).toHaveBeenCalledWith('payload');

    controller.respond('approved');

    await expect(pending).resolves.toBe('approved');
    expect(controller.hasPending()).toBe(false);
    expect(hidePanel).toHaveBeenCalledOnce();
  });

  it('queues concurrent show() requests and presents them one at a time', async () => {
    const controller = new TestController();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    controller.setUIHooks({ showPanel, hidePanel });

    const first = controller.show('first');
    const second = controller.show('second');
    const third = controller.show('third');

    // Only the first is presented; the rest stay queued.
    expect(showPanel).toHaveBeenCalledTimes(1);
    expect(showPanel).toHaveBeenLastCalledWith('first');
    expect(controller.hasPending()).toBe(true);

    controller.respond('answer-first');
    await expect(first).resolves.toBe('answer-first');
    // Advancing to the next queued request reuses the same panel without
    // hiding it in between.
    expect(hidePanel).not.toHaveBeenCalled();
    expect(showPanel).toHaveBeenCalledTimes(2);
    expect(showPanel).toHaveBeenLastCalledWith('second');

    controller.respond('answer-second');
    await expect(second).resolves.toBe('answer-second');
    expect(showPanel).toHaveBeenCalledTimes(3);
    expect(showPanel).toHaveBeenLastCalledWith('third');

    controller.respond('answer-third');
    await expect(third).resolves.toBe('answer-third');
    expect(controller.hasPending()).toBe(false);
    expect(hidePanel).toHaveBeenCalledTimes(1);
  });

  it('auto-resolves matching queued requests via the autoResolveFor hook', async () => {
    class AutoController extends ReverseRpcController<
      { action: string; id: string },
      string
    > {
      protected createCancelResponse(reason: string): string {
        return `cancel:${reason}`;
      }
      protected override autoResolveFor(
        resolved: { action: string; id: string },
        response: string,
        queued: { action: string; id: string },
      ): string | undefined {
        if (response === 'approve_all_same' && resolved.action === queued.action) {
          return `auto:${queued.id}`;
        }
        return undefined;
      }
    }
    const controller = new AutoController();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    controller.setUIHooks({ showPanel, hidePanel });

    const first = controller.show({ action: 'run', id: 'a' });
    const second = controller.show({ action: 'run', id: 'b' });
    const third = controller.show({ action: 'edit', id: 'c' });
    const fourth = controller.show({ action: 'run', id: 'd' });

    controller.respond('approve_all_same');

    await expect(first).resolves.toBe('approve_all_same');
    await expect(second).resolves.toBe('auto:b');
    await expect(fourth).resolves.toBe('auto:d');
    // The non-matching request advances to the panel and stays pending.
    expect(showPanel).toHaveBeenLastCalledWith({ action: 'edit', id: 'c' });
    expect(controller.hasPending()).toBe(true);

    controller.respond('approve_all_same');
    await expect(third).resolves.toBe('approve_all_same');
    expect(controller.hasPending()).toBe(false);
    expect(hidePanel).toHaveBeenCalledTimes(1);
  });

  it('cancelAll cancels the current request and every queued request', async () => {
    const controller = new TestController();
    const hidePanel = vi.fn();
    controller.setUIHooks({ showPanel: vi.fn(), hidePanel });

    const first = controller.show('first');
    const second = controller.show('second');
    const third = controller.show('third');

    controller.cancelAll('shutdown');

    await expect(first).resolves.toBe('cancel:shutdown');
    await expect(second).resolves.toBe('cancel:shutdown');
    await expect(third).resolves.toBe('cancel:shutdown');
    expect(controller.hasPending()).toBe(false);
    expect(hidePanel).toHaveBeenCalledTimes(1);
  });
});

/**
 * Session-scoped cancellation: `A1` / `A2` are session `A`'s requests, `B1`
 * session `B`'s. Payload strings carry both facts so the base-class ordering
 * can be observed without a real panel.
 */
class SessionController extends ReverseRpcController<string, string> {
  protected createCancelResponse(reason: string): string {
    return `cancel:${reason}`;
  }

  protected override sessionIdOf(payload: string): string | undefined {
    return payload.slice(0, 1);
  }

  protected override toolCallIdOf(payload: string): string | undefined {
    return payload;
  }
}

describe('ReverseRpcController session-scoped cancellation', () => {
  function makeController(): {
    controller: SessionController;
    panelPayloads: string[];
    hidePanel: ReturnType<typeof vi.fn>;
  } {
    const controller = new SessionController();
    const panelPayloads: string[] = [];
    const hidePanel = vi.fn();
    controller.setUIHooks({
      showPanel: (payload) => {
        panelPayloads.push(payload);
      },
      hidePanel,
    });
    return { controller, panelPayloads, hidePanel };
  }

  it('drains the whole session from the queue before touching the shown panel', async () => {
    const { controller, panelPayloads } = makeController();
    const first = controller.show('A1');
    const second = controller.show('A2');
    const other = controller.show('B1');

    controller.cancelForSession('A', 'switching session');

    await expect(first).resolves.toBe('cancel:switching session');
    await expect(second).resolves.toBe('cancel:switching session');
    // Only the other session's request reaches the panel: promoting the queue
    // head before filtering used to surface `A2` — a request of the session
    // that was just left, indistinguishable from a new one.
    expect(panelPayloads).toEqual(['A1', 'B1']);
    expect(controller.pendingCountForSession('A')).toBe(0);
    expect(controller.pendingCountForSession('B')).toBe(1);

    controller.respond('answered');
    await expect(other).resolves.toBe('answered');
  });

  it('cancels every queued request of the session instead of promoting another', async () => {
    const { controller, panelPayloads, hidePanel } = makeController();
    const first = controller.show('A1');
    const second = controller.show('A2');
    const third = controller.show('A3');

    controller.cancelForSession('A', 'closing session');

    await expect(first).resolves.toBe('cancel:closing session');
    await expect(second).resolves.toBe('cancel:closing session');
    await expect(third).resolves.toBe('cancel:closing session');
    expect(panelPayloads).toEqual(['A1']);
    expect(controller.hasPending()).toBe(false);
    expect(hidePanel).toHaveBeenCalledTimes(1);
  });

  it('leaves another session\u2019s shown panel untouched when only the queue holds the session', async () => {
    const { controller, panelPayloads, hidePanel } = makeController();
    const shown = controller.show('B1');
    const first = controller.show('A1');
    const second = controller.show('A2');

    controller.cancelForSession('A', 'closing session');

    await expect(first).resolves.toBe('cancel:closing session');
    await expect(second).resolves.toBe('cancel:closing session');
    // B's panel is not replaced, hidden, or re-shown.
    expect(panelPayloads).toEqual(['B1']);
    expect(hidePanel).not.toHaveBeenCalled();
    expect(controller.pendingCountForSession('B')).toBe(1);

    controller.respond('answered');
    await expect(shown).resolves.toBe('answered');
  });

  it('never promotes a queued duplicate when cancelling by tool-call id', async () => {
    const { controller, panelPayloads } = makeController();
    const shown = controller.show('A1');
    const duplicate = controller.show('A1');
    const other = controller.show('B1');

    controller.cancelByToolCallId('A1', 'request cancelled', 'A');

    await expect(shown).resolves.toBe('cancel:request cancelled');
    await expect(duplicate).resolves.toBe('cancel:request cancelled');
    // The promoted panel belongs to the other session, not to the cancelled id.
    expect(panelPayloads).toEqual(['A1', 'B1']);
    expect(controller.pendingCountForSession('A')).toBe(0);

    controller.respond('answered');
    await expect(other).resolves.toBe('answered');
  });

  it('does not resurrect a request the host already answered', async () => {
    const { controller, panelPayloads } = makeController();
    const answered = controller.show('A1');
    const next = controller.show('A2');

    controller.respond('approved');
    await expect(answered).resolves.toBe('approved');
    expect(panelPayloads).toEqual(['A1', 'A2']);

    // The engine's late settled report for the answered request is a no-op and
    // must not cancel or re-show the request now on screen.
    controller.cancelByToolCallId('A1', 'request cancelled', 'A');
    expect(controller.pendingCountForSession('A')).toBe(1);
    expect(panelPayloads).toEqual(['A1', 'A2']);

    controller.respond('approved again');
    await expect(next).resolves.toBe('approved again');
  });
});
