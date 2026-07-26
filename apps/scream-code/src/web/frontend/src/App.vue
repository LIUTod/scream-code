<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import ChatView from './components/ChatView.vue';

type Theme = 'light' | 'dark' | 'system';

const theme = ref<Theme>('system');

function applyTheme() {
  const root = document.documentElement;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const effective = theme.value === 'system' ? (prefersDark ? 'dark' : 'light') : theme.value;
  root.dataset.theme = effective;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', effective === 'dark' ? '#0d1117' : '#ffffff');
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
  top: 12px;
  right: 20px;
  z-index: 50;
  display: flex;
  gap: 4px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px;
}
.theme-btn {
  background: transparent;
  border: none;
  border-radius: 6px;
  padding: 6px 8px;
  cursor: pointer;
  font-size: 14px;
  opacity: 0.6;
}
.theme-btn.active, .theme-btn:hover {
  background: var(--bg);
  opacity: 1;
}
@media (max-width: 640px) {
  .theme-switcher {
    top: 8px;
    right: 12px;
  }
}
</style>
