import type { QuestionHandler, QuestionRequest, QuestionResult } from '@bhjia-phys/hakimi-sdk';

import type {
  QuestionPanelData,
  QuestionPanelResponse,
} from '#/tui/reverse-rpc/types';

import type { QuestionController } from './controller';

/** See `ApprovalRequestContext`: the session identity the handler answers for. */
export interface QuestionRequestContext {
  readonly sessionId: string;
  readonly sessionLabel?: string;
}

export function createQuestionAskHandler(
  controller: QuestionController,
  context?: QuestionRequestContext,
): QuestionHandler {
  return async (event): Promise<QuestionResult> => {
    try {
      const answers = await controller.show(adaptQuestionRequest(event, context));
      return adaptQuestionAnswers(event, answers);
    } catch {
      return null;
    }
  };
}

export function adaptQuestionRequest(
  event: QuestionRequest,
  context?: QuestionRequestContext,
): QuestionPanelData {
  const id =
    event.toolCallId ??
    (event.turnId === undefined ? 'question' : `question-${String(event.turnId)}`);
  return {
    id,
    tool_call_id: id,
    session_id: context?.sessionId,
    session_label: context?.sessionLabel,
    questions: event.questions.map((question) => ({
      question: question.question,
      header: question.header,
      body: question.body,
      multi_select: question.multiSelect ?? false,
      other_label: question.otherLabel,
      other_description: question.otherDescription,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description,
      })),
    })),
  };
}

export function adaptQuestionAnswers(
  event: QuestionRequest,
  response: QuestionPanelResponse,
): QuestionResult {
  const result: Record<string, string | true> = {};
  for (let i = 0; i < event.questions.length; i++) {
    const question = event.questions[i];
    const answer = response.answers[i];
    if (question === undefined || typeof answer !== 'string' || answer.length === 0) continue;
    result[question.question] = answer;
  }
  return Object.keys(result).length > 0
    ? { answers: result, method: response.method }
    : null;
}
