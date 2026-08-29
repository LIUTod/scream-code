<script setup lang="ts">
import { ref, onBeforeUnmount, onMounted, watch, provide } from 'vue';
import WebShell from './components/WebShell.vue';
import Toast from './components/ui/Toast.vue';
import type { Theme } from './theme';

const theme = ref<Theme>('system');
const effectiveTheme = ref<'light' | 'dark'>('dark');
provide('effectiveTheme', effectiveTheme);
provide('theme', theme);

const THEME_COLORS: Record<'light' | 'dark', string> = {
  light: '#ffffff',
  dark: '#101113',
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
  try {
    localStorage.setItem('scream-theme', t);
  } catch {
    // Storage can be unavailable in restricted/private browsing contexts.
  }
  const root = document.documentElement;
  root.classList.add('theme-transition');
  applyTheme();
  if (themeTimer !== null) clearTimeout(themeTimer);
  themeTimer = window.setTimeout(() => root.classList.remove('theme-transition'), 320);
}
provide('setTheme', setTheme);

onMounted(() => {
  try {
    const saved = localStorage.getItem('scream-theme') as Theme | null;
    if (saved === 'light' || saved === 'dark' || saved === 'system') theme.value = saved;
  } catch {
    // Fall back to the system theme when storage is unavailable.
  }
  applyTheme();
});

watch(theme, applyTheme);

const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
colorScheme.addEventListener('change', applyTheme);
onBeforeUnmount(() => {
  colorScheme.removeEventListener('change', applyTheme);
  if (themeTimer !== null) clearTimeout(themeTimer);
  document.documentElement.classList.remove('theme-transition');
});
</script>

<template>
  <div class="app">
    <WebShell />
    <Toast />
  </div>
</template>

<style scoped>
.app {
  position: relative;
  height: 100%;
}
</style>
