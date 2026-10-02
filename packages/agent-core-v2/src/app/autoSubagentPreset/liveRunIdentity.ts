/**
 * `autoSubagentPreset` domain — bounded, process-local run attribution.
 *
 * Only an observed live start can establish account/model ownership. Completed
 * ownership is immutable; changes during an active run discard its attribution.
 * Old ledger records cannot reconstruct identity from today's mutable aliases.
 * Neither identities nor their fingerprints are appended to the run ledger.
 */

import type { AgentRunUsageEntry, AgentRunUsageStartedRecord } from '#/app/agentRunUsage/agentRunUsage';
import { stableSnapshot } from './accountIdentity';

export interface RunIdentity {
  readonly account: string;
  readonly model: string;
  readonly protocol: string;
}

interface ObservedRun {
  readonly started: AgentRunUsageStartedRecord;
  readonly signature: string;
  readonly identity: RunIdentity;
}

export class LiveRunIdentity {
  private readonly active = new Map<string, ObservedRun>();
  private readonly completed = new Map<string, ObservedRun>();

  constructor(
    private readonly resolve: (started: AgentRunUsageStartedRecord) => RunIdentity | undefined,
    private readonly limit: () => number,
  ) {}

  start(record: AgentRunUsageStartedRecord): void {
    if (this.completed.has(record.runId) || this.active.has(record.runId)) return;
    const started = Object.freeze({ ...record });
    const identity = this.resolve(started);
    if (identity === undefined) return;
    this.retain(this.active, record.runId, { started, identity: Object.freeze({ ...identity }), signature: stableSnapshot(started) });
  }

  invalidateChanged(): void {
    for (const [runId, observed] of this.active) {
      if (!this.unchanged(observed)) this.active.delete(runId);
    }
  }

  finish(entry: AgentRunUsageEntry): boolean {
    const observed = this.active.get(entry.started.runId);
    this.active.delete(entry.started.runId);
    if (observed === undefined || entry.finished === undefined ||
      !this.matches(entry, observed) || !this.unchanged(observed)) return false;
    this.retain(this.completed, entry.started.runId, observed);
    return this.completed.has(entry.started.runId);
  }

  of(entry: AgentRunUsageEntry): RunIdentity | undefined {
    const observed = this.completed.get(entry.started.runId);
    return observed !== undefined && this.matches(entry, observed) ? observed.identity : undefined;
  }

  private matches(entry: AgentRunUsageEntry, observed: ObservedRun): boolean {
    return entry.finished?.runId === entry.started.runId &&
      entry.finished.startedAt === observed.started.startedAt &&
      stableSnapshot(entry.started) === observed.signature;
  }

  private unchanged(observed: ObservedRun): boolean {
    const current = this.resolve(observed.started);
    return current?.account === observed.identity.account && current.model === observed.identity.model &&
      current.protocol === observed.identity.protocol;
  }

  private retain(map: Map<string, ObservedRun>, runId: string, observed: ObservedRun): void {
    while (map.size >= this.limit() && map.size > 0) map.delete(map.keys().next().value!);
    if (this.limit() > 0) map.set(runId, observed);
  }
}
