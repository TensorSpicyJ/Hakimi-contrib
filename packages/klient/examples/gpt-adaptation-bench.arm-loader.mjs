/**
 * `gpt-adaptation-bench` arm loader (Node ESM hooks).
 *
 * Rewrites every `@moonshot-ai/*` workspace specifier onto the arm's own
 * source tree, so an arm can never resolve a workspace package (the engine,
 * `@moonshot-ai/protocol`, `minidb`, …) out of the working tree. Resolution
 * follows the package's own `exports` map, so subpath exports such as
 * `@moonshot-ai/minidb/cluster` resolve exactly as Node would.
 *
 * Configuration comes from `KIMI_BENCH_ARM_ROOT`; a specifier whose package is
 * missing from the arm, or whose subpath the package does not export, fails
 * loudly — there is deliberately no fallback to the workspace copy.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const PREFIX = '@moonshot-ai/';

/**
 * Map package *name* (which is not always the directory name — e.g. the
 * `kimi-code-oauth` package lives in `packages/oauth`) to its directory inside
 * the arm root, by reading each package manifest once per process.
 */
const indexCache = new Map();
function packageIndex(root) {
  const cached = indexCache.get(root);
  if (cached !== undefined) return cached;
  const index = new Map();
  const packagesDir = join(root, 'packages');
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const manifestPath = join(packagesDir, entry.name, 'package.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (typeof manifest.name === 'string') index.set(manifest.name, join(packagesDir, entry.name));
      } catch {
        // A malformed manifest belongs to a package we are not resolving.
      }
    }
  }
  indexCache.set(root, index);
  return index;
}

function resolveSubpath(exportsField, subpath) {
  if (exportsField === undefined || exportsField === null) return undefined;
  if (typeof exportsField === 'string') return subpath === '.' ? exportsField : undefined;
  const direct = exportsField[subpath];
  if (typeof direct === 'string') return direct;
  if (direct !== null && typeof direct === 'object' && typeof direct.default === 'string') {
    return direct.default;
  }
  // Pattern exports: './*' -> './src/*.ts'
  if (subpath !== '.') {
    for (const [key, value] of Object.entries(exportsField)) {
      if (!key.includes('*')) continue;
      const [prefix, suffix] = key.split('*');
      if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
      const middle = subpath.slice(prefix.length, subpath.length - suffix.length);
      const target = typeof value === 'string' ? value : value?.default;
      if (typeof target !== 'string') continue;
      return target.replace('*', middle);
    }
  }
  return undefined;
}

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith(PREFIX)) return nextResolve(specifier, context);
  const root = process.env['KIMI_BENCH_ARM_ROOT'];
  if (root === undefined || root === '') {
    throw new Error('KIMI_BENCH_ARM_ROOT must be set for benchmark arm subprocesses');
  }
  const rest = specifier.slice(PREFIX.length);
  const parts = rest.split('/');
  const name = parts[0];
  const subpath = parts.length === 1 ? '.' : `./${parts.slice(1).join('/')}`;
  const packageDir = packageIndex(root).get(`${PREFIX}${name}`);
  if (packageDir === undefined) {
    throw new Error(`arm loader: package ${PREFIX}${name} is not present in arm root ${root}`);
  }
  const packageJsonPath = join(packageDir, 'package.json');
  if (subpath === './package.json') {
    return { url: pathToFileURL(packageJsonPath).href, shortCircuit: true };
  }
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const target = resolveSubpath(manifest.exports, subpath);
  if (target === undefined) {
    throw new Error(
      `arm loader: @moonshot-ai/${name} does not export ${subpath} (arm root ${root})`,
    );
  }
  const file = join(packageDir, target);
  if (!existsSync(file)) {
    throw new Error(`arm loader: ${specifier} resolved to a missing file ${file}`);
  }
  return { url: pathToFileURL(file).href, shortCircuit: true };
}

/** Exposed for the resolution probe: the file an arm would load for a specifier. */
export function armTargetFor(specifier) {
  const root = process.env['KIMI_BENCH_ARM_ROOT'];
  if (root === undefined || !specifier.startsWith(PREFIX)) return undefined;
  const parts = specifier.slice(PREFIX.length).split('/');
  const name = parts[0];
  const subpath = parts.length === 1 ? '.' : `./${parts.slice(1).join('/')}`;
  const packageDir = packageIndex(root).get(`${PREFIX}${name}`);
  if (packageDir === undefined) return undefined;
  const manifestPath = join(packageDir, 'package.json');
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const target = subpath === './package.json' ? 'package.json' : resolveSubpath(manifest.exports, subpath);
  return target === undefined ? undefined : join(packageDir, target);
}

export function fileUrlOf(path) {
  return pathToFileURL(path).href;
}

export function pathOf(url) {
  return fileURLToPath(url);
}

register(import.meta.url);
