/**
 * `research` domain — session research selection and mode preferences.
 *
 * Reads AITP notes through hostFileSystem, persists navigation preferences and
 * a Goal-to-note reference through atomicDocumentStore, uses config and flags
 * for defaults, and protects selection with sessionActivity and participating
 * Agent guards. Shares the session workspace boundary. Bound at Session scope.
 */

import { basename, join, resolve } from 'pathe';
import type { CollectionView } from '#/_base/di/collection';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import { Service } from '#/_base/di/service';
import { Emitter } from '#/_base/event';
import { Error2 } from '#/_base/errors/errors';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IResearchService, ResearchSelectionGuardContribution, type ResearchSelectionGuard, type ResearchGoalAnchor, type ResearchSnapshot } from './research';
import { RESEARCH_SECTION, type ResearchConfig } from './configSection';
import { ResearchErrors } from './errors';
import { discoverResearch, nearestResearchNote, readResearchNote, withinCanonicalRoots } from './researchDiscovery';

interface ResearchSelection { enabled: boolean; path?: string; goalAnchor?: ResearchGoalAnchor }

export class ResearchService extends Service implements IResearchService {
  declare readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  private selection: ResearchSelection = { enabled: true };
  private readonly changed = this._register(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IConfigService private readonly configService: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @ISessionActivityView private readonly activity: ISessionActivityView,
    @ResearchSelectionGuardContribution private readonly guards: CollectionView<ResearchSelectionGuard>,
  ) {
    super();
    this.ready = this.load();
  }

  get enabled(): boolean { return this.flags.enabled('research') && this.selection.enabled; }
  get goalAnchor(): ResearchGoalAnchor | undefined { return this.selection.goalAnchor; }

  private async load(): Promise<void> {
    await this.configService.ready;
    const saved = await this.documents.get<ResearchSelection>(this.session.scope(), 'research.json');
    this.selection = {
      goalAnchor: saved?.goalAnchor,
      enabled: saved?.enabled ?? this.configService.get<ResearchConfig>(RESEARCH_SECTION)?.enabled ?? true,
      path: typeof saved?.path === 'string' ? saved.path : (this.flags.enabled('research') ? (await nearestResearchNote(this.fs, this.workspace.workDir))?.topic.path : undefined),
    };
    if (saved === undefined && this.selection.path !== undefined) {
      await this.documents.set(this.session.scope(), 'research.json', this.selection);
    }
  }

  bindGoal(goalId: string): Promise<ResearchGoalAnchor | null> {
    const pending = this.writeTail.catch(() => undefined).then(async () => {
      await this.ready;
      const existing = this.selection.goalAnchor;
      if (existing?.goalId === goalId && existing.path !== null) return existing;
      if (!this.enabled) return existing?.goalId === goalId ? existing : null;
      const path = this.selection.path ?? (await this.readCurrentNote())?.topic.path ?? null;
      if (existing?.goalId === goalId && existing.path === path) return existing;
      const anchor = { goalId, path };
      const next = { ...this.selection, goalAnchor: anchor };
      await this.documents.set(this.session.scope(), 'research.json', next);
      this.selection = next;
      return anchor;
    });
    this.writeTail = pending;
    return pending;
  }

  async readCurrentNote() {
    await this.ready;
    return this.selection.path === undefined
      ? nearestResearchNote(this.fs, this.workspace.workDir)
      : readResearchNote(this.fs, this.selection.path);
  }

  async snapshot(): Promise<ResearchSnapshot> {
    await this.ready;
    return { ...(await discoverResearch(this.fs, this.workspace.workDir, this.workspace.additionalDirs, this.selection.path)), enabled: this.enabled };
  }

  async select(input: string): Promise<ResearchSnapshot> {
    return this.mutate(async () => {
      const candidate = resolve(this.workspace.workDir, input);
      const stat = await this.fs.stat(candidate);
      const path = stat.isDirectory ? join(candidate, 'research.md') : candidate;
      if (!/\.(?:md|tex)$/i.test(basename(path)) || /^memory(?:_summary)?\.md$/i.test(basename(path))) {
        throw new Error2(ResearchErrors.codes.RESEARCH_NOTE_INVALID, 'Select the topic main note, normally research.md, rather than generic memory.');
      }
      const canonical = await this.fs.realpath(path);
      const roots = [this.workspace.workDir, ...this.workspace.additionalDirs];
      const allowed = await withinCanonicalRoots(this.fs, canonical, roots);
      const snapshot = allowed ? undefined : await this.snapshot();
      const displayed = snapshot === undefined ? [] : [snapshot.current, snapshot.parent, ...snapshot.children, ...snapshot.linkedTopics].filter((topic) => topic !== null);
      const displayedPaths = await Promise.all(displayed.map((topic) => this.fs.realpath(topic.path)));
      if (!allowed && !displayedPaths.includes(canonical)) {
        throw new Error2(ResearchErrors.codes.RESEARCH_NOTE_INVALID, 'The note is outside the workspace and added directories. Add its directory before selecting it.');
      }
      if (await readResearchNote(this.fs, canonical) === null) {
        throw new Error2(ResearchErrors.codes.RESEARCH_NOTE_INVALID, 'The selected research note is unavailable.');
      }
      return { ...this.selection, path: canonical };
    });
  }

  async setEnabled(enabled: boolean): Promise<ResearchSnapshot> {
    return this.mutate(async () => ({ ...this.selection, enabled }));
  }

  private assertIdle(): void {
    const reason = this.activity.state().busy
      ? 'Wait for the running agents and background tasks before changing the research topic or mode.'
      : this.guards.items.map((guard) => guard.reason()).find((reason) => reason !== undefined);
    if (reason !== undefined) throw new Error2(ResearchErrors.codes.RESEARCH_NOTE_INVALID, reason);
  }

  private async mutate(change: () => Promise<ResearchSelection>): Promise<ResearchSnapshot> {
    const pending = this.writeTail.catch(() => undefined).then(async () => {
      await this.ready;
      this.assertIdle();
      const next = await change();
      this.assertIdle();
      await this.documents.set(this.session.scope(), 'research.json', next);
      this.selection = next;
      this.changed.fire();
      return this.snapshot();
    });
    this.writeTail = pending;
    return pending;
  }
}
