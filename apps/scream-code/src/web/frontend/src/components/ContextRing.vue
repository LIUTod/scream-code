<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    /** Context usage: fraction 0..1 or percent 0..100. */
    usage?: number;
    size?: number;
  }>(),
  { usage: undefined, size: 16 },
);

const fraction = computed(() => {
  if (props.usage === undefined || Number.isNaN(props.usage)) return 0;
  const f = props.usage > 1 ? props.usage / 100 : props.usage;
  return Math.min(1, Math.max(0, f));
});

const percent = computed(() => Math.round(fraction.value * 100));

const strokeWidth = 2;
const radius = computed(() => (props.size - strokeWidth) / 2);
const circumference = computed(() => 2 * Math.PI * radius.value);
const dashOffset = computed(() => circumference.value * (1 - fraction.value));

const tone = computed(() => {
  if (fraction.value >= 0.9) return 'var(--color-danger)';
  if (fraction.value >= 0.7) return 'var(--color-warning)';
  return 'var(--color-accent)';
});
</script>

<template>
  <span
    class="context-ring"
    role="img"
    :title="`上下文占用 ${percent}%`"
    :aria-label="`上下文占用 ${percent}%`"
  >
    <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`">
      <circle
        class="ring-track"
        :cx="size / 2"
        :cy="size / 2"
        :r="radius"
        :stroke-width="strokeWidth"
        fill="none"
      />
      <circle
        class="ring-value"
        :cx="size / 2"
        :cy="size / 2"
        :r="radius"
        :stroke-width="strokeWidth"
        fill="none"
        stroke-linecap="round"
        :stroke-dasharray="circumference"
        :stroke-dashoffset="dashOffset"
        :transform="`rotate(-90 ${size / 2} ${size / 2})`"
      />
    </svg>
  </span>
</template>

<style scoped>
.context-ring {
  display: inline-flex;
  align-items: center;
  line-height: 0;
  flex-shrink: 0;
}
.ring-track {
  stroke: var(--color-line);
}
.ring-value {
  stroke: v-bind(tone);
  transition: stroke-dashoffset var(--dur-slow) var(--ease-out), stroke var(--dur-base);
}
</style>
