/**
 * Versioned task selection. v1 remains the original, author-visible freeze.
 * v2 clarifies two visible contracts after the documented P02/R03 audits;
 * their graders, fixtures, references and wrong solutions are unchanged.
 * v3 makes L02's first two stages locally actionable without future prompts.
 * Scores from different suite versions must not be pooled or relabeled.
 */
import { CAPABILITY_SUITE_VERSION, CAPABILITY_TASKS, type CapabilityTask } from './gpt-capability-bench.tasks.js';

export type SuiteId = 'v1' | 'v2' | 'v3';
export interface CapabilitySuite {
  readonly id: SuiteId;
  readonly version: string;
  readonly tasks: readonly CapabilityTask[];
  readonly notes: readonly string[];
}

const P02_PROMPT = [
  'Implement select(rows, policy, now) in src/select.mjs.',
  'Each row has id, windowMs, resetAt, limit and used. id is a string identifier: preserve it unchanged and do not apply numeric validation to id.',
  'The four numeric row fields are windowMs, resetAt, limit and used. The separate argument now is the fifth numeric value. All five of these numeric values must be finite numbers, without coercion; otherwise that row is ineligible.',
  'A row is also ineligible unless windowMs >= 86400000, resetAt > now, limit > 0, and 0 <= used < limit.',
  'Policy inputs are valid fixture values: policy.horizon and policy.exponent are finite positive numbers, and policy.maxBonus is finite. If policy.maxBonus <= 0, return undefined.',
  'policy.horizon and row.windowMs are durations in milliseconds; resetAt and now are timestamps in milliseconds. Compute horizon = min(policy.horizon, row.windowMs), u = max(0, 1 - (resetAt - now) / horizon), and bonus = policy.maxBonus * expm1(policy.exponent * u) / expm1(policy.exponent).',
  'Return {id, bonus, horizon} for the eligible row with greatest bonus. Break equal bonuses by earlier resetAt; preserve input order for exact ties. Return undefined when no row is eligible, including empty input.',
].join('\n');

const R03_PROMPT = [
  'Implement exact density() and partition(beta) in src/enumerate.mjs from the fixed model in sources/model.txt. Enumerate every state; do not use a Monte Carlo approximation.',
  'density() returns an object whose decimal energy-string keys map to exact integer degeneracies. partition(beta) returns the full finite-state Boltzmann sum for the supplied beta; checks at finite beta in [0, 1] require absolute error < 1e-9.',
  'Write research.json with these required fields: states (exact integer state count), groundEnergy (exact numeric minimum energy), groundDegeneracy (exact integer degeneracy), sources (array of source-ID strings), and limitations (array of strings containing "finite-system-only"). Additional top-level metadata is allowed.',
  'The sources array must contain exactly the IDs of the provided model sources, each once, read from their ID: lines. Here the only source ID is "RING4-v1", so sources must be ["RING4-v1"]. Do not put objects, file paths, combined path-and-ID descriptions, or citation prose in this array; optional richer citation metadata belongs in another field.',
].join('\n');

const V1: CapabilitySuite = {
  id: 'v1',
  version: CAPABILITY_SUITE_VERSION,
  tasks: CAPABILITY_TASKS,
  notes: [
    'Original frozen suite. P02 has an ambiguous fifth numeric field; R03 does not expose the strict source-array serialization checked by its grader.',
    'Preserve historical raw outcomes and resource accounting. Any exclusion of P02/R03 is a separately labeled post hoc sensitivity analysis, never a rewrite of v1 scores.',
    'Acceptance is a procedural holdout; task authors can inspect its contents.',
  ],
};

const V2: CapabilitySuite = {
  id: 'v2',
  version: 'capability-v2-2026-09-28',
  tasks: CAPABILITY_TASKS.map((task): CapabilityTask => {
    if (task.id === 'P02-reset-priority') return { ...task, id: 'P02-reset-priority-v2', prompts: [P02_PROMPT] };
    if (task.id === 'R03-enumerate-spin') return { ...task, id: 'R03-enumerate-spin-v2', prompts: [R03_PROMPT] };
    return task;
  }),
  notes: [
    'Only P02-reset-priority-v2 and R03-enumerate-spin-v2 have new task identities and clarified visible prompts. The other 22 task objects are the original v1 objects.',
    'P02 names four numeric row fields plus now and explicitly exempts string IDs. R03 exposes the required source-ID string array and existing numeric tolerances.',
    'All task fixtures, hidden graders, reference/wrong solutions, provenance, category, discovery mode and development/acceptance assignments remain unchanged. Hidden checks have not been relaxed.',
    'This revision follows observed contract defects; it is not an independent holdout or evidence of model improvement. Compare arms within the same suite version and keep v1 historical results separate.',
    'Acceptance is a procedural holdout; task authors can inspect its contents.',
  ],
};

const L02_STAGE_ONE_PROMPT = [
  'Implement reconcile(events) in src/ledger.mjs for the first stage of an append-only request ledger.',
  'The input for this stage consists only of {type:"start",id} events. A start reserves one request. Repeated starts with the same id reserve only one request; do not reset a prior reservation.',
  'Return {requests,tokens,pending}: requests is the number of distinct started IDs, tokens is exactly 0 in this stage, and pending contains every distinct started ID once in first-start order. Empty input returns {requests:0,tokens:0,pending:[]}.',
  'Usage/completion events are outside the current stage and will be defined in the next user turn. No usage schema is needed to finish this stage: do not invent one or ask for it now. Implement and finish the start-only stage.',
].join('\n');

const L02_STAGE_TWO_PROMPT = [
  'Extend reconcile(events) in src/ledger.mjs to reconcile start and usage events. The complete contract for this stage follows; no later schema is needed.',
  'Process the input array in order. A {type:"start",id} event reserves one request. Repeated starts with the same id never add another request, refund a reservation, reset accumulated tokens, or reopen a completed request.',
  'A usage event has the shape {type:"usage",id,input,output}. Its input and output values must each be nonnegative safe integers without coercion. Read token counts from input and output, not from a tokens field. A "complete" event is not the usage-event format.',
  'Only usage for an ID already started earlier in the input can count. Ignore usage before its start; it does not complete that ID. For a started ID, only the first valid usage event counts. Invalid usage leaves it pending, so a later valid usage event can still complete it. Ignore subsequent usage events after that first valid completion.',
  'Return {requests,tokens,pending}: requests is the number of distinct started IDs, tokens is the sum of input+output over counted usage events, and pending contains started IDs without counted usage in first-start order. Missing or invalid usage never removes a reservation. With only start events, retain the first-stage behavior: tokens=0 and all distinct started IDs pending. Empty input returns {requests:0,tokens:0,pending:[]}.',
].join('\n');

const V3: CapabilitySuite = {
  id: 'v3',
  version: 'capability-v3-2026-10-01',
  tasks: V2.tasks.map((task): CapabilityTask => {
    if (task.id !== 'L02-durable-budget') return task;
    const finalPrompt = task.prompts[2];
    if (finalPrompt === undefined) throw new Error('Frozen L02 task is missing its third prompt');
    return { ...task, id: 'L02-durable-budget-v3', prompts: [L02_STAGE_ONE_PROMPT, L02_STAGE_TWO_PROMPT, finalPrompt] };
  }),
  notes: [
    'Based on the frozen v2 suite. Only L02-durable-budget-v3 has a new task identity and clarified first/second user prompts; the other 23 task objects are the original v2 objects.',
    'L02 first handles start-only reservations with tokens=0. The second prompt states the complete start/usage event contract, including ordered eligibility, invalid usage and first-valid-completion rules. The third prompt and its journal artifact requirement remain unchanged and are not exposed early.',
    'All fixtures, hidden graders, reference/wrong solutions, provenance, lifecycle settings, category and development/acceptance assignments remain unchanged. No hidden check is relaxed.',
    'This revision follows an observed first-turn information-release ambiguity. It does not erase v1/v2 observations, establish model improvement, or constitute an independent holdout. Compare arms within one suite version.',
    'Acceptance is a procedural holdout; task authors can inspect its contents.',
  ],
};

export function getSuite(id: SuiteId): CapabilitySuite {
  if (id === 'v1') return V1;
  if (id === 'v2') return V2;
  if (id === 'v3') return V3;
  throw new Error(`Unknown capability suite: ${String(id)}`);
}
