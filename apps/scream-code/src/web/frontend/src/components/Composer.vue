<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { ModelInfo, SessionStatus } from '../types';
import { filterSlashCommands, resolveCommandName, type SlashCommand } from '../commands';
import ContextRing from './ContextRing.vue';
import ModelPicker from './ModelPicker.vue';
import SlashMenu from './SlashMenu.vue';

const props = withDefaults(
  defineProps<{
    busy: boolean;
    status?: SessionStatus;
    sessionId?: string | null;
    models?: ModelInfo[];
  }>(),
  { status: undefined, sessionId: null, models: () => [] },
);

const emit = defineEmits<{
  (e: 'send', text: string): void;
  (e: 'abort'): void;
  (e: 'command', name: string, args?: string): void;
  (e: 'switch-model', alias: string): void;
  (e: 'switch-thinking', level: string): void;
}>();

const text = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);

/* ── Slash command menu ──────────────────────────────────────────────────── */
const slashIndex = ref(0);
/** Set when the user dismisses the menu with Esc; reset on next input change. */
const slashDismissed = ref(false);

const slashQuery = computed(() => {
  const t = text.value;
  if (!t.startsWith('/') || t.includes('\n') || /\s/.test(t.slice(1))) return null;
  return t.slice(1);
});

const slashCommands = computed<SlashCommand[]>(() =>
  slashQuery.value === null ? [] : filterSlashCommands(slashQuery.value),
);

const slashVisible = computed(
  () => slashQuery.value !== null && slashCommands.value.length > 0 && !slashDismissed.value,
);

watch(slashQuery, () => {
  slashIndex.value = 0;
  slashDismissed.value = false;
});

function pickSlashCommand(cmd?: SlashCommand) {
  const chosen = cmd ?? slashCommands.value[slashIndex.value];
  if (!chosen) return;
  if (chosen.acceptsInput) {
    // Keep the command prefix so the user can type arguments, then send.
    // History is recorded when the full `/cmd args` is sent.
    text.value = `/${chosen.name} `;
    slashDismissed.value = true;
    nextTick(() => {
      textareaRef.value?.focus();
      autoResize();
    });
    return;
  }
  pushHistory(`/${chosen.name}`);
  resetInput();
  emit('command', chosen.name);
}

/* ── Steer queue (messages queued while a turn is running) ───────────────── */
const steerQueue = ref<string[]>([]);

// Clear steer queue when switching sessions to prevent cross-session sends.
watch(
  () => props.sessionId,
  () => {
    steerQueue.value = [];
  },
);

watch(
  () => props.busy,
  (busy) => {
    if (!busy && steerQueue.value.length > 0) {
      const [head, ...rest] = steerQueue.value;
      steerQueue.value = rest;
      if (head) emit('send', head);
    }
  },
);

/* ── History recall (↑↓, shell-style) ────────────────────────────────────── */
const HISTORY_LIMIT = 50;
const history = ref<string[]>([]);
const historyIndex = ref(-1);
const historyStash = ref('');

function historyKey(): string {
  return `scream-history:${props.sessionId ?? 'default'}`;
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(historyKey());
    history.value = raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    history.value = [];
  }
  historyIndex.value = -1;
}

function pushHistory(entry: string) {
  if (history.value.at(-1) !== entry) {
    history.value = [...history.value, entry].slice(-HISTORY_LIMIT);
    try {
      localStorage.setItem(historyKey(), JSON.stringify(history.value));
    } catch {
      // Storage full / unavailable — history is best-effort.
    }
  }
  historyIndex.value = -1;
  historyStash.value = '';
}

function recallHistory(direction: 1 | -1, e: KeyboardEvent) {
  const el = textareaRef.value;
  if (!el) return;
  // Only hijack ↑ on the first line and ↓ on the last line.
  const beforeCursor = el.value.slice(0, el.selectionStart ?? 0);
  const afterCursor = el.value.slice(el.selectionEnd ?? 0);
  if (direction === -1 && beforeCursor.includes('\n')) return;
  if (direction === 1 && afterCursor.includes('\n')) return;

  if (direction === -1) {
    if (history.value.length === 0) return;
    e.preventDefault();
    if (historyIndex.value === -1) {
      historyStash.value = text.value;
      historyIndex.value = history.value.length - 1;
    } else if (historyIndex.value > 0) {
      historyIndex.value--;
    }
    text.value = history.value[historyIndex.value] ?? '';
  } else {
    if (historyIndex.value === -1) return;
    e.preventDefault();
    if (historyIndex.value < history.value.length - 1) {
      historyIndex.value++;
      text.value = history.value[historyIndex.value] ?? '';
    } else {
      historyIndex.value = -1;
      text.value = historyStash.value;
    }
  }
  nextTick(() => {
    el.selectionStart = el.selectionEnd = el.value.length;
  });
}

/* ── Draft persistence (per session) ─────────────────────────────────────── */
function draftKey(): string {
  return `scream-draft:${props.sessionId ?? 'default'}`;
}

watch(text, () => {
  autoResize();
  try {
    if (text.value) localStorage.setItem(draftKey(), text.value);
    else localStorage.removeItem(draftKey());
  } catch {
    // Best-effort.
  }
});

watch(
  () => props.sessionId,
  () => {
    loadHistory();
    let draft = '';
    try {
      draft = localStorage.getItem(draftKey()) ?? '';
    } catch {
      draft = '';
    }
    text.value = draft;
    nextTick(autoResize);
  },
  { immediate: true },
);

/* ── Auto-resize ─────────────────────────────────────────────────────────── */
function autoResize() {
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = 'auto';
  const max = Math.round(window.innerHeight * 0.25);
  el.style.height = `${Math.min(Math.max(el.scrollHeight, 36), max)}px`;
}

/* ── Send / queue / abort ────────────────────────────────────────────────── */
function resetInput() {
  text.value = '';
  nextTick(() => {
    if (textareaRef.value) textareaRef.value.style.height = 'auto';
  });
}

function send() {
  const t = text.value.trim();
  if (!t) return;
  if (t.startsWith('/')) {
    const sp = t.indexOf(' ');
    const raw = (sp === -1 ? t.slice(1) : t.slice(1, sp)).toLowerCase();
    const name = resolveCommandName(raw);
    const args = sp === -1 ? '' : t.slice(sp + 1).trim();
    pushHistory(t);
    emit('command', name, args);
    resetInput();
    return;
  }
  if (props.busy) {
    queueSteer();
    return;
  }
  pushHistory(t);
  emit('send', t);
  resetInput();
}

function queueSteer() {
  const t = text.value.trim();
  if (!t) return;
  steerQueue.value = [...steerQueue.value, t];
  resetInput();
}

function onKeydown(e: KeyboardEvent) {
  if (slashVisible.value) {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      slashIndex.value = (slashIndex.value - 1 + slashCommands.value.length) % slashCommands.value.length;
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      slashIndex.value = (slashIndex.value + 1) % slashCommands.value.length;
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      if (e.key === 'Enter' && e.isComposing) return;
      e.preventDefault();
      pickSlashCommand();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      slashDismissed.value = true;
      return;
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    queueSteer();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    if (e.isComposing) return;
    e.preventDefault();
    send();
    return;
  }
  if (e.key === 'ArrowUp') recallHistory(-1, e);
  else if (e.key === 'ArrowDown') recallHistory(1, e);
}

function abort() {
  steerQueue.value = [];
  emit('abort');
}

/* ── Edit & resend entry point ───────────────────────────────────────────── */
function insertText(content: string) {
  text.value = content;
  nextTick(() => {
    autoResize();
    textareaRef.value?.focus();
  });
}

defineExpose({ insertText, openModelPicker });

/* ── Status pills ────────────────────────────────────────────────────────── */
const model = computed(() => props.status?.model);
const permission = computed(() => props.status?.permission);
const contextUsage = computed(() => props.status?.contextUsage);

/* ── Model picker (TUI /model parity) ────────────────────────────────────── */
const pickerOpen = ref(false);

const THINKING_LABELS: Record<string, string> = {
  off: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最大',
};

const thinkingLevel = computed(() => props.status?.thinkingLevel);
const thinkingLabel = computed(() => {
  const level = thinkingLevel.value;
  if (!level || level === 'none') return '';
  return THINKING_LABELS[level] ?? level;
});

/** Whether the model pill is clickable (models list available from backend). */
const modelSwitchable = computed(() => props.models.length > 0);

/** Open the model picker; returns false when no models are configured. */
function openModelPicker(): boolean {
  if (!modelSwitchable.value) return false;
  pickerOpen.value = true;
  return true;
}

function toggleModelPicker() {
  if (!modelSwitchable.value) return;
  pickerOpen.value = !pickerOpen.value;
}

function onApplyModel(alias: string) {
  emit('switch-model', alias);
}

function onApplyThinking(level: string) {
  emit('switch-thinking', level);
}

const permissionClass = computed(() => {
  switch (permission.value) {
    case 'auto': return 'perm-auto';
    case 'yolo': return 'perm-yolo';
    default: return 'perm-manual';
  }
});

const permissionLabel = computed(() => {
  switch (permission.value) {
    case 'auto': return '自动';
    case 'yolo': return 'YOLO';
    default: return '手动';
  }
});
</script>

<template>
  <div class="composer">
    <Transition name="picker">
      <ModelPicker
        v-if="pickerOpen"
        :models="models"
        :current-model="model"
        :current-thinking="thinkingLevel"
        @apply-model="onApplyModel"
        @apply-thinking="onApplyThinking"
        @close="pickerOpen = false"
      />
    </Transition>
    <SlashMenu
      v-if="slashVisible"
      :commands="slashCommands"
      :active-index="slashIndex"
      @select="pickSlashCommand"
      @hover="(i) => (slashIndex = i)"
    />
    <textarea
      ref="textareaRef"
      v-model="text"
      class="composer-input"
      rows="1"
      :placeholder="busy ? '回合进行中：Enter/Ctrl+S 排队消息，随下一轮注入' : '给 Scream 发消息… (Enter 发送, Shift+Enter 换行, / 命令, ↑↓ 历史)'"
      @keydown="onKeydown"
    />

    <div class="composer-footer">
      <div class="composer-pills">
        <button
          v-if="model && modelSwitchable"
          class="pill pill-model pill-btn"
          :title="`当前模型：${model}，点击切换模型 / 思考强度`"
          @click="toggleModelPicker"
        >
          ◆ {{ model }}<template v-if="thinkingLabel"> · {{ thinkingLabel }}</template>
        </button>
        <span v-else-if="model" class="pill pill-model" :title="`当前模型：${model}（启动时通过 --model 指定）`">
          ◆ {{ model }}
        </span>
        <span v-if="permission" :class="['pill', permissionClass]" :title="`权限模式：${permission}`">
          {{ permissionLabel }}
        </span>
        <span v-if="contextUsage !== undefined" class="pill pill-ring">
          <ContextRing :usage="contextUsage" :size="16" />
          <span class="ring-label">上下文</span>
        </span>
        <span v-if="steerQueue.length" class="pill pill-queue" title="运行结束后自动发送">
          已排队 {{ steerQueue.length }} 条
        </span>
      </div>

      <div class="composer-actions">
        <button v-if="busy" class="btn btn-danger" @click="abort">■ 停止</button>
        <button v-else class="btn btn-primary" :disabled="!text.trim()" @click="send">发送 ⏎</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.composer {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
}

.composer-input {
  width: 100%;
  background: var(--color-bg);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  padding: var(--space-2) var(--space-3);
  color: var(--color-text);
  font-size: var(--font-size-base);
  font-family: inherit;
  line-height: 1.5;
  resize: none;
  min-height: 36px;
  max-height: 25vh;
  box-shadow: var(--shadow-xs);
  transition:
    border-color var(--dur-base) var(--ease-out),
    box-shadow var(--dur-base) var(--ease-out);
}
.composer-input:hover:not(:focus) {
  border-color: var(--color-line-strong);
}
.composer-input:focus {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft), 0 0 16px var(--color-accent-glow);
}
.composer-input::placeholder {
  color: var(--color-text-faint);
  opacity: 0.8;
}

.composer-footer {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.composer-pills {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.composer-pills::-webkit-scrollbar {
  display: none;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 3px 10px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-line);
  background: var(--color-surface);
  box-shadow: var(--shadow-xs);
  font-size: var(--font-size-xs);
  font-weight: 500;
  color: var(--color-text-muted);
  white-space: nowrap;
  flex-shrink: 0;
}
.pill-model {
  font-family: var(--font-mono);
  color: var(--color-accent);
  border-color: var(--color-accent-bd);
  background: var(--color-accent-soft);
}
.pill-btn {
  cursor: pointer;
  transition:
    filter var(--dur-fast),
    transform var(--dur-fast);
}
.pill-btn:hover {
  filter: brightness(1.1);
  transform: translateY(-1px);
}

/* Model picker transition */
.picker-enter-active,
.picker-leave-active {
  transition:
    opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}
.picker-enter-from,
.picker-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
.perm-manual {
  color: var(--color-text-muted);
  border-color: var(--color-line-strong);
  background: var(--color-surface-raised);
}
.perm-auto {
  color: var(--color-success);
  border-color: var(--color-success);
  background: var(--color-success-soft);
}
.perm-yolo {
  color: var(--color-danger);
  border-color: var(--color-danger);
  background: var(--color-danger-soft);
}
.pill-ring .ring-label {
  font-size: var(--font-size-xs);
}
.pill-queue {
  color: var(--color-info);
  border-color: var(--color-info);
  background: var(--color-info-soft);
}

.composer-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
.btn {
  border: none;
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-4);
  font-size: var(--font-size-sm);
  font-weight: 600;
  cursor: pointer;
  transition:
    opacity var(--dur-fast),
    box-shadow var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out),
    filter var(--dur-base) var(--ease-out);
}
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.btn-primary {
  background: linear-gradient(135deg, var(--color-accent) 0%, var(--color-accent-hover) 100%);
  color: var(--color-on-accent);
  box-shadow: var(--shadow-xs);
}
.btn-primary:hover:not(:disabled) {
  filter: brightness(1.08);
  transform: scale(1.04);
  box-shadow: var(--shadow-sm), 0 0 12px var(--color-accent-glow);
}
.btn-primary:active:not(:disabled) {
  transform: scale(0.98);
}
.btn-danger {
  background: var(--color-danger);
  color: #fff;
  box-shadow: var(--shadow-xs);
}
.btn-danger:hover {
  filter: brightness(1.1);
}

@media (max-width: 640px) {
  .composer {
    padding: var(--space-2) var(--space-3);
  }
  .pill .ring-label {
    display: none;
  }
  .btn {
    padding: var(--space-2) var(--space-3);
  }
}
</style>
