import { onScopeDispose, ref, watch, type Ref } from 'vue';
import { getKimiWebApi } from '../api';
import type { AppResearchSnapshot } from '../api/types';

/** Session focus is owned by the daemon; only the returned research.md snapshot is shown. */
export function useResearchContext(options: {
  sessionId: Readonly<Ref<string | undefined>>;
  ready: Readonly<Ref<boolean>>;
  running: Readonly<Ref<boolean>>;
  connected: Readonly<Ref<boolean>>;
}) {
  const snapshot = ref<AppResearchSnapshot | null>(null);
  const loading = ref(false);
  const changing = ref(false);
  const error = ref<string | null>(null);
  let generation = 0;

  async function request(input?: { path: string } | { enabled: boolean }): Promise<void> {
    const sessionId = options.sessionId.value;
    if (!sessionId || !options.ready.value || changing.value) return;
    const ticket = ++generation;
    loading.value = true;
    changing.value = input !== undefined;
    error.value = null;
    try {
      const api = getKimiWebApi();
      const result = input === undefined
        ? await api.getSessionResearch(sessionId)
        : await api.updateSessionResearch(sessionId, input);
      if (ticket === generation) snapshot.value = result;
    } catch (cause) {
      if (ticket === generation) error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (ticket === generation) {
        loading.value = false;
        changing.value = false;
      }
    }
  }

  function refresh(): Promise<void> { return request(); }
  function selectTopic(path: string): Promise<void> { return request({ path }); }
  function setEnabled(enabled: boolean): Promise<void> { return request({ enabled }); }

  watch([options.sessionId, options.ready], () => {
    generation++;
    snapshot.value = null;
    loading.value = false;
    changing.value = false;
    error.value = null;
    void refresh();
  }, { immediate: true });

  // A finished turn can have changed the note; reconnect and browser focus also
  // reconcile edits made outside this tab without polling the filesystem.
  watch(options.running, (running, previous) => {
    if (!running && previous) void refresh();
  });
  watch(options.connected, (connected, previous) => {
    if (connected && !previous) void refresh();
  });
  const onFocus = (): void => { void refresh(); };
  if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
  onScopeDispose(() => {
    generation++;
    if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
  });

  return { snapshot, loading, changing, error, refresh, selectTopic, setEnabled };
}
