/** Tests public benchmark planning and evidence decoding without invoking a model or reading credentials. */
import { describe, expect, it } from 'vitest';
import { classifyRun, codexArguments, parseHarnessArgs, readCodexEvents, readHakimiEvents, runOrder } from '../examples/gpt-harness-bench.js';
import type { ProxyMetrics } from '../examples/gpt-harness-bench.proxy.js';
import { sandboxArguments } from '../examples/gpt-harness-bench.sandbox.js';

describe('harness benchmark planning', () => {
  it('defaults to offline planning with Astra high and three distinct arms', () => {
    expect(parseHarnessArgs([])).toMatchObject({ live: false, model: 'gpt-6-astra', effort: 'high', arms: ['codex', 'hakimi', 'hakimi-patch'] });
  });
  it('rejects a live run without a host credential source', () => {
    expect(() => parseHarnessArgs(['--live'])).toThrow('--auth-file');
  });
  it('accepts a paired catalog experiment without changing the default arms', () => {
    expect(parseHarnessArgs(['--arms', 'hakimi-patch,hakimi-catalog']).arms).toEqual(['hakimi-patch', 'hakimi-catalog']);
  });
  it('rejects the Hakimi-specific discovery probe for Codex', () => {
    expect(() => parseHarnessArgs(['--tasks', 'H01-catalog-discovery'])).toThrow('Hakimi arms only');
    expect(parseHarnessArgs(['--tasks', 'H01-catalog-discovery', '--arms', 'hakimi-patch,hakimi-catalog']).tasks).toEqual(['H01-catalog-discovery']);
  });
  it.each(['0', '-1', '1.5', 'NaN'])('rejects an invalid request cap %s', (value) => {
    expect(() => parseHarnessArgs(['--max-requests', value])).toThrow('positive integer');
  });
  it('keeps paired task blocks while rotating arm order across repetitions', () => {
    expect(runOrder({ tasks: ['example'], arms: ['codex', 'hakimi', 'hakimi-patch'], repeats: 2 })).toEqual([
      { task: 'example', repeat: 0, arm: 'codex' },
      { task: 'example', repeat: 0, arm: 'hakimi' },
      { task: 'example', repeat: 0, arm: 'hakimi-patch' },
      { task: 'example', repeat: 1, arm: 'hakimi' },
      { task: 'example', repeat: 1, arm: 'hakimi-patch' },
      { task: 'example', repeat: 1, arm: 'codex' },
    ]);
  });
  it('keeps the model and effort explicit when resuming Codex', () => {
    const args = codexArguments('gpt-6-astra', 'high', 'example-session');
    expect(args).toContain('gpt-6-astra');
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args.slice(-3)).toEqual(['resume', 'example-session', '-']);
    expect(args).not.toContain('--ephemeral');
  });
  it('does not classify a failed Codex turn as a clean completion', () => {
    expect(readCodexEvents('{"type":"thread.started","thread_id":"example"}\n{"type":"turn.failed"}\n')).toEqual({ sessionId: 'example', completed: false, failed: true });
  });
  it('requires structured completion instead of trusting prose on stdout', () => {
    expect(readCodexEvents('Task completed\nnot-json\n').completed).toBe(false);
    expect(readCodexEvents('{"type":"turn.completed","usage":{}}\n').completed).toBe(true);
  });
  it('reads only the completed current Hakimi turn and its resumable identity', () => {
    expect(readHakimiEvents('{"type":"session.started","sessionId":"example"}\n{"type":"turn.ended","reason":"completed"}\n')).toEqual({ sessionId: 'example', completed: true });
  });
  it('uses recorded successful executions instead of attempted model calls for capability checks', () => {
    expect(readHakimiEvents('{"type":"tools.completed","successes":{"TodoList":2,"select_tools":1}}\n').toolSuccesses).toEqual({ TodoList: 2, select_tools: 1 });
    expect(readHakimiEvents('{"type":"tool.call","name":"TodoList"}\n').toolSuccesses).toBeUndefined();
  });
  it('mounts only the proxy socket rather than the host auth source or task repository', () => {
    const args = sandboxArguments({
      engineRoot: '/example/engine', workspace: '/example/work', home: '/example/home',
      runDir: '/example/run', codexRoot: '/example/codex', socketPath: '/example/run/proxy.sock',
      argv: ['/runtime/bin/node', '-v'], timeoutMs: 1000,
    });
    expect(args).toContain('--unshare-all');
    expect(args).toContain('--clearenv');
    expect(args).toContain('/example/run/proxy.sock');
    expect(args).not.toContain('/example/run');
    expect(args.join(' ')).not.toContain('auth.json');
  });
});

function measuredRequest(): ProxyMetrics {
  return {
    upstreamRequests: 1, rejectedRequests: 0, authenticationFailures: 0,
    droppedOutputCapRequests: 0, usageObservedRequests: 1,
    observedBytes: 100, sseDataEvents: 1, knownEventTypes: { 'response.completed': 1 }, unknownEventTypes: 0,
    usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 15 },
    terminalEvents: { completed: 1, failed: 0, incomplete: 0 }, toolTypes: {}, toolNames: {},
    requests: [{ sequence: 1, httpStatus: 200, terminal: 'completed', toolTypes: {}, toolNames: {}, malformedEvents: 0, observedBytes: 100, sseDataEvents: 1, knownEventTypes: { 'response.completed': 1 }, unknownEventTypes: 0 }],
    budgetExceeded: false, requestBudgetExhausted: false, tokenBudgetExhausted: false,
    limits: { maxRequests: 12, totalTokenPolicy: 'observed-after-response' },
  };
}

describe('harness benchmark evidence classification', () => {
  it('accepts a completed passing task when all dispatched requests have measured usage', () => {
    expect(classifyRun({ completed: true, gradePassed: true, sandboxed: true, timedOut: false, metrics: measuredRequest() })).toEqual({ outcome: 'passed', scored: true, measurementComplete: true, passed: true });
  });
  it('invalidates missing measurements even when the hidden grader passes', () => {
    const metrics = measuredRequest();
    metrics.usageObservedRequests = 0;
    expect(classifyRun({ completed: true, gradePassed: true, sandboxed: true, timedOut: false, metrics }).outcome).toBe('invalid');
  });
  it('reports wall-clock exhaustion separately when cancellation prevents final usage', () => {
    const metrics = measuredRequest();
    metrics.usageObservedRequests = 0;
    metrics.requests[0]!.terminal = undefined;
    metrics.requests[0]!.failure = 'client_aborted';
    expect(classifyRun({ completed: false, gradePassed: false, sandboxed: true, timedOut: true, metrics })).toEqual({ outcome: 'budget_exhausted', scored: true, measurementComplete: false, passed: false });
  });
  it('does not score authentication failures as model failures', () => {
    const metrics = measuredRequest();
    metrics.requests[0]!.httpStatus = 401;
    expect(classifyRun({ completed: false, gradePassed: false, sandboxed: true, timedOut: false, metrics }).outcome).toBe('invalid');
  });
});
