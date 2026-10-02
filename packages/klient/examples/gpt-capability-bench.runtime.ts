import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { REPO_ROOT, snapshotEngine } from './gpt-harness-bench.sandbox.js';
import type { BenchTask } from './gpt-adaptation-bench.tasks.js';
import type { CapabilitySuite } from './gpt-capability-bench.suites.js';

export const SNAPSHOT_PACKAGES = ['klient', 'agent-core-v2', 'tree-sitter-bash', 'protocol', 'minidb', 'oauth'];

async function readControlSources() {
  const root = join(REPO_ROOT, 'packages/klient/examples');
  const names = (await readdir(root)).filter((name) => /^gpt-(capability|harness|adaptation)-bench\..*\.(ts|mjs)$/.test(name) || /^gpt-(capability|harness|adaptation)-bench\.ts$/.test(name)).toSorted();
  const digest = createHash('sha256');
  const files = [];
  for (const name of names) {
    const bytes = await readFile(join(root, name));
    digest.update(name); digest.update(bytes);
    files.push({ name, bytes });
  }
  return { sourceHash: digest.digest('hex'), files };
}

export async function benchmarkSourceHash(): Promise<string> { return (await readControlSources()).sourceHash; }

/** The host control tree contains graders and later prompts. Never mount it at /engine or /workspace. */
export async function archiveBenchmarkControl(runRoot: string, expectedSourceHash: string, suite: CapabilitySuite, catalogText?: string) {
  const sources = await readControlSources();
  if (sources.sourceHash !== expectedSourceHash) throw new Error('Benchmark sources changed before control archival');
  const root = join(runRoot, 'control-source');
  await mkdir(root); // A pre-existing archive must never be silently overwritten.
  const examples = join(root, 'packages/klient/examples');
  await mkdir(examples, { recursive: true });
  const files = [];
  for (const { name, bytes } of sources.files) {
    await writeFile(join(examples, name), bytes, { flag: 'wx' });
    files.push({ name, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  for (const name of ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'packages/klient/package.json', 'packages/klient/tsconfig.json', 'packages/klient/tsconfig.examples.json']) {
    await cp(join(REPO_ROOT, name), join(root, name), { force: false, errorOnExist: true });
  }
  await writeFile(join(root, 'selected-suite.json'), JSON.stringify(suite, null, 2) + '\n', { flag: 'wx' });
  if (catalogText !== undefined) await writeFile(join(root, 'model-catalog.json'), catalogText, { flag: 'wx' });
  const index = { sourceHash: sources.sourceHash, files, suite: { id: suite.id, version: suite.version },
    dependencyLockHash: createHash('sha256').update(await readFile(join(root, 'pnpm-lock.yaml'))).digest('hex'),
    modelCatalogHash: catalogText === undefined ? undefined : createHash('sha256').update(catalogText).digest('hex'),
    note: 'Host-only control source and selected task definitions. Runtime/dependencies are in sibling engine/; this directory is never exposed to agents.' };
  await writeFile(join(root, 'index.json'), JSON.stringify(index, null, 2) + '\n', { flag: 'wx' });
  return { ...index, archiveHash: await hashTree(root) };
}
/** Hash file content, path and symlink target without following links out of the tree. */
export async function hashTree(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      hash.update(relative(root, path) + '\0');
      if (entry.isDirectory()) { hash.update('d\0'); await visit(path); }
      else if (entry.isSymbolicLink()) hash.update('l\0' + await readlink(path) + '\0');
      else if (entry.isFile()) hash.update(createHash('sha256').update(await readFile(path)).digest());
      else throw new Error(`Unexpected snapshot entry ${entry.name}`);
    }
  }
  await visit(root); return hash.digest('hex');
}

export async function freezeRuntime(root: string): Promise<{ engineHash: string; dependenciesHash: string }> {
  await snapshotEngine(root);
  const adapter = 'gpt-capability-bench.hakimi.ts';
  await cp(join(REPO_ROOT, 'packages/klient/examples', adapter), join(root, 'packages/klient/examples', adapter));
  // Dependencies are private batch copies. Live installation changes cannot leak between arms.
  await cp(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  for (const name of SNAPSHOT_PACKAGES) {
    const source = join(REPO_ROOT, 'packages', name, 'node_modules');
    if (existsSync(source)) await cp(source, join(root, 'packages', name, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  }
  return { engineHash: await hashTree(root), dependenciesHash: await hashTree(join(root, 'node_modules')) };
}

/** Deterministic Responses fixture: real engine/tools, scripted solution; never a capability score. */
export async function startFixture(task: BenchTask) {
  let sequence = 0;
  let turn = 0;
  let step = 0;
  let childStep = 0;
  const completion = 'Offline fixture completed. This is not model capability evidence.';
  const childMarker = 'BENCH_OFFLINE_CHILD';
  type FixtureTool = { name: string; args: Record<string, unknown> };
  function writeReference(): FixtureTool {
    const files = turn === task.prompts.length - 1 ? task.reference : {};
    const payload = Buffer.from(JSON.stringify(files)).toString('base64');
    const script = `const fs=require('node:fs'),p=require('node:path');for(const [f,s] of Object.entries(JSON.parse(Buffer.from('${payload}','base64')))){fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,s)}`;
    return { name: 'Bash', args: { command: `node -e ${JSON.stringify(script)}`, description: 'Apply the deterministic offline fixture' } };
  }
  const server = createServer((request, response) => {
    void (async () => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const parsed = JSON.parse(body) as { tools?: { name?: string; function?: { name?: string } }[]; input?: { type?: string; role?: string; content?: unknown; output?: unknown }[] };
      const available = new Set((parsed.tools ?? []).map((definition) => definition.name ?? definition.function?.name));
      const lastUser = parsed.input?.findLast((item) => item.role === 'user');
      const lastUserText = JSON.stringify(lastUser?.content ?? '');
      // Catalog announcements and subagent summary-retry instructions are also
      // user-role messages. The original child prompt remains the identity.
      const isChild = (parsed.input ?? []).some((item) => item.role === 'user' && JSON.stringify(item.content).includes(childMarker));
      const isCompaction = lastUserText.includes('You are about to run out of context.') || lastUserText.includes("Write a concise handoff that lets the next turn continue the user's active task.");
      const id = `fixture_${sequence++}`;
      let tool: FixtureTool | undefined;
      let text = completion;
      if (available.size === 0 || isCompaction) {
        // Full compaction is a real, separately metered engine request. The
        // runtime may still advertise tools; recognize its frozen handoff
        // instruction without consuming the next user-turn script operation.
        text = 'Offline compaction fixture: retain the user constraints and continue the next requested turn. Earlier outputs remain in the workspace. This summary only validates the actual compaction and restore pipeline; it is not a model memory or reasoning result.';
      } else if (isChild) {
        if (childStep === 0) tool = { name: 'Bash', args: { command: 'cat src/access.mjs policy.txt', description: 'Read source and authorization contract' } };
        else text = 'Completed the delegated review of src/access.mjs against policy.txt. ROLE_CASE: an uppercase ADMIN role incorrectly bypasses ownership. EMPTY_OWNER: equal empty owner and actor IDs incorrectly authorize access. SHARED_TYPE: a truthy nonboolean shared value incorrectly grants access. The original source was read without modification; each finding has a concrete executable counterexample for the parent report.';
      } else if (task.id.startsWith('F01') && step === 0) {
        tool = { name: 'Skill', args: { skill: 'bench-normalize' } };
      } else if (task.id.startsWith('F02') && step === 0) {
        tool = { name: 'mcp__bench__lookup', args: { key: 'calibration-v1' } };
      } else if (task.id.startsWith('F03') && step === 0) {
        tool = { name: 'Agent', args: { subagent_type: 'explore', description: 'Review the authorization policy', prompt: `${childMarker}: Read src/access.mjs and policy.txt. Report the role case, empty owner ID, and nonboolean shared authorization violations. Do not modify source.`, run_in_background: false } };
      } else if (task.id.startsWith('F04')) {
        if (step === 0) tool = { name: 'Bash', args: { command: 'node scripts/worker.mjs', description: 'Run the fixed background worker', run_in_background: true } };
        else if (step === 1) {
          const outputs = JSON.stringify((parsed.input ?? []).filter((item) => item.type === 'function_call_output').map((item) => item.output));
          const taskId = /task_id: ([a-zA-Z0-9_-]+)/.exec(outputs)?.[1];
          if (!taskId) throw new Error('Background fixture received no real task id');
          await new Promise<void>((done) => { setTimeout(done, 200); });
          tool = { name: 'TaskOutput', args: { task_id: taskId } };
        } else if (step === 2) tool = { name: 'Bash', args: { command: 'test -f result.json && cat result.json', description: 'Verify the actual worker artifact' } };
      } else if (step === 0) tool = writeReference();
      if (!isChild && /^F0[123]/.test(task.id) && step === 1) tool = writeReference();
      if (tool !== undefined) {
        if (!available.has(tool.name)) {
          if (!available.has('select_tools')) throw new Error(`Required fixture tool is unavailable: ${tool.name}`);
          tool = { name: 'select_tools', args: { names: [tool.name] } };
        } else if (isChild) childStep++;
        else step++;
      }
      const item = tool === undefined
        ? { type: 'message', id: `msg_${id}`, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] }
        : { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: tool.name, arguments: JSON.stringify(tool.args) };
      const events: unknown[] = [{ type: 'response.created', response: { id } }];
      if (tool !== undefined) {
        events.push({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } });
        events.push({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: JSON.stringify(tool.args) });
        events.push({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: JSON.stringify(tool.args) });
      } else events.push({ type: 'response.output_text.delta', delta: text });
      events.push({ type: 'response.output_item.done', output_index: 0, item });
      events.push({ type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 } } } });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
    })().catch((error: unknown) => { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } })); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No fixture port');
  return {
    url: `http://127.0.0.1:${address.port}/responses`,
    setTurn: (index: number) => { turn = index; step = 0; childStep = 0; },
    close: async () => { const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed; },
  };
}

export async function ensureDirectory(path: string): Promise<void> { await mkdir(path, { recursive: true }); }
