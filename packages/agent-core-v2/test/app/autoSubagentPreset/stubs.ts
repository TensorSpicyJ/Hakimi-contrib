/**
 * `autoSubagentPreset` test stubs — minimal `IAutoSubagentPresetService` for
 * unit tests.
 *
 * Lives under `test/` (not `src/`). Import from a relative path.
 */

import { vi } from 'vitest';

import {
  IAutoSubagentPresetService,
  type AutoSubagentPresetContext,
  type AutoSubagentPresetEvaluation,
} from '#/app/autoSubagentPreset/autoSubagentPreset';
import { resolveSubagentBinding, type SubagentRouteRequest } from '#/session/subagent/configSection';
import type { IConfigService } from '#/app/config/config';
import type { IFlagService } from '#/app/flag/flag';
import type { IModelCatalog } from '#/kosong/model/catalog';

export interface AutoSubagentPresetStubOptions {
  readonly config: IConfigService;
  readonly flags: IFlagService;
  readonly modelCatalog: IModelCatalog;
}

export function stubAutoSubagentPreset(
  evaluate?: (
    request: SubagentRouteRequest,
    context: AutoSubagentPresetContext,
  ) => Promise<AutoSubagentPresetEvaluation>,
  options?: AutoSubagentPresetStubOptions,
): IAutoSubagentPresetService {
  return {
    _serviceBrand: undefined,
    resolveBinding: vi.fn<IAutoSubagentPresetService['resolveBinding']>(async (request, context) => {
      await evaluate?.(request, context);
      if (options !== undefined) return resolveSubagentBinding(options.config, options.flags, options.modelCatalog, request);
      return { model: request.caller.modelAlias, thinking: request.caller.thinkingLevel,
        source: 'caller', modelSource: 'caller', thinkingSource: 'caller' };
    }),
    evaluate:
      evaluate ??
      vi.fn(async (request: SubagentRouteRequest) => ({ request, reason: 'stubbed' })),
    selectAutomatically:
      evaluate ??
      vi.fn(async (request: SubagentRouteRequest) => ({ request, reason: 'stubbed' })),
    status: () => undefined,
  };
}