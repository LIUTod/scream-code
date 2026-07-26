<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import ChatView from './components/ChatView.vue';

type Theme = 'light' | 'dark' | 'system';

const theme = ref<Theme>('system');

const THEME_COLORS: Record<'light' | 'dark', string> = {
  light: '#ffffff',
  dark: '#0d1117',
};

function applyTheme() {
  const root = document.documentElement;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const effective = theme.value === 'system' ? (prefersDark ? 'dark' : 'light') : theme.value;
  root.dataset.theme = effective;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[effective]);
}

function setTheme(t: Theme) {
  theme.value = t;
  localStorage.setItem('scream-theme', t);
  applyTheme();
}

onMounted(() => {
  const saved = localStorage.getItem('scream-theme') as Theme | null;
  if (saved) theme.value = saved;
  applyTheme();
});

watch(theme, applyTheme);

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
</script>

<template>
  <div class="app">
    <div class="theme-switcher">
      <button
        v-for="t in ['light', 'dark', 'system'] as Theme[]"
        :key="t"
        :class="['theme-btn', { active: theme === t }]"
        :title="t === 'light' ? '浅色' : t === 'dark' ? '深色' : '跟随系统'"
        @click="setTheme(t)"
      >
        {{ t === 'light' ? '☀️' : t === 'dark' ? '🌙' : '⚙️' }}
      </button>
    </div>
    <ChatView />
  </div>
</template>

<style scoped>
.app {
  position: relative;
}
.theme-switcher {
  position: fixed;
  top: var(--space-3);
  right: var(--space-5);
  z-index: var(--z-overlay);
  display: flex;
  gap: var(--space-1);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  padding: var(--space-1);
  box-shadow: var(--shadow-sm);
}
.theme-btn {
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2);
  cursor: pointer;
  font-size: var(--font-size-base);
  opacity: 0.6;
  transition: opacity var(--dur-fast), background var(--dur-fast);
}
.theme-btn.active,
.theme-btn:hover {
  background: var(--color-hover);
  opacity: 1;
}
@media (max-width: 640px) {
  .theme-switcher {
    top: var(--space-2);
    right: var(--space-3);
  }
}
</style>
