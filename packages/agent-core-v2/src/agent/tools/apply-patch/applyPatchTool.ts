/**
 * `applyPatch` domain — Agent-scoped multi-file patch execution.
 *
 * Resolves workspace and skill paths through the shared path-access policy,
 * declares every file access for scheduling and approval, and acquires the
 * selected runtime's filesystem. The edit domain's TextModel preserves line
 * endings through the pure patch helper. Every target is preflighted before
 * writes begin; filesystem failures report partial progress explicitly.
 * Visibility and execution both require the owning experimental flag.
 */

import { dirname } from 'pathe';
import { IFlagService } from '#/app/flag/flag';
import { IAgentRuntimeService, inspectAgentRuntime } from '#/agent/runtimeBinding/agentRuntime';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import type { HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import { OsFsErrors } from '#/os/interface/hostFsErrors';
import type { Runtime } from '#/runtime/runtime';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import { isWithinDirectory, resolvePathAccessPath } from '#/tool/path-access';
import { literalRulePattern, matchesPathRuleSubject } from '#/tool/rule-match';
import { ToolAccesses, type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';
import { APPLY_PATCH_GRAMMAR, APPLY_PATCH_TOOL_NAME, ApplyPatchInputSchema, IApplyPatchTool, type ApplyPatchInput } from './apply-patch';
import { APPLY_PATCH_FLAG_ID } from './flag';
import { applyUpdate, parsePatch, type PatchOperation, type PatchResult } from './patch';
import APPLY_PATCH_DESCRIPTION from './apply-patch.md?raw';

interface ResolvedPatchOperation {
  readonly operation: PatchOperation;
  readonly path: string;
}

interface PreparedPatchOperation extends ResolvedPatchOperation {
  readonly before?: string;
  readonly after?: string;
}

export class ApplyPatchTool implements IApplyPatchTool {
  declare readonly _serviceBrand: undefined;
  readonly name = APPLY_PATCH_TOOL_NAME;
  readonly description = APPLY_PATCH_DESCRIPTION;
  readonly parameters = toInputJsonSchema(ApplyPatchInputSchema);
  readonly inputFormat = {
    type: 'text',
    grammar: { syntax: 'lark', definition: APPLY_PATCH_GRAMMAR },
  } as const;

  constructor(
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @IFlagService private readonly flags: IFlagService,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
  ) {}

  resolveExecution(args: ApplyPatchInput): ToolExecution {
    if (!this.flags.enabled(APPLY_PATCH_FLAG_ID)) return failure('The apply_patch experimental flag is disabled.');
    const parsed = parsePatch(args.input);
    if (!parsed.ok) return failure(parsed.error);
    const inspected = inspectAgentRuntime(this.runtime);
    const view = new RuntimeWorkspaceView(inspected, {
      workDir: this.workspaceCtx.workDir,
      additionalDirs: [...this.workspaceCtx.additionalDirs, ...(this.skillCatalog?.catalog.getSkillRoots() ?? [])],
    });
    const workspace = { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
    const resolved: ResolvedPatchOperation[] = [];
    for (const operation of parsed.value) {
      const path = resolvePathAccessPath(operation.path, {
        env: inspected.environment,
        workspace,
        operation: 'write',
      });
      if (resolved.some((other) =>
        isWithinDirectory(path, other.path, inspected.environment.pathClass) ||
        isWithinDirectory(other.path, path, inspected.environment.pathClass))) {
        return failure(`Patch targets overlap: ${operation.path}. Use each file path only once.`);
      }
      resolved.push({ operation, path });
    }
    const paths = resolved.map((entry) => entry.path);
    return {
      accesses: paths.flatMap((path) => ToolAccesses.readWriteFile(path)),
      description: `Applying patch to ${resolved.map((entry) => entry.operation.path).join(', ')}`,
      display: { kind: 'generic', summary: 'Apply file patch', detail: args.input },
      approvalRule: paths.length === 1 ? literalRulePattern(this.name, paths[0]!) : this.name,
      matchesRule: (ruleArgs) => paths.every((path) => matchesPathRuleSubject(ruleArgs, path, {
        cwd: workspace.workspaceDir,
        pathClass: inspected.environment.pathClass,
        homeDir: inspected.environment.homeDir,
      })),
      execute: async (ctx) => {
        if (!this.flags.enabled(APPLY_PATCH_FLAG_ID)) return failure('The apply_patch experimental flag is disabled.');
        const lease = this.runtime.acquire(['fs']);
        try {
          if (lease.runtime.identity.generation !== inspected.identity.generation) {
            return failure('Runtime changed before execution. Retry the tool call.');
          }
          return await executePatch(lease.runtime, resolved, ctx.signal);
        } finally {
          lease.dispose();
        }
      },
    };
  }
}

async function executePatch(
  runtime: Runtime,
  operations: readonly ResolvedPatchOperation[],
  signal: AbortSignal,
): Promise<ExecutableToolResult> {
  const fs = runtime.fs!;
  const prepared: PreparedPatchOperation[] = [];
  let currentPath = '';
  try {
    for (const entry of operations) {
      signal.throwIfAborted();
      currentPath = entry.operation.path;
      const result = await preflight(fs, entry);
      if (!result.ok) return failure(`Patch preflight failed; no files changed. ${result.error}`);
      prepared.push(result.value);
    }
    signal.throwIfAborted();
  } catch (error) {
    return failure(`Patch preflight failed at ${currentPath}; no files changed. ${errorText(error)}`);
  }

  const completed: string[] = [];
  for (const [index, entry] of prepared.entries()) {
    try {
      signal.throwIfAborted();
      if (entry.operation.type === 'add') {
        await fs.mkdir(dirname(entry.path), { recursive: true });
        signal.throwIfAborted();
        if (!await fs.createExclusive(entry.path, new TextEncoder().encode(entry.after))) {
          return writeFailure(entry, prepared.slice(index + 1), completed, 'The target was created after preflight; it was not overwritten.');
        }
      } else {
        const current = await fs.readText(entry.path, { errors: 'strict' });
        signal.throwIfAborted();
        if (current !== entry.before) {
          return writeFailure(entry, prepared.slice(index + 1), completed, 'The file changed after preflight; it was not overwritten.');
        }
        if (entry.operation.type === 'delete') await fs.remove(entry.path);
        else await fs.writeText(entry.path, entry.after!);
      }
      completed.push(`${entry.operation.type}: ${entry.operation.path}`);
    } catch (error) {
      return writeFailure(entry, prepared.slice(index + 1), completed, errorText(error));
    }
  }
  return { output: `Applied patch:\n${completed.join('\n')}` };
}

async function preflight(fs: IHostFileSystem, entry: ResolvedPatchOperation): Promise<PatchResult<PreparedPatchOperation>> {
  const stat = await statIfPresent(fs, entry.path);
  if (entry.operation.type === 'add') {
    if (stat !== undefined) return { ok: false, error: `${entry.operation.path} already exists. Add File never overwrites files.` };
    const parentError = await validateParents(fs, dirname(entry.path));
    if (parentError !== undefined) return { ok: false, error: parentError };
    return { ok: true, value: { ...entry, after: entry.operation.content } };
  }
  if (stat === undefined || !stat.isFile || stat.isSymbolicLink === true) {
    return { ok: false, error: `${entry.operation.path} must be an existing regular file, not a directory or symlink.` };
  }
  const parentError = await validateParents(fs, dirname(entry.path));
  if (parentError !== undefined) return { ok: false, error: parentError };
  const before = await fs.readText(entry.path, { errors: 'strict' });
  if (entry.operation.type === 'delete') return { ok: true, value: { ...entry, before } };
  const applied = applyUpdate(before, entry.operation);
  return applied.ok ? { ok: true, value: { ...entry, before, after: applied.value } } : applied;
}

async function validateParents(fs: IHostFileSystem, start: string): Promise<string | undefined> {
  let path = start;
  for (;;) {
    const stat = await statIfPresent(fs, path);
    if (stat !== undefined && (!stat.isDirectory || stat.isSymbolicLink === true)) {
      return `Patch parent ${path} is not a regular directory. Symlink paths are unsupported.`;
    }
    const parent = dirname(path);
    if (parent === path) return undefined;
    path = parent;
  }
}

async function statIfPresent(fs: IHostFileSystem, path: string): Promise<HostFileStat | undefined> {
  try {
    return await fs.lstat(path);
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === OsFsErrors.codes.OS_FS_NOT_FOUND) return undefined;
    throw error;
  }
}

function writeFailure(
  failed: ResolvedPatchOperation,
  pending: readonly ResolvedPatchOperation[],
  completed: readonly string[],
  reason: string,
): ExecutableToolResult {
  return failure([
    `Patch stopped at ${failed.operation.path}: ${reason}`,
    `Completed files: ${completed.length === 0 ? 'none' : completed.join(', ')}`,
    `Not attempted: ${pending.length === 0 ? 'none' : pending.map((entry) => entry.operation.path).join(', ')}`,
    'The failing file may have been partially written. Inspect it and completed files before retrying; cross-file writes are not atomic.',
  ].join('\n'));
}

function failure(output: string): ExecutableToolResult & { readonly isError: true } {
  return { isError: true, output };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

registerAgentToolService(IApplyPatchTool, ApplyPatchTool, {
  name: APPLY_PATCH_TOOL_NAME,
  domain: 'applyPatch',
  requiredRuntimeCapabilities: ['fs'],
  when: (accessor) => accessor.get(IFlagService).enabled(APPLY_PATCH_FLAG_ID),
});
