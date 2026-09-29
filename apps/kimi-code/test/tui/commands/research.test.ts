/** Research commands expose the selected note without modifying scientific files. */
import type { Component } from '@moonshot-ai/pi-tui';
import type { ResearchSnapshot } from '@bhjia-phys/hakimi-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleResearchCommand } from '#/tui/commands/research';

function rig() {
  const snapshot: ResearchSnapshot = {
    enabled: true, rootDirectory: '/research',
    current: { path: '/research/branch/research.md', directory: '/research/branch', title: 'Controlled limit', summary: 'The interacting case remains unresolved.' },
    parent: { path: '/research/research.md', directory: '/research', title: 'Green function topology', summary: 'Which invariant can we establish?' },
    children: [], linkedTopics: [],
  };
  const session = {
    id: 'session',
    getResearch: vi.fn(async () => snapshot),
    selectResearch: vi.fn(async (_path: string) => snapshot),
    setResearchEnabled: vi.fn(async (enabled: boolean) => ({ ...snapshot, enabled })),
  };
  let picker: Component | undefined;
  const host = {
    session, requireSession: () => session,
    showStatus: vi.fn(), showError: vi.fn(), restoreEditor: vi.fn(),
    mountEditorReplacement: (component: Component) => { picker = component; },
    tasksBrowserController: { show: vi.fn(async () => {}) },
  };
  return {
    host: host as unknown as SlashCommandHost, session, snapshot,
    status: host.showStatus, error: host.showError, picker: () => picker,
    replaceSession: () => { host.session = { ...session, id: 'new-session' }; },
  };
}

describe('research commands', () => {
  it('ignores a topic snapshot that arrives after the session changes', async () => {
    const r = rig();
    let resolve!: (value: ResearchSnapshot) => void;
    r.session.getResearch.mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = handleResearchCommand(r.host, '');
    r.replaceSession();
    resolve(r.snapshot);
    await pending;
    expect(r.status).not.toHaveBeenCalled();
    expect(r.picker()).toBeUndefined();
  });

  it('does not restore a different session editor from a stale topic picker', async () => {
    const r = rig();
    await handleResearchCommand(r.host, '');
    r.replaceSession();
    r.picker()?.handleInput?.('\u001B');
    expect(r.host.restoreEditor).not.toHaveBeenCalled();
  });

  it('suppresses mode update errors from the previous session', async () => {
    const r = rig();
    let reject!: (error: Error) => void;
    r.session.setResearchEnabled.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    const pending = handleResearchCommand(r.host, 'off');
    r.replaceSession();
    reject(new Error('Old session is busy.'));
    await pending;
    expect(r.error).not.toHaveBeenCalled();
    expect(r.status).not.toHaveBeenCalled();
  });

  it('agents opens the complete agent directory without changing the research topic', async () => {
    const r = rig();
    await handleResearchCommand(r.host, 'agents');
    expect(r.host.tasksBrowserController.show).toHaveBeenCalledWith('agents');
    expect(r.session.selectResearch).not.toHaveBeenCalled();
    expect(r.session.getResearch).not.toHaveBeenCalled();
  });

  it('status displays the question and source path without changing the selection', async () => {
    const r = rig();
    await handleResearchCommand(r.host, 'status');
    expect(r.status).toHaveBeenCalledWith(expect.stringContaining('The interacting case remains unresolved.'));
    expect(r.status).toHaveBeenCalledWith(expect.stringContaining('/research/branch/research.md'));
    expect(r.session.selectResearch).not.toHaveBeenCalled();
  });

  it('back selects the parent note supplied by the current research snapshot', async () => {
    const r = rig();
    await handleResearchCommand(r.host, 'back');
    expect(r.session.selectResearch).toHaveBeenCalledWith('/research/research.md');
  });

  it('off reports a rejected mode change without announcing success', async () => {
    const r = rig();
    r.session.setResearchEnabled.mockRejectedValue(new Error('Pause the active Goal first.'));
    await handleResearchCommand(r.host, 'off');
    expect(r.error).toHaveBeenCalledWith('Pause the active Goal first.');
    expect(r.status).not.toHaveBeenCalled();
  });

  it('the topic picker selects a parent through the same session API', async () => {
    const r = rig();
    await handleResearchCommand(r.host, '');
    const picker = r.picker();
    expect(picker?.render(56).join('\n')).toContain('Research topics');
    picker?.handleInput?.('\u001B[A');
    picker?.handleInput?.('\r');
    expect(r.session.selectResearch).toHaveBeenCalledWith('/research/research.md');
  });
});
