// apps/kimi-web/src/api/daemon/mappers.ts
// wire→app and app→wire mapper functions.
// All snake_case ↔ camelCase conversion happens ONLY here.

import type {
  AppApprovalRequest,
  AppConfig,
  AppEvent,
  AppGoal,
  AutoSubagentPresetCandidateScore,
  AutoSubagentPresetResourceEvidence,
  AutoSubagentPresetResetPriority,
  AutoSubagentPresetRoleScore,
  AutoSubagentPresetRouteScore,
  LocalMeteredUsage,
  AutoSubagentPresetReasonCode,
  AutoSubagentPresetStatus,
  AppGoalWaitLease,
  AppModel,
  AppProvider,
  AppRemotePersistentStatus,
  AppRemoteShareStatus,
  FsEntry,
  AppMessage,
  AppMessageContent,
  AppMessageRole,
  AppQuestionRequest,
  AppSession,
  AppSessionUsage,
  AppTask,
  AppTaskStatus,
  AppWorkspace,
  ApprovalResponse,
  ImageSource,
  PromptSubmission,
  ProviderMeteredBalance,
  ProviderMeteredBalanceResult,
  ProviderMeteredPeriod,
  ProviderMeteredUsage,
  ProviderUsageResult,
  QuestionAnswer,
  QuestionItem,
  QuestionOption,
  QuestionResponse,
  ResearchModeSnapshot,
} from '../types';

import type {
  WireApprovalRequest,
  WireApprovalResponse,
  WireAutoSubagentPresetCandidateScore,
  WireAutoSubagentPresetResetPriority,
  WireAutoSubagentPresetStatus,
  WireTask,
  WireFsEntry,
  WireImageSource,
  WireMessage,
  WireMessageContent,
  WireModel,
  WirePromptSubmission,
  WireProvider,
  WireProviderMeteredBalance,
  WireProviderMeteredBalanceResult,
  WireProviderMeteredPeriod,
  WireProviderMeteredUsage,
  WireProviderUsageItem,
  WireQuestionAnswer,
  WireQuestionItem,
  WireQuestionOption,
  WireQuestionRequest,
  WireQuestionResponse,
  WireRemotePersistentStatus,
  WireRemoteShareStatus,
  WireResearchModeSnapshot,
  WireSession,
  WireSessionUsage,
  WireWorkspace,
  WireEvent,
  WireConfig,
} from './wire';

// ---------------------------------------------------------------------------
// Session mappers
// ---------------------------------------------------------------------------

export function toAppRemoteShareStatus(wire: WireRemoteShareStatus): AppRemoteShareStatus {
  return {
    active: wire.active,
    sessionId: wire.session_id,
    host: wire.host,
    port: wire.port,
    url: wire.url,
    ttlSeconds: wire.ttl_seconds,
    startedAt: wire.started_at,
    expiresAt: wire.expires_at,
  };
}

export function toAppRemotePersistentStatus(
  wire: WireRemotePersistentStatus,
): AppRemotePersistentStatus {
  return {
    active: wire.active,
    state: wire.state,
    health: wire.health,
    origin: wire.origin,
    url: wire.url,
    port: wire.port,
    startedAt: wire.started_at,
    systemdAvailable: wire.systemd_available,
    message: wire.message,
  };
}

export function toAppSessionUsage(wire: WireSessionUsage): AppSessionUsage {
  return {
    inputTokens: wire.input_tokens,
    outputTokens: wire.output_tokens,
    cacheReadTokens: wire.cache_read_tokens,
    cacheCreationTokens: wire.cache_creation_tokens,
    totalCostUsd: wire.total_cost_usd,
    contextTokens: wire.context_tokens,
    contextLimit: wire.context_limit,
    turnCount: wire.turn_count,
  };
}

/**
 * True when a session usage object is the daemon's all-zero placeholder.
 * Both engines return placeholders for the heavy session fields on the
 * list/snapshot read paths; the live values arrive via GET /status and the
 * WS `agent.status.updated` stream. Callers replacing a cached session with
 * a wire record must keep the live usage when the incoming one is this
 * placeholder, or the context ring drops to 0 until the next refresh.
 */
export function isPlaceholderSessionUsage(usage: AppSessionUsage): boolean {
  return (
    usage.contextTokens === 0 &&
    usage.contextLimit === 0 &&
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.turnCount === 0
  );
}

export function toAppSession(wire: WireSession): AppSession {
  return {
    id: wire.id,
    title: wire.title,
    createdAt: wire.created_at,
    updatedAt: wire.updated_at,
    busy: wire.busy,
    mainTurnActive: wire.main_turn_active,
    pendingInteraction: wire.pending_interaction,
    lastTurnReason: wire.last_turn_reason,
    archived: wire.archived ?? false,
    currentPromptId: wire.current_prompt_id,
    lastPrompt: wire.last_prompt,
    cwd: wire.metadata.cwd,
    model: wire.agent_config.model,
    usage: toAppSessionUsage(wire.usage),
    messageCount: wire.message_count,
    lastSeq: wire.last_seq,
    workspaceId: wire.workspace_id,
    parentSessionId:
      typeof wire.metadata['parent_session_id'] === 'string'
        ? wire.metadata['parent_session_id']
        : undefined,
  };
}

export function toAppWorkspace(wire: WireWorkspace): AppWorkspace {
  return {
    id: wire.id,
    root: wire.root,
    name: wire.name,
    lastOpenedAt: wire.last_opened_at,
    sessionCount: wire.session_count,
  };
}

// ---------------------------------------------------------------------------
// Message mappers
// ---------------------------------------------------------------------------

function toAppImageSource(src: WireImageSource): ImageSource {
  if (src.kind === 'base64') {
    return { kind: 'base64', mediaType: src.media_type, data: src.data };
  }
  if (src.kind === 'file') {
    return { kind: 'file', fileId: src.file_id };
  }
  return { kind: 'url', url: src.url, id: src.id };
}

export function toAppMessageContent(wire: WireMessageContent): AppMessageContent {
  switch (wire.type) {
    case 'text':
      return { type: 'text', text: wire.text };
    case 'tool_use':
      return {
        type: 'toolUse',
        toolCallId: wire.tool_call_id,
        toolName: wire.tool_name,
        input: wire.input,
      };
    case 'tool_result':
      return {
        type: 'toolResult',
        toolCallId: wire.tool_call_id,
        output: wire.output,
        isError: wire.is_error,
      };
    case 'image':
      return {
        type: 'image',
        source: toAppImageSource(wire.source),
      };
    case 'video':
      return {
        type: 'video',
        source: toAppImageSource(wire.source),
      };
    case 'file':
      return {
        type: 'file',
        fileId: wire.file_id,
        name: wire.name,
        mediaType: wire.media_type,
        size: wire.size,
      };
    case 'thinking':
      return {
        type: 'thinking',
        thinking: wire.thinking,
        signature: wire.signature,
      };
    default: {
      // Unknown content type — pass raw through
      return { type: 'unknown', raw: wire };
    }
  }
}

export function toAppMessage(wire: WireMessage): AppMessage {
  return {
    id: wire.id,
    sessionId: wire.session_id,
    role: wire.role as AppMessageRole,
    content: wire.content.map(toAppMessageContent),
    createdAt: wire.created_at,
    promptId: wire.prompt_id,
    parentMessageId: wire.parent_message_id,
    metadata: wire.metadata,
  };
}

// ---------------------------------------------------------------------------
// Prompt mappers
// ---------------------------------------------------------------------------

function toWireMessageContent(app: AppMessageContent): WireMessageContent {
  switch (app.type) {
    case 'text':
      return { type: 'text', text: app.text };
    case 'toolUse':
      return {
        type: 'tool_use',
        tool_call_id: app.toolCallId,
        tool_name: app.toolName,
        input: app.input,
      };
    case 'toolResult':
      return {
        type: 'tool_result',
        tool_call_id: app.toolCallId,
        output: app.output,
        is_error: app.isError,
      };
    case 'image':
    case 'video': {
      const src = app.source;
      let wireSrc: WireImageSource;
      if (src.kind === 'base64') {
        wireSrc = { kind: 'base64', media_type: src.mediaType, data: src.data };
      } else if (src.kind === 'file') {
        wireSrc = { kind: 'file', file_id: src.fileId };
      } else {
        wireSrc = { kind: 'url', url: src.url, id: src.id };
      }
      return { type: app.type, source: wireSrc };
    }
    case 'file':
      return {
        type: 'file',
        file_id: app.fileId,
        name: app.name,
        media_type: app.mediaType,
        size: app.size,
      };
    case 'thinking':
      return { type: 'thinking', thinking: app.thinking, signature: app.signature };
    case 'unknown':
      // Best-effort: pass raw back. May not be a valid WireMessageContent.
      return app.raw as WireMessageContent;
  }
}

export function toWirePromptSubmission(input: PromptSubmission): WirePromptSubmission {
  return {
    content: input.content.map(toWireMessageContent),
    metadata: input.metadata,
    agent_id: input.agentId,
    model: input.model,
    thinking: input.thinking,
    permission_mode: input.permissionMode,
    plan_mode: input.planMode,
    swarm_mode: input.swarmMode,
    goal_objective: input.goalObjective,
    goal_control: input.goalControl,
  };
}

// ---------------------------------------------------------------------------
// Approval mappers
// ---------------------------------------------------------------------------

export function toWireApprovalResponse(input: ApprovalResponse): WireApprovalResponse {
  return {
    decision: input.decision,
    scope: input.scope,
    feedback: input.feedback,
    selected_label: input.selectedLabel,
  };
}

export function toAppApprovalRequest(wire: WireApprovalRequest): AppApprovalRequest {
  return {
    approvalId: wire.approval_id,
    sessionId: wire.session_id,
    turnId: wire.turn_id,
    toolCallId: wire.tool_call_id,
    toolName: wire.tool_name,
    action: wire.action,
    // The real daemon sends `tool_input_display`; the stub sends `display`.
    display: wire.tool_input_display ?? wire.display,
    expiresAt: wire.expires_at,
    createdAt: wire.created_at,
  };
}

// ---------------------------------------------------------------------------
// Question mappers
// ---------------------------------------------------------------------------

function toAppQuestionOption(wire: WireQuestionOption): QuestionOption {
  return {
    id: wire.id,
    label: wire.label,
    description: wire.description,
    recommended: wire.recommended === true || wire.is_recommended === true,
  };
}

function toAppQuestionItem(wire: WireQuestionItem): QuestionItem {
  return {
    id: wire.id,
    question: wire.question,
    header: wire.header,
    body: wire.body,
    options: wire.options.map(toAppQuestionOption),
    multiSelect: wire.multi_select,
    allowOther: wire.allow_other,
    otherLabel: wire.other_label,
    otherDescription: wire.other_description,
  };
}

export function toAppQuestionRequest(wire: WireQuestionRequest): AppQuestionRequest {
  return {
    questionId: wire.question_id,
    sessionId: wire.session_id,
    turnId: wire.turn_id,
    toolCallId: wire.tool_call_id,
    questions: wire.questions.map(toAppQuestionItem),
    createdAt: wire.created_at,
  };
}

function toWireQuestionAnswer(app: QuestionAnswer): WireQuestionAnswer {
  switch (app.kind) {
    case 'single':
      return { kind: 'single', option_id: app.optionId };
    case 'multi':
      return { kind: 'multi', option_ids: app.optionIds };
    case 'other':
      return { kind: 'other', text: app.text };
    case 'multiWithOther':
      return { kind: 'multi_with_other', option_ids: app.optionIds, other_text: app.otherText };
    case 'skipped':
      return { kind: 'skipped' };
  }
}

export function toWireQuestionResponse(input: QuestionResponse): WireQuestionResponse {
  const wireAnswers: Record<string, WireQuestionAnswer> = {};
  for (const [questionId, answer] of Object.entries(input.answers)) {
    wireAnswers[questionId] = toWireQuestionAnswer(answer);
  }
  return {
    answers: wireAnswers,
    method: input.method,
    note: input.note,
  };
}

// ---------------------------------------------------------------------------
// Task mapper
// ---------------------------------------------------------------------------

export function toAppTask(wire: WireTask): AppTask {
  return {
    id: wire.id,
    sessionId: wire.session_id,
    kind: wire.kind,
    description: wire.description,
    status: wire.status as AppTaskStatus,
    command: wire.command,
    createdAt: wire.created_at,
    startedAt: wire.started_at,
    completedAt: wire.completed_at,
    outputPreview: wire.output_preview,
    outputBytes: wire.output_bytes,
    agentId: wire.agent_id,
    model: wire.model,
    thinkingEffort: wire.thinking_effort,
    subagentPhase: wire.subagent_phase,
    subagentType: wire.subagent_type,
    parentToolCallId: wire.parent_tool_call_id,
    suspendedReason: wire.suspended_reason,
    swarmIndex: wire.swarm_index,
    // Preserve the server's explicit detached/foreground truth. Missing data
    // stays unknown rather than being guessed from the task kind.
    runInBackground: wire.run_in_background,
    // outputLines starts undefined; populated by eventReducer via task.progress events
  };
}

// ---------------------------------------------------------------------------
// FsEntry mapper
// ---------------------------------------------------------------------------

export function toAppFsEntry(wire: WireFsEntry): FsEntry {
  return {
    path: wire.path,
    name: wire.name,
    kind: wire.kind,
    size: wire.size,
    modifiedAt: wire.modified_at,
    etag: wire.etag,
    mime: wire.mime,
    languageId: wire.language_id,
    isBinary: wire.is_binary,
    isSymlinkTo: wire.is_symlink_to,
    gitStatus: wire.git_status,
    childCount: wire.child_count,
  };
}

// ---------------------------------------------------------------------------
// WireEvent → AppEvent
// ---------------------------------------------------------------------------

function recordString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function recordNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function recordNullableNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function recordGoalWaitLease(source: Record<string, unknown>): AppGoalWaitLease | undefined {
  const raw = source['waitingFor'] ?? source['waiting_for'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const wait = raw as Record<string, unknown>;
  const keys = Object.keys(wait);
  if (
    keys.some((key) => key !== 'taskIds' && key !== 'task_ids' && key !== 'policy') ||
    ('taskIds' in wait && 'task_ids' in wait)
  ) {
    return undefined;
  }
  const taskIds = wait['taskIds'] ?? wait['task_ids'];
  if (
    !Array.isArray(taskIds) ||
    taskIds.length === 0 ||
    taskIds.length > 32 ||
    !taskIds.every((taskId) => typeof taskId === 'string' && taskId.length > 0)
  ) {
    return undefined;
  }
  const policy = wait['policy'];
  if (policy !== 'any' && policy !== 'all') return undefined;
  return { taskIds: taskIds as string[], policy };
}

function recordGoalContinuation(source: Record<string, unknown>): AppGoal['continuation'] {
  const raw = source['continuation'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const continuation = raw as Record<string, unknown>;
  if (Object.keys(continuation).some((key) => key !== 'state' && key !== 'owner' && key !== 'reason')) {
    return undefined;
  }
  const state = continuation['state'];
  if (
    state !== 'idle' &&
    state !== 'deciding' &&
    state !== 'enqueued' &&
    state !== 'running' &&
    state !== 'held' &&
    state !== 'waiting'
  ) {
    return undefined;
  }
  const owner = continuation['owner'];
  const reason = continuation['reason'];
  if (owner !== undefined && typeof owner !== 'string') return undefined;
  if (reason !== undefined && typeof reason !== 'string') return undefined;
  return {
    state,
    ...(owner === undefined ? {} : { owner }),
    ...(reason === undefined ? {} : { reason }),
  };
}

export function toAppGoal(snapshot: unknown): AppGoal | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const source = snapshot as Record<string, unknown>;
  const status = recordString(source, 'status');
  if (status !== 'active' && status !== 'paused' && status !== 'blocked' && status !== 'complete') {
    return null;
  }

  const budgetRaw = source['budget'];
  const budget = budgetRaw && typeof budgetRaw === 'object' ? budgetRaw as Record<string, unknown> : {};

  return {
    goalId: recordString(source, 'goalId') ?? recordString(source, 'goal_id') ?? 'goal',
    objective: recordString(source, 'objective') ?? '',
    completionCriterion: recordString(source, 'completionCriterion') ?? recordString(source, 'completion_criterion'),
    status,
    turnsUsed: recordNumber(source, 'turnsUsed') ?? recordNumber(source, 'turns_used') ?? 0,
    tokensUsed: recordNumber(source, 'tokensUsed') ?? recordNumber(source, 'tokens_used') ?? 0,
    wallClockMs: recordNumber(source, 'wallClockMs') ?? recordNumber(source, 'wall_clock_ms') ?? 0,
    waitingFor: recordGoalWaitLease(source),
    continuation: recordGoalContinuation(source),
    terminalReason: recordString(source, 'terminalReason') ?? recordString(source, 'terminal_reason'),
    budget: {
      tokenBudget: recordNullableNumber(budget, 'tokenBudget') ?? recordNullableNumber(budget, 'token_budget'),
      remainingTokens: recordNullableNumber(budget, 'remainingTokens') ?? recordNullableNumber(budget, 'remaining_tokens'),
      turnBudget: recordNullableNumber(budget, 'turnBudget') ?? recordNullableNumber(budget, 'turn_budget'),
      remainingTurns: recordNullableNumber(budget, 'remainingTurns') ?? recordNullableNumber(budget, 'remaining_turns'),
      wallClockBudgetMs: recordNullableNumber(budget, 'wallClockBudgetMs') ?? recordNullableNumber(budget, 'wall_clock_budget_ms'),
      remainingWallClockMs: recordNullableNumber(budget, 'remainingWallClockMs') ?? recordNullableNumber(budget, 'remaining_wall_clock_ms'),
      overBudget: budget['overBudget'] === true || budget['over_budget'] === true,
    },
  };
}

export function toAppResearchModeSnapshot(
  snapshot: WireResearchModeSnapshot,
): ResearchModeSnapshot {
  // The mode snapshot is two booleans; a shallow copy is sufficient and keeps
  // the caller from sharing the mutable wire reference.
  return { ...snapshot };
}

const AUTO_PRESET_REASON_CODES = new Set<AutoSubagentPresetReasonCode>([
  'cancelled',
  'flag_disabled',
  'auto_preset_disabled',
  'manual_lock',
  'caller_model_unavailable',
  'no_candidates',
  'explicit_preset',
  'no_quota_evidence',
  'no_healthy_candidate',
  'current_optimal',
  'score_margin_not_met',
  'switch_cooldown',
  'current_unhealthy',
  'circuit_breaker_escape',
  'higher_score',
  'manual_override',
  'preset_changed_during_evaluation',
  'routing_config_changed',
  'evaluation_failed',
  'activation_failed',
  'activation_no_effect',
]);
const AUTO_PRESET_ROUTES = new Set(['agent', 'swarm', 'tower_worker', 'tower_reviewer']);
const AUTO_PRESET_ROUTE_AVAILABILITY = new Set([
  'healthy', 'route_unresolved', 'quota_unknown', 'quota_below_floor', 'circuit_open',
  'balance_empty', 'balance_unknown', 'balance_invalid', 'account_unavailable',
  'time_restricted', 'capability_unavailable', 'provider_unsupported', 'model_disabled',
]);
const AUTO_PRESET_AVAILABILITY = new Set([...AUTO_PRESET_ROUTE_AVAILABILITY, 'partial', 'unavailable']);
const AUTO_PRESET_BINDING_SOURCES = new Set(['preset', 'agents', 'legacy-secondary', 'caller', 'auto-fallback']);
const AUTO_PRESET_EVIDENCE_SCOPE = new Set(['profile', 'provider', 'none']);
const AUTO_PRESET_RESET_WINDOW_UNITS = new Set(['minute', 'hour', 'day', 'week']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isSafeInteger(value);
}

function isRate(value: unknown): value is number {
  return isNonNegativeNumber(value) && value <= 1;
}

function isPercent(value: unknown): value is number {
  return isNonNegativeNumber(value) && value <= 100;
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || isNonNegativeNumber(value);
}

function isOptionalPercent(value: unknown): boolean {
  return value === undefined || isPercent(value);
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0);
}

function isTimestamp(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= 8_640_000_000_000_000;
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || isTimestamp(value);
}

function isDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}

function isIsoTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return month! >= 1 && month! <= 12 && day! >= 1 && day! <= new Date(Date.UTC(year!, month!, 0)).getUTCDate();
}

function toAppPresetScoreDetails(value: Record<string, unknown>): Pick<AutoSubagentPresetCandidateScore, 'contributions' | 'localEvidence'> | undefined {
  const contributions = value['contributions'];
  const evidence = value['local_evidence'];
  if (!isRecord(contributions) || !isRecord(evidence)) return undefined;
  if (
    !isOptionalPercent(contributions['quota_remaining']) ||
    !isOptionalPercent(contributions['resource_score']) ||
    !isNonNegativeNumber(contributions['priority_bonus']) ||
    !isNonNegativeNumber(contributions['reset_bonus']) ||
    !isNonNegativeNumber(contributions['route_fit_bonus']) ||
    !isNonNegativeNumber(contributions['token_penalty']) ||
    !isNonNegativeNumber(contributions['reliability_penalty']) ||
    !isNonNegativeNumber(contributions['latency_penalty']) ||
    !isOptionalNonNegativeNumber(contributions['peak_penalty']) ||
    typeof evidence['scope'] !== 'string' ||
    !AUTO_PRESET_EVIDENCE_SCOPE.has(evidence['scope']) ||
    !isNonNegativeInteger(evidence['sample_count']) ||
    !isNonNegativeInteger(evidence['failure_count']) ||
    !isRate(evidence['adjusted_failure_rate']) ||
    !isNonNegativeInteger(evidence['token_count']) ||
    !isOptionalNonNegativeNumber(evidence['average_first_token_latency_ms']) ||
    !isNonNegativeInteger(evidence['first_token_latency_sample_count']) ||
    !isNonNegativeInteger(evidence['llm_request_count'])
  ) return undefined;
  const wire = value as unknown as WireAutoSubagentPresetCandidateScore;
  return {
    contributions: {
      quotaRemaining: wire.contributions.quota_remaining,
      resourceScore: wire.contributions.resource_score,
      priorityBonus: wire.contributions.priority_bonus,
      resetBonus: wire.contributions.reset_bonus,
      routeFitBonus: wire.contributions.route_fit_bonus,
      tokenPenalty: wire.contributions.token_penalty,
      reliabilityPenalty: wire.contributions.reliability_penalty,
      latencyPenalty: wire.contributions.latency_penalty,
      peakPenalty: wire.contributions.peak_penalty,
    },
    localEvidence: {
      scope: wire.local_evidence.scope,
      sampleCount: wire.local_evidence.sample_count,
      failureCount: wire.local_evidence.failure_count,
      adjustedFailureRate: wire.local_evidence.adjusted_failure_rate,
      tokenCount: wire.local_evidence.token_count,
      averageFirstTokenLatencyMs: wire.local_evidence.average_first_token_latency_ms,
      firstTokenLatencySampleCount: wire.local_evidence.first_token_latency_sample_count,
      llmRequestCount: wire.local_evidence.llm_request_count,
    },
  };
}

function toAppPresetMeteredPeriod(value: unknown): ProviderMeteredPeriod | undefined {
  if (!isRecord(value) || !isIsoTime(value['start_at']) || !isIsoTime(value['end_at']) ||
    !['request_count', 'measured_request_count', 'pending_request_count', 'missing_usage_request_count',
      'unpriced_request_count', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'total_tokens']
      .every((key) => isNonNegativeInteger(value[key])) ||
    !(value['estimated_cost'] === null || isDecimal(value['estimated_cost'])) ||
    typeof value['is_partial'] !== 'boolean') return undefined;
  return toAppProviderMeteredPeriod(value as unknown as WireProviderMeteredPeriod);
}

function toAppPresetMeteredUsage(value: unknown): LocalMeteredUsage | undefined {
  if (!isRecord(value) || value['source'] !== 'local' || value['cost_source'] !== 'estimated' ||
    value['currency'] !== 'CNY' || value['timezone'] !== 'Asia/Shanghai' ||
    !(value['tracking_started_at'] === null || isIsoTime(value['tracking_started_at'])) ||
    typeof value['degraded'] !== 'boolean') return undefined;
  const today = toAppPresetMeteredPeriod(value['today']);
  const month = toAppPresetMeteredPeriod(value['month']);
  if (today === undefined || month === undefined) return undefined;
  return {
    source: value['source'], costSource: value['cost_source'], currency: value['currency'],
    timezone: value['timezone'], trackingStartedAt: value['tracking_started_at'],
    degraded: value['degraded'], today, month,
  };
}

/** Strictly validated expiring-quota evidence. Present-but-invalid data must
 *  reject the whole snapshot instead of silently degrading to legacy fields. */
function toAppPresetResetPriority(value: unknown): AutoSubagentPresetResetPriority | undefined {
  if (!isRecord(value) || !isRecord(value['window'])) return undefined;
  const window = value['window'];
  if (!isFiniteNumber(window['duration']) || window['duration'] <= 0 ||
    typeof window['unit'] !== 'string' || !AUTO_PRESET_RESET_WINDOW_UNITS.has(window['unit']) ||
    !isTimestamp(value['reset_at']) || !isPercent(value['remaining_percent']) ||
    !isNonNegativeNumber(value['horizon_ms']) || !isNonNegativeNumber(value['bonus']) ||
    typeof value['floor_relaxed'] !== 'boolean') return undefined;
  const wire = value as unknown as WireAutoSubagentPresetResetPriority;
  return {
    window: { duration: wire.window.duration, unit: wire.window.unit },
    resetAt: wire.reset_at,
    remainingPercent: wire.remaining_percent,
    horizonMs: wire.horizon_ms,
    bonus: wire.bonus,
    floorRelaxed: wire.floor_relaxed,
  };
}

function toAppPresetResource(value: unknown): AutoSubagentPresetResourceEvidence | undefined {
  if (!isRecord(value) || !isOptionalTimestamp(value['blocked_until'])) return undefined;
  const blockedUntil = value['blocked_until'] as number | undefined;
  switch (value['kind']) {
    case 'subscription': {
      if (!isOptionalPercent(value['resource_score']) || !isOptionalPercent(value['quota_remaining_percent']) ||
        !isOptionalTimestamp(value['quota_reset_at'])) return undefined;
      const resetPriority = value['reset_priority'] === undefined
        ? undefined : toAppPresetResetPriority(value['reset_priority']);
      if (value['reset_priority'] !== undefined && resetPriority === undefined) return undefined;
      return {
        kind: 'subscription', blockedUntil,
        resourceScore: value['resource_score'] as number | undefined,
        quotaRemainingPercent: value['quota_remaining_percent'] as number | undefined,
        quotaResetAt: value['quota_reset_at'] as number | undefined,
        resetPriority,
      };
    }
    case 'metered': {
      if (value['currency'] !== 'CNY' ||
        !(value['balance_cny'] === undefined || isDecimal(value['balance_cny'])) ||
        !(value['is_available'] === undefined || typeof value['is_available'] === 'boolean') ||
        !['known', 'query_failed', 'invalid', 'missing'].includes(value['balance_status'] as string) ||
        !(value['resource_score'] === undefined || value['resource_score'] === 0 || value['resource_score'] === 100) ||
        value['resource_score_basis'] !== 'funded_account') return undefined;
      const meteredUsage = value['metered_usage'] === undefined ? undefined : toAppPresetMeteredUsage(value['metered_usage']);
      if (value['metered_usage'] !== undefined && meteredUsage === undefined) return undefined;
      const peak = value['peak_penalty'];
      if (peak !== undefined && (!isRecord(peak) || !isNonNegativeNumber(peak['points']) ||
        !isTimestamp(peak['until']))) return undefined;
      const peakPenalty = peak === undefined ? undefined : {
        points: (peak as Record<string, unknown>)['points'] as number,
        until: (peak as Record<string, unknown>)['until'] as number,
      };
      return {
        kind: 'metered', currency: 'CNY', blockedUntil, peakPenalty,
        balanceCny: value['balance_cny'] as string | undefined,
        isAvailable: value['is_available'] as boolean | undefined,
        balanceStatus: value['balance_status'] as 'known' | 'query_failed' | 'invalid' | 'missing',
        resourceScore: value['resource_score'] as 0 | 100 | undefined,
        resourceScoreBasis: 'funded_account', meteredUsage,
      };
    }
    case 'unknown':
      if (!['missing', 'query_failed', 'unsupported'].includes(value['reason'] as string)) return undefined;
      return { kind: 'unknown', reason: value['reason'] as 'missing' | 'query_failed' | 'unsupported', blockedUntil };
    default: return undefined;
  }
}

function toAppPresetRoute(value: unknown): AutoSubagentPresetRouteScore | undefined {
  if (!isRecord(value) || !['model', 'thinking', 'provider'].every((key) => isOptionalNonEmptyString(value[key])) ||
    !['source', 'model_source', 'thinking_source'].every((key) => value[key] === undefined ||
      (typeof value[key] === 'string' && AUTO_PRESET_BINDING_SOURCES.has(value[key]))) ||
    typeof value['availability'] !== 'string' || !AUTO_PRESET_ROUTE_AVAILABILITY.has(value['availability']) ||
    !isOptionalFiniteNumber(value['score']) || !isOptionalTimestamp(value['circuit_breaker_open_until'])) return undefined;
  const details = toAppPresetScoreDetails(value);
  const resource = toAppPresetResource(value['resource']);
  if (details === undefined || resource === undefined) return undefined;
  const wire = value as unknown as NonNullable<WireAutoSubagentPresetCandidateScore['role_scores']>[number]['original'];
  return {
    model: wire.model, thinking: wire.thinking, provider: wire.provider,
    source: wire.source, modelSource: wire.model_source, thinkingSource: wire.thinking_source,
    availability: wire.availability, score: wire.score,
    contributions: details.contributions, localEvidence: details.localEvidence, resource,
    circuitBreakerOpenUntil: wire.circuit_breaker_open_until,
  };
}

function toAppPresetRole(value: unknown): AutoSubagentPresetRoleScore | undefined {
  if (!isRecord(value) || typeof value['key'] !== 'string' || value['key'].length === 0 ||
    typeof value['route'] !== 'string' || !AUTO_PRESET_ROUTES.has(value['route']) ||
    !isOptionalNonEmptyString(value['profile_name']) || !isNonNegativeNumber(value['weight']) ||
    !isNonNegativeNumber(value['effective_score']) || !isNonNegativeNumber(value['fallback_penalty'])) return undefined;
  const original = toAppPresetRoute(value['original']);
  const effective = toAppPresetRoute(value['effective']);
  if (original === undefined || effective === undefined) return undefined;
  const fallback = value['fallback'];
  if (fallback !== undefined && (!isRecord(fallback) || !isOptionalNonEmptyString(fallback['source_preset']) ||
    typeof fallback['source_role'] !== 'string' || fallback['source_role'].length === 0 ||
    typeof fallback['reason'] !== 'string' || fallback['reason'] === 'healthy' ||
    !AUTO_PRESET_ROUTE_AVAILABILITY.has(fallback['reason']))) return undefined;
  const wire = value as unknown as NonNullable<WireAutoSubagentPresetCandidateScore['role_scores']>[number];
  return {
    key: wire.key, route: wire.route, profileName: wire.profile_name, weight: wire.weight,
    original, effective, effectiveScore: wire.effective_score, fallbackPenalty: wire.fallback_penalty,
    fallback: wire.fallback === undefined ? undefined : {
      sourcePreset: wire.fallback.source_preset, sourceRole: wire.fallback.source_role, reason: wire.fallback.reason,
    },
  };
}

function toAppAutoSubagentPresetCandidate(value: unknown): AutoSubagentPresetCandidateScore | undefined {
  if (!isRecord(value) || typeof value['preset'] !== 'string' || value['preset'].length === 0 ||
    !isOptionalNonEmptyString(value['provider']) || typeof value['availability'] !== 'string' ||
    !AUTO_PRESET_AVAILABILITY.has(value['availability']) || typeof value['selectable'] !== 'boolean' ||
    !isOptionalFiniteNumber(value['score']) || !isOptionalPercent(value['quota_remaining_percent']) ||
    !isOptionalTimestamp(value['quota_reset_at']) || !isOptionalTimestamp(value['circuit_breaker_open_until']) ||
    !(value['participating'] === undefined || typeof value['participating'] === 'boolean') ||
    !isOptionalFiniteNumber(value['native_score']) || !isOptionalNonNegativeNumber(value['total_role_weight']) ||
    !(value['deepseek_role_share'] === undefined || isRate(value['deepseek_role_share'])) ||
    !['role_count', 'native_available_role_count', 'fallback_role_count', 'unavailable_role_count']
      .every((key) => value[key] === undefined || isNonNegativeInteger(value[key]))) return undefined;
  const details = toAppPresetScoreDetails(value);
  if (details === undefined) return undefined;
  const coverage = value['coverage'];
  if (coverage !== undefined && (!isRecord(coverage) ||
    !['resource_provider_count', 'total_provider_count', 'local_evidence_role_count', 'total_role_count']
      .every((key) => isNonNegativeInteger(coverage[key])))) return undefined;
  if (value['role_scores'] !== undefined && !Array.isArray(value['role_scores'])) return undefined;
  const roleScores = (value['role_scores'] as unknown[] | undefined)?.map(toAppPresetRole);
  if (roleScores?.some((role) => role === undefined)) return undefined;
  const wire = value as unknown as WireAutoSubagentPresetCandidateScore;
  return {
    preset: wire.preset, provider: wire.provider, availability: wire.availability, selectable: wire.selectable,
    score: wire.score, quotaRemainingPercent: wire.quota_remaining_percent, quotaResetAt: wire.quota_reset_at,
    circuitBreakerOpenUntil: wire.circuit_breaker_open_until,
    contributions: details.contributions, localEvidence: details.localEvidence,
    participating: wire.participating, nativeScore: wire.native_score,
    roleScores: roleScores as AutoSubagentPresetRoleScore[] | undefined,
    roleCount: wire.role_count, nativeAvailableRoleCount: wire.native_available_role_count,
    fallbackRoleCount: wire.fallback_role_count, unavailableRoleCount: wire.unavailable_role_count,
    totalRoleWeight: wire.total_role_weight,
    deepseekRoleShare: wire.deepseek_role_share,
    coverage: wire.coverage === undefined ? undefined : {
      resourceProviderCount: wire.coverage.resource_provider_count, totalProviderCount: wire.coverage.total_provider_count,
      localEvidenceRoleCount: wire.coverage.local_evidence_role_count, totalRoleCount: wire.coverage.total_role_count,
    },
  };
}

/** Strict wire→app mapper shared by the status REST pull and evaluated events. */
export function toAppAutoSubagentPresetStatus(
  value: unknown,
): AutoSubagentPresetStatus | undefined {
  if (!isRecord(value)) return undefined;
  const policy = value['policy'];
  const candidates = value['candidates'];
  if (!isRecord(policy) || !Array.isArray(candidates)) return undefined;
  if (
    !(value['evaluation_scope'] === undefined || value['evaluation_scope'] === 'preset') ||
    !(policy['role_weights'] === undefined || (isRecord(policy['role_weights']) &&
      Object.values(policy['role_weights']).every(isNonNegativeNumber))) ||
    !(policy['deepseek_avoid_peak_hours'] === undefined || typeof policy['deepseek_avoid_peak_hours'] === 'boolean') ||
    !(policy['deepseek_peak_policy'] === undefined || ['block', 'penalize', 'off'].includes(policy['deepseek_peak_policy'] as string)) ||
    !isOptionalNonNegativeNumber(policy['deepseek_peak_penalty']) ||
    !isOptionalNonNegativeNumber(policy['fallback_penalty']) ||
    !isOptionalPercent(policy['metered_funded_resource_score']) ||
    !isOptionalNonNegativeNumber(policy['reset_priority_window_ms']) ||
    !isOptionalNonNegativeNumber(policy['reset_priority_exponent']) ||
    !isOptionalNonNegativeNumber(policy['reset_priority_max_bonus']) ||
    !isOptionalTimestamp(value['switch_cooldown_until']) ||
    !isTimestamp(value['evaluated_at']) ||
    typeof value['route'] !== 'string' ||
    !AUTO_PRESET_ROUTES.has(value['route']) ||
    !isOptionalNonEmptyString(value['profile_name']) ||
    typeof value['reason_code'] !== 'string' ||
    !AUTO_PRESET_REASON_CODES.has(value['reason_code'] as AutoSubagentPresetReasonCode) ||
    !isOptionalNonEmptyString(value['current_preset']) ||
    !isOptionalNonEmptyString(value['selected_preset']) ||
    !isOptionalNonEmptyString(value['activated_preset']) ||
    !isOptionalFiniteNumber(value['current_score']) ||
    !isOptionalFiniteNumber(value['selected_score']) ||
    !isPercent(policy['quota_floor_percent']) ||
    !isPercent(policy['switch_margin_percent']) ||
    !isNonNegativeNumber(policy['local_usage_window_ms']) ||
    !isPercent(policy['local_usage_weight_percent']) ||
    !isPercent(policy['priority_weight_percent']) ||
    !isPercent(policy['reliability_weight_percent']) ||
    !isPercent(policy['latency_weight_percent']) ||
    !isNonNegativeNumber(policy['switch_cooldown_ms']) ||
    !isNonNegativeInteger(policy['circuit_breaker_failure_threshold']) ||
    !isNonNegativeNumber(policy['circuit_breaker_cooldown_ms'])
  ) {
    return undefined;
  }
  const mappedCandidates = candidates.map(toAppAutoSubagentPresetCandidate);
  if (mappedCandidates.some((candidate) => candidate === undefined)) return undefined;
  const wire = value as unknown as WireAutoSubagentPresetStatus;
  return {
    evaluationScope: wire.evaluation_scope,
    evaluatedAt: wire.evaluated_at,
    route: wire.route,
    profileName: wire.profile_name,
    reasonCode: wire.reason_code,
    currentPreset: wire.current_preset,
    selectedPreset: wire.selected_preset,
    activatedPreset: wire.activated_preset,
    currentScore: wire.current_score,
    selectedScore: wire.selected_score,
    switchCooldownUntil: wire.switch_cooldown_until,
    candidates: mappedCandidates as AutoSubagentPresetCandidateScore[],
    policy: {
      roleWeights: wire.policy.role_weights === undefined ? undefined : { ...wire.policy.role_weights },
      deepseekAvoidPeakHours: wire.policy.deepseek_avoid_peak_hours,
      deepseekPeakPolicy: wire.policy.deepseek_peak_policy,
      deepseekPeakPenalty: wire.policy.deepseek_peak_penalty,
      fallbackPenalty: wire.policy.fallback_penalty,
      meteredFundedResourceScore: wire.policy.metered_funded_resource_score,
      resetPriorityWindowMs: wire.policy.reset_priority_window_ms,
      resetPriorityExponent: wire.policy.reset_priority_exponent,
      resetPriorityMaxBonus: wire.policy.reset_priority_max_bonus,
      quotaFloorPercent: wire.policy.quota_floor_percent,
      switchMarginPercent: wire.policy.switch_margin_percent,
      localUsageWindowMs: wire.policy.local_usage_window_ms,
      localUsageWeightPercent: wire.policy.local_usage_weight_percent,
      priorityWeightPercent: wire.policy.priority_weight_percent,
      reliabilityWeightPercent: wire.policy.reliability_weight_percent,
      latencyWeightPercent: wire.policy.latency_weight_percent,
      switchCooldownMs: wire.policy.switch_cooldown_ms,
      circuitBreakerFailureThreshold: wire.policy.circuit_breaker_failure_threshold,
      circuitBreakerCooldownMs: wire.policy.circuit_breaker_cooldown_ms,
    },
  };
}

/**
 * Map a WireEvent to an AppEvent.
 *
 * Decision: reducer consumes AppEvent.
 * - Visible events are fully mapped to their camelCase AppEvent variant.
 * - No-op-but-known streaming/tool events (tool.*, assistant.tool_use_*,
 *   assistant.completed) are folded to { type: 'unknown', raw } so the reducer
 *   can advance lastSeqBySession without emitting warnings.
 *   We use a dedicated sentinel raw: { _noop: true } so Task 7 reducer can
 *   distinguish real unknowns (push warning) from no-op knowns (silent advance).
 * - Truly unknown events are also { type: 'unknown', raw } but raw._noop is absent.
 */
export function toAppEvent(wire: WireEvent): AppEvent {
  // TypeScript cannot narrow the WireEvent union through specific `case` arms
  // because the catch-all `WireEventUnknown` member has `type: string` (broad)
  // and `payload: unknown`, which prevents discriminated-union narrowing.
  // We cast to `any` once here; individual cases are still logically type-safe
  // because the union member types document the actual payload shapes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = wire as any;
  switch ((wire as { type: string }).type) {
    // ----- Session lifecycle -----
    case 'event.session.created':
      return { type: 'sessionCreated', session: toAppSession(w.payload.session) };

    case 'event.session.updated':
      return {
        type: 'sessionUpdated',
        session: toAppSession(w.payload.session),
        changedFields: w.payload.changed_fields,
      };

    case 'event.session.deleted':
      return { type: 'sessionDeleted', sessionId: w.session_id };

    // ----- Workspace lifecycle -----
    case 'event.workspace.created':
      return { type: 'workspaceCreated', workspace: toAppWorkspace(w.payload.workspace) };

    case 'event.workspace.updated':
      return { type: 'workspaceUpdated', workspace: toAppWorkspace(w.payload.workspace) };

    case 'event.workspace.deleted':
      return {
        type: 'workspaceDeleted',
        workspaceId: w.payload.workspace_id,
        root: w.payload.root,
      };

    case 'event.session.work_changed':
      return {
        type: 'sessionWorkChanged',
        sessionId: w.session_id,
        busy: w.payload.busy,
        mainTurnActive: w.payload.main_turn_active,
        pendingInteraction: w.payload.pending_interaction,
        lastTurnReason: w.payload.last_turn_reason,
      };

    // Deprecated: old journals may still carry status_changed; fold it onto
    // the busy flag (awaiting/running were live work, aborted was not).
    case 'event.session.status_changed':
      return {
        type: 'sessionWorkChanged',
        sessionId: w.session_id,
        busy: w.payload.status !== 'idle' && w.payload.status !== 'aborted',
        mainTurnActive: w.payload.status !== 'idle' && w.payload.status !== 'aborted',
        pendingInteraction:
          w.payload.status === 'awaiting_approval'
            ? 'approval'
            : w.payload.status === 'awaiting_question'
              ? 'question'
              : 'none',
        lastTurnReason: w.payload.status === 'aborted' ? 'cancelled' : undefined,
      };

    case 'event.session.usage_updated':
      return {
        type: 'sessionUsageUpdated',
        sessionId: w.session_id,
        usage: toAppSessionUsage(w.payload.usage),
      };

    case 'event.session.history_compacted':
      return {
        type: 'historyCompacted',
        sessionId: w.session_id,
        beforeSeq: w.payload.before_seq,
        reason: w.payload.reason,
        summaryMessageId: w.payload.summary_message_id,
      };

    case 'event.goal.updated': {
      const goal = toAppGoal(w.payload.snapshot ?? null);
      return {
        type: 'goalUpdated',
        sessionId: w.session_id,
        goal: goal?.status === 'complete' ? null : goal,
      };
    }

    case 'event.research_mode.updated':
      return {
        type: 'researchUpdated',
        sessionId: w.session_id,
        snapshot: toAppResearchModeSnapshot(w.payload.snapshot),
      };

    case 'event.subagent.preset_evaluated': {
      const status = toAppAutoSubagentPresetStatus(w.payload);
      if (status === undefined) {
        return { type: 'unknown', raw: { _noop: true, _wireType: w.type } };
      }
      return {
        type: 'subagentPresetEvaluated',
        sessionId: w.session_id,
        status,
      };
    }

    case 'event.subagent.preset_changed': {
      const payload = isRecord(w.payload) ? w.payload : {};
      const rawCurrentPreset = payload['current_preset'];
      const rawPreviousPreset = payload['previous_preset'];
      const reasonCode = payload['reason_code'];
      const evaluatedAt = payload['evaluated_at'];
      const profileName = payload['profile_name'];
      const previousScore = payload['previous_score'];
      const currentScore = payload['current_score'];
      const hasExpandedFields =
        reasonCode !== undefined ||
        evaluatedAt !== undefined ||
        profileName !== undefined ||
        previousScore !== undefined ||
        currentScore !== undefined;
      if (
        typeof rawCurrentPreset !== 'string' ||
        rawCurrentPreset.trim().length === 0 ||
        (rawPreviousPreset !== undefined &&
          (typeof rawPreviousPreset !== 'string' || rawPreviousPreset.trim().length === 0)) ||
        (hasExpandedFields &&
          (typeof reasonCode !== 'string' ||
            !AUTO_PRESET_REASON_CODES.has(reasonCode as AutoSubagentPresetReasonCode) ||
            !isNonNegativeNumber(evaluatedAt) ||
            !isOptionalNonEmptyString(profileName) ||
            !isOptionalFiniteNumber(previousScore) ||
            !isOptionalFiniteNumber(currentScore)))
      ) {
        return { type: 'unknown', raw: { _noop: true, _wireType: w.type } };
      }
      return {
        type: 'subagentPresetChanged',
        sessionId: w.session_id,
        previousPreset: typeof rawPreviousPreset === 'string' ? rawPreviousPreset.trim() : undefined,
        currentPreset: rawCurrentPreset.trim(),
        reasonCode: hasExpandedFields ? reasonCode as AutoSubagentPresetReasonCode : undefined,
        profileName: typeof profileName === 'string' ? profileName : undefined,
        evaluatedAt: typeof evaluatedAt === 'number' ? evaluatedAt : undefined,
        previousScore: typeof previousScore === 'number' ? previousScore : undefined,
        currentScore: typeof currentScore === 'number' ? currentScore : undefined,
      };
    }

    // ----- Message lifecycle -----
    case 'event.message.created':
      return { type: 'messageCreated', message: toAppMessage(w.payload.message) };

    case 'event.message.updated':
      return {
        type: 'messageUpdated',
        sessionId: w.session_id,
        messageId: w.payload.message_id,
        content: w.payload.content.map(toAppMessageContent),
        status: w.payload.status,
      };

    // ----- Assistant streaming -----
    case 'event.assistant.delta':
      return {
        type: 'assistantDelta',
        sessionId: w.session_id,
        messageId: w.payload.message_id,
        contentIndex: w.payload.content_index,
        delta: w.payload.delta,
      };

    // No-op streaming events — advance seq silently
    case 'event.assistant.tool_use_started':
    case 'event.assistant.tool_use_delta':
    case 'event.assistant.tool_use_completed':
    case 'event.assistant.completed':
    case 'event.tool.started':
      return { type: 'unknown', raw: { _noop: true, _wireType: w.type } };

    case 'event.tool.output':
      return {
        type: 'toolOutput',
        sessionId: w.session_id,
        toolCallId: w.payload.tool_call_id,
        outputChunk: w.payload.chunk,
        stream: w.payload.stream,
      };

    case 'event.tool.progress':
      if (typeof w.payload.message === 'string' && w.payload.message.length > 0) {
        return {
          type: 'toolOutput',
          sessionId: w.session_id,
          toolCallId: w.payload.tool_call_id,
          outputChunk: w.payload.message,
          stream: 'stdout',
        };
      }
      return { type: 'unknown', raw: { _noop: true, _wireType: w.type } };

    case 'event.tool.completed':
      return { type: 'unknown', raw: { _noop: true, _wireType: w.type } };

    // ----- Approval -----
    case 'event.approval.requested':
      return {
        type: 'approvalRequested',
        sessionId: w.session_id,
        approval: toAppApprovalRequest(w.payload),
      };

    case 'event.approval.resolved':
      return {
        type: 'approvalResolved',
        sessionId: w.session_id,
        approvalId: w.payload.approval_id,
        decision: w.payload.decision,
        resolvedAt: w.payload.resolved_at,
      };

    case 'event.approval.expired':
      return {
        type: 'approvalExpired',
        sessionId: w.session_id,
        approvalId: w.payload.approval_id,
      };

    // ----- Question -----
    case 'event.question.requested':
      return {
        type: 'questionRequested',
        sessionId: w.session_id,
        question: toAppQuestionRequest(w.payload),
      };

    case 'event.question.answered':
      return {
        type: 'questionAnswered',
        sessionId: w.session_id,
        questionId: w.payload.question_id,
        resolvedAt: w.payload.resolved_at,
      };

    case 'event.question.dismissed':
      return {
        type: 'questionDismissed',
        sessionId: w.session_id,
        questionId: w.payload.question_id,
        dismissedAt: w.payload.dismissed_at,
      };

    // ----- Tasks -----
    case 'event.task.created':
      return {
        type: 'taskCreated',
        sessionId: w.session_id,
        task: toAppTask(w.payload.task),
      };

    case 'event.task.progress':
      return {
        type: 'taskProgress',
        sessionId: w.session_id,
        taskId: w.payload.task_id,
        outputChunk: w.payload.output_chunk,
        stream: w.payload.stream,
      };

    case 'event.task.completed':
      return {
        type: 'taskCompleted',
        sessionId: w.session_id,
        taskId: w.payload.task_id,
        status: w.payload.status as AppTaskStatus,
        outputPreview: w.payload.output_preview,
        outputBytes: w.payload.output_bytes,
      };

    case 'event.config.changed':
      return {
        type: 'configChanged',
        changedFields: w.payload.changedFields ?? w.payload.changed_fields ?? [],
        config: toAppConfig(w.payload.config),
      };

    case 'event.model_catalog.changed':
      return {
        type: 'modelCatalogChanged',
        changed: w.payload.changed.map(
          (item: { provider_id: string; provider_name: string; added: number; removed: number }) => ({
            providerId: item.provider_id,
            providerName: item.provider_name,
            added: item.added,
            removed: item.removed,
          }),
        ),
        unchanged: w.payload.unchanged,
        failed: w.payload.failed,
      };

    default: {
      // Truly unknown event — record warning
      return { type: 'unknown', raw: wire };
    }
  }
}

// ---------------------------------------------------------------------------
// Model + Provider mappers
// PRESUMED — not in current daemon docs; isolated here, swap when backend defines them.
// ---------------------------------------------------------------------------

export function toAppModel(wire: WireModel): AppModel {
  return {
    id: wire.model,
    provider: wire.provider,
    model: wire.model,
    displayName: wire.display_name,
    maxContextSize: wire.max_context_size,
    capabilities: wire.capabilities,
    supportEfforts: wire.support_efforts,
    defaultEffort: wire.default_effort,
  };
}

export function toAppProvider(wire: WireProvider): AppProvider {
  return {
    id: wire.id,
    type: wire.type,
    baseUrl: wire.base_url,
    defaultModel: wire.default_model,
    hasApiKey: wire.has_api_key,
    status: wire.status,
    models: wire.models,
  };
}

type WireUsageRow = Extract<WireProviderUsageItem, { kind: 'ok' }>['limits'][number];
type AppUsageRow = Extract<ProviderUsageResult, { kind: 'ok' }>['limits'][number];

function toAppProviderUsageRow(wire: WireUsageRow): AppUsageRow {
  return {
    name: wire.name,
    window: wire.window,
    used: wire.used,
    limit: wire.limit,
    resetAt: wire.reset_at,
  };
}

function toAppProviderMeteredBalance(wire: WireProviderMeteredBalance): ProviderMeteredBalance {
  return {
    currency: wire.currency,
    total: wire.total,
    granted: wire.granted,
    toppedUp: wire.topped_up,
  };
}

function toAppProviderMeteredBalanceResult(
  wire: WireProviderMeteredBalanceResult,
): ProviderMeteredBalanceResult {
  if (wire.kind === 'ok') {
    return {
      kind: 'ok',
      isAvailable: wire.is_available,
      balances: wire.balances.map(toAppProviderMeteredBalance),
    };
  }
  return { kind: 'error', message: wire.message, status: wire.status };
}

function toAppProviderMeteredPeriod(wire: WireProviderMeteredPeriod): ProviderMeteredPeriod {
  return {
    startAt: wire.start_at,
    endAt: wire.end_at,
    requestCount: wire.request_count,
    measuredRequestCount: wire.measured_request_count,
    pendingRequestCount: wire.pending_request_count,
    missingUsageRequestCount: wire.missing_usage_request_count,
    unpricedRequestCount: wire.unpriced_request_count,
    inputTokens: wire.input_tokens,
    outputTokens: wire.output_tokens,
    cacheReadTokens: wire.cache_read_tokens,
    totalTokens: wire.total_tokens,
    estimatedCost: wire.estimated_cost,
    isPartial: wire.is_partial,
  };
}

function toAppProviderMeteredUsage(wire: WireProviderMeteredUsage): ProviderMeteredUsage {
  return {
    source: wire.source,
    costSource: wire.cost_source,
    currency: wire.currency,
    timezone: wire.timezone,
    trackingStartedAt: wire.tracking_started_at,
    degraded: wire.degraded,
    today: toAppProviderMeteredPeriod(wire.today),
    month: toAppProviderMeteredPeriod(wire.month),
    balance: toAppProviderMeteredBalanceResult(wire.balance),
  };
}

export function toAppProviderUsageResult(wire: WireProviderUsageItem): ProviderUsageResult {
  if (wire.kind !== 'ok') {
    return {
      provider: wire.provider,
      kind: wire.kind,
      message: wire.message,
      status: wire.status,
    };
  }
  return {
    provider: wire.provider,
    kind: 'ok',
    summary: wire.summary === null ? null : toAppProviderUsageRow(wire.summary),
    limits: wire.limits.map(toAppProviderUsageRow),
    extraUsage:
      wire.extra_usage === null
        ? null
        : {
            balanceCents: wire.extra_usage.balance_cents,
            totalCents: wire.extra_usage.total_cents,
            monthlyChargeLimitEnabled: wire.extra_usage.monthly_charge_limit_enabled,
            monthlyChargeLimitCents: wire.extra_usage.monthly_charge_limit_cents,
            monthlyUsedCents: wire.extra_usage.monthly_used_cents,
            currency: wire.extra_usage.currency,
          },
    meteredUsage: wire.metered_usage === undefined ? undefined : toAppProviderMeteredUsage(wire.metered_usage),
  };
}

export function toAppConfig(wire: WireConfig): AppConfig {
  const providers: Record<string, { type: string; baseUrl?: string; defaultModel?: string; hasApiKey: boolean }> = {};
  for (const [id, provider] of Object.entries(wire.providers)) {
    providers[id] = {
      type: provider.type,
      baseUrl: provider.base_url,
      defaultModel: provider.default_model,
      hasApiKey: provider.has_api_key,
    };
  }
  return {
    providers,
    defaultProvider: wire.default_provider,
    defaultModel: wire.default_model,
    models: wire.models,
    thinking: wire.thinking as { enabled?: boolean; effort?: string } | undefined,
    planMode: wire.plan_mode,
    yolo: wire.yolo,
    defaultPermissionMode: wire.default_permission_mode,
    defaultPlanMode: wire.default_plan_mode,
    permission: wire.permission,
    hooks: wire.hooks,
    services: wire.services,
    mergeAllAvailableSkills: wire.merge_all_available_skills,
    extraSkillDirs: wire.extra_skill_dirs,
    loopControl: wire.loop_control,
    background: wire.background,
    subagent: wire.subagent,
    secondaryModel: wire.secondary_model,
    experimental: wire.experimental,
    telemetry: wire.telemetry,
    raw: wire.raw,
  };
}

// Helper to extract sessionId from a WireEvent (needed by reducer for lastSeq update)
export function wireEventSessionId(wire: WireEvent): string {
  return wire.session_id;
}

export function wireEventSeq(wire: WireEvent): number {
  return wire.seq;
}
