/** Isolates complete agent processes; only production runtime, workspace and a quota socket are mounted. */
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const PACKAGES = ['klient', 'agent-core-v2', 'tree-sitter-bash', 'protocol', 'minidb', 'oauth'];

export async function snapshotEngine(destination: string): Promise<string> {
  await mkdir(destination, { recursive: true });
  await mkdir(join(destination, 'node_modules'), { recursive: true });
  for (const file of ['package.json', 'tsconfig.json', 'build/register-raw-text-loader.mjs', 'build/raw-text-loader.mjs']) {
    await mkdir(dirname(join(destination, file)), { recursive: true });
    await cp(join(REPO_ROOT, file), join(destination, file));
  }
  for (const name of PACKAGES) {
    const root = join(REPO_ROOT, 'packages', name);
    const out = join(destination, 'packages', name);
    await mkdir(out, { recursive: true });
    await mkdir(join(out, 'node_modules'), { recursive: true });
    for (const part of ['package.json', 'tsconfig.json', 'src', 'dist']) {
      if (existsSync(join(root, part))) await cp(join(root, part), join(out, part), { recursive: true });
    }
  }
  const examples = join(destination, 'packages/klient/examples');
  await mkdir(examples, { recursive: true });
  await cp(join(REPO_ROOT, 'packages/klient/examples/gpt-harness-bench.hakimi.ts'), join(examples, 'gpt-harness-bench.hakimi.ts'));
  const hash = createHash('sha256');
  async function visit(root: string): Promise<void> {
    for (const entry of (await readdir(root, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        hash.update(path.slice(destination.length));
        hash.update(await readFile(path));
      } else throw new Error(`Unexpected link in engine snapshot: ${path}`);
    }
  }
  await visit(destination);
  return hash.digest('hex');
}

export interface AgentProcessOptions {
  /** V2 freezes dependencies once per batch instead of binding the live checkout. */
  dependencyRoot?: string;
  engineRoot: string;
  workspace: string;
  home: string;
  runDir: string;
  codexRoot: string;
  socketPath: string;
  argv: readonly string[];
  timeoutMs: number;
  stdin?: string;
}

export interface AgentProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export function sandboxArguments(options: AgentProcessOptions): string[] {
  const args = [
    '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/etc',
    '--ro-bind', options.engineRoot, '/engine',
    '--ro-bind', join(options.dependencyRoot ?? REPO_ROOT, 'node_modules'), '/engine/node_modules',
    '--ro-bind', dirname(dirname(process.execPath)), '/runtime',
    '--ro-bind', options.codexRoot, '/codex',
    '--bind', options.workspace, '/workspace', '--bind', options.home, '/home/bench',
    '--ro-bind', options.socketPath, '/run/proxy.sock',
    '--ro-bind', join(options.runDir, 'plan.json'), '/run/plan.json',
    '--ro-bind', join(options.runDir, 'launch.sh'), '/run/launch.sh',
    '--ro-bind', join(options.runDir, 'hosts'), '/etc/hosts',
    '--clearenv', '--setenv', 'PATH', '/runtime/bin:/usr/bin:/bin',
    '--setenv', 'HOME', '/home/bench', '--setenv', 'CODEX_HOME', '/home/bench/codex',
    '--setenv', 'TSX_TSCONFIG_PATH', '/engine/packages/agent-core-v2/tsconfig.json',
    '--setenv', 'BENCH_API_KEY', 'benchmark-placeholder', '--setenv', 'LANG', 'C.UTF-8',
    '--chdir', '/workspace',
  ];
  for (const name of PACKAGES) {
    const path = join(options.dependencyRoot ?? REPO_ROOT, 'packages', name, 'node_modules');
    if (existsSync(path)) args.push('--ro-bind', path, `/engine/packages/${name}/node_modules`);
  }
  args.push('--', '/bin/sh', '/run/launch.sh', ...options.argv);
  return args;
}

export async function runAgentProcess(options: AgentProcessOptions): Promise<AgentProcessResult> {
  await mkdir(options.home, { recursive: true });
  await writeFile(join(options.runDir, 'hosts'), '127.0.0.1 localhost chatgpt.com\n');
  await writeFile(join(options.runDir, 'launch.sh'), [
    '#!/bin/sh',
    'socat TCP-LISTEN:48631,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/proxy.sock &',
    'bridge=$!',
    'trap \'kill "$bridge" 2>/dev/null || true\' EXIT',
    '"$@"',
  ].join('\n'));
  const start = Date.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bwrap', sandboxArguments(options), { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputTruncated = false;
    const capture = (chunk: Buffer, channel: 'stdout' | 'stderr'): void => {
      const current = channel === 'stdout' ? stdout : stderr;
      const next = current + chunk.toString();
      if (next.length > 512 * 1024) outputTruncated = true;
      if (channel === 'stdout') stdout = next.slice(0, 512 * 1024);
      else stderr = next.slice(0, 512 * 1024);
    };
    child.stdout.on('data', (chunk: Buffer) =>{  capture(chunk, 'stdout'); });
    child.stderr.on('data', (chunk: Buffer) =>{  capture(chunk, 'stderr'); });
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdin ?? '');
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }, options.timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      resolvePromise({ exitCode, timedOut, durationMs: Date.now() - start, stdout, stderr, outputTruncated });
    });
  });
}
