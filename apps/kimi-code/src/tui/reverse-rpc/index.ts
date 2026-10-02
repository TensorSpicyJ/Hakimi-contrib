import type { SessionInteractionSettledEvent } from '@bhjia-phys/hakimi-sdk';

import type { ApprovalController } from './approval/controller';
import type { QuestionController } from './question/controller';
import { ReverseRpcModalCoordinator } from './modal-coordinator';
import type { ApprovalPanelData, QuestionPanelData } from './types';

export interface ReverseRPCUIHooks {
  readonly showApprovalPanel: (payload: ApprovalPanelData) => void;
  readonly hideApprovalPanel: () => void;
  readonly showQuestionDialog: (payload: QuestionPanelData) => void;
  readonly hideQuestionDialog: () => void;
}

/**
 * Builds the handler for the SDK's settled channel: a pending approval or
 * question the engine stopped waiting for (its turn was cancelled, its session
 * closed) must not leave a panel on screen. Both controllers are cleared by
 * tool-call id, scoped to the reporting session, and the call is idempotent —
 * the request the user just answered is already gone from its controller when
 * the engine reports it settled.
 */
export function createInteractionSettledHandler(
  approvalController: ApprovalController,
  questionController: QuestionController,
): (event: SessionInteractionSettledEvent) => void {
  return (event) => {
    for (const toolCallId of event.toolCallIds) {
      approvalController.cancelByToolCallId(toolCallId, 'request cancelled', event.sessionId);
      questionController.cancelByToolCallId(toolCallId, 'request cancelled', event.sessionId);
    }
  };
}

export function registerReverseRPCHandlers(
  approvalController: ApprovalController,
  questionController: QuestionController,
  uiHooks: ReverseRPCUIHooks,
): Array<() => void> {
  const modalCoordinator = new ReverseRpcModalCoordinator(uiHooks);

  // Setup UI hooks for controllers
  approvalController.setUIHooks({
    showPanel: (payload) => {
      modalCoordinator.showApproval(payload);
    },
    hidePanel: () => {
      modalCoordinator.hide('approval');
    },
  });

  questionController.setUIHooks({
    showPanel: (payload) => {
      modalCoordinator.showQuestion(payload);
    },
    hidePanel: () => {
      modalCoordinator.hide('question');
    },
  });

  return [
    () => {
      modalCoordinator.clear();
    },
  ];
}
