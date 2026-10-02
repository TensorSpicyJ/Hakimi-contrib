<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type {
  AutoSubagentPresetCandidateScore,
  AutoSubagentPresetResetPriority,
  AutoSubagentPresetRouteScore,
} from '../../api/types';
import {
  presetScoreNumber, subagentPresetAvailabilityLabel, subagentPresetBindingLabel,
  subagentPresetBindingSourceLabel, subagentPresetCandidateBreakdown,
  subagentPresetResetFloorRelaxedLabel, subagentPresetResetPriorityLabel,
  subagentPresetResourceLabel, subagentPresetRoleContribution, subagentPresetRolePeakLabel,
} from '../../lib/subagentPreset';
import Badge from '../ui/Badge.vue';

const props = defineProps<{ candidate: AutoSubagentPresetCandidateScore; now?: number }>();
const { t, locale } = useI18n();
const number = (value: number | undefined) => presetScoreNumber(value, t);
const time = (value: number) => new Date(value).toLocaleString(locale.value);
function evidence(route: AutoSubagentPresetRouteScore): string {
  const e = route.localEvidence;
  return e.sampleCount === 0 ? t('settings.presetScoring.noSamples') : t('settings.presetScoring.samples', {
    count: e.sampleCount, failures: e.failureCount, tokens: e.tokenCount.toLocaleString(locale.value),
  });
}
/** Expiring-window evidence comes from the server as-is; only its distance to
 *  reset is derived from the ticking clock (or the fixed test/harness time). */
function resetLabel(resetPriority: AutoSubagentPresetResetPriority | undefined): string | undefined {
  return subagentPresetResetPriorityLabel(resetPriority, props.now ?? Date.now(), locale.value, t);
}
</script>

<template>
  <details v-if="candidate.roleScores" class="preset-role-details">
    <summary tabindex="0">{{ t('settings.presetScoring.roles') }}</summary>
    <p class="role-note">{{ t('settings.presetScoring.formula') }}</p>
    <p class="role-note">{{ t('settings.presetScoring.denominator', { weight: candidate.totalRoleWeight ?? t('settings.presetScoring.unknown'), priority: number(candidate.contributions.priorityBonus) }) }}</p>
    <table class="preset-role-table">
      <caption>{{ candidate.preset }} · {{ t('settings.presetScoring.roles') }}</caption>
      <thead><tr>
        <th scope="col">{{ t('settings.presetScoring.role') }}</th>
        <th scope="col">{{ t('settings.presetScoring.binding') }}</th>
        <th scope="col">{{ t('settings.presetScoring.resource') }}</th>
        <th scope="col">{{ t('settings.presetScoring.scores') }}</th>
        <th scope="col">{{ t('settings.presetScoring.evidence') }}</th>
      </tr></thead>
      <tbody>
        <tr v-for="role in candidate.roleScores" :key="role.key" :class="{ 'has-fallback': role.fallback }">
          <th scope="row" :data-label="t('settings.presetScoring.role')">
            <strong>{{ role.key }}</strong>
            <small>{{ role.route }}</small>
            <small>{{ t('settings.presetScoring.weight', { weight: role.weight }) }}</small>
          </th>
          <td :data-label="t('settings.presetScoring.binding')">
            <div class="role-binding">
              <code>{{ subagentPresetBindingLabel(role.original, t) }}</code>
              <template v-if="role.fallback">
                <strong class="fallback-binding">→ {{ subagentPresetBindingLabel(role.effective, t) }}</strong>
                <Badge variant="warning" size="sm">{{ t('settings.presetScoring.temporary') }}</Badge>
              </template>
            </div>
            <small>{{ subagentPresetBindingSourceLabel(role.original, t) }}</small>
            <template v-if="role.fallback">
              <small>{{ subagentPresetBindingSourceLabel(role.effective, t) }}</small>
              <small>{{ t('settings.presetScoring.fallbackSource', { preset: role.fallback.sourcePreset ?? t('settings.presetScoring.sources.agents'), role: role.fallback.sourceRole }) }}</small>
            </template>
          </td>
          <td :data-label="t('settings.presetScoring.resource')">
            <div v-for="(route, index) in role.fallback ? [role.original, role.effective] : [role.original]" :key="index" class="route-evidence">
              <small>{{ t(index === 0 ? 'settings.presetScoring.original' : 'settings.presetScoring.effective') }} · {{ route.provider ?? t('settings.presetScoring.unknown') }}</small>
              <span>{{ subagentPresetResourceLabel(route.resource, locale, t) }}</span>
              <small v-if="route.resource.kind === 'metered'">{{ t('settings.presetScoring.funded', { score: number(route.resource.resourceScore) }) }}</small>
              <small v-if="route.resource.kind === 'subscription' && route.resource.quotaResetAt !== undefined">{{ t('settings.usageResetsAt', { time: time(route.resource.quotaResetAt) }) }}</small>
              <template v-if="route.resource.kind === 'subscription' && route.resource.resetPriority !== undefined">
                <span class="reset-priority">{{ resetLabel(route.resource.resetPriority) }}</span>
                <small v-if="subagentPresetResetFloorRelaxedLabel(route.resource.resetPriority, t)">{{ subagentPresetResetFloorRelaxedLabel(route.resource.resetPriority, t) }}</small>
              </template>
              <small v-if="subagentPresetRolePeakLabel(route.resource, locale, t)">{{ subagentPresetRolePeakLabel(route.resource, locale, t) }}</small>
              <small v-if="route.resource.blockedUntil !== undefined">{{ t('settings.presetScoring.blockedUntil', { time: time(route.resource.blockedUntil) }) }}</small>
              <small v-if="route.circuitBreakerOpenUntil !== undefined">{{ t('settings.presetScoring.circuitUntil', { time: time(route.circuitBreakerOpenUntil) }) }}</small>
            </div>
          </td>
          <td :data-label="t('settings.presetScoring.scores')">
            <span>{{ t('settings.presetScoring.raw', { score: number(role.original.score) }) }}</span>
            <small>{{ subagentPresetCandidateBreakdown(role.original, t) }}</small>
            <template v-if="role.fallback">
              <span>{{ t('settings.presetScoring.effectiveRaw', { score: number(role.effective.score) }) }}</span>
              <small>{{ subagentPresetCandidateBreakdown(role.effective, t) }}</small>
            </template>
            <small>{{ t('settings.presetScoring.penalty', { score: number(role.fallbackPenalty) }) }}</small>
            <strong>{{ t('settings.presetScoring.contribution', { score: number(role.effectiveScore), weight: role.weight, contribution: number(role.effectiveScore * role.weight) }) }}</strong>
            <small>{{ t('settings.presetScoring.meanContribution', { score: number(subagentPresetRoleContribution(role, props.candidate.totalRoleWeight)) }) }}</small>
          </td>
          <td :data-label="t('settings.presetScoring.evidence')">
            <div v-for="(route, index) in role.fallback ? [role.original, role.effective] : [role.original]" :key="index" class="route-evidence">
              <small>{{ t(index === 0 ? 'settings.presetScoring.original' : 'settings.presetScoring.effective') }}</small>
              <strong>{{ subagentPresetAvailabilityLabel(route.availability, t) }}</strong>
              <span>{{ evidence(route) }}</span>
              <small>{{ t('settings.presetScoring.latency', { latency: number(route.localEvidence.averageFirstTokenLatencyMs), count: route.localEvidence.firstTokenLatencySampleCount }) }}</small>
            </div>
            <small v-if="role.fallback">{{ subagentPresetAvailabilityLabel(role.fallback.reason, t) }}</small>
          </td>
        </tr>
      </tbody>
    </table>
  </details>
</template>

<style scoped>
.preset-role-details { min-width: 0; margin-top: var(--space-2); container-type: inline-size; }
summary { cursor: pointer; padding: var(--space-2); border-radius: var(--radius-sm); color: var(--color-text); }
summary:hover { background: var(--color-hover); }
summary:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.role-note { color: var(--color-text-muted); margin: var(--space-2) 0; font-size: var(--text-xs); }
.preset-role-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: var(--text-xs); }
caption { text-align: left; color: var(--color-text-muted); padding: var(--space-2); }
th, td { vertical-align: top; text-align: left; padding: var(--space-2); border-bottom: 1px solid var(--color-line); overflow-wrap: anywhere; }
th { font-weight: var(--weight-medium); }
thead { background: var(--color-surface-sunken); }
th:first-child { width: 14%; }
small, td > span, td > strong, .route-evidence > span, .route-evidence > strong { display: block; margin-bottom: var(--space-1); }
small { font-size: var(--text-xs); color: var(--color-text-muted); }
.role-binding { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-1); margin-bottom: var(--space-2); }
.fallback-binding { color: var(--color-warning); font-family: var(--font-mono); }
.reset-priority { color: var(--color-success); }
.route-evidence + .route-evidence { border-top: 1px solid var(--color-line); padding-top: var(--space-2); margin-top: var(--space-2); }
@container (max-width: 640px) {
  .preset-role-table, caption, tbody, th, td { display: block; width: auto; }
  thead { display: none; }
  th:first-child { width: auto; grid-column: 1 / -1; }
  tr { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); border: 1px solid var(--color-line); border-radius: var(--radius-sm); margin-bottom: var(--space-3); }
  td::before { content: attr(data-label); display: block; font-weight: var(--weight-medium); margin-bottom: var(--space-2); }
  td:last-child { border-bottom: 0; }
}
@container (max-width: 400px) {
  tr { display: block; }
}
</style>
