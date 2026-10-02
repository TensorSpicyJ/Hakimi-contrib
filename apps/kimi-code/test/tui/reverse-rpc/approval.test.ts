import type { ApprovalRequest } from '@bhjia-phys/hakimi-sdk';
import { describe, expect, it, vi } from 'vitest';

import { ApprovalController } from '#/tui/reverse-rpc/approval/controller';
import { createApprovalRequestHandler } from '#/tui/reverse-rpc/approval/handler';
import type { ApprovalPanelData } from '#/tui/reverse-rpc/types';

function approvalEvent(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    toolCallId: 'tc-1',
    toolName: 'Bash',
    action: 'run command',
    display: {
      kind: 'generic',
      summary: 'run command',
      detail: {
        command: 'rm -rf /tmp/cache',
        cwd: '/tmp',
      },
    },
    ...overrides,
  };
}

describe('approval reverse-rpc', () => {
  const panel = (id: string, action: string, sessionId?: string): ApprovalPanelData => ({
    id,
    tool_call_id: id,
    tool_name: 'Bash',
    action,
    description: '',
    display: [],
    choices: [],
    session_id: sessionId,
  });

  it('auto-approves queued requests with the same action when the current is approved for session', async () => {
    const controller = new ApprovalController();

    const first = controller.show(panel('tc-1', 'run command: ls', 'ses_a'));
    const second = controller.show(panel('tc-2', 'run command: ls', 'ses_a'));
    const third = controller.show(panel('tc-3', 'edit src/x.ts', 'ses_a'));
    const fourth = controller.show(panel('tc-4', 'run command: ls', 'ses_a'));

    controller.respond({ decision: 'approved', scope: 'session', feedback: 'ok' });

    await expect(first).resolves.toEqual({
      decision: 'approved',
      scope: 'session',
      feedback: 'ok',
    });
    // Queued same-action requests of the SAME session inherit a session-scoped
    // approval without surfacing another panel. The user's feedback is not
    // carried over — it described the first request only.
    await expect(second).resolves.toEqual({ decision: 'approved', scope: 'session' });
    await expect(fourth).resolves.toEqual({ decision: 'approved', scope: 'session' });
    // A different-action request still waits for an explicit decision.
    expect(controller.hasPending()).toBe(true);

    controller.respond({ decision: 'rejected' });
    await expect(third).resolves.toEqual({ decision: 'rejected' });
  });

  it('never lets one session approve another session\u2019s request', async () => {
    const controller = new ApprovalController();

    // Two projects can legitimately raise the same action (both run `ls`).
    const foreground = controller.show(panel('tc-a', 'run command: ls', 'ses_a'));
    const background = controller.show(panel('tc-b', 'run command: ls', 'ses_b'));

    controller.respond({ decision: 'approved', scope: 'session' });

    await expect(foreground).resolves.toEqual({ decision: 'approved', scope: 'session' });
    // The background session's identical request keeps its own panel: the
    // session-scoped approval is bound to the session that granted it.
    expect(controller.pendingCountForSession('ses_b')).toBe(1);
    controller.respond({ decision: 'rejected' });
    await expect(background).resolves.toEqual({ decision: 'rejected' });
  });

  it('does not inherit a session approval when the request has no session identity', async () => {
    const controller = new ApprovalController();

    const first = controller.show(panel('tc-1', 'run command: ls', undefined));
    const second = controller.show(panel('tc-2', 'run command: ls', undefined));

    controller.respond({ decision: 'approved', scope: 'session' });

    await expect(first).resolves.toEqual({ decision: 'approved', scope: 'session' });
    // Unknown identity never inherits: it would otherwise be impossible to say
    // which session the user approved for.
    expect(controller.pendingCountForSession('ses_a')).toBe(0);
    expect(controller.hasPending()).toBe(true);
    controller.respond({ decision: 'rejected' });
    await expect(second).resolves.toEqual({ decision: 'rejected' });
  });

  it('cancels only the requests owned by the session being unloaded', async () => {
    const controller = new ApprovalController();
    const foreground = controller.show(panel('tc-a', 'run command: ls', 'ses_a'));
    const background = controller.show(panel('tc-b', 'run command: ls', 'ses_b'));

    controller.cancelForSession('ses_a', 'switching session');

    await expect(foreground).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'switching session',
    });
    // The background session's request survives the foreground switch and is
    // promoted to the visible panel.
    expect(controller.pendingCountForSession('ses_b')).toBe(1);
    controller.respond({ decision: 'approved' });
    await expect(background).resolves.toEqual({ decision: 'approved' });
  });

  it('cancels every queued request of the unloaded session and shows none of them', async () => {
    const controller = new ApprovalController();
    const panels: ApprovalPanelData[] = [];
    controller.setUIHooks({
      showPanel: (payload) => {
        panels.push(payload);
      },
      hidePanel: () => undefined,
    });

    // A1 is on screen; A2 (same session) and B1 wait behind it.
    const a1 = controller.show(panel('tc-a1', 'run command: ls', 'ses_a'));
    const a2 = controller.show(panel('tc-a2', 'run command: ls', 'ses_a'));
    const b1 = controller.show(panel('tc-b1', 'run command: ls', 'ses_b'));

    controller.cancelForSession('ses_a', 'switching session');

    await expect(a1).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'switching session',
    });
    await expect(a2).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'switching session',
    });
    // The panel after A1 is B1: promoting A2 first (the previous order) would
    // have shown a request of the session just left, with no session label on a
    // foreground panel — indistinguishable from the new session's own request.
    expect(panels.map((item) => item.tool_call_id)).toEqual(['tc-a1', 'tc-b1']);
    expect(controller.pendingCountForSession('ses_a')).toBe(0);
    expect(controller.pendingCountForSession('ses_b')).toBe(1);

    controller.respond({ decision: 'approved' });
    await expect(b1).resolves.toEqual({ decision: 'approved' });
  });

  it('leaves the shown panel of another session alone when only the queue holds the unloaded session', async () => {
    const controller = new ApprovalController();
    const hidePanel = vi.fn();
    const panels: string[] = [];
    controller.setUIHooks({
      showPanel: (payload) => {
        panels.push(payload.tool_call_id ?? '');
      },
      hidePanel,
    });

    const b1 = controller.show(panel('tc-b1', 'run command: ls', 'ses_b'));
    const a2 = controller.show(panel('tc-a2', 'run command: ls', 'ses_a'));
    const a3 = controller.show(panel('tc-a3', 'run command: ls', 'ses_a'));

    controller.cancelForSession('ses_a', 'session closed');

    await expect(a2).resolves.toEqual({ decision: 'cancelled', feedback: 'session closed' });
    await expect(a3).resolves.toEqual({ decision: 'cancelled', feedback: 'session closed' });
    // B's panel is neither replaced nor hidden, and no same-session panel
    // flashed even though every queued request belonged to the unloaded one.
    expect(panels).toEqual(['tc-b1']);
    expect(hidePanel).not.toHaveBeenCalled();
    expect(controller.pendingCountForSession('ses_b')).toBe(1);

    controller.respond({ decision: 'approved' });
    await expect(b1).resolves.toEqual({ decision: 'approved' });
  });

  it('drops a stale request reported settled by the engine', async () => {
    const controller = new ApprovalController();
    const stale = controller.show(panel('tc-a', 'run command: ls', 'ses_a'));
    const next = controller.show(panel('tc-b', 'run command: ls', 'ses_a'));

    controller.cancelByToolCallId('tc-a', 'request cancelled');

    await expect(stale).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'request cancelled',
    });
    expect(controller.pendingCountForSession('ses_a')).toBe(1);
    controller.respond({ decision: 'approved' });
    await expect(next).resolves.toEqual({ decision: 'approved' });
  });

  it('carries the owning session identity into the panel data', async () => {
    const controller = new ApprovalController();
    const show = vi.spyOn(controller, 'show').mockResolvedValue({ decision: 'approved' });
    const handler = createApprovalRequestHandler(controller, undefined, {
      sessionId: 'ses_b',
      sessionLabel: '/tmp/project-b',
    });

    await handler(approvalEvent());

    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'ses_b', session_label: '/tmp/project-b' }),
    );
  });

  it('does not auto-approve queued requests when only approved-once is chosen', async () => {
    const controller = new ApprovalController();
    const panel = (id: string) => ({
      id,
      tool_call_id: id,
      tool_name: 'Bash',
      action: 'run command: ls',
      description: '',
      display: [],
      choices: [],
    });

    const first = controller.show(panel('tc-1'));
    const second = controller.show(panel('tc-2'));

    controller.respond({ decision: 'approved' });

    await expect(first).resolves.toEqual({ decision: 'approved' });
    // The second same-action request must NOT be auto-resolved — approve-once
    // is a one-shot decision, not a session rule.
    expect(controller.hasPending()).toBe(true);
    controller.respond({ decision: 'approved' });
    await expect(second).resolves.toEqual({ decision: 'approved' });
  });

  it('ApprovalController cancels pending requests with a cancelled response', async () => {
    const controller = new ApprovalController();
    const pending = controller.show({
      id: 'req-1',
      tool_call_id: 'tc-1',
      tool_name: 'Bash',
      action: 'run',
      description: '',
      display: [],
      choices: [],
    });

    controller.cancelAll('closed');

    await expect(pending).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'closed',
    });
  });

  it('adapts approval payloads through the handler and falls back on failure', async () => {
    const controller = new ApprovalController();
    const show = vi.spyOn(controller, 'show').mockResolvedValue({
      decision: 'approved',
      scope: 'session',
      feedback: 'looks good',
    });
    const handler = createApprovalRequestHandler(controller);

    await expect(handler(approvalEvent())).resolves.toEqual({
      decision: 'approved',
      scope: 'session',
      feedback: 'looks good',
    });
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tc-1',
        tool_call_id: 'tc-1',
        tool_name: 'Bash',
        display: [
          expect.objectContaining({
            type: 'shell',
            command: 'rm -rf /tmp/cache',
            cwd: '/tmp',
            danger: 'recursive delete',
          }),
        ],
      }),
    );

    show.mockRejectedValueOnce(new Error('boom'));
    await expect(handler(approvalEvent())).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'approval handler failed',
    });
  });
});
