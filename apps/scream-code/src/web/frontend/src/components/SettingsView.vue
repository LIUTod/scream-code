<script setup lang="ts">
import { inject, ref, watch } from 'vue';
import type { Ref } from 'vue';
import type { LikePreferences } from '../types';
import type { Theme } from '../theme';
import SvgIcon from './ui/SvgIcon.vue';
import Button from './ui/Button.vue';

const props = withDefaults(
  defineProps<{ like?: LikePreferences }>(),
  { like: () => ({}) },
);

const emit = defineEmits<{
  (e: 'update-like', prefs: LikePreferences): void;
}>();

/* ── Theme (light / dark / system) ───────────────────────────────────────── */
const theme = inject<Ref<Theme>>('theme', ref('system' as Theme));
const setTheme = inject<(t: Theme) => void>('setTheme', () => {});

const THEME_OPTIONS: { id: Theme; label: string; icon: string }[] = [
  { id: 'light', label: '浅色', icon: 'sun' },
  { id: 'dark', label: '深色', icon: 'moon' },
  { id: 'system', label: '跟随系统', icon: 'monitor' },
];

/* ── Like preferences (nickname / tone / other / doNot) ───────────────────── */
const draft = ref<LikePreferences>({ ...props.like });
const saved = ref(false);

watch(
  () => props.like,
  (v) => {
    draft.value = { ...v };
  },
);

const FIELDS: { key: keyof LikePreferences; label: string; hint: string }[] = [
  { key: 'nickname', label: '称呼', hint: 'AI 如何称呼你' },
  { key: 'tone', label: '语气', hint: '回复的语气风格' },
  { key: 'other', label: '偏好', hint: '其他偏好说明' },
  { key: 'doNot', label: '禁止事项', hint: '明确禁止的行为' },
];

function save() {
  emit('update-like', cleanup());
  saved.value = true;
  setTimeout(() => (saved.value = false), 1500);
}

function cleanup(): LikePreferences {
  const out: LikePreferences = {};
  for (const f of FIELDS) {
    const v = draft.value[f.key];
    if (typeof v === 'string' && v.trim()) out[f.key] = v.trim();
  }
  return out;
}
</script>

<template>
  <div class="settings">
    <div class="settings-inner">
      <h1 class="settings-title">设置</h1>

      <section class="settings-section">
        <h2 class="section-title">外观</h2>
        <div class="theme-grid" role="radiogroup" aria-label="主题">
          <button
            v-for="opt in THEME_OPTIONS"
            :key="opt.id"
            role="radio"
            :aria-checked="theme === opt.id"
            :class="['theme-option', { active: theme === opt.id }]"
            @click="setTheme(opt.id)"
          >
            <SvgIcon :name="opt.icon" :size="20" />
            <span>{{ opt.label }}</span>
          </button>
        </div>
      </section>

      <section class="settings-section">
        <h2 class="section-title">偏好设置</h2>
        <div class="like-fields">
          <label v-for="f in FIELDS" :key="f.key" class="like-field">
            <span class="like-label">{{ f.label }}</span>
            <input
              v-model="draft[f.key]"
              class="like-input"
              :placeholder="f.hint"
              :aria-label="f.label"
            />
          </label>
          <div class="like-actions">
            <Button variant="primary" @click="save">保存偏好</Button>
            <span v-if="saved" class="saved-hint">已保存</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: var(--space-6) var(--space-8);
  background: transparent;
}
.settings-inner {
  max-width: var(--content-max);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
.settings-title {
  font-size: var(--font-size-2xl);
  font-weight: 700;
  color: var(--color-text);
}
.settings-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.section-title {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--color-text-muted);
}
.theme-grid {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.theme-option {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 40px;
  padding: 0 var(--space-4);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}
.theme-option:hover {
  color: var(--color-text);
  border-color: var(--color-line-strong);
}
.theme-option.active {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-on-accent);
  font-weight: 600;
}
.like-fields {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 480px;
}
.like-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.like-label {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text);
}
.like-input {
  height: 40px;
  padding: 0 var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-family: inherit;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.like-input:focus {
  outline: none;
  border-color: var(--color-accent-bd);
  box-shadow: var(--glow-focus);
}
.like-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-1);
}
.saved-hint {
  font-size: var(--font-size-sm);
  color: var(--color-success);
}
@media (max-width: 640px) {
  .settings {
    padding: var(--space-4) var(--space-3);
  }
  .theme-option {
    min-height: 44px;
  }
}
</style>
