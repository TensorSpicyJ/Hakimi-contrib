import type { ApprovalResponse } from '@bhjia-phys/hakimi-sdk';

import { ReverseRpcController } from '#/tui/reverse-rpc/base-controller';
import type { ApprovalPanelData } from '#/tui/reverse-rpc/types';

export class ApprovalController extends ReverseRpcController<
  ApprovalPanelData,
  ApprovalResponse
> {
  protected createCancelResponse(reason: string): ApprovalResponse {
    return { decision: 'cancelled', feedback: reason };
  }

  protected override sessionIdOf(payload: ApprovalPanelData): string | undefined {
    return payload.session_id;
  }

  protected override toolCallIdOf(payload: ApprovalPanelData): string | undefined {
    return payload.tool_call_id;
  }

  /**
   * Inherit a session-scoped approval only inside the session that granted it.
   * Two sessions can legitimately raise the same `action` (both run `ls`, both
   * edit a file with the same arguments), so matching on the action alone would
   * let one project's approval silently authorize another's request. A payload
   * without a session identity never inherits — an unknown request always gets
   * its own decision.
   */
  protected override autoResolveFor(
    resolvedPayload: ApprovalPanelData,
    response: ApprovalResponse,
    queuedPayload: ApprovalPanelData,
  ): ApprovalResponse | undefined {
    if (response.decision !== 'approved') return undefined;
    if (response.scope !== 'session') return undefined;
    const sessionId = resolvedPayload.session_id;
    if (sessionId === undefined || sessionId !== queuedPayload.session_id) return undefined;
    if (resolvedPayload.action !== queuedPayload.action) return undefined;
    // Inherit the session-scoped approval. Drop `feedback` and
    // `selectedLabel` — those described the user's interaction with the
    // first request only and would be misleading on auto-resolved ones.
    return { decision: 'approved', scope: 'session' };
  }
}
