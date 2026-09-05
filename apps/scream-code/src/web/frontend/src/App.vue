<script setup lang="ts">
import { ref, onBeforeUnmount, onMounted, watch, provide } from 'vue';
import WebShell from './components/WebShell.vue';
import ImageLightbox from './components/ImageLightbox.vue';
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
  const prev = theme.value;
  theme.value = t;
  try {
    localStorage.setItem('scream-theme', t);
  } catch {
    // Storage can be unavailable in restricted/private browsing contexts.
  }
  if (prev === t) return;
  const root = document.documentElement;
  const prefersReduced =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // G5.3: circular wipe via the View Transition API when available and motion
  // is allowed; otherwise fall back to the CSS class cross-fade below.
  const apply = () => {
    root.classList.add('theme-transition');
    applyTheme();
    if (themeTimer !== null) clearTimeout(themeTimer);
    themeTimer = window.setTimeout(() => root.classList.remove('theme-transition'), 320);
  };
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { finished: Promise<void> };
  };
  if (typeof doc.startViewTransition === 'function' && !prefersReduced) {
    const transition = doc.startViewTransition(() => {
      applyTheme();
    });
    // The finished promise rejects when a newer transition supersedes this
    // one (rapid theme toggling); swallow it and still clear the CSS class.
    void transition.finished.then(
      () => root.classList.remove('theme-transition'),
      () => {
        root.classList.remove('theme-transition');
      },
    );
    return;
  }
  apply();
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
    <ImageLightbox />
    <Toast />
  </div>
</template>

<style scoped>
.app {
  position: relative;
  height: 100%;
}
</style>
