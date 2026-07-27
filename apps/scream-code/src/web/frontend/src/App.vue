<script setup lang="ts">
import { ref, onMounted, watch, provide } from 'vue';
import ChatView from './components/ChatView.vue';
import Toast from './components/ui/Toast.vue';
import type { Theme } from './theme';

const theme = ref<Theme>('system');
const effectiveTheme = ref<'light' | 'dark'>('dark');
provide('effectiveTheme', effectiveTheme);
provide('theme', theme);

const THEME_COLORS: Record<'light' | 'dark', string> = {
  light: '#f7f8f7',
  dark: '#0d1117',
};

function applyTheme() {
  const root = document.documentElement;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const effective = theme.value === 'system' ? (prefersDark ? 'dark' : 'light') : theme.value;
  effectiveTheme.value = effective;
  root.dataset.theme = effective;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[effective]);
}

let themeTimer: number | null = null;

function setTheme(t: Theme) {
  theme.value = t;
  localStorage.setItem('scream-theme', t);
  // Briefly enable cross-property transitions so the theme swap animates.
  const root = document.documentElement;
  root.classList.add('theme-transition');
  applyTheme();
  if (themeTimer !== null) clearTimeout(themeTimer);
  themeTimer = window.setTimeout(() => root.classList.remove('theme-transition'), 320);
}
provide('setTheme', setTheme);

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
    <ChatView />
    <Toast />
  </div>
</template>

<style scoped>
.app {
  position: relative;
}
</style>
