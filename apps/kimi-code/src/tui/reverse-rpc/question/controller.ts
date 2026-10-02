import { ReverseRpcController } from '#/tui/reverse-rpc/base-controller';
import type { QuestionPanelData, QuestionPanelResponse } from '#/tui/reverse-rpc/types';

export class QuestionController extends ReverseRpcController<
  QuestionPanelData,
  QuestionPanelResponse
> {
  protected createCancelResponse(_reason: string): QuestionPanelResponse {
    return { answers: [] };
  }

  protected override sessionIdOf(payload: QuestionPanelData): string | undefined {
    return payload.session_id;
  }

  protected override toolCallIdOf(payload: QuestionPanelData): string | undefined {
    return payload.tool_call_id;
  }
}
