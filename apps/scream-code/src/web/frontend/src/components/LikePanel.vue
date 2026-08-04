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
      <div><span>偏好设置</span><small>/like 用户偏好</small></div>
      <SvgIcon name="heart" :size="19" />
    </div>
    <div class="like-fields">
      <div v-for="f in fields" :key="f.key" class="like-field">
        <span class="like-label">{{ f.label }}</span>
        <span class="like-value">{{ (like[f.key] ?? '').trim() || '未设置' }}</span>
      </div>
    </div>
    <button class="like-edit" @click="open">编辑偏好</button>

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
.panel-section { padding:17px; border:1px solid var(--color-line); border-radius:14px; background:var(--color-surface); box-shadow:0 2px 8px rgba(20,35,24,.03); }
.section-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:14px; color:var(--color-accent); }
.section-heading > div { display:flex; flex-direction:column; }
.section-heading span { color:var(--color-text); font-size:14px; font-weight:700; }
.section-heading small { margin-top:4px; color:var(--color-text-faint); font-size:10px; font-weight:400; }
.like-fields { display:flex; flex-direction:column; gap:8px; margin-bottom:12px; }
.like-field { display:flex; flex-direction:column; gap:2px; }
.like-label { color:var(--color-text-faint); font-size:10px; font-weight:600; text-transform:uppercase; }
.like-value { color:var(--color-text); font-size:12px; word-break:break-word; }
.like-edit { width:100%; height:32px; border:1px solid var(--color-line); border-radius:8px; background:var(--color-surface-sunken); color:var(--color-text); font-size:12px; cursor:pointer; }
.like-edit:hover { border-color:var(--color-accent-bd); color:var(--color-accent); }
.dialog-overlay { position:fixed; inset:0; background:rgba(0,0,0,.4); display:flex; align-items:center; justify-content:center; z-index:50; }
.dialog { width:380px; max-width:calc(100vw - 40px); padding:20px; border-radius:14px; background:var(--color-surface); border:1px solid var(--color-line); display:flex; flex-direction:column; gap:12px; }
.dialog-title { font-size:15px; font-weight:700; color:var(--color-text); }
.dialog-field { display:flex; flex-direction:column; gap:5px; }
.dialog-field span { font-size:11px; color:var(--color-text-faint); }
.dialog-field input { padding:8px 10px; border:1px solid var(--color-line); border-radius:8px; background:var(--color-surface-sunken); color:var(--color-text); font-size:12px; }
.dialog-error { color:var(--color-error, #e5534b); font-size:11px; }
.dialog-actions { display:flex; justify-content:flex-end; gap:8px; }
.dialog-actions button { padding:7px 14px; border-radius:8px; border:1px solid var(--color-line); background:var(--color-surface-sunken); color:var(--color-text); font-size:12px; cursor:pointer; }
.dialog-actions button:last-child { border-color:var(--color-accent); background:var(--color-accent-soft); color:var(--color-accent); }
.dialog-actions button:disabled { opacity:.5; cursor:default; }
</style>
