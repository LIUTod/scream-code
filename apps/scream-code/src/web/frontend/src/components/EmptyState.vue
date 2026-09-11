<script setup lang="ts">
import { onMounted, ref } from 'vue';

withDefaults(
  defineProps<{
    workDir?: string | null;
    model?: string | null;
    contextUsage?: number | null;
    connected?: boolean;
  }>(),
  { workDir: null, model: null, contextUsage: null, connected: false },
);

const emit = defineEmits<{
  (e: 'pick', text: string): void;
}>();

/** G5.5: recent prompts recorded by the client (localStorage key must match). */
const RECENT_KEY = 'scream-recent-prompts';
const recentPrompts = ref<string[]>([]);
onMounted(() => {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) recentPrompts.value = parsed.filter((x): x is string => typeof x === 'string').slice(0, 4);
    }
  } catch {
    recentPrompts.value = [];
  }
});

function fmtContext(usage: number | null | undefined): string {
  if (usage === null || usage === undefined) return '—';
  // Context usage may be a 0..1 fraction or 0..100 percent; normalise for display.
  const pct = usage <= 1 ? Math.round(usage * 100) : Math.round(usage);
  return `${Math.min(pct, 100)}%`;
}
</script>

<template>
  <div class="empty-state">
    <div class="empty-logo">
      <img src="/icon.ico" alt="Scream" class="logo-img" />
    </div>
    <h1 class="empty-title">Scream Web UI</h1>
    <p class="empty-subtitle">给 Scream 发消息，开始处理你的任务</p>

    <div v-if="recentPrompts.length > 0" class="recent" aria-label="最近输入">
      <span class="recent-label">最近</span>
      <div class="recent-chips">
        <button
          v-for="(p, i) in recentPrompts"
          :key="`${i}-${p}`"
          class="recent-chip"
          :title="p"
          @click="emit('pick', p)"
        >
          {{ p }}
        </button>
      </div>
    </div>

    <div v-if="workDir" class="empty-workdir" :title="workDir">
      <span class="workdir-label">工作目录</span>
      <span class="workdir-path">{{ workDir }}</span>
    </div>

    <div class="empty-status" aria-label="连接与模型状态">
      <span class="status-dot" :class="connected ? 'on' : 'off'" />
      <span class="status-item">{{ connected ? '已连接' : '未连接' }}</span>
      <template v-if="model">
        <span class="status-sep">·</span>
        <span class="status-item">模型 {{ model }}</span>
      </template>
      <template v-if="contextUsage !== null && contextUsage !== undefined">
        <span class="status-sep">·</span>
        <span class="status-item">上下文 {{ fmtContext(contextUsage) }}</span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
  padding: var(--space-8) var(--space-4);
  color: var(--color-text-muted);
}

.empty-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  background: var(--color-accent-soft);
  border: 1px solid var(--color-accent-bd);
  border-radius: var(--radius-xl);
  box-shadow: 0 0 24px var(--color-accent-glow), var(--shadow-sm);
  overflow: hidden;
}

.logo-img {
  width: 36px;
  height: 36px;
  object-fit: contain;
}

.empty-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.01em;
  background: linear-gradient(120deg, var(--color-text) 30%, var(--color-accent) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
}

.empty-subtitle {
  margin: 0;
  font-size: var(--font-size-base);
}

.empty-workdir {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-5);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  max-width: 100%;
}
.recent {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-4);
  max-width: 100%;
}
.recent-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-faint);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.recent-chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
  max-width: 560px;
}
.recent-chip {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 4px 12px;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}
.recent-chip:hover {
  border-color: var(--color-accent-bd);
  color: var(--color-text);
  background: var(--color-hover);
}
.workdir-label {
  color: var(--color-text-faint);
  flex-shrink: 0;
}
.workdir-path {
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

.empty-status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-4);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  box-shadow: var(--shadow-xs);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  max-width: 90%;
  flex-wrap: wrap;
  justify-content: center;
}
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-text-faint);
}
.status-dot.on {
  background: var(--color-success);
  box-shadow: 0 0 6px var(--color-success);
}
.status-sep { opacity: 0.4; }
.status-item { white-space: nowrap; }

</style>
