/**
 * `fullCompaction` domain — full-history compaction control and diagnostics.
 *
 * Defines the Agent-scope service for starting and cancelling handoffs and
 * inspecting content-free policy counters for its most recent run.
 */

import type {
  CompactionResult,
  CompactionSource,
} from './types';
import { createDecorator } from "#/_base/di/instantiation";
import type { Event } from '#/_base/event';
import type { Hooks } from '#/hooks';

export interface FullCompactionInput {
  readonly source: CompactionSource;
  readonly instruction?: string;
}

export interface FullCompactionTask {
  readonly abortController: AbortController;
  readonly promise: Promise<CompactionResult>;
  readonly trigger: CompactionSource;
  readonly tokenCount: number;
  readonly traceId?: string;
}

export interface CompactionContinuityRun {
  readonly policy: 'baseline' | 'continuity';
  readonly outcome: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly inputMessageCount: number;
  readonly preparedMessageCount: number;
  readonly duplicateReminderCount: number;
  readonly repeatedToolLineCount: number;
  readonly retryDroppedMessageCount: number;
  readonly requestCount: number;
}

export interface CompactionContinuityDiagnostics {
  readonly enabled: boolean;
  readonly lastRun: CompactionContinuityRun | null;
}

export interface IAgentFullCompactionService {
  readonly _serviceBrand: undefined;

  readonly compacting: FullCompactionTask | null;
  begin(input: FullCompactionInput): boolean;
  cancel(): void;
  diagnostics(): CompactionContinuityDiagnostics;

  readonly hooks: Hooks<{
    onWillCompact: FullCompactionTask;
  }>;

  readonly onDidFinishCompaction: Event<FullCompactionTask>;
}

export const IAgentFullCompactionService = createDecorator<IAgentFullCompactionService>('agentFullCompactionService');
