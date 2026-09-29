<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppResearchSnapshot } from '../../api/types';
import Badge from '../ui/Badge.vue';
import Button from '../ui/Button.vue';
import Icon from '../ui/Icon.vue';
import IconButton from '../ui/IconButton.vue';
import Spinner from '../ui/Spinner.vue';
import Switch from '../ui/Switch.vue';
import Tooltip from '../ui/Tooltip.vue';

const props = defineProps<{
  snapshot: AppResearchSnapshot | null;
  sessionId?: string;
  loading?: boolean;
  changing?: boolean;
  error?: string | null;
  locked?: boolean;
}>();
const emit = defineEmits<{
  selectTopic: [path: string];
  setEnabled: [enabled: boolean];
  refresh: [];
  openNote: [path: string];
}>();
const { t } = useI18n();
const expanded = ref(false);
const current = computed(() => props.snapshot?.current);
const enabled = computed(() => props.snapshot?.enabled ?? !props.sessionId);
const disabled = computed(() => props.changing || props.locked);
const headline = computed(() => current.value?.mainQuestion || current.value?.summary);
</script>

<template>
  <section class="research-context" :aria-label="t('researchContext.label')">
    <div class="research-heading">
      <Badge size="sm" variant="neutral">AITP</Badge>
      <Button
        variant="ghost"
        size="sm"
        class="research-title"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <span class="research-title-text">{{ snapshot?.enabled === false ? t('researchContext.disabled') : current?.title || t('researchContext.label') }}</span>
        <Icon :name="expanded ? 'chevron-up' : 'chevron-down'" size="sm" />
      </Button>
      <Spinner v-if="loading" size="sm" />
      <Tooltip v-if="snapshot?.parent && enabled" :text="t('researchContext.parent')">
        <IconButton :label="t('researchContext.parent')" :disabled="disabled" @click="emit('selectTopic', snapshot.parent.path)">
          <Icon name="undo" size="sm" />
        </IconButton>
      </Tooltip>
      <Tooltip v-if="current && enabled" :text="t('researchContext.openNote')">
        <IconButton :label="t('researchContext.openNote')" @click="emit('openNote', current.path)">
          <Icon name="file-text" size="sm" />
        </IconButton>
      </Tooltip>
      <Tooltip v-if="snapshot" :text="locked ? t('researchContext.locked') : t('researchContext.toggle')">
        <Switch :model-value="enabled" :label="t('researchContext.toggle')" :disabled="disabled" @update:model-value="emit('setEnabled', $event)" />
      </Tooltip>
    </div>
    <p v-if="enabled && headline" class="research-headline" :class="{ expanded }">{{ headline }}</p>
    <p v-else-if="enabled && !loading" class="research-empty">{{ sessionId ? t('researchContext.noNote') : t('researchContext.draft') }}</p>
    <div v-if="error" class="research-error" role="alert">
      <span>{{ t('researchContext.loadFailed') }} {{ error }}</span>
      <Button variant="ghost" size="sm" :disabled="loading" @click="emit('refresh')">{{ t('researchContext.retry') }}</Button>
    </div>
    <div v-if="expanded" class="research-details">
      <template v-if="enabled && snapshot">
        <p v-if="current?.mainQuestion && current.summary && current.summary !== current.mainQuestion" class="research-summary">{{ current.summary }}</p>
        <dl class="research-paths">
          <template v-if="current">
            <dt>{{ t('researchContext.topicDirectory') }}</dt>
            <dd>{{ current.directory }}</dd>
          </template>
          <dt>{{ t('researchContext.workingDirectory') }}</dt>
          <dd>{{ snapshot.rootDirectory }}</dd>
        </dl>
        <p v-if="snapshot.warning" class="research-warning">{{ snapshot.warning }}</p>
        <nav v-if="snapshot.parent || snapshot.children.length || snapshot.linkedTopics.length" :aria-label="t('researchContext.topics')" class="research-topics">
          <Button v-if="snapshot.parent" variant="ghost" class="research-topic" :disabled="disabled" @click="emit('selectTopic', snapshot.parent.path)">
            <Icon name="undo" size="sm" />
            <span class="research-topic-copy"><span class="research-topic-label">{{ t('researchContext.parent') }}</span><span>{{ snapshot.parent.title }}</span></span>
          </Button>
          <template v-for="group in [{ label: t('researchContext.subtopics'), topics: snapshot.children }, { label: t('researchContext.linkedTopics'), topics: snapshot.linkedTopics }]" :key="group.label">
            <span v-if="group.topics.length" class="research-topic-label research-group-label">{{ group.label }}</span>
            <Button v-for="topic in group.topics" :key="topic.path" variant="ghost" class="research-topic" :disabled="disabled" @click="emit('selectTopic', topic.path)">
              <Icon name="arrow-right" size="sm" />
              <span class="research-topic-copy"><span>{{ topic.title }}</span><span v-if="topic.mainQuestion || topic.summary" class="research-topic-summary">{{ topic.mainQuestion || topic.summary }}</span></span>
            </Button>
          </template>
        </nav>
        <p v-if="locked" class="research-empty">{{ t('researchContext.locked') }}</p>
      </template>
      <p v-else-if="!enabled && snapshot" class="research-empty">{{ t('researchContext.enableHint') }}</p>
      <Button v-if="sessionId" variant="ghost" size="sm" :disabled="loading" @click="emit('refresh')">
        <Icon name="refresh" size="sm" />{{ t('researchContext.refresh') }}
      </Button>
    </div>
  </section>
</template>

<style scoped>
.research-context {
  flex: none;
  min-width: 0;
  padding: var(--space-2) var(--space-4) var(--space-3);
  border-bottom: 1px solid var(--color-line);
  background: var(--color-bg);
}
.research-heading { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.research-title { flex: 1; min-width: 0; justify-content: flex-start; padding-inline: var(--space-1); color: var(--color-text); }
.research-title :deep(.ui-button__content) { min-width: 0; }
.research-title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.research-headline, .research-summary { margin: var(--space-2) 0 0; font-size: var(--text-sm); line-height: var(--leading-relaxed); color: var(--color-text); overflow-wrap: anywhere; }
.research-headline { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.research-headline.expanded { -webkit-line-clamp: 6; }
.research-empty { margin: var(--space-2) 0 0; color: var(--color-text-muted); font-size: var(--text-xs); line-height: var(--leading-relaxed); }
.research-details { max-height: 36vh; overflow-y: auto; padding-top: var(--space-2); }
.research-paths { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-2) var(--space-3); margin: var(--space-3) 0; font-size: var(--text-xs); color: var(--color-text-muted); }
.research-paths dt { font-weight: var(--weight-medium); }
.research-paths dd { margin: 0; font-family: var(--font-mono); overflow-wrap: anywhere; }
.research-topics { display: flex; flex-direction: column; align-items: stretch; gap: var(--space-1); }
.research-topic { height: auto; min-height: var(--space-8); justify-content: flex-start; text-align: left; padding: var(--space-2); color: var(--color-text); }
.research-topic :deep(.ui-button__content) { width: 100%; min-width: 0; }
.research-topic-copy { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; overflow-wrap: anywhere; white-space: normal; }
.research-topic-label, .research-topic-summary { font-size: var(--text-xs); color: var(--color-text-muted); font-weight: var(--weight-normal); }
.research-topic-summary { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.research-group-label { margin: var(--space-3) var(--space-2) var(--space-1); }
.research-error { display: flex; align-items: center; gap: var(--space-2); color: var(--color-danger); font-size: var(--text-xs); overflow-wrap: anywhere; }
.research-error span { min-width: 0; }
.research-warning { color: var(--color-warning); font-size: var(--text-xs); overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .research-context { padding-inline: var(--space-3); }
  .research-heading { gap: var(--space-1); }
  .research-headline.expanded { -webkit-line-clamp: 4; }
  .research-paths { grid-template-columns: minmax(0, 1fr); gap: var(--space-1); }
  .research-paths dd + dt { margin-top: var(--space-2); }
}
</style>
