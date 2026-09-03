<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ChatMessage, ModelInfo, SessionStatus } from '../types';
import { filterSlashCommands, resolveCommandName, type SlashCommand } from '../commands';
import { useFileAtMention } from '../composables/useFileAtMention';
import { deriveHistoryFromMessages, mergeInputHistory } from '../utils/inputHistory';
import AtFileMenu from './AtFileMenu.vue';
import ContextRing from './ContextRing.vue';
import HistoryMenu from './HistoryMenu.vue';
import ModelPicker from './ModelPicker.vue';
import SlashMenu from './SlashMenu.vue';
import SvgIcon from './ui/SvgIcon.vue';

const props = withDefaults(
  defineProps<{
    busy: boolean;
    status?: SessionStatus;
    sessionId?: string | null;
    models?: ModelInfo[];
    /** Session working directory — the scope for @ file mentions. */
    workDir?: string;
    /** 'chat' shows model name + @ 提及; 'home' (workspace central card) shows 通用智能体 + 技能. */
    variant?: 'chat' | 'home';
    placeholder?: string;
    /** Session journal — source for ↑ input history recall (chat view only). */
    messages?: ChatMessage[];
  }>(),
  { status: undefined, sessionId: null, models: () => [], workDir: '', variant: 'chat', placeholder: undefined },
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

/* ── @ file mention menu (scoped to the session workDir via files REST) ──── */
const workDirRef = computed(() => props.workDir || undefined);
const atMention = useFileAtMention(text, textareaRef, workDirRef);

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

/* ── Input history (↑ opens a menu over the textarea, newest entry first) ── */
const HISTORY_LIMIT = 50;
/** Timestamp of the last compositionend — guards Safari's confirmation Enter. */
let lastCompositionEndAt = 0;
/** Stored history per session: old→new (localStorage; covers commands/offline). */
const storedHistory = ref<string[]>([]);
/** Merged history shown in the menu: newest first, deduped, capped. */
const history = computed(() =>
  mergeInputHistory(storedHistory.value, deriveHistoryFromMessages(props.messages ?? []), HISTORY_LIMIT),
);
const historyMenuOpen = ref(false);
const historyIndex = ref(0);

function historyKey(): string {
  return `scream-history:${props.sessionId ?? 'default'}`;
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(historyKey());
    storedHistory.value = raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    storedHistory.value = [];
  }
}

function pushHistory(entry: string) {
  if (storedHistory.value.at(-1) !== entry) {
    storedHistory.value = [...storedHistory.value, entry].slice(-HISTORY_LIMIT);
    try {
      localStorage.setItem(historyKey(), JSON.stringify(storedHistory.value));
    } catch {
      // Storage full / unavailable — history is best-effort.
    }
  }
}

/** Fill the input from a history entry (Tab/Enter/click) and focus the end. */
function applyHistoryInput(entry: string) {
  text.value = entry;
  historyMenuOpen.value = false;
  nextTick(() => {
    const el = textareaRef.value;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    autoResize();
    // A restored entry may end in an @token; caret moves after this must not
    // resurrect the @ file menu from it.
    atMention.reset();
  });
}

/** ↑ on an empty input: swap menus and start on the newest entry. */
function openHistoryMenu() {
  slashDismissed.value = true;
  atMention.dismiss();
  historyIndex.value = Math.max(0, history.value.length - 1);
  historyMenuOpen.value = true;
}

function historyMove(delta: 1 | -1) {
  const len = history.value.length;
  if (len === 0) return;
  historyIndex.value = Math.min(len - 1, Math.max(0, historyIndex.value + delta));
}

// The menu items derive from a live computed: journal updates (streamed turn,
// older-page prepend, snapshot replace) can shrink the list and leave the
// active index dangling — clamp instead of letting Tab/Enter silently no-op.
watch(
  () => history.value.length,
  () => {
    if (historyIndex.value >= history.value.length) {
      historyIndex.value = Math.max(0, history.value.length - 1);
    }
  },
);

/* ── Draft persistence (per session) ─────────────────────────────────────── */
function draftKey(): string {
  return `scream-draft:${props.sessionId ?? 'default'}`;
}

let draftTimer: ReturnType<typeof setTimeout> | undefined;

watch(text, () => {
  autoResize();
  // Any input change closes the history menu (reference behavior): typing
  // after ↑ must never let a later Enter overwrite the just-typed text with
  // a history entry.
  historyMenuOpen.value = false;
  // Recompute the @ mention menu (caret-based; the textarea value already
  // holds the new text at this point).
  atMention.refresh();
  // Debounce draft persistence so keystrokes do not hit localStorage on every
  // input event.
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      if (text.value) localStorage.setItem(draftKey(), text.value);
      else localStorage.removeItem(draftKey());
    } catch {
      // Best-effort.
    }
  }, 300);
});

watch(
  () => props.sessionId,
  () => {
    // Drop any pending draft write from the previous session so a stale
    // timer cannot persist the old text under the new session's key.
    clearTimeout(draftTimer);
    loadHistory();
    // The history list belongs to the previous session; reset menu state so
    // neither a stale open menu nor a dangling index crosses sessions.
    historyMenuOpen.value = false;
    historyIndex.value = 0;
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

/**
 * Re-derive the @ menu when the caret moves without a text change (clicks,
 * arrow keys, Home/End), so it never latches onto a stale token position.
 */
function onCaretMove() {
  atMention.refresh();
}

/* ── Mobile keyboard avoidance (visualViewport) ──────────────────────────── */
// When the on-screen keyboard shrinks the visual viewport, lift the composer
// by the height difference so it stays reachable above the keyboard.
// Conservative: guarded by a 'visualViewport' in window check, ignores small
// viewport shifts (e.g. mobile URL bar collapses), and restores on unmount.
const keyboardInset = ref(0);

function syncKeyboardInset(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const diff = Math.round(window.innerHeight - vv.height - vv.offsetTop);
  // Only the keyboard produces a large sustained shrink; smaller diffs are
  // transient chrome changes and are treated as "no keyboard".
  keyboardInset.value = diff > 120 ? diff : 0;
}

if ('visualViewport' in window) {
  onMounted(() => {
    window.visualViewport?.addEventListener('resize', syncKeyboardInset);
    syncKeyboardInset();
  });
  onBeforeUnmount(() => {
    window.visualViewport?.removeEventListener('resize', syncKeyboardInset);
    keyboardInset.value = 0;
  });
}

/* ── Outside-click closes the history menu ───────────────────────────────── */
// Clicking anywhere outside the menu and the input (e.g. the message list)
// dismisses the menu. Without this, the menu would stay open after the
// textarea blurs and Esc (which fires on the textarea) could no longer
// reach it.
function onDocumentMousedown(e: MouseEvent) {
  if (!historyMenuOpen.value) return;
  const target = e.target as Node | null;
  if (!(target instanceof Element)) return;
  if (target.closest('.history-menu') || target.closest('#composer-input')) return;
  historyMenuOpen.value = false;
}

onMounted(() => document.addEventListener('mousedown', onDocumentMousedown));
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocumentMousedown));

/* ── Send / queue / abort ────────────────────────────────────────────────── */
function resetInput() {
  text.value = '';
  // The text watcher refreshes from the pre-patch DOM value; clear mention
  // state explicitly so the menu never flashes after a send.
  atMention.reset();
  historyMenuOpen.value = false;
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
  // Record queued input in history too — an aborted/discarded queue must not
  // make the text unrecoverable via ↑.
  pushHistory(t);
  steerQueue.value = [...steerQueue.value, t];
  resetInput();
}

function onKeydown(e: KeyboardEvent) {
  // The @ file menu claims navigation keys before the slash menu and before
  // the send/EOL fallthroughs below.
  if (atMention.visible.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      atMention.move(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      atMention.move(-1);
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      if (e.isComposing) return;
      // While the directory is still loading there is nothing to confirm, but
      // the key must not fall through to send a half-typed @query.
      e.preventDefault();
      if (atMention.dirLoading.value) return;
      if (atMention.confirm()) return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      atMention.dismiss();
      return;
    }
  }
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
    // Queue-as-steer only makes sense while a turn is running; idle Ctrl+S
    // would park the text in steerQueue with no busy-false edge to flush it.
    if (props.busy) queueSteer();
    else send();
    return;
  }

  // History menu keyboard flow (menu open; claims nav keys before send).
  if (historyMenuOpen.value && !e.isComposing) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      historyMove(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      historyMove(-1);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      historyMenuOpen.value = false;
      return;
    }
    if ((e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) && history.value[historyIndex.value] !== undefined) {
      e.preventDefault();
      applyHistoryInput(history.value[historyIndex.value]);
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    if (e.isComposing) return;
    // Safari fires the confirmation Enter keydown after compositionend
    // (isComposing already false): swallow it so an unconverted pinyin
    // string is never sent.
    if (Date.now() - lastCompositionEndAt < 100) return;
    e.preventDefault();
    send();
    return;
  }
  // ↑ with an empty input opens the history menu (no IME, not busy);
  // otherwise ↑/↓ fall through to caret movement / menu navigation above.
  if (e.key === 'ArrowUp' && !e.isComposing && !props.busy && text.value.trim().length === 0 && history.value.length > 0) {
    e.preventDefault();
    openHistoryMenu();
  }
}

function abort() {
  steerQueue.value = [];
  emit('abort');
}

/* ── Edit & resend entry point ───────────────────────────────────────────── */
function insertText(content: string) {
  text.value = content;
  historyMenuOpen.value = false;
  nextTick(() => {
    autoResize();
    textareaRef.value?.focus();
  });
}

/** Append a trigger token (@ /) and refocus — used by quick-action chips. */
function insertToken(token: string) {
  text.value += token;
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

const inputPlaceholder = computed(
  () =>
    props.placeholder ??
    (props.busy
      ? '回合进行中：Enter/Ctrl+S 排队消息，随下一轮注入'
      : '输入消息，@ 提及，/ 触发指令'),
);

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
  <div class="composer" :style="keyboardInset ? { paddingBottom: keyboardInset + 'px' } : undefined">
    <SlashMenu
      v-if="slashVisible"
      :commands="slashCommands"
      :active-index="slashIndex"
      @select="pickSlashCommand"
      @hover="(i) => (slashIndex = i)"
    />
    <AtFileMenu
      v-if="atMention.visible.value"
      :suggestions="atMention.suggestions.value"
      :active-index="atMention.index.value"
      :loading="atMention.dirLoading.value"
      :work-dir="workDir"
      @select="(entry) => atMention.confirm(entry)"
      @hover="(i) => (atMention.index.value = i)"
    />
    <HistoryMenu
      v-if="historyMenuOpen && history.length > 0"
      :items="history"
      :active-index="historyIndex"
      @apply="applyHistoryInput"
      @hover="(i) => (historyIndex = i)"
    />
    <textarea
      ref="textareaRef"
      v-model="text"
      id="composer-input"
      name="message"
      class="composer-input"
      rows="1"
      :placeholder="inputPlaceholder"
      @keydown="onKeydown"
      @compositionend="lastCompositionEndAt = Date.now()"
      @click="onCaretMove"
      @keyup="onCaretMove"
    />

    <div class="composer-footer">
      <div class="composer-quick-actions">
        <template v-if="variant === 'home'">
          <button class="quick-action" title="插入 / 触发指令" @click="insertToken('/')"><SvgIcon name="command" :size="15" /><span>技能</span></button>
        </template>
        <template v-else>
          <button class="quick-action" title="插入 @ 提及" @click="insertToken('@')"><SvgIcon name="at" :size="15" /><span>提及</span></button>
          <button class="quick-action" title="插入 / 触发指令" @click="insertToken('/')"><SvgIcon name="command" :size="15" /><span>指令</span></button>
        </template>
        <span v-if="permission" :class="['permission-label', permissionClass]" :title="`权限模式：${permission}`">{{ permissionLabel }}</span>
        <span v-if="steerQueue.length" class="queue-label" title="运行结束后自动发送">已排队 {{ steerQueue.length }} 条</span>
      </div>

      <div class="composer-actions">
        <button v-if="model" :class="['model-select', { clickable: modelSwitchable }]" :disabled="!modelSwitchable" :title="variant === 'home' ? `当前模型：${model}` : `当前模型：${model}`" @click="toggleModelPicker">
          <SvgIcon name="brain" :size="15" /><span>{{ variant === 'home' ? '通用智能体' : model }}</span><template v-if="variant !== 'home' && thinkingLabel"> · {{ thinkingLabel }}</template><SvgIcon v-if="modelSwitchable" name="chevron-down" :size="12" />
        </button>
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
        <span v-if="contextUsage !== undefined" class="context-label" title="上下文使用率"><ContextRing :usage="contextUsage" :size="15" /></span>
        <button v-if="busy" class="stop-btn" title="停止当前回合" @click="abort"><SvgIcon name="stop" :size="14" /><span>停止</span></button>
        <button v-else class="send-btn" :disabled="!text.trim()" title="发送 (Enter)" aria-label="发送" @click="send"><SvgIcon name="arrow-up" :size="16" /></button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* One bordered surface per region. Everything inside the card is a FLAT
   control (32px tall, radius-md, no border, no fill until hover) so the card
   never contains a second layer of boxes. */
.composer {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--color-surface);
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xs);
  transition:
    border-color var(--dur-base) var(--ease-out),
    box-shadow var(--dur-base) var(--ease-out);
}
.composer:focus-within {
  border-color: var(--color-accent);
  box-shadow: var(--glow-focus);
}

.composer-input {
  width: 100%;
  min-height: 44px;
  max-height: 25vh;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--color-text);
  font-size: var(--font-size-base);
  font-family: inherit;
  line-height: 1.65;
  resize: none;
}
.composer-input:focus {
  outline: none;
}
.composer-input::placeholder {
  color: var(--color-text-faint);
  opacity: 0.8;
}

.composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-width: 0;
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

.composer-quick-actions,
.composer-actions {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}
/* Shared control cell: every footer control is the same box metric —
   32px tall, radius-md, borderless, transparent until hover. Only buttons and
   status spans; the .model-picker popover must keep its own size. */
.composer-quick-actions > button,
.composer-quick-actions > span,
.composer-actions > button,
.composer-actions > span {
  height: 32px;
  border-radius: var(--radius-md);
}
.composer-quick-actions {
  flex: 1;
  overflow-x: auto;
  scrollbar-width: none;
}
.composer-quick-actions::-webkit-scrollbar {
  display: none;
}

.quick-action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 var(--space-2);
  flex-shrink: 0;
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}
.quick-action:hover {
  color: var(--color-accent);
  background: var(--color-hover);
}
.quick-action:active {
  transform: translateY(1px);
}

/* Status chips: same cell as the buttons, distinguished by tint only — no
   second border layer inside the card. */
.permission-label,
.queue-label {
  display: inline-flex;
  align-items: center;
  padding: 0 var(--space-2);
  border: 0;
  color: var(--color-text-muted);
  background: var(--color-accent-soft);
  font-size: var(--font-size-xs);
  white-space: nowrap;
  flex-shrink: 0;
}
.permission-label.perm-manual {
  color: var(--color-text-muted);
  background: var(--color-hover);
}
.permission-label.perm-auto {
  color: var(--color-success);
  background: var(--color-success-soft);
}
.permission-label.perm-yolo {
  color: var(--color-danger);
  background: var(--color-danger-soft);
}

.model-select {
  max-width: 230px;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 var(--space-2);
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  white-space: nowrap;
  transition:
    color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}
.model-select span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-select.clickable {
  cursor: pointer;
}
.model-select.clickable:hover {
  color: var(--color-accent);
  background: var(--color-hover);
}
.model-select.clickable:active {
  transform: translateY(1px);
}
.model-select:disabled {
  cursor: default;
  opacity: 0.7;
}

.context-label {
  display: grid;
  place-items: center;
  flex-shrink: 0;
}

.send-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  flex-shrink: 0;
  border: none;
  background: var(--color-accent);
  color: var(--color-on-accent);
  cursor: pointer;
  box-shadow: var(--shadow-xs);
  transition:
    box-shadow var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out),
    filter var(--dur-base) var(--ease-out),
    opacity var(--dur-base) var(--ease-out);
}
.send-btn:hover:not(:disabled) {
  box-shadow: var(--glow-accent), var(--shadow-xs);
  transform: translateY(-1px);
  filter: brightness(1.04);
}
.send-btn:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: var(--shadow-xs);
  filter: brightness(0.97);
}
.send-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.stop-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 var(--space-2);
  flex-shrink: 0;
  border: 0;
  background: var(--color-danger-soft);
  color: var(--color-danger);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.stop-btn:hover {
  background: var(--color-danger);
  color: var(--color-on-accent);
  box-shadow: var(--shadow-xs);
}
.stop-btn:active {
  transform: translateY(1px);
}

@media (max-width: 640px) {
  /* Touch targets grow to 40px; the selector must match the shared 32px rule's
     specificity, otherwise the desktop metric wins and taps stay 32px. */
  .composer-quick-actions > button,
  .composer-quick-actions > span,
  .composer-actions > button,
  .composer-actions > span {
    height: 40px;
  }
  .quick-action span,
  .permission-label,
  .context-label { display: none; }
  .quick-action { min-width: 40px; justify-content: center; }
  .model-select { max-width: 145px; }
  .send-btn { width: 40px; }
  .stop-btn span { display: none; }
}
</style>
