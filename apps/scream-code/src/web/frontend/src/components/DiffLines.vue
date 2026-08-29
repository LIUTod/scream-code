<!-- Line-by-line diff renderer. Shared by EditToolCard and any future
     diff display (e.g. a diff panel). Pure presentation, no logic. -->
<script setup lang="ts">
import type { DiffLine } from '../utils/diff';

defineProps<{ lines: DiffLine[] }>();
</script>

<template>
  <div class="diff-lines">
    <div v-for="(line, i) in lines" :key="i" class="dl" :class="`dl-${line.type}`">
      <span class="dl-gutter old">{{ line.oldNo ?? '' }}</span>
      <span class="dl-gutter new">{{ line.newNo ?? '' }}</span>
      <span class="dl-sign">{{ line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ' }}</span>
      <span class="dl-text">{{ line.text }}</span>
    </div>
  </div>
</template>

<style scoped>
.diff-lines {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  line-height: 1.5;
  width: max-content;
  min-width: 100%;
  overflow-x: auto;
  border-radius: var(--radius-sm);
}
.dl {
  display: flex;
  align-items: flex-start;
  min-height: 18px;
  white-space: pre;
  width: 100%;
}
.dl:hover .dl-text {
  background: var(--color-hover);
}
.dl-gutter {
  flex: none;
  width: 36px;
  padding: 0 6px;
  text-align: right;
  color: var(--color-text-faint);
  user-select: none;
  font-variant-numeric: tabular-nums;
}
.dl-gutter.new {
  border-right: 1px solid var(--color-line);
}
.dl-sign {
  flex: none;
  width: 16px;
  text-align: center;
  user-select: none;
  font-weight: 600;
}
.dl-text {
  flex: none;
  padding-right: 14px;
  white-space: pre;
  color: var(--color-text);
}

.dl-add {
  background: var(--color-success-soft);
  box-shadow: inset 2px 0 0 var(--color-success);
}
.dl-add .dl-sign { color: var(--color-success); }

.dl-del {
  background: var(--color-danger-soft);
  box-shadow: inset 2px 0 0 var(--color-danger);
}
.dl-del .dl-sign { color: var(--color-danger); }

.dl-context .dl-sign { color: var(--color-text-faint); }
</style>
