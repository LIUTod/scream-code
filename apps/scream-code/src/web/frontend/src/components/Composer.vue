<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';

const props = defineProps<{
  busy: boolean;
}>();

const emit = defineEmits<{
  (e: 'send', text: string): void;
  (e: 'abort'): void;
}>();

const text = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);

function autoResize() {
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}

watch(text, autoResize);

function send() {
  const t = text.value.trim();
  if (!t || props.busy) return;
  emit('send', t);
  text.value = '';
  nextTick(() => {
    if (textareaRef.value) textareaRef.value.style.height = 'auto';
  });
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

function abort() {
  emit('abort');
}
</script>

<template>
  <div class="composer">
    <textarea
      ref="textareaRef"
      v-model="text"
      class="composer-input"
      rows="1"
      placeholder="给 Scream 发消息... (Enter 发送, Shift+Enter 换行)"
      :disabled="busy"
      @keydown="onKeydown"
    />
    <div class="composer-actions">
      <button v-if="busy" class="btn btn-danger" @click="abort">停止</button>
      <button v-else class="btn btn-primary" :disabled="!text.trim()" @click="send">发送</button>
    </div>
  </div>
</template>

<style scoped>
.composer {
  display: flex;
  gap: 12px;
  padding: 12px 20px;
  border-top: 1px solid var(--border);
  background: var(--surface);
}
.composer-input {
  flex: 1;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 14px;
  color: var(--text);
  font-size: 14px;
  font-family: inherit;
  resize: none;
  min-height: 44px;
  max-height: 200px;
  line-height: 1.5;
}
.composer-input:focus {
  outline: none;
  border-color: var(--accent);
}
.composer-input:disabled {
  opacity: 0.6;
}
.composer-actions {
  display: flex;
  align-items: flex-end;
}
.btn {
  border: none;
  border-radius: 10px;
  padding: 10px 20px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.btn-primary {
  background: var(--accent);
  color: #000;
}
.btn-danger {
  background: var(--red);
  color: #fff;
}
@media (max-width: 640px) {
  .composer {
    padding: 10px 12px;
  }
  .btn {
    padding: 10px 14px;
  }
}
</style>
