<script setup lang="ts">
/**
 * New-session confirmation dialog: pick a workspace and a model first, then the
 * session is actually created.
 *
 * Replaces the old "clicking new silently returns home", where clicking new from
 * the home screen appeared to do nothing at all. Now the entry point is a
 * confirmation dialog; once confirmed it materialises the session and enters the
 * chat view. An empty workspace = follow the server's startup directory; no model
 * selected = follow the server default.
 */
import { computed, ref, watch } from 'vue';

import Dialog from './ui/Dialog.vue';
import Button from './ui/Button.vue';
import type { ModelInfo } from '../types';

const props = defineProps<{
  open: boolean;
  models: ModelInfo[];
  recentWorkDirs: string[];
  defaultDir: string;
  /** Model alias currently in effect (empty string when there is no session). */
  currentModel: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'confirm', payload: { workDir: string | null; model: string | null }): void;
}>();

const workDirInput = ref(props.defaultDir);
const selectedModel = ref<string | null>(props.currentModel || null);

// Resets to "server default + current model" on every open; an unconfirmed draft from last time is not remembered.
watch(
  () => props.open,
  (v) => {
    if (!v) return;
    workDirInput.value = props.defaultDir;
    selectedModel.value = props.currentModel || null;
  },
  { immediate: true },
);

const workDirValid = computed(() => {
  const v = workDirInput.value.trim();
  if (!v) return true; // empty = server default workspace
  return v.startsWith('/');
});

const workDirError = computed(() =>
  workDirInput.value.trim() && !workDirValid.value
    ? '请输入绝对路径（如 /home/user/projects）'
    : '',
);

function pickRecent(dir: string): void {
  workDirInput.value = dir;
}

function onConfirm(): void {
  const dir = workDirInput.value.trim();
  emit('confirm', { workDir: dir || null, model: selectedModel.value });
}
</script>

<template>
  <Dialog :open="open" title="新建会话" max-width="480px" @close="emit('close')">
    <div class="nsm-body">
      <section class="nsm-section">
        <div class="nsm-label">工作区</div>
        <input
          v-model="workDirInput"
          class="nsm-input"
          type="text"
          spellcheck="false"
          :placeholder="defaultDir || '服务器默认工作区'"
          :class="{ 'is-invalid': !!workDirError }"
        />
        <div v-if="workDirError" class="nsm-error">{{ workDirError }}</div>
        <div v-if="recentWorkDirs.length" class="nsm-recents">
          <button
            v-for="d in recentWorkDirs"
            :key="d"
            type="button"
            class="nsm-recent"
            :class="{ 'is-active': workDirInput === d }"
            :title="d"
            @click="pickRecent(d)"
          >
            {{ d.split('/').filter(Boolean).pop() || d }}
          </button>
        </div>
      </section>

      <section class="nsm-section">
        <div class="nsm-label">模型</div>
        <div class="nsm-models" role="radiogroup" aria-label="选择模型">
          <button
            type="button"
            class="nsm-model"
            :class="{ 'is-active': selectedModel === null }"
            role="radio"
            :aria-checked="selectedModel === null"
            @click="selectedModel = null"
          >
            <span class="nsm-model-name">跟随服务器默认</span>
          </button>
          <button
            v-for="m in models"
            :key="m.alias"
            type="button"
            class="nsm-model"
            :class="{ 'is-active': selectedModel === m.alias }"
            role="radio"
            :aria-checked="selectedModel === m.alias"
            @click="selectedModel = m.alias"
          >
            <span class="nsm-model-name">{{ m.displayName || m.model }}</span>
            <span class="nsm-model-alias">{{ m.provider }}/{{ m.model }}</span>
          </button>
        </div>
      </section>
    </div>

    <template #footer>
      <Button variant="ghost" @click="emit('close')">取消</Button>
      <Button variant="primary" :disabled="!workDirValid" @click="onConfirm">进入新会话</Button>
    </template>
  </Dialog>
</template>

<style scoped>
.nsm-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
.nsm-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.nsm-label {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--color-text-muted);
  letter-spacing: 0.04em;
}
.nsm-input {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-sm);
  font-family: var(--font-mono);
  color: var(--color-text);
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  outline: none;
}
.nsm-input:focus-visible {
  border-color: var(--color-accent);
  box-shadow: var(--glow-focus);
}
.nsm-input.is-invalid {
  border-color: var(--color-danger);
}
.nsm-error {
  font-size: var(--font-size-xs);
  color: var(--color-danger);
}
.nsm-recents {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}
.nsm-recent {
  padding: 2px var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-full);
  cursor: pointer;
}
.nsm-recent:hover {
  color: var(--color-text);
  background: var(--color-hover);
}
.nsm-recent.is-active {
  color: var(--color-text);
  border-color: var(--color-accent);
}
/* Model list: fixed height with scrolling, instant colour change on row hover (no colour transition). */
.nsm-models {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow-y: auto;
  padding: var(--space-1);
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
}
.nsm-model {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-sm);
  text-align: left;
  color: var(--color-text);
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.nsm-model:hover {
  background: var(--color-hover);
}
.nsm-model.is-active {
  background: var(--color-selected);
  font-weight: 600;
}
.nsm-model-alias {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--color-text-faint);
}
</style>
