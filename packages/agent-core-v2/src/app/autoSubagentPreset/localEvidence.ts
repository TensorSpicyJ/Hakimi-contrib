/**
 * `autoSubagentPreset` domain — deduplicated local execution evidence.
 *
 * Summarizes observed runs, with sample confidence shrinkage and weighted first
 * token latency; missing latency and usage are not fabricated measurements.
 */

import type { AgentRunUsageEntry } from '#/app/agentRunUsage/agentRunUsage';
import { grandTotal } from '#/kosong/contract/usage';
import type { AutoSubagentPresetEvidenceScope, AutoSubagentPresetLocalEvidence } from './autoSubagentPreset';

export function summarizeRuns(entries: readonly AgentRunUsageEntry[], scope: AutoSubagentPresetEvidenceScope): AutoSubagentPresetLocalEvidence {
  const samples = [...new Map(entries.map((entry) => [entry.started.runId, entry])).values()];
  const failureCount = samples.filter((entry) => entry.finished?.status === 'failed').length;
  let tokenCount = 0;
  let latencyTotalMs = 0;
  let firstTokenLatencySampleCount = 0;
  let llmRequestCount = 0;
  for (const entry of samples) {
    const finished = entry.finished;
    if (finished?.usage !== undefined) tokenCount += grandTotal(finished.usage);
    llmRequestCount += finished?.llmRequestCount ?? 0;
    const count = finished?.firstTokenLatencySampleCount ?? 1;
    if (finished?.averageFirstTokenLatencyMs === undefined || count <= 0) continue;
    latencyTotalMs += finished.averageFirstTokenLatencyMs * count;
    firstTokenLatencySampleCount += count;
  }
  return { scope: samples.length === 0 ? 'none' : scope, sampleCount: samples.length, failureCount,
    adjustedFailureRate: samples.length === 0 ? 0 : failureCount / samples.length * Math.min(1, samples.length / 5),
    tokenCount, averageFirstTokenLatencyMs: firstTokenLatencySampleCount === 0 ? undefined : latencyTotalMs / firstTokenLatencySampleCount,
    firstTokenLatencySampleCount, llmRequestCount };
}
