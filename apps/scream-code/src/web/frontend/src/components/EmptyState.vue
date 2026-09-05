<script setup lang="ts">
import { onMounted, ref } from 'vue';
import SvgIcon from './ui/SvgIcon.vue';

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

const SUGGESTIONS = [
  { icon: 'edit', title: '帮我写一个函数', prompt: '帮我写一个函数' },
  { icon: 'clipboard', title: '解释这段代码', prompt: '解释这段代码' },
  { icon: 'activity', title: '调试这个问题', prompt: '调试这个问题' },
];

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

    <div class="suggestions">
      <button
        v-for="s in SUGGESTIONS"
        :key="s.title"
        class="suggestion-card"
        @click="emit('pick', s.prompt)"
      >
        <span class="suggestion-icon"><SvgIcon :name="s.icon" :size="22" /></span>
        <span class="suggestion-title">{{ s.title }}</span>
      </button>
    </div>

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

    <div class="empty-shortcuts" aria-hidden="true">
      <span><kbd>⌘K</kbd> 搜索会话</span>
      <span><kbd>⌘N</kbd> 新建会话</span>
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
  width: 72px;
  height: 72px;
  background: var(--color-accent-soft);
  border: 1px solid var(--color-accent-bd);
  border-radius: var(--radius-xl);
  box-shadow: 0 0 24px var(--color-accent-glow), var(--shadow-sm);
  overflow: hidden;
}

.logo-img {
  width: 48px;
  height: 48px;
  object-fit: contain;
}

.empty-title {
  margin: 0;
  font-size: 28px;
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

.suggestions {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-4);
  flex-wrap: wrap;
  justify-content: center;
}

.suggestion-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-5) var(--space-6);
  min-width: 128px;
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xs);
  cursor: pointer;
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text);
  transition:
    border-color var(--dur-base) var(--ease-out),
    background var(--dur-base) var(--ease-out),
    box-shadow var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}
.suggestion-card:hover {
  border-color: var(--color-accent-bd, var(--color-accent));
  background: var(--color-accent-soft, var(--color-hover));
  box-shadow: var(--shadow-md), 0 0 16px var(--color-accent-glow);
  transform: translateY(-2px);
}
.suggestion-card:active {
  transform: translateY(0);
  box-shadow: var(--shadow-xs);
}
.suggestion-icon {
  font-size: var(--font-size-2xl);
}
.suggestion-title {
  white-space: nowrap;
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

.empty-shortcuts {
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  color: var(--color-text-faint);
  font-size: 11px;
}
.empty-shortcuts kbd {
  display: inline-block;
  padding: 1px 5px;
  border: 1px solid var(--color-line);
  border-bottom-width: 2px;
  border-radius: var(--radius-xs);
  background: var(--color-surface);
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-text-muted);
}

@media (max-width: 640px) {
  .suggestions {
    flex-direction: column;
    width: 100%;
    max-width: 320px;
  }
  .suggestion-card {
    flex-direction: row;
    justify-content: flex-start;
    min-width: 0;
  }
}
</style>
