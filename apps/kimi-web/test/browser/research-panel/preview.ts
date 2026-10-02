import { createApp, h, nextTick, ref } from 'vue';
import ConversationPane from '../../../src/components/chat/ConversationPane.vue';
import i18n, { setLocale } from '../../../src/i18n';
import '../../../src/style.css';

// Visual-only fixture: mode, plugin metadata and actual session skills are
// independent props. The real server/browser smoke is a separate verification.
const snapshot = ref({ enabled: true, skillsAvailable: true });
const sessionId = ref('session-a');
const turns = ref([]);
const sessionLoading = ref(false);
const expandSignal = ref(0);
const previewOpen = ref(false);
const commands = [];
setLocale('en');
createApp({ setup: () => () => h('main', {
  style: 'display:flex;height:100dvh;width:100%;overflow:hidden;',
}, [
  h(ConversationPane, {
    style: 'flex:1;min-width:0;',
    turns: turns.value, sessionId: sessionId.value, sessionLoading: sessionLoading.value,
    research: snapshot.value, researchEnabled: true, researchExpandSignal: expandSignal.value,
    aitpPlugin: { id: 'aitp', version: '1.1.0+example.20260916.long-build-metadata-for-narrow-screen-layout', enabled: true, state: 'ok' },
    pluginMetadataStatus: 'ready',
    skills: ['aitp-memory', 'aitp-research', 'aitp-writing', 'aitp-distill'].map(name => ({ name, source: 'plugin', description: name })),
    tasks: [], running: true, workspaceName: 'Research fixture',
    status: { model: 'Fixture', modelId: 'fixture', ctxUsed: 0, ctxMax: 100000,
      permission: 'auto', branch: '', cwd: '/fixture', auto: true },
    onInterrupt: () => commands.push('interrupt'),
    onStartResearch: () => { snapshot.value = { ...snapshot.value, enabled: true }; },
    onStopResearch: () => { snapshot.value = { ...snapshot.value, enabled: false }; },
  }),
  previewOpen.value ? h('aside', { class: 'fixture-preview',
    style: 'width:320px;flex:none;background:var(--color-surface);',
  }, 'Existing file preview') : null,
]) }).use(i18n).mount('#app');
Object.assign(window, { researchPanelHarness: {
  commands,
  theme: (value) => { document.documentElement.dataset.colorScheme = value; },
  locale: setLocale,
  conversation: async () => {
    turns.value = [{ id: 'prompt-1', role: 'user', no: 1, text: 'Check the spin representation.' }];
    await nextTick();
  },
  session: async (value) => { sessionId.value = value; await nextTick(); },
  loading: async (value) => { sessionLoading.value = value; await nextTick(); },
  mode: async (value) => { snapshot.value = { ...snapshot.value, enabled: value === 'on' }; await nextTick(); },
  reveal: async () => { expandSignal.value++; await nextTick(); },
  preview: async () => { previewOpen.value = true; await nextTick(); },
} });
