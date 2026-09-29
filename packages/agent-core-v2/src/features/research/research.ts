/**
 * `research` domain — session research navigation and mode contract.
 *
 * Keeps only the selected note and mode preference; scientific content remains
 * in ordinary AITP files. Shared by every Agent in this Session.
 */

import { collection } from '#/_base/di/collection';
import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

export interface ResearchTopic {
  readonly path: string;
  readonly directory: string;
  readonly title: string;
  readonly summary: string;
  readonly mainQuestion?: string;
}

export interface ResearchSnapshot {
  readonly enabled: boolean;
  readonly rootDirectory: string;
  readonly current: ResearchTopic | null;
  readonly parent: ResearchTopic | null;
  readonly children: readonly ResearchTopic[];
  readonly linkedTopics: readonly ResearchTopic[];
  readonly warning?: string;
}

export interface ResearchNote {
  readonly topic: ResearchTopic;
  readonly content: string;
  readonly truncated: boolean;
}

export interface ResearchGoalAnchor {
  readonly goalId: string;
  readonly path: string | null;
}

export interface IResearchService {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly onDidChange: Event<void>;
  readonly enabled: boolean;
  readonly goalAnchor: ResearchGoalAnchor | undefined;
  bindGoal(goalId: string): Promise<ResearchGoalAnchor | null>;
  snapshot(): Promise<ResearchSnapshot>;
  select(path: string): Promise<ResearchSnapshot>;
  setEnabled(enabled: boolean): Promise<ResearchSnapshot>;
  readCurrentNote(): Promise<ResearchNote | null>;
}

export const IResearchService = createDecorator<IResearchService>('researchService');

export interface ResearchSelectionGuard {
  readonly reason: () => string | undefined;
}

export const ResearchSelectionGuardContribution = collection<ResearchSelectionGuard>('research-selection-guard');
