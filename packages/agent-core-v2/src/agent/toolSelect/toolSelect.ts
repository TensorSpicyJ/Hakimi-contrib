/**
 * `toolSelect` domain — progressive tool disclosure contract.
 *
 * Defines the Agent-scope service that shapes provider-visible tool/history
 * views, records selected dynamic schemas as pending declarations, and
 * reports loadable-tool announcements and content-free disclosure diagnostics.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { Tool } from '#/kosong/contract/tool';
import type { ToolInfo } from '#/tool/toolContract';

export const SELECT_TOOLS_TOOL_NAME = 'select_tools';

export interface ShapedToolEntry extends ToolInfo {
  readonly deferred?: true;
}

export interface LoadToolsResult {
  readonly toLoad: readonly string[];
  readonly alreadyAvailable: readonly string[];
  readonly unknown: readonly string[];
}

export interface ToolSelectionDiagnostics {
  readonly mode: 'off' | 'native' | 'catalog';
  readonly activeToolCount: number;
  readonly visibleToolCount: number;
  readonly loadableToolCount: number;
  readonly loadedToolCount: number;
  readonly pendingToolCount: number;
}

export interface IAgentToolSelectService {
  readonly _serviceBrand: undefined;

  enabled(): boolean;

  shapeTools(entries: readonly ToolInfo[]): readonly ShapedToolEntry[];

  shapeHistory(messages: readonly ContextMessage[]): readonly ContextMessage[];

  load(names: readonly string[]): LoadToolsResult;

  drainPendingToolSchemas(): readonly Tool[] | undefined;

  loadableToolsAnnouncement(isNewTurn?: boolean, forceCatalogRefresh?: boolean): string | undefined;

  diagnostics(): ToolSelectionDiagnostics;
}

export const IAgentToolSelectService: ServiceIdentifier<IAgentToolSelectService> =
  createDecorator<IAgentToolSelectService>('agentToolSelectService');
