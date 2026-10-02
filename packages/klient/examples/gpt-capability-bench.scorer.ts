/** Host-side evidence checks, separate from artifact grading. Never stage this file for the model. */
import { runScorerSelfTest, type GradeOptions, type ScorerSelfTestResult } from './gpt-adaptation-bench.scorer.js';
import { BENCH_CALIBRATION, CAPABILITY_TASKS, type CapabilityTask } from './gpt-capability-bench.tasks.js';
import type { CapabilityToolCall } from './gpt-capability-bench.hakimi.js';

export interface CapabilityTurnEvidence {
  readonly toolCalls?: readonly CapabilityToolCall[];
  readonly agents?: readonly unknown[];
  readonly tasks?: readonly unknown[];
  readonly compactions?: readonly unknown[];
  readonly sessionId?: string;
}
export interface CapabilityCheck { readonly name: string; readonly passed: boolean }
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).join('\n');
  return Object.values(record(value)).map(text).join('\n');
}
function succeeded(call: CapabilityToolCall): boolean {
  return call.status === 'succeeded' && call.source === 'event' && call.synthetic !== true && call.isError !== true;
}
function matchesCalibration(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (typeof value === 'string') {
    try { return matchesCalibration(JSON.parse(value), depth + 1); } catch { return false; }
  }
  if (Array.isArray(value)) return value.some(part => matchesCalibration(part, depth + 1));
  const row = record(value);
  if (Object.entries(BENCH_CALIBRATION).every(([key, expected]) => row[key] === expected)) return true;
  return Object.values(row).some(part => matchesCalibration(part, depth + 1));
}
function outputId(output: unknown, key: string): string | undefined {
  return new RegExp(`(?:^|\\n)${key}:\\s*(\\S+)`).exec(text(output))?.[1];
}

/** Evidence is supplied by the adapter's matched runtime events, never model-authored success flags. */
export function checkCapabilityEvidence(task: CapabilityTask, turns: readonly CapabilityTurnEvidence[]): readonly CapabilityCheck[] {
  const calls = turns.flatMap(turn => turn.toolCalls ?? []);
  const successful = calls.filter(succeeded);
  const checks: CapabilityCheck[] = (task.requiredTools ?? []).map(name => ({
    name: `real-tool:${name}`, passed: successful.some(call => call.name === name),
  }));
  if (task.id === 'F01-skill') checks.push({
    name: 'skill:bench-normalize-activated',
    passed: successful.some(call => call.name === 'Skill' && record(call.args)['skill'] === 'bench-normalize'),
  });
  if (task.id === 'F02-mcp-calibration') checks.push({
    name: 'mcp:authoritative-calibration-returned',
    passed: successful.some(call => call.name === 'mcp__bench__lookup' && record(call.args)['key'] === 'calibration-v1' && matchesCalibration(call.output)),
  });
  if (task.id === 'F03-subagent-review') {
    const agents = turns.flatMap(turn => turn.agents ?? []).map(record);
    checks.push({ name: 'subagent:completed-source-review', passed: successful.some(call => {
      if (call.name !== 'Agent' || !['coder', 'explore'].includes(String(record(call.args)['subagent_type']))) return false;
      const id = outputId(call.output, 'agent_id');
      const agent = agents.find(item => item['agentId'] === id && item['newAgent'] === true);
      if (!agent || typeof agent['finalText'] !== 'string' || !agent['finalText'].trim()) return false;
      const history = record(agent['context'])['history'];
      return Array.isArray(history) && history.some(message => record(message)['role'] === 'tool' && text(record(message)['content']).includes('canRead')) && /status:\s*completed/.test(text(call.output));
    }) });
  }
  if (task.id === 'F04-background') {
    const tasks = turns.flatMap(turn => turn.tasks ?? []).map(record);
    checks.push({ name: 'background:matching-job-completed-and-collected', passed: successful.some(call => {
      const args = record(call.args);
      if (call.name !== 'Bash' || args['run_in_background'] !== true || typeof args['command'] !== 'string' || !/\bnode\s+(?:\.\/)?scripts\/worker\.mjs(?:\s|$)/.test(args['command'])) return false;
      const id = outputId(call.output, 'task_id');
      if (id === undefined) return false;
      const completed = tasks.some(item => item['taskId'] === id && item['agentId'] === call.agentId && item['kind'] === 'process' && item['status'] === 'completed' && item['exitCode'] === 0 && Object.hasOwn(item, 'output') && String(item['command']).includes('scripts/worker.mjs'));
      return completed && successful.some(read => read.name === 'TaskOutput' && read.agentId === call.agentId && record(read.args)['task_id'] === id && /status:\s*completed/.test(text(read.output)));
    }) });
  }
  if (task.id === 'X02-flaky-reader') checks.push({
    name: 'recovery:real-failure-then-success', passed: calls.some((call, index) =>
      call.name === 'Bash' && call.status === 'failed' && call.source === 'event' && !call.synthetic &&
      String(record(call.args)['command']).includes('scripts/read.mjs') && text(call.output).includes('TEMPORARY_UNAVAILABLE') &&
      calls.slice(index + 1).some(next => succeeded(next) && next.name === 'Bash' && String(record(next.args)['command']).includes('scripts/read.mjs')),
    ),
  });
  if (task.compactBeforeTurn !== undefined) checks.push({
    name: `lifecycle:compacted-before-turn-${task.compactBeforeTurn}`, passed: (turns[task.compactBeforeTurn]?.compactions?.length ?? 0) > 0,
  });
  return checks;
}

/** Five artifact controls for each task. Feature evidence has independent controls in the unit tests. */
export async function runCapabilityScorerSelfTests(options: GradeOptions): Promise<readonly ScorerSelfTestResult[]> {
  const results: ScorerSelfTestResult[] = [];
  for (const task of CAPABILITY_TASKS) results.push(await runScorerSelfTest(task, options));
  return results;
}
