import type { ResearchSnapshot, Session } from '@bhjia-phys/hakimi-sdk';
import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

export function formatResearchStatus(snapshot: ResearchSnapshot): string {
  const current = snapshot.current;
  return [
    `Research mode ${snapshot.enabled ? 'enabled' : 'disabled'}`,
    current?.title ?? 'No research note found. Start with aitp-memory to establish the question.',
    current?.mainQuestion ?? current?.summary,
    current?.path,
    snapshot.warning,
  ].filter(Boolean).join('\n');
}

export async function handleResearchCommand(host: SlashCommandHost, args: string): Promise<void> {
  let session: Session | undefined;
  try {
    session = host.requireSession();
    const selectedSession = session;
    const isCurrent = (): boolean => host.session === selectedSession;
    const input = args.trim();
    if (input === 'agents') {
      await host.tasksBrowserController.show('agents');
      return;
    }
    if (input === 'on' || input === 'off') {
      const next = await session.setResearchEnabled(input === 'on');
      if (isCurrent()) host.showStatus(formatResearchStatus(next));
      return;
    }
    const snapshot = await session.getResearch();
    if (!isCurrent()) return;
    if (input === 'status') {
      host.showStatus(formatResearchStatus(snapshot));
      return;
    }
    if (input === 'back') {
      if (!snapshot.parent) {
        host.showStatus('Already at the main research topic.');
        return;
      }
      const next = await session.selectResearch(snapshot.parent.path);
      if (isCurrent()) host.showStatus(formatResearchStatus(next));
      return;
    }
    if (input) {
      const next = await session.selectResearch(input);
      if (isCurrent()) host.showStatus(formatResearchStatus(next));
      return;
    }
    host.showStatus(formatResearchStatus(snapshot));
    const options = [
      ...(snapshot.parent ? [{ value: snapshot.parent.path, label: `← ${snapshot.parent.title}`, description: snapshot.parent.summary }] : []),
      ...(snapshot.current ? [{ value: snapshot.current.path, label: snapshot.current.title, description: snapshot.current.summary }] : []),
      ...[...snapshot.children, ...snapshot.linkedTopics].map((topic) => ({
        value: topic.path, label: topic.title, description: topic.summary || topic.directory,
      })),
    ].filter((item, index, all) => all.findIndex((candidate) => candidate.value === item.value) === index);
    options.push({ value: 'agents:', label: 'Agents in this session', description: 'Inspect delegated work and return to the main conversation.' });
    const selectTopic = async (path: string): Promise<void> => {
      try {
        const next = await selectedSession.selectResearch(path);
        if (isCurrent()) host.showStatus(formatResearchStatus(next));
      } catch (error) {
        if (isCurrent()) host.showError(formatErrorMessage(error));
      }
    };
    host.mountEditorReplacement(new ChoicePickerComponent({
      title: 'Research topics',
      hint: '↑↓ navigate · Enter select · Esc cancel',
      options,
      searchable: true,
      currentValue: snapshot.current?.path,
      onSelect: (path) => {
        if (!isCurrent()) return;
        host.restoreEditor();
        if (path === 'agents:') {
          void host.tasksBrowserController.show('agents');
          return;
        }
        void selectTopic(path);
      },
      onCancel: () => { if (isCurrent()) host.restoreEditor(); },
    }));
  } catch (error) {
    if (session === undefined || host.session === session) host.showError(formatErrorMessage(error));
  }
}
