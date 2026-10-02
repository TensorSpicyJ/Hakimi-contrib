<!-- apps/kimi-web/src/components/chat/tool-calls/StartSessionTool.vue -->
<!-- The `StartSession` (cross-project handoff) tool card. Beyond the generic
     rendering it offers the one thing this tool's result is for: a jump into
     the session it just started, which lives in another project workspace and
     therefore nowhere near the source session's own rows in the sidebar.

     The jump goes through the app-provided `openSession` action so A's live
     state is not torn down by a full page load; without a provider (e.g. a
     detached render) the button falls back to a plain `/sessions/<id>` link. -->
<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FilePreviewRequest, ToolCall, ToolMedia, ToolStatus } from '../../../types';
import { toolGlyph, toolLabel, toolSummary } from '../../../lib/toolMeta';
import { sessionUrl } from '../../../lib/sessionRoute';
import { parseStartSessionResult } from '../../../lib/startSessionResult';
import ToolRow from '../ToolRow.vue';
import Link from '../../ui/Link.vue';
import ToolOutputBlock from './ToolOutputBlock.vue';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    tool: ToolCall;
    mobile?: boolean;
    stackPosition?: 'single' | 'first' | 'middle' | 'last';
    toolDiffPanel?: boolean;
  }>(),
  { mobile: false, stackPosition: 'single', toolDiffPanel: false },
);

defineEmits<{
  openMedia: [media: ToolMedia];
  openFile: [target: FilePreviewRequest];
  openToolDiff: [id: string];
}>();

const openSession = inject<((sessionId: string) => void) | undefined>('openSession', undefined);

const open = ref(props.tool.defaultExpanded === true);
const status = computed<ToolStatus>(() => props.tool.status);
const label = computed(() => toolLabel(props.tool.name));
const glyph = computed(() => toolGlyph(props.tool.name));
const summary = computed(() => toolSummary(props.tool.name, props.tool.arg));
const summaryFull = computed(() => toolSummary(props.tool.name, props.tool.arg, true));
const result = computed(() => parseStartSessionResult(props.tool.output));
/** The started session always exists once the tool reports an id — even a
 *  failed or blocked start leaves it in place, and opening it is how the user
 *  reads what happened. */
const sessionId = computed(() => result.value.sessionId);
const href = computed(() =>
  sessionId.value === undefined ? undefined : sessionUrl(sessionId.value),
);

function toggle(): void {
  open.value = !open.value;
}

function onOpen(event: MouseEvent): void {
  if (openSession === undefined || sessionId.value === undefined) return;
  event.preventDefault();
  openSession(sessionId.value);
}

watch(
  () => [props.tool.defaultExpanded, props.tool.status] as const,
  () => {
    if (props.tool.defaultExpanded === true) open.value = true;
  },
);
</script>

<template>
  <ToolRow
    :status="status"
    :icon="glyph"
    :name="label"
    :arg="!open ? summary : ''"
    :time="tool.timing"
    :open="open"
    :expandable="true"
    :stacked="stackPosition !== 'single'"
    :stack-position="stackPosition"
    @toggle="toggle"
  >
    <template #trailing>
      <Link
        v-if="sessionId"
        :href="href"
        :title="sessionId"
        @click.stop="onOpen"
      >{{ t('tools.openSession') }}</Link>
    </template>
    <div v-if="summaryFull" class="bb-summary">{{ summaryFull }}</div>
    <ToolOutputBlock :lines="tool.output" empty-text="Waiting for output…" />
  </ToolRow>
</template>

<style scoped>
.bb-summary {
  color: var(--color-text);
  border-bottom: 1px dashed var(--color-line);
  padding-bottom: 6px;
  margin-bottom: 6px;
  word-break: break-all;
}
</style>
