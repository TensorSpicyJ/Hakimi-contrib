/**
 * `subagent` domain — `ISubagentPresetActivationService` implementation.
 *
 * Serializes every manual and automatic preset write against the process-wide
 * `config` instance, validates route models through `modelCatalog` inside the
 * critical section, persists the User-layer choice, and best-effort aligns an
 * existing Memory overlay. The public `activate` (manual boundary, including a
 * manual clear) commits the preset together with `auto_preset.manual_lock =
 * true` in one patch so the automatic decider defers to it; the serialized
 * transaction methods patch only the preset. `activate` validates all native
 * aliases; `activateEvaluated` trusts the automatic decider's resource/role
 * decision made under the same writer lock and checks structure plus main
 * routes instead. Both share the same atomic commit and Memory alignment.
 * Bound at App scope.
 */

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ConfigTarget, IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import { IModelCatalog } from '#/kosong/model/catalog';

import {
  assertValidEvaluatedSubagentPreset,
  SUBAGENT_SECTION,
  type SubagentConfig,
} from './configSection';
import {
  ISubagentPresetActivationService,
  type SubagentPresetActivationResult,
  type SubagentPresetActivationTransaction,
  validateSubagentPreset,
} from './presetActivation';

const CANCELLED_MESSAGE = 'Preset activation cancelled.';
const FAILED_MESSAGE = 'Failed to activate subagent preset.';

export class SubagentPresetActivationService implements ISubagentPresetActivationService {
  declare readonly _serviceBrand: undefined;

  private writeChain: Promise<void> = Promise.resolve();
  private _manualRevision = 0;
  private readonly transaction: SubagentPresetActivationTransaction = {
    activate: (preset, signal) => this.activateLocked(preset, signal, false),
    activateEvaluated: (preset, signal) => this.activateLocked(preset, signal, false, () => {
      assertValidEvaluatedSubagentPreset(this.config, this.modelCatalog, preset);
      return undefined;
    }),
  };

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
  ) {}

  get manualRevision(): number {
    return this._manualRevision;
  }

  activate(preset: string, signal?: AbortSignal): Promise<SubagentPresetActivationResult> {
    return this.runExclusive(async () => {
      const result = await this.activateLocked(preset, signal, true);
      if (result.kind === 'activated') this._manualRevision += 1;
      return result;
    });
  }

  runExclusive<T>(
    task: (transaction: SubagentPresetActivationTransaction) => Promise<T>,
  ): Promise<T> {
    const run = this.writeChain.then(
      () => task(this.transaction),
      () => task(this.transaction),
    );
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async activateLocked(
    preset: string,
    signal: AbortSignal | undefined,
    manual: boolean,
    validate: () => string | undefined = () => validateSubagentPreset(this.config, this.modelCatalog, preset),
  ): Promise<SubagentPresetActivationResult> {
    if (signal?.aborted === true) return { kind: 'cancelled', message: CANCELLED_MESSAGE };

    let hasMemoryOverlay: boolean;
    try {
      const invalid = validate();
      if (invalid !== undefined) {
        return { kind: 'failed', message: invalid, commitStarted: false };
      }
      hasMemoryOverlay =
        this.config.inspect<SubagentConfig>(SUBAGENT_SECTION).memoryValue !== undefined;
    } catch {
      return { kind: 'failed', message: FAILED_MESSAGE, commitStarted: false };
    }

    if (signal?.aborted) return { kind: 'cancelled', message: CANCELLED_MESSAGE };
    const patch = manual ? { preset, autoPreset: { manualLock: true } } : { preset };

    try {
      await this.config.set(SUBAGENT_SECTION, patch, ConfigTarget.User);
    } catch {
      return { kind: 'failed', message: FAILED_MESSAGE, commitStarted: true };
    }

    let warning: string | undefined;
    if (hasMemoryOverlay) {
      try {
        await this.config.set(SUBAGENT_SECTION, patch, ConfigTarget.Memory);
      } catch {
        warning = 'The preset was saved, but the active Memory overlay could not be updated.';
      }
    }

    try {
      const postInvalid = validate();
      if (postInvalid !== undefined) {
        warning = appendWarning(warning, `The saved preset is no longer valid: ${postInvalid}`);
      } else if (this.config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.preset !== preset) {
        warning = appendWarning(warning, 'The preset was saved, but is not the active effective preset.');
      }
    } catch {
      warning = appendWarning(warning, 'The preset was saved, but its effective state could not be verified.');
    }

    return warning === undefined ? { kind: 'activated' } : { kind: 'activated', warning };
  }
}

function appendWarning(current: string | undefined, next: string): string {
  return current === undefined ? next : `${current} ${next}`;
}

registerScopedService(
  LifecycleScope.App,
  ISubagentPresetActivationService,
  SubagentPresetActivationService,
  ScopeActivation.OnDemand,
  'subagent',
);
