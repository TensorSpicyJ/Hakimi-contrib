/**
 * `gpt-adaptation-bench` process sandbox.
 *
 * Untrusted code (the model's project tests, and the hidden grader that
 * imports the model's sources) runs inside a **fresh root** — a directory that
 * contains only the Node runtime, the input files and the shared libraries
 * they need — reached through a user + mount + PID + network namespace:
 *
 *   unshare --user --map-root-user --mount --pid --fork --net \
 *     --root=<fresh root> --wd=/work --mount-proc \
 *     /bin/setpriv --no-new-privs --bounding-set=-all ... /bin/node ...
 *
 * Properties this buys (each has an escape probe in `runEscapeProbes`):
 *   - **No host path exists at all.** The host filesystem is not part of the
 *     sandbox's path space; there is no mask to unmount, no repository, no
 *     credential store, no operator home. (The previous design bind-masked the
 *     home and could be undone with `umount` — this one cannot.)
 *   - **Empty capability set + `no_new_privs`.** `CapPrm/CapEff/CapBnd` are all
 *     zero, so even a smuggled-in binary cannot `umount`, `mount` or `chroot`.
 *   - **Private PID and procfs.** `/proc` shows only the sandbox's own PID 1;
 *     no host PID, and therefore no `/proc/<pid>/root` route out.
 *   - **No network.** A fresh network namespace contains only a down `lo`, so
 *     neither the process nor its children can reach anything.
 *   - **Only stdio as inherited file descriptors**, and a bounded capture of
 *     the sandbox's stdout/stderr.
 *
 * Scratch lives under `<repo>/.tmp/gpt-adaptation-bench/sandbox/`, never in the
 * system temp directory. When the boundary cannot be built the runner returns
 * `isolated: false` and callers must treat that as a hard failure.
 */

import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface SandboxProbe {
  readonly supported: boolean;
  readonly reason?: string;
  readonly detail?: string;
}

export interface SandboxResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** False when the boundary could not be established; callers must not proceed. */
  readonly isolated: boolean;
  readonly reason?: string;
  /** True when the captured output was cut at `SANDBOX_MAX_OUTPUT_BYTES`. */
  readonly outputTruncated?: boolean;
}

export const SANDBOX_EXIT_UNSUPPORTED = 90;
export const SANDBOX_MAX_OUTPUT_BYTES = 256 * 1024;
export const SANDBOX_OUTPUT_TRUNCATION_MARKER = '\n[sandbox output truncated]\n';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

/** Scratch root for every sandbox in this benchmark (inside the working tree). */
export const SANDBOX_SCRATCH_ROOT = join(REPO_ROOT, '.tmp', 'gpt-adaptation-bench', 'sandbox');
let selectedScratchRoot = SANDBOX_SCRATCH_ROOT;

/** Explicit namespace selection before first use; never accepts arbitrary paths. */
export function useCapabilitySandbox(): void {
  const root = join(REPO_ROOT, '.tmp', 'hakimi-benchmark-v2', 'sandbox');
  if (selectedScratchRoot === root) return;
  if (runtimeTemplate !== undefined) throw new Error('Select the sandbox namespace before first use');
  selectedScratchRoot = root;
}

/**
 * The operator's real home directory. `os.homedir()` follows `$HOME`, which a
 * run may legitimately set to its own isolated home — reading it that way
 * would silently stop protecting the operator's files.
 */
export function resolvedUserHome(): string {
  try {
    const info = userInfo();
    if (typeof info.homedir === 'string' && info.homedir !== '') return info.homedir;
  } catch {
    // Fall through to the environment on a host without a passwd entry.
  }
  return process.env['HOME'] ?? '/root';
}

/**
 * Host paths the sandbox must never expose. With a fresh root none of them are
 * reachable; the list exists so callers and probes can assert that.
 */
export function maskTargets(): readonly string[] {
  const candidates = [resolvedUserHome(), REPO_ROOT];
  const existing = [...new Set(candidates)].filter((target) => existsSync(target));
  for (const target of existing) {
    if (/\s/.test(target)) {
      throw new Error(`sandbox target contains whitespace and cannot be handled safely: ${target}`);
    }
  }
  return existing;
}

interface BuiltRoot {
  readonly root: string;
  readonly workDir: string;
  readonly cleanup: () => Promise<void>;
}

function runCapture(
  argv: readonly string[],
  options: { timeoutMs?: number },
): { status: number | null; stdout: string; stderr: string; error?: string } {
  const result = spawnSync(argv[0] as string, argv.slice(1), {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 20_000,
    env: { PATH: process.env['PATH'] ?? '' },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error === undefined ? undefined : (result.error as NodeJS.ErrnoException).code,
  };
}

/** Shared libraries an ELF binary needs, as absolute paths (via `ldd`). */
function dynamicDependencies(binary: string): readonly string[] {
  const result = runCapture(['ldd', binary], {});
  const paths = new Set<string>();
  for (const line of `${result.stdout}\n${result.stderr}`.split('\n')) {
    const match = /=>\s+(\/[^\s]+)/.exec(line) ?? /^\s*(\/[^\s]+)\s+\(0x/.exec(line);
    if (match?.[1] !== undefined) paths.add(match[1]);
  }
  return [...paths];
}

async function copyIntoRoot(root: string, source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, dereference: true });
}

/** Each root owns separate inodes: untrusted writes must not reach the template. */
async function placeIntoRoot(root: string, source: string, target: string): Promise<void> {
  await copyIntoRoot(root, source, target);
}

/**
 * The runtime template (Node, setpriv, their shared libraries and minimal
 * /etc + /dev placeholders) is copied privately into each sandbox root.
 */
let runtimeTemplate: Promise<{ readonly dir: string; readonly files: readonly string[] }> | undefined;

function buildRuntimeTemplate(): Promise<{ readonly dir: string; readonly files: readonly string[] }> {
  runtimeTemplate ??= (async () => {
    const dir = join(selectedScratchRoot, 'runtime');
    const versionFile = join(dir, '.runtime-signature');
    const signature = JSON.stringify({ execPath: process.execPath, version: process.version });
    if (existsSync(versionFile)) {
      try {
        if ((await readFile(versionFile, 'utf8')).trim() === signature) {
          return { dir, files: await listFiles(dir) };
        }
      } catch {
        // Rebuild below.
      }
    }
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, 'bin'), { recursive: true });
    await mkdir(join(dir, 'dev'), { recursive: true });
    await mkdir(join(dir, 'etc'), { recursive: true });
    await mkdir(join(dir, 'proc'), { recursive: true });
    await mkdir(join(dir, 'tmp'), { recursive: true });
    const nodeSource = process.execPath;
    if (!existsSync(nodeSource)) throw new Error(`node runtime not found at ${nodeSource}`);
    await copyIntoRoot(dir, nodeSource, join(dir, 'bin', 'node'));
    const setprivSource = '/usr/bin/setpriv';
    if (!existsSync(setprivSource)) {
      throw new Error('setpriv is required to drop capabilities inside the sandbox');
    }
    await copyIntoRoot(dir, setprivSource, join(dir, 'bin', 'setpriv'));
    const libraries = new Set<string>([
      ...dynamicDependencies(nodeSource),
      ...dynamicDependencies(setprivSource),
    ]);
    for (const library of libraries) {
      if (!existsSync(library)) continue;
      await copyIntoRoot(dir, library, join(dir, library));
    }
    await writeFile(join(dir, 'etc', 'passwd'), MINIMAL_PASSWD, 'utf8');
    await writeFile(join(dir, 'etc', 'group'), MINIMAL_GROUP, 'utf8');
    await writeFile(join(dir, 'etc', 'nsswitch.conf'), MINIMAL_NSSWITCH, 'utf8');
    for (const device of SANDBOX_DEVICE_PLACEHOLDERS) {
      await writeFile(join(dir, 'dev', device), '', 'utf8');
    }
    await writeFile(versionFile, signature, 'utf8');
    return { dir, files: await listFiles(dir) };
  })();
  return runtimeTemplate;
}

async function listFiles(dir: string, prefix = ''): Promise<readonly string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // Dotfiles are bookkeeping (the runtime signature), never part of a root.
    if (entry.name.startsWith('.')) continue;
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listFiles(join(dir, entry.name), relative)));
    else out.push(relative);
  }
  return out;
}

const MINIMAL_PASSWD = 'root:x:0:0:root:/:/bin/sh\nsandbox:x:1:1:sandbox:/:/bin/sh\n';
const MINIMAL_GROUP = 'root:x:0:\nsandbox:x:1:\n';
const MINIMAL_NSSWITCH = 'passwd: files\ngroup: files\nhosts: files\n';

/**
 * Build the fresh root: Node, `setpriv`, their shared libraries, the input
 * files under `/work`, an empty `/proc` mountpoint and a writable `/tmp`.
 * Nothing else from the host is copied or bound.
 */
async function buildFreshRoot(options: {
  label: string;
  workDir: string;
  extraFiles?: Readonly<Record<string, string>>;
}): Promise<BuiltRoot> {
  const base = join(selectedScratchRoot, `${options.label}-${Math.random().toString(36).slice(2, 8)}`);
  const root = join(base, 'root');
  try {
    await mkdir(selectedScratchRoot, { recursive: true });
    const runtime = await buildRuntimeTemplate();
    for (const dir of RUNTIME_DIRECTORIES) await mkdir(join(root, dir), { recursive: true });
    for (const file of runtime.files) {
      await placeIntoRoot(root, join(runtime.dir, file), join(root, file));
    }
    await mkdir(join(root, 'work'), { recursive: true });
    const entries = await readdir(options.workDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      await cp(join(options.workDir, entry.name), join(root, 'work', entry.name), { recursive: true });
    }
    for (const [relative, contents] of Object.entries(options.extraFiles ?? {})) {
      const target = join(root, 'work', relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents, 'utf8');
    }

    const directories: string[] = [];
    const collect = async (dir: string): Promise<void> => {
      directories.push(dir);
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await collect(join(dir, entry.name));
      }
    };
    await collect(root);
    for (const dir of directories) {
      const result = spawnSync('chmod', ['a+rx', dir], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`failed to make ${dir} traversable: ${result.stderr}`);
    }
    return { root, workDir: options.workDir, cleanup: () => rm(base, { recursive: true, force: true }) };
  } catch (error) {
    await rm(base, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The launcher. Nothing from the host is bound in: a `--map-root-user` mount
 * namespace cannot bind host device nodes, so `/dev/*` placeholders are plain
 * files (see `buildFreshRoot`), which is enough for `> /dev/null` and for Node
 * itself.
 */
function launchArgv(options: {
  root: string;
  workDir: string;
  argv: readonly string[];
}): readonly string[] {
  return [
    'unshare',
    '--user',
    '--map-root-user',
    '--mount',
    '--pid',
    '--fork',
    '--net',
    `--root=${options.root}`,
    `--wd=${options.workDir}`,
    '--mount-proc',
    '/bin/setpriv',
    '--no-new-privs',
    '--bounding-set=-all',
    '--inh-caps=-all',
    '--ambient-caps=-all',
    ...options.argv,
  ];
}

/** Device placeholders created inside the root (regular files, never host binds). */
export const SANDBOX_DEVICE_PLACEHOLDERS = ['null', 'zero', 'urandom', 'random'] as const;

/** Directory skeleton of every fresh root (files are copied in separately). */
export const RUNTIME_DIRECTORIES = ['bin', 'dev', 'etc', 'proc', 'tmp'] as const;

async function spawnSandboxed(options: {
  root: string;
  workDir: string;
  argv: readonly string[];
  timeoutMs: number;
  extraEnv?: Readonly<Record<string, string>>;
}): Promise<SandboxResult> {
  const argv = launchArgv(options);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: selectedScratchRoot,
      env: {
        PATH: process.env['PATH'] ?? '',
        ...options.extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let outputTruncated = false;
    let timedOut = false;
    const append = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      const current = stream === 'stdout' ? stdout : stderr;
      if (current.length >= SANDBOX_MAX_OUTPUT_BYTES) {
        outputTruncated = true;
        return;
      }
      const clipped = (current + text).slice(0, SANDBOX_MAX_OUTPUT_BYTES);
      outputTruncated = outputTruncated || clipped.length < current.length + text.length;
      if (stream === 'stdout') stdout = clipped;
      else stderr = clipped;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the sandbox's own process group only (never anything else).
      try {
        process.kill(-(child.pid as number), 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code ?? -1,
        stdout: outputTruncated ? `${stdout}${SANDBOX_OUTPUT_TRUNCATION_MARKER}` : stdout,
        stderr: outputTruncated ? `${stderr}${SANDBOX_OUTPUT_TRUNCATION_MARKER}` : stderr,
        timedOut,
        isolated: true,
        outputTruncated,
      });
    });
  });
}


/**
 * Translate a caller's argv into the sandbox's path space:
 *   - the host runtime path becomes the sandbox runtime (`/bin/node`);
 *   - anything inside the workspace becomes `/work/...`;
 *   - paths the sandbox already owns (`/bin/*`, `/dev/*`, `/proc/*`) pass through;
 *   - every other absolute path is deliberately left alone, so it simply does
 *     not exist inside the root rather than silently resolving somewhere else.
 */
export function rewriteInnerArgv(
  innerArgv: readonly string[],
  workspaceDir: string,
): readonly string[] {
  const workspacePrefix = workspaceDir.endsWith('/') ? workspaceDir : `${workspaceDir}/`;
  return innerArgv.map((entry) => {
    if (entry === process.execPath) return '/bin/node';
    if (entry.startsWith(workspacePrefix)) return `/work/${entry.slice(workspacePrefix.length)}`;
    if (entry.startsWith('/work/') || entry.startsWith('/bin/') || entry.startsWith('/dev/') || entry.startsWith('/proc/')) {
      return entry;
    }
    return entry;
  });
}

let cachedProbe: SandboxProbe | undefined;

/** Verify once per process that the fresh-root boundary can be created. */
export async function probeSandbox(): Promise<SandboxProbe> {
  if (cachedProbe !== undefined) return cachedProbe;
  const workDir = join(selectedScratchRoot, 'probe-work');
  let built: BuiltRoot | undefined;
  try {
    await mkdir(workDir, { recursive: true });
    await writeFile(join(workDir, 'probe.mjs'), 'console.log("SANDBOX_OK")\n', 'utf8');
    built = await buildFreshRoot({ label: 'probe', workDir });
    const result = await spawnSandboxed({
      root: built.root,
      workDir: '/work',
      argv: ['/bin/node', 'probe.mjs'],
      timeoutMs: 30_000,
    });
    const supported = result.exitCode === 0 && result.stdout.includes('SANDBOX_OK');
    cachedProbe = supported
      ? {
          supported: true,
          detail: 'fresh root + user/mount/pid/net namespaces + empty capability set',
        }
      : {
          supported: false,
          reason: 'the fresh-root sandbox could not be created',
          detail: `exit ${String(result.exitCode)}: ${result.stderr.split('\n').slice(0, 3).join(' | ')}`,
        };
    return cachedProbe;
  } catch (error) {
    cachedProbe = {
      supported: false,
      reason: error instanceof Error ? error.message : String(error),
    };
    return cachedProbe;
  } finally {
    await rm(workDir, { recursive: true, force: true });
    if (built !== undefined) await built.cleanup();
  }
}

/**
 * Run a Node command inside the fresh-root sandbox.
 *
 * `scratchRoot` is accepted for call-site compatibility; scratch always lives
 * under `<repo>/.tmp/gpt-adaptation-bench/sandbox` so a run cannot place copies
 * (or deletions) outside the working tree.
 */
export async function runSandboxed(options: {
  workspaceDir: string;
  innerArgv: readonly string[];
  scratchRoot: string;
  timeoutMs: number;
  label: string;
  extraEnv?: Readonly<Record<string, string>>;
  extraFiles?: Readonly<Record<string, string>>;
}): Promise<SandboxResult> {
  const probe = await probeSandbox();
  if (!probe.supported) {
    return {
      exitCode: SANDBOX_EXIT_UNSUPPORTED,
      stdout: '',
      stderr: 'sandbox unavailable',
      timedOut: false,
      isolated: false,
      reason: `${probe.reason ?? 'unsupported'}${probe.detail === undefined ? '' : `: ${probe.detail}`}`,
    };
  }
  await mkdir(selectedScratchRoot, { recursive: true });
  let built: BuiltRoot | undefined;
  try {
    built = await buildFreshRoot({
      label: options.label.replaceAll(/[^A-Za-z0-9._-]/g, '_'),
      workDir: options.workspaceDir,
      extraFiles: options.extraFiles,
    });
    const argv = rewriteInnerArgv(options.innerArgv, options.workspaceDir);
    return await spawnSandboxed({
      root: built.root,
      workDir: '/work',
      argv,
      timeoutMs: options.timeoutMs,
      extraEnv: options.extraEnv,
    });
  } finally {
    if (built !== undefined) await built.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Escape probes (negative tests for the boundary)
// ---------------------------------------------------------------------------

export interface EscapeProbe {
  readonly name: string;
  readonly kind: 'must-block' | 'control' | 'assertion';
  readonly blocked: boolean;
  readonly okay: boolean;
  readonly detail: string;
}

export const ESCAPE_PROBE_NAMES = [
  'read-repo-sentinel',
  'read-benchmark-source',
  'read-hidden-grader',
  'read-user-home',
  'proc-host-pid',
  'proc-list',
  'capabilities-empty',
  'file-descriptors',
  'umount-attempt',
  'chroot-escape',
  'mount-bind',
  'symlink-escape',
  'network-fetch',
  'network-dns',
  'network-child-process',
  'read-own-workspace',
] as const;

const PROBE_SOURCE = `
import { spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { readFileSync, readdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

const targets = JSON.parse(process.env.PROBE_TARGETS ?? '{}');
const results = [];
const block = (name, fn) => {
  try { fn(); results.push({ name, kind: 'must-block', blocked: false }); }
  catch (error) { results.push({ name, kind: 'must-block', blocked: true, detail: String(error?.code ?? error?.message ?? error).slice(0, 70) }); }
};
const assertion = (name, fn) => {
  try {
    const value = fn();
    results.push({ name, kind: 'assertion', blocked: false, detail: JSON.stringify(value).slice(0, 90) });
  } catch (error) { results.push({ name, kind: 'assertion', blocked: false, detail: 'error: ' + String(error?.message ?? error).slice(0, 60) }); }
};
const tool = (name, argv) => {
  const child = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 5000 });
  if (child.error) throw Object.assign(new Error('spawn'), { code: child.error.code ?? 'SPAWN_FAILED' });
  if (child.status !== 0) throw new Error('exit ' + String(child.status) + ' ' + String(child.stderr ?? '').slice(0, 40));
  return child.stdout;
};

block('read-repo-sentinel', () => readFileSync(targets.sentinel, 'utf8'));
block('read-benchmark-source', () => readFileSync(targets.benchmarkSource, 'utf8'));
block('read-hidden-grader', () => readFileSync(targets.hiddenGrader, 'utf8'));
block('read-user-home', () => readdirSync(targets.userHome));
block('proc-host-pid', () => readFileSync('/proc/' + String(targets.parentPid) + '/root' + targets.sentinel, 'utf8'));
assertion('proc-list', () => readdirSync('/proc').filter((entry) => /^[0-9]+$/.test(entry)));
assertion('capabilities-empty', () => {
  const status = readFileSync('/proc/self/status', 'utf8');
  const value = (key) => (new RegExp('^' + key + ':\\\\s*(\\\\S+)', 'm').exec(status)?.[1] ?? 'missing');
  return { prm: value('CapPrm'), eff: value('CapEff'), bnd: value('CapBnd'), nnp: value('NoNewPrivs') };
});
assertion('file-descriptors', () => {
  const targets = [];
  for (const fd of readdirSync('/proc/self/fd')) {
    try { targets.push(String(readlinkSync('/proc/self/fd/' + fd)).slice(0, 120)); }
    catch { targets.push('<unreadable>'); }
  }
  return [...new Set(targets)];
});
block('umount-attempt', () => tool('umount', ['umount', '/work']));
block('chroot-escape', () => tool('chroot', ['chroot', '/', '/bin/node', '-e', 'process.exit(0)']));
block('mount-bind', () => tool('mount', ['mount', '--bind', '/', '/work/host']));
block('symlink-escape', () => {
  symlinkSync(targets.sentinel, '/work/sentinel-link');
  return readFileSync('/work/sentinel-link', 'utf8');
});

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('probe-timeout')), ms));
const settle = async (name, fn) => {
  try { await fn(); results.push({ name, kind: 'must-block', blocked: false }); }
  catch (error) { results.push({ name, kind: 'must-block', blocked: true, detail: String(error?.cause?.code ?? error?.code ?? error?.message ?? error).slice(0, 70) }); }
};
await settle('network-fetch', () =>
  Promise.race([fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', body: '{}' }), timeout(4000)]),
);
await settle('network-dns', () => Promise.race([lookup('chatgpt.com'), timeout(4000)]));
await settle('network-child-process', async () => {
  const child = spawnSync('/bin/node', ['-e', 'fetch("https://chatgpt.com/").then(()=>process.exit(0)).catch(()=>process.exit(3))'], { timeout: 6000 });
  if (child.status !== 0) throw new Error('child-exit-' + String(child.status));
});
try {
  const value = readFileSync(join(process.cwd(), 'fixture.txt'), 'utf8');
  results.push({ name: 'read-own-workspace', kind: 'control', blocked: false, detail: value.trim().slice(0, 20) });
} catch (error) {
  results.push({ name: 'read-own-workspace', kind: 'control', blocked: true, detail: String(error?.code ?? error) });
}
console.log('PROBE_RESULT ' + Buffer.from(JSON.stringify({ results }), 'utf8').toString('base64'));
`;

/**
 * Run the escape probes through the real sandbox path. Every `must-block`
 * probe must be blocked, the control must succeed, and the assertions report
 * the sandbox's actual capability/PID/FD state.
 */
export async function runEscapeProbes(options: {
  scratchRoot: string;
  runRoot: string;
  timeoutMs?: number;
}): Promise<readonly EscapeProbe[]> {
  const probe = await probeSandbox();
  const unavailable = (reason: string): readonly EscapeProbe[] =>
    ESCAPE_PROBE_NAMES.map((name) => ({
      name,
      kind: name === 'read-own-workspace' ? 'control' : name === 'proc-list' || name === 'capabilities-empty' || name === 'file-descriptors' ? 'assertion' : 'must-block',
      blocked: false,
      okay: false,
      detail: reason,
    }));
  if (!probe.supported) return unavailable(`sandbox unavailable: ${probe.reason ?? 'unsupported'}`);

  // The sentinel lives inside the working tree (never a real credential file)
  // and must be unreachable from inside the sandbox.
  const sentinelDir = join(selectedScratchRoot, 'sentinel');
  await mkdir(sentinelDir, { recursive: true });
  const sentinelPath = join(sentinelDir, `sentinel-${Math.random().toString(36).slice(2, 8)}.txt`);
  const token = `bench-sentinel-${Math.random().toString(36).slice(2, 10)}`;
  await writeFile(sentinelPath, `${token}\n`, 'utf8');

  const workDir = join(selectedScratchRoot, 'escape-work');
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(join(workDir, 'fixture.txt'), 'fixture-visible\n', 'utf8');

  const targets = {
    sentinel: sentinelPath,
    benchmarkSource: join(import.meta.dirname, 'gpt-adaptation-bench.sandbox.ts'),
    hiddenGrader: join(REPO_ROOT, 'packages', 'klient', 'examples', 'gpt-adaptation-bench.tasks.ts'),
    userHome: resolvedUserHome(),
    parentPid: process.pid,
    runRoot: options.runRoot,
  };

  const result = await runSandboxed({
    workspaceDir: workDir,
    innerArgv: ['/bin/node', '--input-type=module', '--eval', PROBE_SOURCE],
    scratchRoot: options.scratchRoot,
    timeoutMs: options.timeoutMs ?? 90_000,
    label: 'escape-probe',
    extraEnv: { PROBE_TARGETS: JSON.stringify(targets) },
  });
  const line = result.stdout.split('\n').find((candidate) => candidate.startsWith('PROBE_RESULT '));
  if (line === undefined) {
    return unavailable(
      `probe produced no result (exit ${String(result.exitCode)}): ${`${result.stdout}\n${result.stderr}`.slice(0, 200)}`,
    );
  }
  const decoded = JSON.parse(
    Buffer.from(line.slice('PROBE_RESULT '.length), 'base64').toString('utf8'),
  ) as { results: { name: string; kind: 'must-block' | 'control' | 'assertion'; blocked: boolean; detail?: string }[] };
  const probes: EscapeProbe[] = [];
  for (const entry of decoded.results) {
    const kind = entry.kind;
    let okay = entry.blocked;
    let detail = entry.detail ?? '';
    if (kind === 'control') okay = !entry.blocked;
    if (kind === 'assertion') {
      if (entry.name === 'capabilities-empty') {
        okay = /"prm":"0000000000000000"/.test(detail) && /"eff":"0000000000000000"/.test(detail) && /"bnd":"0000000000000000"/.test(detail) && /"nnp":"1"/.test(detail);
      } else if (entry.name === 'proc-list') {
        okay = detail === '["1"]';
      } else if (entry.name === 'file-descriptors') {
        // No inherited descriptor may point at anything on the host.
        const markers = [targets.userHome, targets.runRoot, targets.sentinel, REPO_ROOT];
        okay = markers.every((marker) => !detail.includes(marker)) && !detail.includes('<unreadable>');
      }
    }
    probes.push({ name: entry.name, kind, blocked: entry.blocked, okay, detail });
  }
  for (const name of ESCAPE_PROBE_NAMES) {
    if (probes.some((candidate) => candidate.name === name)) continue;
    probes.push({
      name,
      kind: name === 'read-own-workspace' ? 'control' : name === 'proc-list' || name === 'capabilities-empty' || name === 'file-descriptors' ? 'assertion' : 'must-block',
      blocked: false,
      okay: false,
      detail: 'probe did not run',
    });
  }
  await rm(sentinelDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
  return probes;
}

/** Exported for tests: the launcher argv (namespace + capability drop). */
export function sandboxLauncherDescription(): string {
  return launchArgv({ root: '<root>', workDir: '/work', argv: ['/bin/node'] }).join(' ');
}

/** Exported for tests: read the host-side scratch root the sandbox uses. */
export function scratchRoot(): string {
  return selectedScratchRoot;
}

/** Exported for tests: does any host path leak into the built root? */
export async function rootContainsPath(root: string, candidate: string): Promise<boolean> {
  return existsSync(join(root, candidate.replace(/^\/+/, '')));
}
