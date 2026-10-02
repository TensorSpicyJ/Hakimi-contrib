/**
 * `sessionHandoff` domain — `ISessionHandoffCoordinator` implementation.
 *
 * Owns the host registration table and the start orchestration: validates the
 * flag through `flags` (`IFlagService`), the deny guards, host availability,
 * the target directory through `hostFs` (`IHostFileSystem`), the configured
 * default model alias through `config` (`IConfigService`) and `models`
 * (`IModelService`), and the target project's trust read off the materialized
 * workspace's program (never granted here); creates the target session through
 * `sessions` (`ISessionManager`, which materializes the target workspace
 * through `workspaces`) bound to the default main profile from
 * `agentProfileCatalog`; records the source lineage and the prompt text in the
 * target's metadata and announces an explicit title through the standard
 * `session.meta.updated` event, both through the target handle's
 * `ISessionMetadata` / `IEventService` (`promptMetadata`); awaits every matching
 * host's pre-prompt preparation with the live target handle; re-reads the
 * target project's trust and resolves the target prompt entry point; then runs
 * the final authorization check and immediately submits the initial prompt
 * with the `contextMemory` user origin through `ensureMainAgent` and
 * `IAgentPromptService.enqueue`, with no await in between. Nothing after
 * session creation throws: the result carries the real target id and status.
 * Rejections never create a session, submit a prompt, or grant trust, but
 * reading the target's trust materializes its workspace handler, so a rejected
 * handoff can leave that directory known to the workspace catalog. Bound at
 * App scope by `SessionHandoffFeature`.
 */

import { isAbsolute, resolve } from 'pathe';

import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { abortError, isAbortError } from '#/_base/utils/abort';
import { toErrorMessage } from '#/_base/errors/errorMessage';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IEventService } from '#/app/event/event';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { DEFAULT_MODEL_SECTION } from '#/app/kosongConfig/configSection';
import { IAgentPromptService, type PromptHandle, type PromptState } from '#/agent/prompt/prompt';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import { promptMetadataTextFromText } from '#/agent/prompt/promptMetadataText';
import { Error2, ErrorCodes } from '#/errors';
import { IModelService } from '#/kosong/model/model';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { applyPromptMetadataUpdate } from '#/session/sessionMetadata/promptMetadata';
import { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';

import { SessionHandoffErrors } from './errors';
import { CROSS_PROJECT_SESSIONS_FLAG_ID } from './flag';
import { START_SESSION_TOOL_NAME } from './tools/start-session/start-session';
import {
  ISessionHandoffCoordinator,
  SESSION_HANDOFF_CUSTOM_KEY,
  type SessionHandoffDenyGuard,
  type SessionHandoffHost,
  type SessionHandoffPrepareContext,
  type SessionHandoffRequest,
  type SessionHandoffStartResult,
  type SessionHandoffTarget,
  type StartSessionStatus,
} from './sessionHandoff';

export class SessionHandoffCoordinator implements ISessionHandoffCoordinator {
  declare readonly _serviceBrand: undefined;

  private readonly hosts: SessionHandoffHost[] = [];
  private readonly denyGuards: SessionHandoffDenyGuard[] = [];

  constructor(
    @IFlagService private readonly flags: IFlagService,
    @ISessionManager private readonly sessions: ISessionManager,
    @IWorkspaceInstanceManager private readonly workspaces: IWorkspaceInstanceManager,
    @IConfigService private readonly config: IConfigService,
    @IModelService private readonly models: IModelService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
  ) {}

  registerHost(host: SessionHandoffHost): IDisposable {
    this.hosts.push(host);
    return toDisposable(() => {
      const index = this.hosts.indexOf(host);
      if (index >= 0) this.hosts.splice(index, 1);
    });
  }

  registerDenyGuard(guard: SessionHandoffDenyGuard): IDisposable {
    this.denyGuards.push(guard);
    return toDisposable(() => {
      const index = this.denyGuards.indexOf(guard);
      if (index >= 0) this.denyGuards.splice(index, 1);
    });
  }

  isAvailable(sourceSessionId: string): boolean {
    if (!this.flags.enabled(CROSS_PROJECT_SESSIONS_FLAG_ID)) return false;
    if (this.denyReasonFor(sourceSessionId) !== undefined) return false;
    return this.matchingHosts(sourceSessionId).length > 0;
  }

  async start(request: SessionHandoffRequest): Promise<SessionHandoffStartResult> {
    this.assertNotAborted(request.signal);
    if (request.sourceAgentId !== MAIN_AGENT_ID) {
      throw new Error2(
        SessionHandoffErrors.codes.SESSION_HANDOFF_NOT_MAIN_AGENT,
        `The ${START_SESSION_TOOL_NAME} tool is available to the main agent only`,
        { details: { agentId: request.sourceAgentId } },
      );
    }
    this.assertAuthorized(request.sourceSessionId);
    const workDir = await this.resolveWorkDir(request.workDir);
    const model = await this.resolveDefaultModel();
    await this.assertTrusted(workDir);
    this.assertNotAborted(request.signal);
    // Snapshot the hosts serving this source session right before creation,
    // and re-validate the authorization with it: the pre-flight awaits gave
    // flag changes, deny guards, and host registration changes time to land,
    // and a revoked permission must not create a session.
    const hosts = this.assertAuthorized(request.sourceSessionId);

    const handle = await this.sessions.create({
      workDir,
      mainAgentBinding: { profile: DEFAULT_AGENT_PROFILE_NAME, model },
    });
    const context = handle.accessor.get(ISessionContext);
    const target: SessionHandoffTarget = {
      sessionId: context.sessionId,
      workspaceId: context.workspaceId,
      workDir,
      title: request.title,
    };
    let metadataFailure: string | undefined;
    try {
      await this.recordTarget(handle, context.sessionId, request);
    } catch (error) {
      metadataFailure = toErrorMessage(error);
    }

    // Preparation always runs once the target exists — including on the
    // metadata-failure path — so every participating host can register a
    // session that was created even when the handoff will not start. All
    // snapshot hosts are prepared, in registration order, before any prompt.
    const prepareContext: SessionHandoffPrepareContext = {
      sourceSessionId: request.sourceSessionId,
      sourceAgentId: request.sourceAgentId,
      sourceWorkDir: request.sourceWorkDir,
      workDir,
      prompt: request.prompt,
      title: request.title,
      target,
      handle,
    };
    for (const host of hosts) {
      try {
        await host.prepare(prepareContext);
      } catch (error) {
        return failed(target, error);
      }
    }

    // Trust can be revoked while the hosts prepared: re-read it from the
    // target workspace (never granted here) before anything is submitted.
    if (!(await this.isTrusted(workDir))) {
      return {
        ...target,
        status: 'failed',
        failure: `The project at "${workDir}" is no longer trusted, so the task was not submitted`,
      };
    }

    // Resolve the target's prompt entry point now, so the final
    // authorization check below runs with no further await before the submit
    // call — no host can slip in between the check and the enqueue.
    let promptService: IAgentPromptService;
    try {
      promptService = await this.resolveMainPromptService(handle);
    } catch (error) {
      return failed(target, error);
    }

    // Nothing may start on a permission revoked during preparation, and
    // never when the serving set drifted — a host that did not prepare this
    // session must not inherit it.
    const revoked = this.revocationReasonFor(request.sourceSessionId, hosts);
    if (revoked !== undefined) {
      return { ...target, status: 'failed', failure: revoked };
    }
    if (request.signal.aborted) {
      return {
        ...target,
        status: 'aborted',
        failure: 'The handoff was cancelled before the initial prompt was submitted',
      };
    }
    if (metadataFailure !== undefined) {
      return {
        ...target,
        status: 'failed',
        failure: `The session was created but its metadata could not be recorded, so the task was not submitted: ${metadataFailure}`,
      };
    }

    try {
      const prompt = await this.submit(promptService, request.prompt);
      const status = promptStatus(prompt.state);
      const failure = startFailure(status);
      return failure === undefined
        ? { ...target, promptId: prompt.id, status }
        : { ...target, promptId: prompt.id, status, failure };
    } catch (error) {
      return failed(target, error);
    }
  }

  private assertAuthorized(sourceSessionId: string): readonly SessionHandoffHost[] {
    this.assertEnabled();
    const denial = this.denyReasonFor(sourceSessionId);
    if (denial !== undefined) {
      throw new Error2(SessionHandoffErrors.codes.SESSION_HANDOFF_DENIED, denial, {
        details: { sessionId: sourceSessionId },
      });
    }
    const hosts = this.matchingHosts(sourceSessionId);
    if (hosts.length === 0) {
      throw new Error2(
        SessionHandoffErrors.codes.SESSION_HANDOFF_UNSUPPORTED,
        'This host cannot take over a session started from another session, so cross-project session handoff is unavailable',
        { details: { sessionId: sourceSessionId } },
      );
    }
    return hosts;
  }

  /**
   * Authorization drift observed after preparation. Evaluated instead of
   * thrown because the target session already exists by then. The serving set
   * must still be exactly the prepared one: a host added, withdrawn, or no
   * longer matching during preparation means nobody may start this session
   * under it.
   */
  private revocationReasonFor(
    sourceSessionId: string,
    preparedHosts: readonly SessionHandoffHost[],
  ): string | undefined {
    if (!this.flags.enabled(CROSS_PROJECT_SESSIONS_FLAG_ID)) {
      return 'Cross-project session handoff was disabled before the first prompt was submitted, so the task was not started';
    }
    const denial = this.denyReasonFor(sourceSessionId);
    if (denial !== undefined) return denial;
    const current = this.matchingHosts(sourceSessionId);
    if (
      current.length !== preparedHosts.length ||
      current.some((host, index) => host !== preparedHosts[index])
    ) {
      return 'The set of hosts serving this session changed while it was being prepared, so the session was left unstarted rather than started under a host that did not prepare it';
    }
    return undefined;
  }

  private assertEnabled(): void {
    if (this.flags.enabled(CROSS_PROJECT_SESSIONS_FLAG_ID)) return;
    throw new Error2(
      SessionHandoffErrors.codes.SESSION_HANDOFF_DISABLED,
      `Cross-project session handoff is disabled. Enable the "${CROSS_PROJECT_SESSIONS_FLAG_ID}" experimental flag to use ${START_SESSION_TOOL_NAME}.`,
    );
  }

  private assertNotAborted(signal: AbortSignal): void {
    if (signal.aborted) throw abortError('The handoff was cancelled');
  }

  private denyReasonFor(sourceSessionId: string): string | undefined {
    for (const guard of this.denyGuards) {
      const reason = guard.denyReason(sourceSessionId);
      if (reason !== undefined) return reason;
    }
    return undefined;
  }

  private matchingHosts(sourceSessionId: string): SessionHandoffHost[] {
    return this.hosts.filter((host) => host.matches(sourceSessionId));
  }

  private async resolveWorkDir(workDir: string): Promise<string> {
    if (!isAbsolute(workDir)) {
      throw new Error2(
        SessionHandoffErrors.codes.SESSION_HANDOFF_WORK_DIR_INVALID,
        `work_dir must be an absolute path to an existing directory, got "${workDir}"`,
        { details: { workDir } },
      );
    }
    const absolute = resolve(workDir);
    const stat = await this.hostFs.stat(absolute).catch(() => undefined);
    if (stat === undefined || !stat.isDirectory) {
      throw new Error2(
        SessionHandoffErrors.codes.SESSION_HANDOFF_WORK_DIR_INVALID,
        `work_dir "${absolute}" is not an existing directory`,
        { details: { workDir: absolute } },
      );
    }
    return absolute;
  }

  private async resolveDefaultModel(): Promise<string> {
    await Promise.all([this.config.ready, this.models.ready]);
    const alias = this.config.get<string>(DEFAULT_MODEL_SECTION);
    if (alias === undefined || alias.trim().length === 0 || this.models.get(alias) === undefined) {
      throw new Error2(
        ErrorCodes.MODEL_NOT_CONFIGURED,
        `No default model is configured, so a session cannot be started in another project. Configure a default model first.`,
      );
    }
    return alias;
  }

  private async assertTrusted(workDir: string): Promise<void> {
    if (await this.isTrusted(workDir)) return;
    throw new Error2(
      SessionHandoffErrors.codes.SESSION_HANDOFF_TRUST_REQUIRED,
      `The project at "${workDir}" is not trusted. Open or trust that project first; this tool never marks a project trusted on its own.`,
      { details: { workDir } },
    );
  }

  private async isTrusted(workDir: string): Promise<boolean> {
    const workspace = await this.workspaces.getOrCreate({ root: workDir });
    return workspace.program.trust.get();
  }

  private async recordTarget(
    handle: ISessionScopeHandle,
    sessionId: string,
    request: SessionHandoffRequest,
  ): Promise<void> {
    const metadata = handle.accessor.get(ISessionMetadata);
    const eventService = handle.accessor.get(IEventService);
    const current = await metadata.read();
    await metadata.update({
      title: request.title,
      titleKind: request.title === undefined ? undefined : 'custom',
      custom: {
        ...current.custom,
        [SESSION_HANDOFF_CUSTOM_KEY]: {
          source_session_id: request.sourceSessionId,
          source_work_dir: request.sourceWorkDir,
          started_at: Date.now(),
        },
      },
    });
    // An explicit title is announced through the standard session-metadata
    // event so live clients stop showing an untitled session; `patch` carries
    // only fields that event already defines, so the lineage in `custom`
    // stays list/REST-readable. The prompt text follows in the same event
    // type through `applyPromptMetadataUpdate`, which leaves a custom title
    // alone.
    if (request.title !== undefined) {
      eventService.publish({
        type: 'session.meta.updated',
        payload: {
          agentId: MAIN_AGENT_ID,
          sessionId,
          title: request.title,
          patch: { title: request.title, isCustomTitle: true },
        },
      });
    }
    await applyPromptMetadataUpdate(
      { metadata, eventService, sessionId },
      promptMetadataTextFromText(request.prompt),
    );
  }

  private async resolveMainPromptService(handle: ISessionScopeHandle): Promise<IAgentPromptService> {
    const agent = await ensureMainAgent(handle);
    return agent.accessor.get(IAgentPromptService);
  }

  private async submit(
    promptService: IAgentPromptService,
    prompt: string,
  ): Promise<PromptHandle> {
    return promptService.enqueue({
      message: {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        toolCalls: [],
        origin: USER_PROMPT_ORIGIN,
      },
    });
  }
}

function promptStatus(state: PromptState): StartSessionStatus {
  switch (state) {
    case 'running':
    case 'steered':
      return 'running';
    case 'pending':
      return 'pending';
    case 'completed':
      return 'completed';
    case 'blocked':
      return 'blocked';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'aborted';
  }
}

function startFailure(status: StartSessionStatus): string | undefined {
  switch (status) {
    case 'running':
    case 'pending':
    case 'completed':
      return undefined;
    case 'blocked':
      return 'The session was created, but the first prompt was blocked before its turn started';
    case 'aborted':
      return 'The session was created, but the first prompt was cancelled before its turn completed';
    case 'failed':
      return 'The session was created, but the first prompt failed before its turn started';
  }
}

function failed(target: SessionHandoffTarget, error: unknown): SessionHandoffStartResult {
  return {
    ...target,
    status: isAbortError(error) ? 'aborted' : 'failed',
    failure: toErrorMessage(error),
  };
}
