<script setup lang="ts">
import type { Theme } from '../theme';
import SvgIcon from './ui/SvgIcon.vue';

withDefaults(defineProps<{
  theme: Theme;
  busy?: boolean;
}>(), { busy: false });

const emit = defineEmits<{
  (e: 'expand'): void;
  (e: 'select', module: 'run' | 'git' | 'todo' | 'like' | 'goal'): void;
  (e: 'cycle-theme'): void;
}>();

const MODULES: { key: 'run' | 'git' | 'todo' | 'like' | 'goal'; icon: string; label: string }[] = [
  { key: 'run', icon: 'activity', label: '运行状态' },
  { key: 'git', icon: 'git-branch', label: 'Git 变更' },
  { key: 'todo', icon: 'check', label: '核心 Todo' },
  { key: 'like', icon: 'sparkles', label: '偏好设置' },
  { key: 'goal', icon: 'target', label: 'Goal 管理' },
];

const themeIcon: Record<Theme, string> = { light: 'sun', dark: 'moon', system: 'monitor' };
</script>

<template>
  <div class="right-rail" role="toolbar" aria-label="右侧功能区">
    <div class="rail-stack">
      <button class="rail-btn rail-toggle" title="展开面板" aria-label="展开右侧面板" @click="emit('expand')">
        <SvgIcon name="panel-left" :size="18" />
      </button>
      <div class="rail-group">
        <button
          v-for="module in MODULES"
          :key="module.key"
          class="rail-btn"
          :title="module.label"
          :aria-label="module.label"
          @click="emit('select', module.key)"
        >
          <SvgIcon :name="module.icon" :size="20" />
          <span v-if="module.key === 'run' && busy" class="live-dot" />
        </button>
      </div>
    </div>
    <button class="rail-btn" :title="`切换主题（当前 ${theme}）`" :aria-label="`切换主题（当前 ${theme}）`" @click="emit('cycle-theme')">
      <SvgIcon :name="themeIcon[theme]" :size="20" />
    </button>
  </div>
</template>

<style scoped>
/* Mirrors the collapsed sidebar: same 64px width, same background/border/button treatment. */
.right-rail {
  width: var(--sidebar-width-collapsed);
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  padding: 18px 0 14px;
  border-left: 1px solid var(--color-line);
  background: var(--color-surface);
}
.rail-stack { display:flex; flex-direction:column; align-items:center; gap:10px; }
.rail-group { display: flex; flex-direction: column; gap: 6px; align-items: center; }
.rail-btn {
  position: relative;
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--color-text-faint);
  cursor: pointer;
}
.rail-toggle { color: var(--color-text-muted); }
.rail-btn:hover { color: var(--color-accent); background: var(--color-accent-soft); }
.live-dot {
  position: absolute;
  top: 7px;
  right: 7px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-accent);
  animation: rail-pulse 1.2s infinite;
}
@keyframes rail-pulse { 50% { opacity: 0.25; } }
</style>
