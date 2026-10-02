import { readFileSync } from 'node:fs';
import { computed, nextTick, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

import type {
  AppConfig,
  AutoSubagentPresetCandidateScore,
  AutoSubagentPresetStatus,
} from '../src/api/types';
import { useModelProviderState } from '../src/composables/client/useModelProviderState';
import type { ExtendedState } from '../src/composables/useKimiWebClient';
import { i18n } from '../src/i18n';
import {
  autoSubagentPresetEnabled,
  autoSubagentPresetFlagOverridden,
  autoSubagentPresetPatch,
  autoSubagentPresetSupported,
  formatSubagentPresetScore,
  mainRouteForPreset,
  subagentPresetCandidateBreakdown,
  subagentPresetCandidateSummary,
  subagentPresetCandidatesOrder,
  subagentPresetCandidatesPatch,
  subagentPresetCurrentEvaluation,
  subagentPresetLabel,
  subagentPresetChangedLabel,
  subagentPresetManualLock,
  subagentPresetReasonLabel,
  subagentPresetRemainingLabel,
  autoSubagentPresetActionLabel,
  autoSubagentPresetUnavailableReason,
  autoSubagentPresetResultLabel,
  subagentPresetAvailabilityLabel,
  subagentPresetDisplayRows,
  subagentPresetMenuRows,
  subagentPresetConfiguredLabel,
  subagentPresetParticipationLabel,
  subagentPresetCandidateState,
  subagentPresetEvaluationScopeLabel,
  subagentPresetTotals,
  subagentPresetRoleCounts,
  subagentPresetCoverageLabel,
  subagentPresetResourceLabel,
  subagentPresetPeakPolicyLabel,
  subagentPresetPeakSummary,
  subagentPresetRolePeakLabel,
  subagentPresetResetFloorRelaxedLabel,
  subagentPresetResetPriorityLabel,
  subagentPresetMeteredProviders,
  subagentPresetRoleContribution,
  subagentPresetBindingLabel,
  subagentPresetBindingSourceLabel,
  formatPresetCny,
} from '../src/lib/subagentPreset';
import type { AutoSubagentPresetRoleScore, AutoSubagentPresetRouteScore, AutoSubagentPresetCandidateAvailability } from '../src/api/types';
import enHeader from '../src/i18n/locales/en/header';
import zhHeader from '../src/i18n/locales/zh/header';
import enSettings from '../src/i18n/locales/en/settings';
import zhSettings from '../src/i18n/locales/zh/settings';

const apiMock = vi.hoisted(() => ({ listModels: vi.fn(), setConfig: vi.fn() }));

vi.mock('../src/api', () => ({
  getKimiWebApi: () => apiMock,
}));

const config: AppConfig = {
  providers: {},
  subagent: {
    preset: 'fast',
    agents: { coder: { model: 'base/coder' } },
    presets: {
      fast: { coder: { model: 'fast/coder' } },
      deep: {
        main: { model: 'acme/main', thinkingEffort: 'high' },
        coder: { model: 'acme/coder', thinkingEffort: 'high' },
      },
    },
  },
};

describe('Web subagent preset routes', () => {
  it('exposes the actual selected main route for the summary and runtime application', () => {
    expect(mainRouteForPreset(config, 'deep')).toEqual({
      model: 'acme/main',
      thinkingEffort: 'high',
    });
    expect(mainRouteForPreset(config, '')).toBeUndefined();
  });
});

describe('permanent automatic preset entry points', () => {
  const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

  it('keeps desktop, mobile and settings actions visible with disabled explanations and loading', () => {
    for (const [path, handler] of [
      ['components/chat/ChatHeader.vue', 'resumeAutoPreset'],
      ['components/mobile/MobileSettingsSheet.vue', 'onResumeAutoPreset'],
      ['components/settings/SettingsDialog.vue', 'resumeAutoPreset'],
    ]) {
      const component = source(path!);
      const action = component.match(new RegExp(`<(?:Button|MenuItem)[^>]*@click="${handler}"[^>]*>`))?.[0];
      expect(action).toBeDefined();
      expect(action).not.toContain('v-if');
      expect(action).toContain('disabledReason');
      expect(component).toContain('autoPresetControl?.pending');
      expect(component).toContain('autoPresetControl?.feedback');
      expect(component).toContain("t('header.subagentPresetAutomatic')");
      expect(component).not.toContain('subagentPresetResumeAutoPatch');
    }
    const settings = source('components/settings/SettingsDialog.vue');
    expect(settings.indexOf('@click="resumeAutoPreset"')).toBeLessThan(settings.indexOf('<template v-if="config">'));
    expect(settings).toContain("emit('resumeAutoPreset')");
  });

  it('routes all entry points to one guarded action with a captured optional session', () => {
    const app = source('App.vue');
    expect(app.match(/@resume-auto-preset="handleResumeAutoPreset"/g)).toHaveLength(3);
    expect(app).toContain('t, client.autoPresetAction.supported');
    expect(app).toContain("client.autoPresetAction.metaStatus === 'error'");
    expect(app).toContain("t('header.subagentPresetAutoMetaRetry')");
    const handler = app.slice(app.indexOf('async function handleResumeAutoPreset'), app.indexOf('// LoginDialog callbacks'));
    expect(handler).toContain('if (configSaving.value || autoPresetControl.value.disabledReason) return;');
    expect(handler).toContain('const targetSessionId = client.activeSessionId.value;');
    expect(handler).toContain('await client.autoSelectSubagentPreset(targetSessionId);');
    expect(handler).not.toContain('updateConfig');
    expect(handler).not.toContain('applyPresetMainRoute');
  });
});

describe('automatic preset setting', () => {
  const enabledConfig: AppConfig = {
    ...config,
    experimental: { auto_subagent_preset: false },
    subagent: { ...config.subagent, autoPreset: { enabled: true } },
  };

  it('reports the runtime as enabled only when both effective gates are on', () => {
    expect(autoSubagentPresetEnabled(enabledConfig, { auto_subagent_preset: true })).toBe(true);
    expect(autoSubagentPresetEnabled(enabledConfig, { auto_subagent_preset: false })).toBe(false);
    expect(
      autoSubagentPresetEnabled(
        { ...enabledConfig, subagent: { ...enabledConfig.subagent, autoPreset: { enabled: false } } },
        { auto_subagent_preset: true },
      ),
    ).toBe(false);
  });

  it('detects support from the effective flag catalog, even when the flag is off', () => {
    expect(autoSubagentPresetSupported({ auto_subagent_preset: false })).toBe(true);
    expect(autoSubagentPresetSupported({ auto_subagent_preset: true })).toBe(true);
    expect(autoSubagentPresetSupported({})).toBe(false);
  });

  it('uses effective meta flags and reports environment overrides in either direction', () => {
    expect(enabledConfig.experimental?.['auto_subagent_preset']).toBe(false);
    expect(autoSubagentPresetEnabled(enabledConfig, { auto_subagent_preset: true })).toBe(true);
    expect(
      autoSubagentPresetFlagOverridden(enabledConfig, { auto_subagent_preset: true }),
    ).toBe(true);
    expect(
      autoSubagentPresetFlagOverridden(
        { ...enabledConfig, experimental: { auto_subagent_preset: true } },
        { auto_subagent_preset: false },
      ),
    ).toBe(true);
    expect(autoSubagentPresetFlagOverridden(enabledConfig, {})).toBe(false);
  });

  it('patches only the two gates and puts the fail-closed domain first', () => {
    const enabled = autoSubagentPresetPatch(true);
    expect(Object.keys(enabled)).toEqual(['subagent', 'experimental']);
    expect(enabled).toEqual({
      subagent: { autoPreset: { enabled: true } },
      experimental: { auto_subagent_preset: true },
    });
    expect(autoSubagentPresetPatch(false)).toEqual({
      subagent: { autoPreset: { enabled: false } },
      experimental: { auto_subagent_preset: false },
    });
  });
});

describe('manual lock and resume-auto', () => {
  it('reports the persistent manual lock from autoPreset.manualLock', () => {
    const locked = { ...config, subagent: { ...config.subagent, autoPreset: { manualLock: true } } };
    expect(subagentPresetManualLock(locked)).toBe(true);
    expect(subagentPresetManualLock(config)).toBe(false);
    expect(subagentPresetManualLock({ ...config, subagent: undefined })).toBe(false);
    expect(subagentPresetManualLock(null)).toBe(false);
    expect(subagentPresetManualLock(undefined)).toBe(false);
  });

  it('keeps automatic selection actionable in manual, automatic, and disabled modes', () => {
    const t = (key: string) => key;
    expect(autoSubagentPresetActionLabel(false, false, t)).toBe('header.subagentPresetAutoSelect');
    expect(autoSubagentPresetActionLabel(false, true, t)).toBe('header.subagentPresetResumeAuto');
    expect(autoSubagentPresetActionLabel(true, false, t)).toBe('header.subagentPresetAutoAgain');
    expect(autoSubagentPresetUnavailableReason(null, {}, t)).toBe('header.subagentPresetConfigUnavailable');
    expect(autoSubagentPresetUnavailableReason(config, {}, t)).toBeUndefined();
    expect(autoSubagentPresetUnavailableReason(config, {}, t, true)).toBeUndefined();
    expect(autoSubagentPresetUnavailableReason(config, {}, t, false)).toBe('header.subagentPresetAutoUnsupported');
    expect(autoSubagentPresetUnavailableReason(config, { auto_subagent_preset: false }, t)).toBeUndefined();
    expect(autoSubagentPresetUnavailableReason(
      { ...config, experimental: { auto_subagent_preset: true } },
      { auto_subagent_preset: false }, t,
    )).toBe('header.subagentPresetAutoEnvDisabled');
  });
});

describe('automatic-preset candidate priority', () => {
  it('falls back to declaration order only when candidates is absent', () => {
    expect(subagentPresetCandidatesOrder(config, ['fast', 'deep', 'balanced'])).toEqual([
      'fast',
      'deep',
      'balanced',
    ]);
    expect(
      subagentPresetCandidatesOrder(
        { ...config, subagent: { ...config.subagent, autoPreset: { candidates: [] } } },
        ['fast', 'deep'],
      ),
    ).toEqual([]);
    expect(subagentPresetCandidatesOrder(null, ['fast'])).toEqual(['fast']);
  });

  it('treats a configured subset as authoritative and never appends missing presets', () => {
    const ordered: AppConfig = {
      ...config,
      subagent: {
        ...config.subagent,
        autoPreset: { candidates: ['balanced'] },
      },
    };
    expect(subagentPresetCandidatesOrder(ordered, ['fast', 'deep', 'balanced'])).toEqual([
      'balanced',
    ]);
    expect(subagentPresetCandidatesOrder(ordered, ['fast', 'deep'])).toEqual(['balanced']);
  });

  it('keeps the configured order as-is, including names no longer declared', () => {
    const stale: AppConfig = {
      ...config,
      subagent: {
        ...config.subagent,
        autoPreset: { candidates: ['deep', 'retired', 'fast'] },
      },
    };
    expect(subagentPresetCandidatesOrder(stale, ['fast', 'deep'])).toEqual([
      'deep',
      'retired',
      'fast',
    ]);
  });

  it('returns a copy so callers may reorder without mutating the config', () => {
    const withCandidates: AppConfig = {
      ...config,
      subagent: { ...config.subagent, autoPreset: { candidates: ['fast', 'deep'] } },
    };
    const order = subagentPresetCandidatesOrder(withCandidates, ['deep', 'fast']);
    order.reverse();
    expect(withCandidates.subagent?.autoPreset?.candidates).toEqual(['fast', 'deep']);
  });

  it('persists a priority list targeting only the candidates field', () => {
    expect(subagentPresetCandidatesPatch(['deep', 'fast'])).toEqual({
      subagent: { autoPreset: { candidates: ['deep', 'fast'] } },
    });
  });
});

describe('preset main runtime application', () => {
  function createHarness(persistSessionProfile = vi.fn().mockResolvedValue(true)) {
    const state = {
      activeSessionId: 'sess_a',
      sessions: [
        { id: 'sess_a', model: 'old/a' },
        { id: 'sess_b', model: 'old/b' },
      ],
      defaultModel: 'old/a',
      thinking: 'high',
      thinkingBySession: { sess_a: 'high', sess_b: 'low' },
    } as unknown as ExtendedState;
    const updateSession = vi.fn(
      (
        id: string,
        update: (session: ExtendedState['sessions'][number]) => ExtendedState['sessions'][number],
      ) => {
        state.sessions = state.sessions.map((session) =>
          session.id === id ? update(session) : session,
        );
      },
    );
    const modelProvider = useModelProviderState(state, {
      pushOperationFailure: vi.fn(),
      refreshSessionStatus: vi.fn().mockResolvedValue(undefined),
      persistSessionProfile,
      activity: computed(() => 'idle'),
      updateSession,
      updateSessionMessages: vi.fn(),
    });
    return { state, modelProvider, persistSessionProfile };
  }

  it('updates one session profile without rewriting the exact global config patch', async () => {
    apiMock.setConfig.mockReset();
    const { state, modelProvider, persistSessionProfile } = createHarness();

    const applied = await modelProvider.applyPresetMainRoute({
      model: 'new/model',
      thinkingEffort: 'max',
    }, 'sess_a');

    expect(applied).toBe(true);
    expect(persistSessionProfile).toHaveBeenCalledWith(
      { model: 'new/model', thinking: 'max' },
      'sess_a',
    );
    expect(state.sessions[0]?.model).toBe('new/model');
    expect(state.thinking).toBe('max');
    expect(state.thinkingBySession).toEqual({ sess_a: 'max', sess_b: 'low' });
    expect(apiMock.setConfig).not.toHaveBeenCalled();
  });

  it('keeps preset thinking through a draft model catalog refresh', async () => {
    const { state, modelProvider, persistSessionProfile } = createHarness();
    state.activeSessionId = undefined;
    state.thinking = 'low';
    apiMock.listModels.mockResolvedValue([
      {
        id: 'new/draft',
        provider: 'acme',
        model: 'new/draft',
        maxContextSize: 128_000,
        capabilities: ['thinking'],
        supportEfforts: ['low', 'max'],
        defaultEffort: 'low',
      },
    ]);

    const applied = await modelProvider.applyPresetMainRoute({
      model: 'new/draft',
      thinkingEffort: 'max',
    });
    await modelProvider.loadModels();
    await nextTick();

    expect(applied).toBe(true);
    expect(modelProvider.draftModel.value).toBe('new/draft');
    expect(state.thinking).toBe('max');
    expect(persistSessionProfile).not.toHaveBeenCalled();
  });

  it('applies to the session captured before a slow global save', async () => {
    const { state, modelProvider, persistSessionProfile } = createHarness();
    state.activeSessionId = 'sess_b';
    state.thinking = 'low';

    await modelProvider.applyPresetMainRoute(
      { model: 'new/a', thinkingEffort: 'max' },
      'sess_a',
    );

    expect(persistSessionProfile).toHaveBeenCalledWith(
      { model: 'new/a', thinking: 'max' },
      'sess_a',
    );
    expect(state.sessions.map((session) => session.model)).toEqual(['new/a', 'old/b']);
    expect(state.thinkingBySession).toEqual({ sess_a: 'max', sess_b: 'low' });
    expect(state.thinking).toBe('low');
  });

  it('does not restore one session thinking into another after a failed request', async () => {
    let resolvePersist: ((value: boolean) => void) | undefined;
    const persist = vi.fn().mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolvePersist = resolve;
      }),
    );
    const { state, modelProvider } = createHarness(persist);

    const applying = modelProvider.applyPresetMainRoute(
      { model: 'new/a', thinkingEffort: 'max' },
      'sess_a',
    );
    state.activeSessionId = 'sess_b';
    state.thinking = 'low';
    resolvePersist?.(false);

    expect(await applying).toBe(false);
    expect(state.sessions.map((session) => session.model)).toEqual(['old/a', 'old/b']);
    expect(state.thinkingBySession).toEqual({ sess_a: 'high', sess_b: 'low' });
    expect(state.thinking).toBe('low');
  });

  it('does not let an older failed activation roll back a newer one', async () => {
    let resolveFirst: ((value: boolean) => void) | undefined;
    let resolveSecond: ((value: boolean) => void) | undefined;
    const persist = vi.fn()
      .mockImplementationOnce(
        () => new Promise<boolean>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockImplementationOnce(
        () => new Promise<boolean>((resolve) => {
          resolveSecond = resolve;
        }),
      );
    const { state, modelProvider } = createHarness(persist);

    const first = modelProvider.applyPresetMainRoute(
      { model: 'first/a', thinkingEffort: 'max' },
      'sess_a',
    );
    const second = modelProvider.applyPresetMainRoute(
      { model: 'second/a', thinkingEffort: 'low' },
      'sess_a',
    );
    resolveFirst?.(false);
    expect(await first).toBe(false);
    expect(state.sessions[0]?.model).toBe('second/a');
    expect(state.thinkingBySession['sess_a']).toBe('low');

    resolveSecond?.(true);
    expect(await second).toBe(true);
  });
});

describe('subagent-preset controls and status separators', () => {
  // Real i18n singleton — resolve labels against both shipped locales.
  const t = (key: string, named?: Record<string, unknown>): string =>
    String(i18n.global.t(key, named));

  function withLocale(locale: 'en' | 'zh', run: () => void): void {
    const prev = i18n.global.locale.value;
    i18n.global.locale.value = locale;
    try {
      run();
    } finally {
      i18n.global.locale.value = prev;
    }
  }

  const candidate: AutoSubagentPresetCandidateScore = {
    preset: 'balanced',
    provider: 'provider-a',
    availability: 'healthy',
    selectable: true,
    score: 76.25,
    quotaRemainingPercent: 80,
    contributions: {
      quotaRemaining: 80,
      priorityBonus: 8,
      resetBonus: 1,
      routeFitBonus: 2,
      tokenPenalty: 3,
      reliabilityPenalty: 7.5,
      latencyPenalty: 4.25,
    },
    localEvidence: {
      scope: 'profile',
      sampleCount: 8,
      failureCount: 1,
      adjustedFailureRate: 0.15,
      tokenCount: 42_000,
      averageFirstTokenLatencyMs: 320,
      firstTokenLatencySampleCount: 9,
      llmRequestCount: 12,
    },
  };

  const switchedStatus: AutoSubagentPresetStatus = {
    evaluatedAt: 1_750_000_000_000,
    route: 'agent',
    reasonCode: 'higher_score',
    currentPreset: 'balanced',
    selectedPreset: 'kimi-heavy',
    activatedPreset: 'kimi-heavy',
    currentScore: 76.25,
    selectedScore: 91,
    candidates: [candidate, { ...candidate, preset: 'kimi-heavy', score: 91 }],
    policy: {
      quotaFloorPercent: 10,
      switchMarginPercent: 5,
      localUsageWindowMs: 86_400_000,
      localUsageWeightPercent: 10,
      priorityWeightPercent: 20,
      reliabilityWeightPercent: 15,
      latencyWeightPercent: 10,
      switchCooldownMs: 30_000,
      circuitBreakerFailureThreshold: 3,
      circuitBreakerCooldownMs: 60_000,
    },
  };

  it('derives the actual current preset score instead of reusing the pre-evaluation score', () => {
    expect(subagentPresetCurrentEvaluation(switchedStatus, 'kimi-heavy')).toEqual({
      preset: 'kimi-heavy',
      score: 91,
    });
    expect(subagentPresetCurrentEvaluation(switchedStatus, undefined)).toEqual({
      preset: 'kimi-heavy',
      score: 91,
    });
    expect(subagentPresetCurrentEvaluation(switchedStatus, 'balanced')).toEqual({
      preset: 'kimi-heavy',
      score: 91,
    });
    expect(
      subagentPresetCurrentEvaluation(
        { ...switchedStatus, activatedPreset: undefined },
        'balanced',
      ),
    ).toEqual({ preset: 'balanced', score: 76.25 });
  });

  it('reports the evaluated preset, reason and timestamp even when unchanged', () => {
    for (const locale of ['en', 'zh'] as const) withLocale(locale, () => {
      const result = autoSubagentPresetResultLabel(
        config, { ...switchedStatus, reasonCode: 'current_optimal' }, locale, t,
      );
      expect(result).toContain('fast');
      expect(result).toContain(t('header.subagentPresetReasons.current_optimal'));
      expect(result).toContain(new Date(switchedStatus.evaluatedAt).toLocaleString(locale));
      expect(t('header.subagentPresetAutoAgain')).not.toContain('header.');
    });
  });

  it('formats the header control label in en and zh', () => {
    withLocale('en', () => {
      expect(subagentPresetLabel('balanced', t)).toBe('Preset: balanced');
    });
    withLocale('zh', () => {
      expect(subagentPresetLabel('balanced', t)).toBe('Preset：balanced');
    });
  });

  it('shows base routing when no preset is configured and normalizes whitespace', () => {
    withLocale('en', () => {
      expect(subagentPresetLabel(undefined, t)).toBe('Preset: Base routing');
      expect(subagentPresetLabel('', t)).toBe('Preset: Base routing');
      expect(subagentPresetLabel('   ', t)).toBe('Preset: Base routing');
      expect(subagentPresetLabel(' balanced ', t)).toBe('Preset: balanced');
    });
    withLocale('zh', () => {
      expect(subagentPresetLabel(undefined, t)).toBe('Preset：基础路由');
    });
  });

  it('labels status.currentPreset as the pre-evaluation preset in both locales', () => {
    withLocale('en', () => {
      expect(
        t('settings.smartRoutingCurrentSelection', {
          previous: 'balanced',
          selected: 'kimi-heavy',
        }),
      ).toBe('Before evaluation balanced · selected kimi-heavy');
    });
    withLocale('zh', () => {
      expect(
        t('settings.smartRoutingCurrentSelection', {
          previous: 'balanced',
          selected: 'kimi-heavy',
        }),
      ).toBe('评估前 balanced · 选择 kimi-heavy');
    });
  });

  it('renders the status separator with from → to in en and zh', () => {
    withLocale('en', () => {
      expect(subagentPresetChangedLabel({ from: 'balanced', to: 'kimi-heavy' }, t)).toBe(
        'Subagent preset switched automatically: balanced → kimi-heavy',
      );
    });
    withLocale('zh', () => {
      expect(subagentPresetChangedLabel({ from: 'balanced', to: 'kimi-heavy' }, t)).toBe(
        'Subagent 预设已自动切换：balanced → kimi-heavy',
      );
    });
  });

  it('falls back to the new-preset-only label when from is absent or a no-op', () => {
    withLocale('en', () => {
      expect(subagentPresetChangedLabel({ to: 'balanced' }, t)).toBe(
        'Subagent preset switched automatically: balanced',
      );
      expect(subagentPresetChangedLabel({ from: 'balanced', to: 'balanced' }, t)).toBe(
        'Subagent preset switched automatically: balanced',
      );
      expect(subagentPresetChangedLabel(undefined, t)).toBe(
        'Subagent preset switched automatically: ',
      );
    });
    withLocale('zh', () => {
      expect(subagentPresetChangedLabel({ to: 'balanced' }, t)).toBe(
        'Subagent 预设已自动切换：balanced',
      );
    });
  });

  it('localizes the manual-lock badge and resume-auto action in en and zh', () => {
    withLocale('en', () => {
      expect(t('header.subagentPresetLocked')).toBe('Manual lock');
      expect(t('header.subagentPresetResumeAuto')).toBe('Resume automatic switching');
      expect(t('settings.presetManualLocked')).toBe('Locked');
      expect(t('settings.presetResumeAuto')).toBe('Resume automatic switching');
    });
    withLocale('zh', () => {
      expect(t('header.subagentPresetLocked')).toBe('手动锁定');
      expect(t('header.subagentPresetResumeAuto')).toBe('恢复自动切换');
      expect(t('settings.presetManualLocked')).toBe('已锁定');
      expect(t('settings.presetResumeAuto')).toBe('恢复自动切换');
    });
  });

  it('localizes the candidate-priority editor copy in en and zh', () => {
    withLocale('en', () => {
      expect(t('settings.presetCandidates')).toBe('Automatic switch priority');
      expect(t('settings.presetCandidatesAddPlaceholder')).toBe('Add preset…');
      expect(t('settings.presetCandidatesMoveUp')).toBe('Move up');
      expect(t('settings.presetCandidatesMoveDown')).toBe('Move down');
      expect(t('settings.presetCandidatesRemove')).toBe('Remove from priority list');
    });
    withLocale('zh', () => {
      expect(t('settings.presetCandidates')).toBe('自动切换候选优先级');
      expect(t('settings.presetCandidatesAddPlaceholder')).toBe('添加预设…');
      expect(t('settings.presetCandidatesMoveUp')).toBe('上移');
      expect(t('settings.presetCandidatesMoveDown')).toBe('下移');
      expect(t('settings.presetCandidatesRemove')).toBe('从优先级列表中移除');
    });
  });

  it('localizes structured reasons in diagnostics and transcript markers', () => {
    withLocale('en', () => {
      expect(subagentPresetReasonLabel('current_unhealthy', t)).toBe(
        'The current preset is not eligible for automatic selection',
      );
      expect(
        subagentPresetChangedLabel(
          {
            from: 'balanced',
            to: 'kimi-heavy',
            reasonCode: 'higher_score',
            profileName: 'reviewer',
          },
          t,
        ),
      ).toBe(
        'Subagent preset switched automatically: balanced → kimi-heavy · Another preset scored clearly higher for reviewer',
      );
    });
    withLocale('zh', () => {
      expect(subagentPresetReasonLabel('circuit_breaker_escape', t)).toBe(
        '当前 Preset 已触发熔断',
      );
      expect(
        subagentPresetChangedLabel(
          {
            from: 'balanced',
            to: 'kimi-heavy',
            reasonCode: 'higher_score',
            profileName: 'reviewer',
          },
          t,
        ),
      ).toBe(
        'Subagent 预设已自动切换：balanced → kimi-heavy · reviewer 角色：另一 Preset 的综合得分明显更高',
      );
    });
  });

  it('formats candidate totals, strongest contributions, and missing evidence', () => {
    withLocale('en', () => {
      expect(formatSubagentPresetScore(candidate.score, t)).toBe('Score 76.3');
      expect(formatSubagentPresetScore(undefined, t)).toBe('Score —');
      expect(subagentPresetCandidateSummary(candidate, 1000, t)).toBe(
        'Quota +80.0 · Reliability −7.5',
      );
      expect(subagentPresetCandidateBreakdown(candidate, t)).toContain(
        'Quota +80.0 · Priority +8.0 · Reset bonus +1.0',
      );
      expect(
        subagentPresetCandidateSummary(
          { ...candidate, localEvidence: { ...candidate.localEvidence, scope: 'none' } },
          1000,
          t,
        ),
      ).toBe('Quota +80.0 · Reliability −7.5 · No usable account history');
    });
    withLocale('zh', () => {
      expect(subagentPresetCandidateSummary(candidate, 1000, t)).toBe(
        '额度 +80.0 · 可靠性 −7.5',
      );
    });
  });

  const nativeRoute: AutoSubagentPresetRouteScore = {
    model: 'example/native', thinking: 'max', provider: 'example-subscription', source: 'preset',
    availability: 'quota_below_floor', score: 12, contributions: candidate.contributions,
    localEvidence: candidate.localEvidence,
    resource: { kind: 'subscription', quotaRemainingPercent: 12, resourceScore: 12 },
  };
  const replacement: AutoSubagentPresetRouteScore = {
    ...nativeRoute, model: 'example/flash', thinking: 'low', provider: 'example-metered',
    availability: 'healthy', score: 100,
    contributions: { ...candidate.contributions, quotaRemaining: undefined, resourceScore: 100 },
    resource: { kind: 'metered', currency: 'CNY', balanceCny: '12.34', balanceStatus: 'known', isAvailable: true, resourceScore: 100, resourceScoreBasis: 'funded_account' },
  };
  const role: AutoSubagentPresetRoleScore = {
    key: 'coder', route: 'agent', profileName: 'coder', weight: 2,
    original: nativeRoute, effective: replacement, effectiveScore: 90, fallbackPenalty: 10,
    fallback: { sourcePreset: 'allowed', sourceRole: 'reviewer', reason: 'quota_below_floor' },
  };
  const whole: AutoSubagentPresetCandidateScore = {
    ...candidate, participating: true, nativeScore: 0, score: 90, roleScores: [role],
    roleCount: 1, nativeAvailableRoleCount: 0, fallbackRoleCount: 1, unavailableRoleCount: 0,
    totalRoleWeight: 2, coverage: { resourceProviderCount: 2, totalProviderCount: 2, localEvidenceRoleCount: 1, totalRoleCount: 1 },
  };

  it('keeps all presets visible without adding exclusions to the configured candidate pool', () => {
    const status = { ...switchedStatus, evaluationScope: 'preset' as const, candidates: [whole, { ...whole, preset: 'excluded', participating: false }] };
    const rows = subagentPresetDisplayRows(['balanced', 'excluded', 'new'], status, ['balanced']);
    expect(rows.map((r) => [r.preset, r.participating])).toEqual([['balanced', true], ['excluded', false], ['new', false]]);
    expect(rows[2]?.candidate).toBeUndefined();
    expect(subagentPresetDisplayRows(['balanced'], undefined, [])[0]?.participating).toBe(false);
    expect(subagentPresetDisplayRows([], status)[1]?.participating).toBe(false);
    expect(subagentPresetDisplayRows(['balanced'], undefined)[0]?.candidate).toBeUndefined();
    expect(subagentPresetDisplayRows([], status, [])[0]?.participating).toBe(false);
  });

  it('separates current configuration from an earlier automatic activation in reactive diagnostics', () => {
    for (const locale of ['en', 'zh'] as const) withLocale(locale, () => {
      const currentConfig = ref<AppConfig>({ ...config, subagent: { ...config.subagent, preset: 'kimi-heavy' } });
      const label = computed(() => subagentPresetConfiguredLabel(currentConfig.value, t));
      const history = { ...switchedStatus };
      expect(label.value).toBe(t('settings.smartRoutingConfiguredSelection', { preset: 'kimi-heavy' }));
      currentConfig.value = { ...config, subagent: { ...config.subagent, preset: 'manual-B', autoPreset: { manualLock: true } } };
      expect(label.value).toBe(t('settings.smartRoutingConfiguredSelection', { preset: 'manual-B' }));
      expect(label.value).not.toContain('kimi-heavy');
      currentConfig.value.subagent!.preset = '';
      expect(label.value).toBe(t('settings.smartRoutingConfiguredSelection', { preset: t('header.subagentPresetBaseOption') }));
      expect(label.value).not.toContain('kimi-heavy');
      expect(history.activatedPreset).toBe('kimi-heavy');
      // The optimistic auto-response helper retains its existing precedence.
      expect(subagentPresetCurrentEvaluation(history, 'manual-B').preset).toBe('kimi-heavy');
      expect(subagentPresetCurrentEvaluation(history, '').preset).toBe('kimi-heavy');
    });
    const settings = readFileSync(new URL('../src/components/settings/SettingsDialog.vue', import.meta.url), 'utf8');
    expect(settings).toContain('subagentPresetConfiguredLabel(props.config, t)');
    expect(settings).not.toContain('subagentPresetCurrentEvaluation');
    expect(settings).toContain('class="scheduler-current"');
    expect(settings).toContain('class="scheduler-activation"');
    expect(settings).toContain("t('settings.smartRoutingActivatedSelection', { preset })");
  });

  it('keeps deleted or renamed history read-only and leaves configured exclusions manually selectable', () => {
    const status = { ...switchedStatus, candidates: [whole, { ...whole, preset: 'excluded', participating: false }] };
    for (const names of [['excluded'], ['renamed', 'excluded']]) {
      const menu = subagentPresetMenuRows(names, status, ['renamed']);
      expect(menu.map((row) => row.preset)).toEqual(names);
      expect(menu.find((row) => row.preset === 'excluded')).toMatchObject({ configured: true, participating: false });
      const rows = subagentPresetDisplayRows(names, status, ['balanced', 'renamed']);
      expect(rows.find((row) => row.preset === 'balanced')).toMatchObject({ configured: false, participating: false, candidate: whole });
      expect(subagentPresetDisplayRows(names, status).find((row) => row.preset === 'balanced')).toMatchObject({ configured: false, participating: false });
    }
    for (const file of ['chat/ChatHeader.vue', 'mobile/MobileSettingsSheet.vue']) {
      const source = readFileSync(new URL(`../src/components/${file}`, import.meta.url), 'utf8');
      expect(source).toContain('subagentPresetMenuRows(');
      expect(source).toMatch(/preset !== '' && !props\.subagentPresetNames\??\.includes\(preset\)/);
    }
    const settings = readFileSync(new URL('../src/components/settings/SettingsDialog.vue', import.meta.url), 'utf8');
    expect(settings).toContain('v-if="!row.configured"');
    expect(settings).toContain("t('settings.smartRoutingRemovedPreset')");
    const row = settings.slice(settings.indexOf('v-for="row in schedulerRows"'), settings.indexOf('<div v-if="schedulerMeteredProviders.length"'));
    expect(row).not.toContain('@click=');
  });

  it('distinguishes native, temporary, partial and legacy totals in both locales', () => {
    for (const locale of ['en', 'zh'] as const) withLocale(locale, () => {
      expect(subagentPresetCandidateState(whole, t)).toBe(t('header.subagentPresetFallback'));
      expect(subagentPresetCandidateState({ ...whole, fallbackRoleCount: 0 }, t)).toBe(t('header.subagentPresetNative'));
      for (const availability of ['partial', 'unavailable'] as const) expect(subagentPresetCandidateState({ ...whole, availability }, t)).toBe(t(`header.subagentPresetAvailability.${availability}`));
      expect(subagentPresetTotals(whole, t)).toContain('0.0');
      expect(subagentPresetTotals(whole, t)).toContain('90.0');
      expect(subagentPresetTotals(undefined, t)).toBe(t('header.subagentPresetScoreNoData'));
      expect(subagentPresetRoleCounts(whole, t)).toContain('0/1');
      expect(subagentPresetCoverageLabel(whole, t)).toContain('2/2');
      expect(subagentPresetParticipationLabel(false, t)).toBe(t('header.subagentPresetExcluded'));
      expect(subagentPresetCandidateState(candidate, t)).toBe(t('header.subagentPresetLegacy'));
      expect(subagentPresetEvaluationScopeLabel(switchedStatus, t)).toBe(t('header.subagentPresetLegacy'));
      expect(subagentPresetEvaluationScopeLabel({ ...switchedStatus, evaluationScope: 'preset', candidates: [whole] }, t)).toBe(t('header.subagentPresetAggregate'));
      expect(subagentPresetEvaluationScopeLabel({ ...switchedStatus, evaluationScope: 'preset' }, t)).toBe(t('header.subagentPresetLegacy'));
      expect(subagentPresetBindingLabel(replacement, t)).toBe('example/flash · low');
      expect(subagentPresetBindingSourceLabel(replacement, t)).not.toContain('settings.');
      expect(subagentPresetCandidateSummary({ ...whole, localEvidence: { ...candidate.localEvidence, sampleCount: 0 } }, 0, t)).toContain(t('header.subagentPresetNoLocalEvidence'));
    });
  });

  it('renders peak modes, weighted shares and server deductions in both locales without rescoring', () => {
    for (const locale of ['en', 'zh'] as const) withLocale(locale, () => {
      for (const mode of ['block', 'penalize', 'off'] as const) {
        const label = subagentPresetPeakPolicyLabel({ deepseekPeakPolicy: mode, deepseekPeakPenalty: 60, deepseekAvoidPeakHours: true }, t)!;
        expect(label).toContain(t(`settings.presetScoring.peakModes.${mode}`));
        expect(label).toContain('60.0');
      }
      expect(subagentPresetPeakPolicyLabel({ deepseekAvoidPeakHours: true }, t)).toContain(t('settings.presetScoring.peakModes.block'));
      expect(subagentPresetPeakPolicyLabel({ deepseekAvoidPeakHours: false }, t)).toContain(t('settings.presetScoring.peakModes.off'));
      expect(subagentPresetPeakPolicyLabel({}, t)).toBeUndefined();
      for (const [share, points] of [[0, 0], [0.25, 15], [0.5, 30], [1, 60]] as const) {
        // Deliberately fixed role count / clamped score: neither controls the displayed evidence.
        const value = { ...whole, deepseekRoleShare: share, roleCount: 17, score: 0,
          contributions: { ...whole.contributions, peakPenalty: points } };
        const label = subagentPresetPeakSummary(value, t)!;
        expect(label).toContain(`${(share * 100).toFixed(1)}%`);
        expect(label).toContain(points ? `−${points.toFixed(1)}` : t('settings.presetScoring.peakNoPenalty'));
        expect(subagentPresetCandidateSummary(value, 0, t)).toContain(label);
        expect(value.score).toBe(0);
      }
      // A weekend/non-peak evaluation may still have 100% DeepSeek weight; no penalty is inferred.
      const weekend = { ...whole, deepseekRoleShare: 1, contributions: { ...whole.contributions, peakPenalty: 0 } };
      expect(subagentPresetPeakSummary(weekend, t)).toContain(t('settings.presetScoring.peakNoPenalty'));
      expect(subagentPresetPeakSummary(whole, t)).toBeUndefined();
      const until = Date.parse('2026-09-21T12:00:00+08:00');
      const resource = { kind: 'metered' as const, currency: 'CNY' as const, balanceStatus: 'known' as const,
        resourceScoreBasis: 'funded_account' as const, peakPenalty: { points: 60, until } };
      const roleLabel = subagentPresetRolePeakLabel(resource, locale, t)!;
      expect(roleLabel).toContain('−60.0');
      expect(roleLabel).toContain(new Date(until).toLocaleString(locale, { timeZone: 'Asia/Shanghai' }));
      expect(roleLabel).not.toMatch(/blocked|Circuit|禁用|熔断/);
      expect(subagentPresetRolePeakLabel({ kind: 'subscription' }, locale, t)).toBeUndefined();
      expect(subagentPresetRolePeakLabel({ ...resource, peakPenalty: undefined }, locale, t)).toBeUndefined();
      expect(subagentPresetCandidateBreakdown({ contributions: { ...whole.contributions, peakPenalty: 60 } }, t)).toContain('−60.0');
    });
  });

  it('renders expiring-window evidence with the real remaining quota and floor waiver in both locales', () => {
    const resetPriority = {
      window: { duration: 1, unit: 'week' as const },
      resetAt: 1_750_003_600_000,
      remainingPercent: 12,
      horizonMs: 43_200_000,
      bonus: 117.5,
      floorRelaxed: true,
    };
    const now = resetPriority.resetAt - 12 * 3_600_000;
    withLocale('en', () => {
      const label = subagentPresetResetPriorityLabel(resetPriority, now, 'en', t)!;
      expect(label).toContain('1 week');
      expect(label).toContain('12.0%');
      expect(label).toContain('+117.5 points');
      expect(label).toContain('12h');
      expect(label).toContain(new Date(resetPriority.resetAt).toLocaleString('en'));
      expect(subagentPresetResetFloorRelaxedLabel(resetPriority, t)).toContain('expiring remaining quota is usable');
      expect(subagentPresetResetFloorRelaxedLabel({ ...resetPriority, floorRelaxed: false }, t)).toBeUndefined();
      expect(subagentPresetResetPriorityLabel(undefined, now, 'en', t)).toBeUndefined();
    });
    withLocale('zh', () => {
      const label = subagentPresetResetPriorityLabel(resetPriority, now, 'zh', t)!;
      expect(label).toContain('1 周');
      expect(label).toContain('12.0%');
      expect(label).toContain('+117.5 分');
      expect(label).toContain('12 小时');
      expect(label).toContain(new Date(resetPriority.resetAt).toLocaleString('zh'));
      expect(subagentPresetResetFloorRelaxedLabel(resetPriority, t)).toBe(
        '已临期放宽额度健康门槛：临期剩余额度可用（其他限制不变）',
      );
    });
  });

  it('uses the fixed denominator and does not sum repeated metered accounts', () => {
    expect(subagentPresetRoleContribution(role, 4)).toBe(45);
    expect(subagentPresetRoleContribution({ ...role, weight: 0 }, 4)).toBe(0);
    expect(subagentPresetRoleContribution(role, 0)).toBeUndefined();
    expect(subagentPresetRoleContribution(role, undefined)).toBeUndefined();
    const providers = subagentPresetMeteredProviders([whole, { ...whole, preset: 'other', roleScores: [role, { ...role, key: 'reviewer', original: replacement }] }]);
    expect(providers).toHaveLength(1);
    expect(providers[0]?.resource).toBe(replacement.resource);
  });

  it('formats CNY as currency and keeps unknown, zero, failed, invalid and restricted evidence distinct', () => {
    for (const locale of ['en', 'zh'] as const) withLocale(locale, () => {
      expect(formatPresetCny('0', locale, t)).toBe('¥0.00');
      expect(formatPresetCny('12.3400', locale, t)).toBe('¥12.34');
      expect(formatPresetCny('0.000001', locale, t)).toContain('0.000001');
      for (const value of [undefined, null, '', 'NaN', '-1', '1e3', 'oops']) expect(formatPresetCny(value, locale, t)).toBe(t('settings.presetScoring.unknown'));
      expect(subagentPresetResourceLabel(replacement.resource, locale, t)).toContain('¥12.34');
      expect(subagentPresetResourceLabel(replacement.resource, locale, t)).not.toContain('%');
      expect(subagentPresetCandidateBreakdown(replacement, t)).toContain(t('settings.presetScoring.resourceScore', { score: '100.0' }));
      for (const balanceStatus of ['query_failed', 'invalid', 'missing'] as const) {
        expect(subagentPresetResourceLabel({ kind: 'metered', currency: 'CNY', balanceStatus, resourceScoreBasis: 'funded_account', blockedUntil: 1000 }, locale, t)).toBe(t(`settings.presetScoring.balanceStatus.${balanceStatus}`));
      }
      for (const reason of ['query_failed', 'unsupported', 'missing'] as const) expect(subagentPresetResourceLabel({ kind: 'unknown', reason }, locale, t)).toBe(t(`settings.presetScoring.unknownResource.${reason}`));
      expect(subagentPresetResourceLabel({ kind: 'subscription' }, locale, t)).toBe(t('header.subagentPresetQuotaNoData'));
    });
  });

  it('covers every availability and all scoring locale keys without fallback', () => {
    const availability = {
      healthy: true, route_unresolved: true, quota_unknown: true, quota_below_floor: true, circuit_open: true,
      balance_empty: true, balance_unknown: true, balance_invalid: true, account_unavailable: true, time_restricted: true,
      capability_unavailable: true, provider_unsupported: true, model_disabled: true, partial: true, unavailable: true,
    } satisfies Record<AutoSubagentPresetCandidateAvailability, boolean>;
    const paths = (value: object, prefix = ''): string[] => Object.entries(value).flatMap(([key, v]) => typeof v === 'object' ? paths(v, `${prefix}${key}.`) : [`${prefix}${key}`]).sort();
    expect(paths(enHeader)).toEqual(paths(zhHeader));
    expect(paths(enSettings)).toEqual(paths(zhSettings));
    for (const locale of ['en', 'zh'] as const) withLocale(locale, () => {
      for (const key of Object.keys(availability) as AutoSubagentPresetCandidateAvailability[]) expect(subagentPresetAvailabilityLabel(key, t)).not.toContain('header.');
      for (const key of [...paths(enHeader).map((k) => `header.${k}`), ...paths(enSettings.presetScoring).map((k) => `settings.presetScoring.${k}`)]) expect(i18n.global.te(key, locale)).toBe(true);
    });
  });

  it('keeps settings overview outside snapshot and manual-lock conditions with a real role table', () => {
    const settings = readFileSync(new URL('../src/components/settings/SettingsDialog.vue', import.meta.url), 'utf8');
    const table = readFileSync(new URL('../src/components/settings/PresetRoleScores.vue', import.meta.url), 'utf8');
    const header = readFileSync(new URL('../src/components/chat/ChatHeader.vue', import.meta.url), 'utf8');
    expect(settings).toContain('<Card class="scheduler-card">');
    expect(settings).toContain('v-for="row in schedulerRows"');
    expect(settings).not.toContain('v-else-if="autoSubagentPresetStatus"');
    expect(settings).toContain('<PresetRoleScores :candidate="row.candidate" :now="schedulerNow" />');
    expect(table).toContain('<table class="preset-role-table">');
    expect(table).toContain('role.original');
    expect(table).toContain('role.effective');
    expect(table).toContain('role.fallbackPenalty');
    expect(table).toContain('route.resource');
    expect(table).toContain('route.resource.blockedUntil');
    expect(table).toContain('route.resource.resetPriority');
    expect(table).toContain('subagentPresetResetFloorRelaxedLabel');
    expect(table).toContain('subagentPresetRolePeakLabel(route.resource, locale, t)');
    expect(settings).toContain('subagentPresetPeakSummary(row.candidate, t)');
    expect(settings).toContain("autoSubagentPresetStatus ? 'settings.presetScoring.peakEvaluation' : 'settings.presetScoring.peakConfigured'");
    expect(settings).toContain('if (props.autoSubagentPresetStatus !== undefined) return props.autoSubagentPresetStatus.policy;');
    expect(table).toContain('settings.presetScoring.temporary');
    expect(header).not.toContain('hasPresetCandidate');
  });

  it('reserves a full wrapping line for preset names instead of letting badges truncate them', () => {
    const settings = readFileSync(new URL('../src/components/settings/SettingsDialog.vue', import.meta.url), 'utf8');
    const nameRule = settings.match(/\.scheduler-candidate-name\s*\{([^}]+)\}/)?.[1];
    expect(nameRule).toBeDefined();
    expect(nameRule).toContain('flex: 0 0 100%');
    expect(nameRule).toContain('overflow-wrap: anywhere');
    expect(nameRule).toContain('white-space: normal');
    expect(nameRule).not.toContain('ellipsis');
    expect(nameRule).not.toContain('overflow: hidden');
    expect(settings).toMatch(/\.scheduler-candidate-head\s*\{[^}]*flex-wrap: wrap/);
  });

  it('derives cooldown and circuit-breaker countdowns from an explicit clock input', () => {
    withLocale('en', () => {
      expect(subagentPresetRemainingLabel(61_000, 1_000, 'cooldown', t)).toBe(
        'Switch cooldown · 1m remaining',
      );
      expect(subagentPresetRemainingLabel(3_000, 1_000, 'circuit', t)).toBe(
        'Circuit breaker · 2s remaining',
      );
      expect(subagentPresetRemainingLabel(1_000, 1_000, 'cooldown', t)).toBeUndefined();
      expect(
        subagentPresetCandidateSummary(
          {
            ...candidate,
            availability: 'circuit_open',
            selectable: false,
            circuitBreakerOpenUntil: 3_000,
          },
          1_000,
          t,
        ),
      ).toBe('Circuit breaker · 2s remaining');
    });
  });
});
