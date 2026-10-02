import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITY_TASKS } from '../examples/gpt-capability-bench.tasks.js';
import { getSuite, type SuiteId } from '../examples/gpt-capability-bench.suites.js';
import { checkCapabilityEvidence, runCapabilityScorerSelfTests } from '../examples/gpt-capability-bench.scorer.js';
import { gradeWorkspace, runScorerSelfTest, writeTree } from '../examples/gpt-adaptation-bench.scorer.js';
import { useCapabilitySandbox } from '../examples/gpt-adaptation-bench.sandbox.js';
import type { CapabilityToolCall } from '../examples/gpt-capability-bench.hakimi.js';

// These values pin the original suite before introducing v2. They must not be
// regenerated to accommodate changes to historical tasks or observed scores.
const V1_FILE_SHA256 = '4656500eef118c8aa04ac0a322e78c702cdd88bbebeb8257e284ee9599aa181b';
const V1_TASK_SHA256 = {
  'S01-labels': 'ac01a643b7c9d1da32074a70e83f3be2d270476c78ea6c9cc904cce114d29606',
  'S02-inventory': 'acb61e0e2c49513f31783e893cfec9ba0a6a1998a3ca22e24eebe8fb26dc1c73',
  'S03-config': 'ddcfa11ad432538403625dd693493a4d975c260083399b8b9c69357d49f66f80',
  'S04-codepoints': '79053e83675b4adfe2529d237eb93304cbe7b2b065fb6139ff1bcee79bb2bc42',
  'P01-ledger-price': '15e0db6bd13e2e0eadd9706cf857e271db722e513744d06d827b44a30dc5995f',
  'P02-reset-priority': '8389e3a2f7af1340512d3fa716fe33bb2a211db8061a53d8096551ebc60e364b',
  'P03-resume-binding': '3e9866f3b3876d7e2865a6f47d9f76d99b5c4db93f31badd404578373ea3160c',
  'P04-wire-null': 'ced9d9e17c97b1160e7b0db0e9e02716dfffcfb291e317f4e2811c657e59ecfe',
  'F01-skill': '1ffee919faeefecd75ce6d24eea3360239cf67730c95ab34ce55179af2eee114',
  'F02-mcp-calibration': '5ce809048ffb1ef2f85ccf152c3be55e5a64a3348b9a9d2ce2deb735d0bad15a',
  'F03-subagent-review': '5e58b5cb3016d445f3c7c9b8a56685f24bc9189d1681544ac0fe35327ce4c86d',
  'F04-background': 'cebe5a2ed35f54f5381902793cffedf58fccba12031032e36b178f59f3f956f7',
  'L01-migration': '1ee9e3b57737e4d7995ea9525ec630819798af7ea974872884c7c27ba4c4f2a7',
  'L02-durable-budget': '4901f98107783a2f4bc39ca0f0521b798b5304959a8ed49c25337726d3f7120f',
  'L03-compaction-catalog': 'a6f3c1333eefc632aa89fed1171f2b7780df919a66a096e10293a6d9f46c356e',
  'L04-config-evolution': 'f5a2211fed9502223295f9fe563bed01c642659872964cb7b310f470c2f38af6',
  'R01-linear-fit': 'b5e539d6e1b1ccbe54ba2d59292ebeb4f690ff09c83f9f22bb41f7f3cebddbba',
  'R02-weighted-estimate': '8ddf44992f37ad01bd13e3998cd3613e9a2d61199293ee2b40448b85fa7151b3',
  'R03-enumerate-spin': '52ced24c37d35758117c59257502b08c027ccd0dbf9872a9b99c346e7b503c38',
  'R04-evidence-decision': '2755bf433e03fac0491d610366367466e8d69b6a64379e50606a9b4a01cf00d8',
  'X01-jsonl-recovery': '7f3a6e64160456f97bd80ecfffa808ffdf3ecf1a57475b1732b06f6f4971b1e2',
  'X02-flaky-reader': '2108daf0e434d6a21ecf91c39d867fa5195132615399e8ec3949abe4f8389ed9',
  'X03-untrusted-document': '105921583a6f6c5fef17cb6d3c0cce12a26c543d86879d755840fcb2b50f0c34',
  'X04-replay-journal': '0b1dd6e941e6fd0d5bc893f5151d71d41f9332eae04682837daf70039e727c85',
};
const FROZEN_SUITE_SHA256 = {
  v1: '62b311c16836be30498f666036dea4986a358bfbeb76a0e905ba1109f95bf4d3',
  v2: '8594c1bce1f3bc03e0c5b5fd824f307e54aa0f2d977be2fb612b31a21622553a',
};
const V2_TASKS_SHA256 = '75cf347e7dfc0580bc311548362d1ef8be6995f56fc1aea51dbd3738529945f7';

function find(id: string) { return CAPABILITY_TASKS.find(task => task.id === id)!; }
function call(name: string, args: unknown, output: unknown): CapabilityToolCall {
  return { agentId: 'main', toolCallId: name, name, args, output, status: 'succeeded', source: 'event', isError: false, synthetic: false };
}
describe('capability task inventory and frozen rubric', () => {
  it('has 24 unique tasks, six balanced categories and one procedural holdout per category', () => {
    expect(CAPABILITY_TASKS).toHaveLength(24);
    expect(new Set(CAPABILITY_TASKS.map(task => task.id)).size).toBe(24);
    for (const category of ['simple','project','features','long','research','recovery']) {
      const tasks = CAPABILITY_TASKS.filter(task => task.category === category);
      expect(tasks).toHaveLength(4);
      expect(tasks.filter(task => task.split === 'acceptance')).toHaveLength(1);
    }
    for (const task of CAPABILITY_TASKS) {
      expect(Object.keys(task.reference).length).toBeGreaterThan(0);
      expect(Object.keys(task.wrong).length).toBeGreaterThan(0);
      expect(Object.keys(task.files).some(path => path.startsWith('test/'))).toBe(true);
      expect(task.prompts.length).toBeGreaterThan(0);
      expect(task.grader).toContain("from 'node:test'");
      expect(Object.values(task.files)).not.toContain(task.grader);
      if (task.category === 'research') expect(task.rubric?.length).toBeGreaterThanOrEqual(3);
    }
  });
  it('pins four reduced repository contracts with their exact observed source identity', () => {
    const tasks = CAPABILITY_TASKS.filter(task => task.provenance.kind === 'repository-reduction');
    expect(tasks).toHaveLength(4);
    for (const {provenance} of tasks) {
      expect(provenance.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(provenance.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(provenance.sourcePath).toMatch(/^packages\//);
      expect(provenance.reductionBoundary?.length).toBeGreaterThan(50);
    }
  });
  it('separates natural discovery from explicit protocol probes', () => {
    expect(find('F02-mcp-calibration').discovery).toBe('natural');
    expect(find('F01-skill').discovery).toBe('protocol');
    expect(find('F03-subagent-review').discovery).toBe('protocol');
    expect(find('F04-background').discovery).toBe('protocol');
  });
});

describe('versioned capability suite contracts', () => {
  it('pins the original source bytes and every v1 task hash', () => {
    const bytes = readFileSync(new URL('../examples/gpt-capability-bench.tasks.ts', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(V1_FILE_SHA256);
    expect(getSuite('v1').tasks).toBe(CAPABILITY_TASKS);
    const hashes = Object.fromEntries(getSuite('v1').tasks.map(task => [task.id, createHash('sha256').update(JSON.stringify(task)).digest('hex')]));
    expect(hashes).toEqual(V1_TASK_SHA256);
  });

  it('retains the entire frozen v1 and v2 suite objects and every v2 task', () => {
    for (const suiteId of ['v1', 'v2'] as const) {
      expect(createHash('sha256').update(JSON.stringify(getSuite(suiteId))).digest('hex')).toBe(FROZEN_SUITE_SHA256[suiteId]);
    }
    expect(createHash('sha256').update(JSON.stringify(getSuite('v2').tasks)).digest('hex')).toBe(V2_TASKS_SHA256);
  });

  it('changes only two task identities and visible prompts, retaining the exact hidden contracts', () => {
    const before = getSuite('v1');
    const after = getSuite('v2');
    expect(after.version).not.toBe(before.version);
    const changed: string[] = [];
    after.tasks.forEach((task, index) => {
      const old = before.tasks[index]!;
      if (task.id === old.id) {
        expect(task).toBe(old);
        return;
      }
      changed.push(task.id);
      const { id, prompts, ...retained } = task;
      const { id: oldId, prompts: oldPrompts, ...original } = old;
      expect(id).toBe(`${oldId}-v2`);
      expect(prompts).not.toEqual(oldPrompts);
      expect(retained).toEqual(original);
      expect(task.grader).toBe(old.grader);
      expect(task.reference).toBe(old.reference);
      expect(task.wrong).toBe(old.wrong);
    });
    expect(changed).toEqual(['P02-reset-priority-v2', 'R03-enumerate-spin-v2']);
  });

  it.each(['v1', 'v2', 'v3'] as const)('retains 24 tasks and all category/split assignments in %s', suiteId => {
    const { tasks } = getSuite(suiteId);
    expect(tasks).toHaveLength(24);
    expect(new Set(tasks.map(task => task.id)).size).toBe(24);
    expect(tasks.filter(task => task.split === 'acceptance')).toHaveLength(6);
    expect(tasks.filter(task => task.split === 'development')).toHaveLength(18);
    for (const category of ['simple', 'project', 'features', 'long', 'research', 'recovery']) {
      const group = tasks.filter(task => task.category === category);
      expect(group).toHaveLength(4);
      expect(group.filter(task => task.split === 'acceptance')).toHaveLength(1);
    }
  });

  it('changes only L02 identity and its first two prompts in v3 without leaking the third stage', () => {
    const before = getSuite('v2');
    const after = getSuite('v3');
    expect(after.version).toBe('capability-v3-2026-10-01');
    const changed: string[] = [];
    after.tasks.forEach((task, index) => {
      const old = before.tasks[index]!;
      if (task.id === old.id) {
        expect(task).toBe(old);
        return;
      }
      changed.push(task.id);
      expect(old.id).toBe('L02-durable-budget');
      const { id, prompts, ...retained } = task;
      const { id: oldId, prompts: oldPrompts, ...original } = old;
      expect(id).toBe(`${oldId}-v3`);
      expect(prompts).toHaveLength(3);
      expect(prompts[0]).not.toBe(oldPrompts[0]);
      expect(prompts[1]).not.toBe(oldPrompts[1]);
      expect(prompts[2]).toBe(oldPrompts[2]);
      expect(retained).toEqual(original);
      expect(task.grader).toBe(old.grader);
      expect(task.files).toBe(old.files);
      expect(task.reference).toBe(old.reference);
      expect(task.wrong).toBe(old.wrong);
      expect(task.resumeAfter).toBe(1);
      expect(prompts[0]).toContain('input for this stage consists only of {type:"start",id}');
      expect(prompts[0]).toContain('tokens is exactly 0');
      expect(prompts[0]).toContain('pending contains every distinct started ID once in first-start order');
      expect(prompts[0]).toContain('No usage schema is needed to finish this stage');
      expect(prompts[0]).not.toContain('type:"usage"');
      expect(prompts[1]).toContain('{type:"usage",id,input,output}');
      expect(prompts[1]).toContain('first valid usage event counts');
      expect(prompts.slice(0, 2).join('\n')).not.toContain('journal.json');
      expect(prompts.slice(0, 2).join('\n')).not.toContain('17 tokens');
    });
    expect(changed).toEqual(['L02-durable-budget-v3']);
    expect(after.tasks.some(task => task.id === 'L02-durable-budget')).toBe(false);
  });

  it('exposes the previously hidden type and citation contracts and rejects unknown suites', () => {
    const revised = getSuite('v2').tasks;
    const p02 = revised.find(task => task.id === 'P02-reset-priority-v2')!.prompts.join('\n');
    expect(p02).toContain('id is a string identifier');
    expect(p02).toContain('do not apply numeric validation to id');
    expect(p02).toContain('now is the fifth numeric value');
    expect(p02).toContain('horizon = min(policy.horizon, row.windowMs)');
    const r03 = revised.find(task => task.id === 'R03-enumerate-spin-v2')!.prompts.join('\n');
    expect(r03).toContain('sources must be ["RING4-v1"]');
    expect(r03).toContain('Do not put objects, file paths');
    expect(r03).toContain('absolute error < 1e-9');
    expect(() => getSuite('unknown' as SuiteId)).toThrow('Unknown capability suite');
  });
});

describe('capability execution evidence controls', () => {
  it('rejects prose, absent evidence, wrong arguments, synthetic events and unverified context', () => {
    const task = find('F01-skill');
    expect(checkCapabilityEvidence(task, []).every(check => check.passed)).toBe(false);
    for (const tool of [call('Skill',{skill:'wrong'},'done'), {...call('Skill',{skill:'bench-normalize'},'done'),synthetic:true}, {...call('Skill',{skill:'bench-normalize'},'done'),status:'unverified' as const,source:'context' as const}]) {
      expect(checkCapabilityEvidence(task,[{toolCalls:[tool]}]).every(check => check.passed)).toBe(false);
    }
    expect(checkCapabilityEvidence(task,[{toolCalls:[call('Skill',{skill:'bench-normalize'},'activated')]}]).every(check => check.passed)).toBe(true);
  });
  it('requires real MCP lookup parameters and matching returned data', () => {
    const task = find('F02-mcp-calibration');
    const args = {key:'calibration-v1'};
    expect(checkCapabilityEvidence(task,[{toolCalls:[call('mcp__bench__lookup',args,'success')]}]).every(c=>c.passed)).toBe(false);
    const output = [{type:'text',text:JSON.stringify({id:'calibration-v1',unit:'mV',slope:2.5,intercept:-1,source:'bench-calibration-2026-01'})}];
    expect(checkCapabilityEvidence(task,[{toolCalls:[call('mcp__bench__lookup',args,output)]}]).every(c=>c.passed)).toBe(true);
  });
  it('requires a matching child with actual source-reading context and completed output', () => {
    const task = find('F03-subagent-review');
    const toolCalls = [call('Agent',{subagent_type:'explore'},'agent_id: child\nstatus: completed')];
    expect(checkCapabilityEvidence(task,[{toolCalls}]).every(c=>c.passed)).toBe(false);
    const agents = [{agentId:'child',newAgent:true,finalText:'Authorization findings',context:{history:[{role:'tool',content:[{type:'text',text:'export function canRead(actor,doc) {...}'}]}]}}];
    expect(checkCapabilityEvidence(task,[{toolCalls,agents}]).every(c=>c.passed)).toBe(true);
    expect(checkCapabilityEvidence(task,[{toolCalls,agents:[{...agents[0],agentId:'other'}]}]).every(c=>c.passed)).toBe(false);
  });
  it('requires a matching completed background process and its collected TaskOutput', () => {
    const task=find('F04-background');
    const toolCalls=[call('Bash',{command:'node scripts/worker.mjs',run_in_background:true},'task_id: p1'),call('TaskOutput',{task_id:'p1'},'status: completed\nexitCode: 0')];
    const tasks=[{taskId:'p1',agentId:'main',kind:'process',command:'node scripts/worker.mjs',status:'completed',exitCode:0,output:''}];
    expect(checkCapabilityEvidence(task,[{toolCalls,tasks}]).every(c=>c.passed)).toBe(true);
    expect(checkCapabilityEvidence(task,[{toolCalls,tasks:[{...tasks[0],status:'running'}]}]).every(c=>c.passed)).toBe(false);
    expect(checkCapabilityEvidence(task,[{toolCalls,tasks:[{...tasks[0],taskId:'different'}]}]).every(c=>c.passed)).toBe(false);
  });
  it('requires observed compaction at the specified turn', () => {
    const task=find('L03-compaction-catalog');
    expect(checkCapabilityEvidence(task,[{compactions:[{}]},{}]).every(c=>c.passed)).toBe(false);
    expect(checkCapabilityEvidence(task,[{},{compactions:[{}]}]).every(c=>c.passed)).toBe(true);
  });
  it('requires transient failure before success, not a fabricated attempts file', () => {
    const task=find('X02-flaky-reader');
    const success=call('Bash',{command:'node scripts/read.mjs'},'{"total":42}');
    const failed={...success,toolCallId:'failed',status:'failed' as const,isError:true,output:'TEMPORARY_UNAVAILABLE'};
    expect(checkCapabilityEvidence(task,[{toolCalls:[success]}]).every(c=>c.passed)).toBe(false);
    expect(checkCapabilityEvidence(task,[{toolCalls:[failed,success]}]).every(c=>c.passed)).toBe(true);
  });
});

// Full process-isolated controls are explicit because they require Linux namespaces.
it.runIf(process.env['CAPABILITY_SCORER_SELFTEST'] === '1')('runs every positive/negative/tamper artifact control offline', async () => {
  useCapabilitySandbox();
  const results=await runCapabilityScorerSelfTests({scratchDir:resolve(import.meta.dirname,'../../../.tmp/hakimi-benchmark-v2/task-controls'),timeoutMs:20000});
  expect(results.filter(result=>!result.ok)).toEqual([]);
}, 300_000);

it.runIf(process.env['CAPABILITY_SUITE_SELFTEST'] === '1')('runs v2 revised-task controls and rejects the former contract misinterpretations', async () => {
  useCapabilitySandbox();
  const scratch = resolve(import.meta.dirname, '../../../.tmp/hakimi-benchmark-v2/suite-v2');
  const revised = getSuite('v2').tasks.filter(task => task.id.endsWith('-v2'));
  const controls = [];
  for (const task of revised) controls.push(await runScorerSelfTest(task, { scratchDir: resolve(scratch, task.id), timeoutMs: 20000 }));

  const p02 = revised.find(task => task.id === 'P02-reset-priority-v2')!;
  const r03 = revised.find(task => task.id === 'R03-enumerate-spin-v2')!;
  const research = JSON.parse(r03.reference['research.json']!) as Record<string, unknown>;
  const cases: readonly { name: string; task: typeof p02; expected: boolean; patch: Readonly<Record<string, string>> }[] = [
    {
      name: 'p02-explicit-string-identifier-solution', task: p02, expected: true,
      patch: { 'src/select.mjs': `export function select(rows, policy, now) {
        if (policy.maxBonus <= 0 || !Number.isFinite(now)) return undefined;
        let chosen;
        let chosenReset;
        for (const row of rows) {
          if (![row.windowMs, row.resetAt, row.limit, row.used].every(Number.isFinite) || row.windowMs < 86400000 || row.resetAt <= now || row.limit <= 0 || row.used < 0 || row.used >= row.limit) continue;
          const horizon = Math.min(policy.horizon, row.windowMs);
          const urgency = Math.max(0, 1 - (row.resetAt - now) / horizon);
          const bonus = policy.maxBonus * Math.expm1(policy.exponent * urgency) / Math.expm1(policy.exponent);
          if (chosen === undefined || bonus > chosen.bonus || (bonus === chosen.bonus && row.resetAt < chosenReset)) {
            chosen = { id: row.id, bonus, horizon }; chosenReset = row.resetAt;
          }
        }
        return chosen;
      }\n` },
    },
    {
      name: 'p02-incorrect-numeric-identifier-filter', task: p02, expected: false,
      patch: { 'src/select.mjs': p02.reference['src/select.mjs']!.replace('[r.windowMs,r.resetAt,r.limit,r.used,now]', '[r.id,r.windowMs,r.resetAt,r.limit,r.used]') },
    },
    {
      name: 'r03-object-citations-explicitly-disallowed', task: r03, expected: false,
      patch: { 'research.json': JSON.stringify({ ...research, sources: [{ path: 'sources/model.txt', id: 'RING4-v1' }] }) },
    },
    {
      name: 'r03-path-and-id-citations-explicitly-disallowed', task: r03, expected: false,
      patch: { 'research.json': JSON.stringify({ ...research, sources: ['sources/model.txt (RING4-v1)'] }) },
    },
    {
      name: 'r03-incorrect-source-id-rejected', task: r03, expected: false,
      patch: { 'research.json': JSON.stringify({ ...research, sources: ['OTHER-v1'] }) },
    },
    {
      name: 'r03-extra-metadata-with-correct-source-array', task: r03, expected: true,
      patch: { 'research.json': JSON.stringify({ ...research, sourceDetails: [{ path: 'sources/model.txt', id: 'RING4-v1' }] }) },
    },
  ];
  const regressions = [];
  for (const fixture of cases) {
    const workspace = resolve(scratch, fixture.name);
    await writeTree(workspace, { ...fixture.task.files, ...fixture.task.reference, ...fixture.patch });
    const grade = await gradeWorkspace(fixture.task, workspace, { scratchDir: resolve(scratch, 'grader'), timeoutMs: 20000 });
    regressions.push({ name: fixture.name, expected: fixture.expected, grade });
  }
  await mkdir(scratch, { recursive: true });
  await writeFile(resolve(scratch, 'selftest-summary.json'), JSON.stringify({ suite: getSuite('v2').version, controls, regressions }, null, 2) + '\n');
  expect(controls).toHaveLength(2);
  expect(controls.every(control => control.variants.length === 5 && control.ok)).toBe(true);
  for (const result of regressions) {
    expect(result.grade.sandboxed, result.name).toBe(true);
    expect(result.grade.passed, result.name).toBe(result.expected);
  }
}, 120_000);

it.runIf(process.env['CAPABILITY_V3_SELFTEST'] === '1')('runs L02 v3 final controls and independently verifies each implementation stage', async () => {
  useCapabilitySandbox();
  const scratch = resolve(import.meta.dirname, '../../../.tmp/hakimi-benchmark-v2/suite-v3');
  const task = getSuite('v3').tasks.find(candidate => candidate.id === 'L02-durable-budget-v3')!;
  const controls = await runScorerSelfTest(task, { scratchDir: resolve(scratch, 'final-controls'), timeoutMs: 20000 });
  // These extra suites validate the staged contract offline. They do not replace
  // the benchmark's frozen final grader, and are never sent as model input.
  const header = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { reconcile } from '../src/ledger.mjs';\n`;
  const stageOneGrader = header + `test('start-only stage is self-contained', () => {
    assert.deepEqual(reconcile([]), {requests:0,tokens:0,pending:[]});
    const events = ['second','first','second','__proto__','constructor',''].map(id=>({type:'start',id}));
    assert.deepEqual(reconcile(events), {requests:5,tokens:0,pending:['second','first','__proto__','constructor','']});
  });\n`;
  const stageTwoGrader = header + `test('full usage schema, validation, order and reservation preservation', () => {
    assert.deepEqual(reconcile([]), {requests:0,tokens:0,pending:[]});
    const events = [
      {type:'usage',id:'a',input:100,output:3},
      {type:'start',id:'a'}, {type:'start',id:'b'}, {type:'start',id:'a'},
      {type:'usage',id:'a',input:-1,output:3},
      {type:'usage',id:'a',input:1.5,output:3},
      {type:'usage',id:'a',input:'10',output:3},
      {type:'usage',id:'a',input:10,output:7},
      {type:'usage',id:'a',input:2,output:4}, {type:'start',id:'a'},
      {type:'start',id:'c'}, {type:'usage',id:'c',input:0,output:0},
      {type:'start',id:'d'}, {type:'usage',id:'d',input:NaN,output:2},
      {type:'usage',id:'d',input:2,output:Infinity},
      {type:'usage',id:'d',input:Number.MAX_SAFE_INTEGER+1,output:1}
    ];
    assert.deepEqual(reconcile(events), {requests:4,tokens:17,pending:['b','d']});
    assert.deepEqual(reconcile([{type:'usage',id:'x',input:3,output:4},{type:'start',id:'x'}]), {requests:1,tokens:0,pending:['x']});
    assert.deepEqual(reconcile([{type:'start',id:'b'},{type:'start',id:'a'},{type:'start',id:'b'}]), {requests:2,tokens:0,pending:['b','a']});
  });\n`;
  const stageOneTask = { ...task, grader: stageOneGrader };
  const stageTwoTask = { ...task, grader: stageTwoGrader };
  const stageOneSolution = `export function reconcile(events) {
    const started = new Set();
    for (const event of events) if (event.type === 'start') started.add(event.id);
    return { requests: started.size, tokens: 0, pending: [...started] };
  }\n`;
  const inventedCompletionSchema = `export function reconcile(events) {
    const started = new Set(), completed = new Set(); let tokens = 0;
    for (const event of events) {
      if (event.type === 'start') started.add(event.id);
      if (event.type === 'complete' && started.has(event.id) && !completed.has(event.id)) {
        completed.add(event.id); tokens += event.tokens;
      }
    }
    return {requests:started.size,tokens,pending:[...started].filter(id=>!completed.has(id))};
  }\n`;
  const cases: readonly { name: string; task: typeof task; expected: boolean; source: string }[] = [
    { name: 'stage1-correct-with-no-future-schema', task: stageOneTask, expected: true, source: stageOneSolution },
    { name: 'stage1-stub-rejected', task: stageOneTask, expected: false, source: task.files['src/ledger.mjs']! },
    { name: 'stage2-backwards-compatible-with-stage1', task: stageOneTask, expected: true, source: task.reference['src/ledger.mjs']! },
    { name: 'stage2-complete-contract-with-no-journal-required', task: stageTwoTask, expected: true, source: task.reference['src/ledger.mjs']! },
    { name: 'stage1-not-mistaken-for-stage2-completion', task: stageTwoTask, expected: false, source: stageOneSolution },
    { name: 'stage2-invented-complete-event-rejected', task: stageTwoTask, expected: false, source: inventedCompletionSchema },
    { name: 'stage3-still-requires-journal-artifact', task, expected: false, source: task.reference['src/ledger.mjs']! },
  ];
  const stages = [];
  for (const fixture of cases) {
    const workspace = resolve(scratch, fixture.name);
    await writeTree(workspace, { ...task.files, 'src/ledger.mjs': fixture.source });
    const grade = await gradeWorkspace(fixture.task, workspace, { scratchDir: resolve(scratch, 'grader'), timeoutMs: 20000 });
    stages.push({ name: fixture.name, expected: fixture.expected, grade });
  }
  await mkdir(scratch, { recursive: true });
  await writeFile(resolve(scratch, 'selftest-summary.json'), JSON.stringify({ suite: getSuite('v3').version, controls, stages }, null, 2) + '\n');
  expect(controls.variants).toHaveLength(5);
  expect(controls.ok).toBe(true);
  for (const result of stages) {
    expect(result.grade.sandboxed, result.name).toBe(true);
    expect(result.grade.passed, result.name).toBe(result.expected);
  }
}, 120_000);
