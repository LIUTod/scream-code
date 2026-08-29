<script setup lang="ts">
import { ref } from 'vue';
import type { LikePreferences } from '../types';
import SvgIcon from './ui/SvgIcon.vue';

const props = defineProps<{
  like: LikePreferences;
  updateLike: (prefs: LikePreferences) => Promise<boolean>;
}>();

const editing = ref(false);
const saving = ref(false);
const error = ref('');
const draft = ref<LikePreferences>({});

const fields = [
  { key: 'nickname' as const, label: '昵称', placeholder: '用户称呼，如：老板' },
  { key: 'tone' as const, label: '语气', placeholder: 'AI 风格，如：专业不拖沓' },
  { key: 'other' as const, label: '偏好', placeholder: '其他用户偏好' },
  { key: 'doNot' as const, label: '禁止', placeholder: '用户明确不让做的事' },
];

function open(): void {
  draft.value = { ...props.like };
  error.value = '';
  editing.value = true;
}

async function confirm(): Promise<void> {
  saving.value = true;
  error.value = '';
  const ok = await props.updateLike(draft.value);
  saving.value = false;
  if (ok) editing.value = false;
  else error.value = '保存失败';
}
</script>

<template>
  <section class="panel-section like-section">
    <div class="section-heading">
      <span class="head-icon"><SvgIcon name="settings" :size="14" /></span>
      <span class="head-title">偏好设置</span>
      <span class="head-hint">/like 用户偏好</span>
    </div>
    <div class="panel-body">
      <dl class="kv-rows">
        <div v-for="f in fields" :key="f.key" class="kv-row">
          <dt>{{ f.label }}</dt>
          <dd>{{ (like[f.key] ?? '').trim() || '未设置' }}</dd>
        </div>
      </dl>
      <div class="panel-actions">
        <button class="like-edit" @click="open">编辑偏好</button>
      </div>
    </div>

    <div v-if="editing" class="dialog-overlay" @click.self="editing = false">
      <div class="dialog">
        <div class="dialog-title">编辑用户偏好</div>
        <label v-for="f in fields" :key="f.key" class="dialog-field">
          <span>{{ f.label }}</span>
          <input v-model="draft[f.key]" :placeholder="f.placeholder" />
        </label>
        <div v-if="error" class="dialog-error">{{ error }}</div>
        <div class="dialog-actions">
          <button @click="editing = false">取消</button>
          <button :disabled="saving" @click="confirm">{{ saving ? '保存中…' : '确认' }}</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Card, header anatomy, kv rows and the action strip come from the shared
   global styles. */
.like-edit {
  min-height: 32px;
  display: inline-flex;
  align-items: center;
  padding: 0 var(--space-3);
  border: 0;
  border-radius: var(--radius-md);
  background: var(--color-accent-soft);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.like-edit:hover { background: var(--color-hover); color: var(--color-accent); }
/* The drawer turns into a `z-index: var(--z-overlay)` layer on mobile, so this
   editor has to sit above it — z-50 used to bury the modal under the panel. */
.dialog-overlay { position:fixed; inset:0; background:rgba(0,0,0,.4); display:flex; align-items:center; justify-content:center; z-index:var(--z-modal); }
.dialog { width:380px; max-width:calc(100vw - 40px); padding:var(--space-5); border-radius:var(--radius-lg); background:var(--color-surface); border:1px solid var(--color-line); display:flex; flex-direction:column; gap:var(--space-3); }
.dialog-title { font-size:var(--font-size-base); font-weight:700; color:var(--color-text); }
.dialog-field { display:flex; flex-direction:column; gap:5px; }
.dialog-field span { font-size:var(--font-size-xs); color:var(--color-text-faint); }
.dialog-field input { height:32px; padding:0 var(--space-2); border:1px solid var(--color-line); border-radius:var(--radius-md); background:var(--color-surface-sunken); color:var(--color-text); font-size:var(--font-size-xs); }
.dialog-error { color:var(--color-danger); font-size:var(--font-size-xs); }
.dialog-actions { display:flex; justify-content:flex-end; gap:var(--space-2); }
.dialog-actions button { min-height:32px; padding:0 var(--space-3); border-radius:var(--radius-md); border:0; background:var(--color-accent-soft); color:var(--color-text-muted); font-size:var(--font-size-xs); cursor:pointer; }
.dialog-actions button:last-child { background:var(--color-accent); color:var(--color-on-accent); }
.dialog-actions button:disabled { opacity:.5; cursor:default; }
</style>
