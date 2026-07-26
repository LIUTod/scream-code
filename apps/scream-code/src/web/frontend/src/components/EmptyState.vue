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
  box-shadow: var(--shadow-xs);
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
