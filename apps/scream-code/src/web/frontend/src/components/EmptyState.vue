<script setup lang="ts">
withDefaults(
  defineProps<{
    workDir?: string | null;
  }>(),
  { workDir: null },
);

const emit = defineEmits<{
  (e: 'pick', text: string): void;
}>();

const SUGGESTIONS = [
  { icon: '✍️', title: '帮我写一个函数', prompt: '帮我写一个函数' },
  { icon: '📖', title: '解释这段代码', prompt: '解释这段代码' },
  { icon: '🐞', title: '调试这个问题', prompt: '调试这个问题' },
];
</script>

<template>
  <div class="empty-state">
    <div class="empty-logo">■</div>
    <h1 class="empty-title">Scream Web UI</h1>
    <p class="empty-subtitle">给 Scream 发消息，开始处理你的任务</p>

    <div class="suggestions">
      <button
        v-for="s in SUGGESTIONS"
        :key="s.title"
        class="suggestion-card"
        @click="emit('pick', s.prompt)"
      >
        <span class="suggestion-icon">{{ s.icon }}</span>
        <span class="suggestion-title">{{ s.title }}</span>
      </button>
    </div>

    <div v-if="workDir" class="empty-workdir" :title="workDir">
      <span class="workdir-label">工作目录</span>
      <span class="workdir-path">{{ workDir }}</span>
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
  gap: var(--space-3);
  padding: var(--space-6) var(--space-4);
  color: var(--color-text-muted);
}

.empty-logo {
  font-size: 44px;
  color: var(--color-accent);
  line-height: 1;
}

.empty-title {
  margin: 0;
  font-size: var(--font-size-2xl);
  font-weight: 700;
  color: var(--color-text);
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
  padding: var(--space-4) var(--space-5);
  min-width: 120px;
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  cursor: pointer;
  font-size: var(--font-size-sm);
  color: var(--color-text);
  transition:
    border-color var(--dur-fast),
    background var(--dur-fast),
    transform var(--dur-fast);
}
.suggestion-card:hover {
  border-color: var(--color-accent-bd, var(--color-accent));
  background: var(--color-accent-soft, var(--color-hover));
  transform: translateY(-1px);
}
.suggestion-icon {
  font-size: var(--font-size-xl);
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
  font-size: var(--font-size-xs);
  max-width: 80%;
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
