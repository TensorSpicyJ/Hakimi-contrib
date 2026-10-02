import { describe, expect, it, vi } from 'vitest';

import { ApprovalController } from '#/tui/reverse-rpc/approval/controller';
import { createInteractionSettledHandler, registerReverseRPCHandlers } from '#/tui/reverse-rpc/index';
import { QuestionController } from '#/tui/reverse-rpc/question/controller';
import type { ApprovalPanelData, QuestionPanelData } from '#/tui/reverse-rpc/types';

function approvalPanel(id: string, sessionId: string): ApprovalPanelData {
  return {
    id,
    tool_call_id: id,
    tool_name: 'Bash',
    action: 'run command: pnpm test',
    description: '',
    display: [],
    choices: [],
    session_id: sessionId,
  };
}

function questionPanel(id: string, sessionId: string): QuestionPanelData {
  return { id, tool_call_id: id, questions: [], session_id: sessionId };
}

describe('createInteractionSettledHandler', () => {
  it('drops the panels of requests the engine stopped waiting for', async () => {
    const approvalController = new ApprovalController();
    const questionController = new QuestionController();
    const settled = createInteractionSettledHandler(approvalController, questionController);

    const approval = approvalController.show(approvalPanel('tc-1', 'ses_a'));
    const question = questionController.show(questionPanel('tq-1', 'ses_a'));
    expect(approvalController.pendingCountForSession('ses_a')).toBe(1);

    settled({ sessionId: 'ses_a', toolCallIds: ['tc-1', 'tq-1'] });

    await expect(approval).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'request cancelled',
    });
    await expect(question).resolves.toEqual({ answers: [] });
    expect(approvalController.hasPending()).toBe(false);
    expect(questionController.hasPending()).toBe(false);
  });

  it('never drops another session\u2019s panel', async () => {
    const approvalController = new ApprovalController();
    const questionController = new QuestionController();
    const settled = createInteractionSettledHandler(approvalController, questionController);

    // Same tool-call id in two sessions: only the reporting session is cleared.
    const foreground = approvalController.show(approvalPanel('tc-1', 'ses_a'));
    const background = approvalController.show(approvalPanel('tc-1', 'ses_b'));

    settled({ sessionId: 'ses_a', toolCallIds: ['tc-1'] });

    await expect(foreground).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'request cancelled',
    });
    expect(approvalController.pendingCountForSession('ses_b')).toBe(1);
    approvalController.respond({ decision: 'approved' });
    await expect(background).resolves.toEqual({ decision: 'approved' });
  });

  it('is a no-op for requests the host already answered', async () => {
    const approvalController = new ApprovalController();
    const questionController = new QuestionController();
    const settled = createInteractionSettledHandler(approvalController, questionController);

    const next = approvalController.show(approvalPanel('tc-2', 'ses_a'));
    // The host answered tc-1 and is now showing tc-2; the engine's settled
    // notification for tc-1 must not touch the panel on screen.
    settled({ sessionId: 'ses_a', toolCallIds: ['tc-1'] });

    expect(approvalController.pendingCountForSession('ses_a')).toBe(1);
    approvalController.respond({ decision: 'approved' });
    await expect(next).resolves.toEqual({ decision: 'approved' });
  });
});

describe('registerReverseRPCHandlers', () => {
  it('wires controller UI hooks without registering wire request handlers', async () => {
    const approvalController = new ApprovalController();
    const questionController = new QuestionController();
    const uiHooks = {
      showApprovalPanel: vi.fn(),
      hideApprovalPanel: vi.fn(),
      showQuestionDialog: vi.fn(),
      hideQuestionDialog: vi.fn(),
    };

    registerReverseRPCHandlers(approvalController, questionController, uiHooks);

    const approvalPending = approvalController.show({
      id: 'req-1',
      tool_call_id: 'tc-1',
      tool_name: 'Bash',
      action: 'run',
      description: '',
      display: [],
      choices: [],
    });
    expect(uiHooks.showApprovalPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'req-1' }),
    );
    approvalController.cancelAll('bye');
    await expect(approvalPending).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'bye',
    });
    expect(uiHooks.hideApprovalPanel).toHaveBeenCalledOnce();

    const questionPending = questionController.show({
      id: 'q-1',
      tool_call_id: 'tc-1',
      questions: [],
    });
    expect(uiHooks.showQuestionDialog).toHaveBeenCalledWith(expect.objectContaining({ id: 'q-1' }));
    questionController.cancelAll('bye');
    await expect(questionPending).resolves.toEqual({ answers: [] });
    expect(uiHooks.hideQuestionDialog).toHaveBeenCalledOnce();
  });

  it('queues question dialogs behind active approval panels', async () => {
    const approvalController = new ApprovalController();
    const questionController = new QuestionController();
    const uiHooks = {
      showApprovalPanel: vi.fn(),
      hideApprovalPanel: vi.fn(),
      showQuestionDialog: vi.fn(),
      hideQuestionDialog: vi.fn(),
    };

    registerReverseRPCHandlers(approvalController, questionController, uiHooks);

    const approvalPending = approvalController.show({
      id: 'approval-1',
      tool_call_id: 'tc-1',
      tool_name: 'Bash',
      action: 'run',
      description: '',
      display: [],
      choices: [],
    });
    const questionPending = questionController.show({
      id: 'question-1',
      tool_call_id: 'tq-1',
      questions: [],
    });

    expect(uiHooks.showApprovalPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'approval-1' }),
    );
    expect(uiHooks.showQuestionDialog).not.toHaveBeenCalled();

    approvalController.respond({ decision: 'approved' });
    await expect(approvalPending).resolves.toEqual({ decision: 'approved' });
    expect(uiHooks.hideApprovalPanel).toHaveBeenCalledOnce();
    expect(uiHooks.showQuestionDialog).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'question-1' }),
    );

    questionController.respond({ answers: ['answer'] });
    await expect(questionPending).resolves.toEqual({ answers: ['answer'] });
    expect(uiHooks.hideQuestionDialog).toHaveBeenCalledOnce();
  });

  it('queues approval panels behind active question dialogs', async () => {
    const approvalController = new ApprovalController();
    const questionController = new QuestionController();
    const uiHooks = {
      showApprovalPanel: vi.fn(),
      hideApprovalPanel: vi.fn(),
      showQuestionDialog: vi.fn(),
      hideQuestionDialog: vi.fn(),
    };

    registerReverseRPCHandlers(approvalController, questionController, uiHooks);

    const questionPending = questionController.show({
      id: 'question-1',
      tool_call_id: 'tq-1',
      questions: [],
    });
    const approvalPending = approvalController.show({
      id: 'approval-1',
      tool_call_id: 'tc-1',
      tool_name: 'Bash',
      action: 'run',
      description: '',
      display: [],
      choices: [],
    });

    expect(uiHooks.showQuestionDialog).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'question-1' }),
    );
    expect(uiHooks.showApprovalPanel).not.toHaveBeenCalled();

    questionController.respond({ answers: ['answer'] });
    await expect(questionPending).resolves.toEqual({ answers: ['answer'] });
    expect(uiHooks.hideQuestionDialog).toHaveBeenCalledOnce();
    expect(uiHooks.showApprovalPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'approval-1' }),
    );

    approvalController.respond({ decision: 'approved' });
    await expect(approvalPending).resolves.toEqual({ decision: 'approved' });
    expect(uiHooks.hideApprovalPanel).toHaveBeenCalledOnce();
  });

  it('removes queued modals when their controller is cancelled', async () => {
    const approvalController = new ApprovalController();
    const questionController = new QuestionController();
    const uiHooks = {
      showApprovalPanel: vi.fn(),
      hideApprovalPanel: vi.fn(),
      showQuestionDialog: vi.fn(),
      hideQuestionDialog: vi.fn(),
    };

    registerReverseRPCHandlers(approvalController, questionController, uiHooks);

    const approvalPending = approvalController.show({
      id: 'approval-1',
      tool_call_id: 'tc-1',
      tool_name: 'Bash',
      action: 'run',
      description: '',
      display: [],
      choices: [],
    });
    const questionPending = questionController.show({
      id: 'question-1',
      tool_call_id: 'tq-1',
      questions: [],
    });

    questionController.cancelAll('closed');
    await expect(questionPending).resolves.toEqual({ answers: [] });
    expect(uiHooks.hideQuestionDialog).not.toHaveBeenCalled();

    approvalController.respond({ decision: 'approved' });
    await expect(approvalPending).resolves.toEqual({ decision: 'approved' });
    expect(uiHooks.showQuestionDialog).not.toHaveBeenCalled();
  });

  it('clears active and queued modals without showing queued entries', async () => {
    const approvalController = new ApprovalController();
    const questionController = new QuestionController();
    const uiHooks = {
      showApprovalPanel: vi.fn(),
      hideApprovalPanel: vi.fn(),
      showQuestionDialog: vi.fn(),
      hideQuestionDialog: vi.fn(),
    };

    const disposers = registerReverseRPCHandlers(approvalController, questionController, uiHooks);

    const approvalPending = approvalController.show({
      id: 'approval-1',
      tool_call_id: 'tc-1',
      tool_name: 'Bash',
      action: 'run',
      description: '',
      display: [],
      choices: [],
    });
    const questionPending = questionController.show({
      id: 'question-1',
      tool_call_id: 'tq-1',
      questions: [],
    });

    for (const dispose of disposers) dispose();
    expect(uiHooks.hideApprovalPanel).toHaveBeenCalledOnce();
    expect(uiHooks.showQuestionDialog).not.toHaveBeenCalled();

    approvalController.cancelAll('closed');
    questionController.cancelAll('closed');
    await expect(approvalPending).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'closed',
    });
    await expect(questionPending).resolves.toEqual({ answers: [] });
    expect(uiHooks.hideQuestionDialog).not.toHaveBeenCalled();
  });
});
