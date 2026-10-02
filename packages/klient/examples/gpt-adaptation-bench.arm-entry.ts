/**
 * `gpt-adaptation-bench` arm entry point — the process the orchestrator spawns.
 *
 * Kept deliberately tiny: it forwards one plan file to the arm driver and
 * exits non-zero when the run failed, so the orchestrator's process result is
 * the primary signal and the JSON result file is the detail. Every exit path —
 * success or failure — first flushes the fetch guard's pending stream
 * observations, so a failed run never silently loses its HTTP evidence.
 */

import { runArmFromPlanFile } from './gpt-adaptation-bench.arm.js';

const planPath = process.argv[2];
if (planPath === undefined || planPath === '') {
  console.error('usage: gpt-adaptation-bench.arm-entry.ts <plan.json>');
  process.exit(2);
}

async function flushGuardObservations(): Promise<void> {
  const flush = Reflect.get(globalThis, Symbol.for('hakimi.gptBenchFlush')) as
    | (() => Promise<void>)
    | undefined;
  try {
    await flush?.();
  } catch {
    // A lost observation is recorded as a missing measurement by the guard
    // itself; exit must still happen.
  }
}

try {
  const result = await runArmFromPlanFile(planPath);
  await flushGuardObservations();
  console.log(
    JSON.stringify({
      runId: result.runId,
      arm: result.arm,
      status: result.status,
      armRootVerified: result.armRootVerified,
      prompts: result.prompts.length,
    }),
  );
  process.exit(result.status === 'ok' ? 0 : 1);
} catch (error) {
  await flushGuardObservations();
  console.error(error);
  process.exit(1);
}
