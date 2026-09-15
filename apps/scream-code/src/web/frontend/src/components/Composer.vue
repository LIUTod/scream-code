<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ChatMessage, GoalSnapshot, ModelInfo, SessionStatus } from '../types';
import type { IconName } from './ui/SvgIcon.vue';
import type { ConnectionStatus } from '../composables/useScreamWebClient';
import { filterSlashCommands, resolveCommandName, type SlashCommand } from '../commands';
import { useFileAtMention } from '../composables/useFileAtMention';
import { deriveHistoryFromMessages, mergeInputHistory } from '../utils/inputHistory';
import { singleGroup, type MenuEntry, type MenuGroup } from '../utils/menus';
import { MOD_KEY_LABEL } from '../utils/platform';
import { useWorkspacePreference, workDirBasename } from '../composables/useWorkspacePreference';
import AtFileMenu from './AtFileMenu.vue';
import ContextRing from './ContextRing.vue';
import GoalBar from './GoalBar.vue';
import HistoryMenu from './HistoryMenu.vue';
import MenuPopover from './MenuPopover.vue';
import ModelPicker from './ModelPicker.vue';
import SlashMenu from './SlashMenu.vue';
import SvgIcon from './ui/SvgIcon.vue';
import WorkspacePicker from './WorkspacePicker.vue';

const props = withDefaults(
  defineProps<{
    busy: boolean;
    status?: SessionStatus;
    sessionId?: string | null;
    models?: ModelInfo[];
    /** Session working directory — the scope for @ file mentions. */
    workDir?: string;
    /** 'chat' shows the model name + @ file mentions; 'home' (workspace central card) shows the generic agent + skills. */
    variant?: 'chat' | 'home';
    placeholder?: string;
    /** Session journal — source for ↑ input history recall (chat view only). */
    messages?: ChatMessage[];
    /** WS connection state: feeds both the placeholder state machine and the chip disabled checks. */
    connectionStatus?: ConnectionStatus;
    /** In-flight Goal snapshot: when non-null a one-line takeover bar appears above the input. */
    goal?: GoalSnapshot | null;
    /** Recent workspaces (de-duplicated session workDir list); consumed only by the home variant's workspace popover. */
    recentWorkDirs?: string[];
  }>(),
  {
    status: undefined,
    sessionId: null,
    models: () => [],
    workDir: '',
    variant: 'chat',
    placeholder: undefined,
    connectionStatus: 'idle',
    goal: null,
    recentWorkDirs: () => [],
  },
);

const emit = defineEmits<{
  (e: 'send', text: string): void;
  (e: 'abort'): void;
  (e: 'command', name: string, args?: string): void;
  (e: 'switch-model', alias: string): void;
  (e: 'switch-thinking', level: string): void;
  /** Permission mode switch: the host calls client.switchPermission (the existing session control channel). */
  (e: 'switch-permission', mode: string): void;
  (e: 'goal-pause'): void;
  (e: 'goal-resume'): void;
  (e: 'goal-cancel'): void;
  /** Edit goal: the host switches the right dock to the Goal tab, reusing GoalPanel's edit form. */
  (e: 'goal-edit'): void;
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

/**
 * Draft injected from outside (skills center "try it" etc.) waiting to land. The
 * sessionId usually arrives after the injection, and the session-switch draft restore
 * consumes it once instead of reading back the previous session's draft; the TTL
 * window stops an "injected but never sent, then switched session" leftover from
 * polluting later sessions.
 */
const INJECTED_DRAFT_TTL_MS = 5000;
let injectedDraft: { text: string; at: number } | null = null;

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
    // An injected draft wins over the local draft: when a session is created the
    // sessionId often lands after the injection, and consuming it once here keeps the
    // injected text from being overwritten by the previous session's empty draft
    // (past the TTL it is discarded).
    if (injectedDraft && Date.now() - injectedDraft.at <= INJECTED_DRAFT_TTL_MS) {
      text.value = injectedDraft.text;
      injectedDraft = null;
      nextTick(autoResize);
      return;
    }
    injectedDraft = null;
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
  const target = e.target as Node | null;
  if (!(target instanceof Element)) return;
  if (target.closest('.history-menu') || target.closest('#composer-input')) return;
  historyMenuOpen.value = false;
  // The slash menu shares the same "click outside closes" rule: any click outside the
  // composer invalidates the current menu (it reappears automatically while slashQuery
  // keeps changing, see the watch above).
  if (slashVisible.value && !target.closest('.composer-chips')) {
    slashDismissed.value = true;
  }
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

/**
 * External draft injection (the main path for the skills center "try it").
 *
 * The only difference from insertText: the content is registered as an injected draft
 * that survives a session switch, because when a session is created the sessionId
 * often lands after the injection and the session-switch draft restore reads back the
 * previous session's (empty) draft. activate = take focus and put the caret at the end
 * so the host can keep filling in arguments immediately; false only fills the content
 * without touching focus (background prefill).
 */
function insertDraft(content: string, options: { activate?: boolean } = {}) {
  const activate = options.activate !== false;
  injectedDraft = { text: content, at: Date.now() };
  text.value = content;
  slashDismissed.value = true;
  atMention.dismiss();
  historyMenuOpen.value = false;
  nextTick(() => {
    autoResize();
    const el = textareaRef.value;
    if (!el || !activate) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
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

/* ── Placeholder state machine (single choke point for the ternaries) ────── */
const model = computed(() => props.status?.model);
const permission = computed(() => props.status?.permission);
const contextUsage = computed(() => props.status?.contextUsage);

/**
 * "Offline" only means the WS is disconnected / reconnecting: the home card's
 * connectionStatus is idle (no session opened yet) and must not count as offline.
 */
const offline = computed(
  () => props.connectionStatus === 'disconnected' || props.connectionStatus === 'reconnecting',
);

type PlaceholderKey = 'offline' | 'plan' | 'queue' | 'busy' | 'no-workspace' | 'idle';

/** One actionable sentence per state (no content-free "in progress" phrasing). */
const PLACEHOLDER_TEXT: Record<PlaceholderKey, string> = {
  offline: '连接已断开，正在重连 — 可以先打字，回车会把消息排队',
  plan: '计划模式：只做只读分析与方案输出，回车提交这个问题',
  queue: `已排队：回车继续排队下一条，${MOD_KEY_LABEL}S 立即注入`,
  busy: `回合进行中：现在打字然后回车，消息会排队随下一轮注入（${MOD_KEY_LABEL}S 立即注入）`,
  'no-workspace': '这个会话还没有工作目录：@ 文件提及暂不可用，可以直接提问',
  idle: '输入消息，@ 提及文件，/ 触发指令',
};

const placeholderKey = computed<PlaceholderKey>(() => {
  if (offline.value) return 'offline';
  if (props.busy) return text.value.trim() ? 'queue' : 'busy';
  if (props.status?.planMode) return 'plan';
  // A chat session without a workDir is the abnormal case; the home card's directory
  // is only the preset for the next create and has nothing to do with @ mentions (home
  // @ falls back to /files/root), so it stays out of this state machine.
  if (props.variant === 'chat' && !props.workDir) return 'no-workspace';
  return 'idle';
});

/**
 * The idle state honours the placeholder passed in by the host (WorkspaceHome's goal
 * card swaps the wording with it); every other state is owned by the state machine.
 */
const inputPlaceholder = computed(() =>
  placeholderKey.value === 'idle' && props.placeholder
    ? props.placeholder
    : PLACEHOLDER_TEXT[placeholderKey.value],
);

/* ── State chips (model / thinking / permission / context) ───────────────── */
const THINKING_LABELS: Record<string, string> = {
  off: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最大',
};

/** Thinking metadata of the current model; without thinkingLevels there is no chip (no faked data source). */
const activeModelInfo = computed(() => {
  const alias = props.status?.model;
  if (!alias) return undefined;
  return props.models.find((entry) => entry.alias === alias);
});
const thinkingLevels = computed(() => activeModelInfo.value?.thinkingLevels ?? []);
const thinkingLevel = computed(() => props.status?.thinkingLevel);
const thinkingLabel = computed(() => {
  const level = thinkingLevel.value;
  if (!level || level === 'none') return '默认';
  return THINKING_LABELS[level] ?? level;
});

const PERMISSION_LABELS: Record<string, string> = {
  manual: '手动',
  auto: '自动',
  yolo: 'YOLO',
  bot: '无人值守',
  ask: '询问',
};

/** The four modes a Web session can actually land in today (ask only exists core-side and keeps a fallback label). */
const PERMISSION_MODES = ['manual', 'auto', 'yolo', 'bot'] as const;
const PERMISSION_HINTS: Record<string, string> = {
  manual: '每次工具调用都要你确认',
  auto: '安全操作自动放行，敏感操作仍要确认',
  yolo: '全部自动放行，不再打断',
  bot: '无人值守模式：批量接管确认',
};

const permissionLabel = computed(
  () => PERMISSION_LABELS[permission.value ?? ''] ?? permission.value ?? '手动',
);
const permissionClass = computed(() => {
  switch (permission.value) {
    case 'auto':
      return 'perm-auto';
    case 'yolo':
      return 'perm-yolo';
    case 'bot':
      return 'perm-bot';
    default:
      return 'perm-manual';
  }
});

const contextPercent = computed(() => {
  const usage = contextUsage.value;
  return usage === undefined ? '' : `${Math.round(usage * 100)}%`;
});

/* ── Workspace chip (home: preset for next create / chat: session workDir) ── */
const { preferredWorkDir, serverWorkDir, displayWorkDir, setPreferredWorkDir } =
  useWorkspacePreference();

interface ChipView {
  label: string;
  /** Hover text; when disabled it must state the reason — no silent paths. */
  title: string;
  enabled: boolean;
  visible: boolean;
}

/**
 * Visibility, enablement and copy for the clickable chips are all computed here; the
 * template only renders and dispatches. Every reason a chip cannot be clicked
 * (offline, status not back yet, no session, no metadata) goes into title.
 */
/**
 * Chip clickability, two rules:
 * - disabled only for "no data source" (empty model list) or "session state does not
 *   fit" (offline / no session in the chat view), and a disabled chip always states
 *   the reason in title — no silent paths;
 * - the workspace-home model capsule is not session-bound (it is the generic agent's
 *   default picker) and keeps the old behaviour: any list can be opened, and client
 *   toasts explain a failed choice.
 */
const chips = computed<{
  model: ChipView;
  thinking: ChipView;
  permission: ChipView;
  workspace: ChipView;
  context: ChipView;
}>(() => {
  const sessionGated = props.variant === 'chat';
  const blocked = sessionGated
    ? offline.value
      ? '连接已断开，正在重连 — 重连后可以切换'
      : !props.sessionId
        ? '还没有打开会话，先新建或选择一个会话'
        : ''
    : '';
  const noModels = props.models.length === 0
    ? '后端没有返回可选模型，暂时不能切换'
    : '';
  return {
    model: {
      label: props.variant === 'home' ? '通用智能体' : (model.value ?? ''),
      title:
        noModels ||
        blocked ||
        (model.value
          ? `当前模型：${model.value}，点击切换`
          : '会话状态还没回来'),
      enabled: !noModels && !blocked,
      visible: !!model.value || props.variant === 'home',
    },
    thinking: {
      label: `思考 · ${thinkingLabel.value}`,
      title:
        blocked ||
        `思考力度：${thinkingLabel.value}，点击调整（可选：${thinkingLevels.value.join(' / ')}）`,
      enabled: !blocked,
      visible: props.variant === 'chat' && thinkingLevels.value.length > 0,
    },
    permission: {
      // Always visible + always clickable: disabling the chip until status came back
      // turned it into a dead button during the window right after a session opened
      // (and whenever status frames never arrived) — clicking the shield did nothing
      // and the permission switch read as broken. The switch is a write, so an
      // optimistic update fills permission immediately without knowing the current
      // value; a real failure is covered by the postSessionAction toast + rollback.
      // Only two hard gates remain: offline / no session (blocked).
      label: permission.value ? permissionLabel.value : '权限',
      title:
        blocked ||
        (permission.value
          ? `权限模式：${permissionLabel.value}，点击切换（会记录到会话日志）`
          : '权限模式：点击切换（会记录到会话日志）'),
      enabled: !blocked,
      visible: props.variant === 'chat',
    },
    workspace:
      props.variant === 'chat'
        ? {
            // Read-only in the chat view: the workspace is fixed at session creation —
            // changing the directory mid-way would mean another session.
            label: props.workDir ? workDirBasename(props.workDir) : '工作区',
            title: props.workDir
              ? `工作区：${props.workDir} — 工作区随会话创建，不可中途更换`
              : '这个会话还没有工作目录',
            enabled: false,
            visible: true,
          }
        : {
            label: displayWorkDir.value ? workDirBasename(displayWorkDir.value) : '默认工作区',
            title: displayWorkDir.value
              ? `工作区：${displayWorkDir.value}，点击为下一次新建选择目录`
              : '还没拿到服务器默认工作区，点击可手动输入目录',
            enabled: true,
            visible: true,
          },
    context: {
      label: contextPercent.value,
      title:
        contextUsage.value === undefined
          ? '上下文占用还没回来'
          : `上下文占用 ${(contextUsage.value * 100).toFixed(1)}%`,
      enabled: false,
      visible: contextUsage.value !== undefined,
    },
  };
});

/* ── Chip popovers: at most one open at a time ───────────────────────────── */
type ChipMenu = 'model' | 'thinking' | 'permission' | 'workspace';
const openMenu = ref<ChipMenu | null>(null);

/** Workspace popover selection: store the preference (memory + localStorage); it applies to the next create. */
function onWorkspaceSelect(dir: string) {
  setPreferredWorkDir(dir);
  openMenu.value = null;
}

function toggleMenu(menu: ChipMenu, enabled: boolean) {
  if (!enabled) return;
  historyMenuOpen.value = false;
  openMenu.value = openMenu.value === menu ? null : menu;
}

/** MenuPopover open/close callback: only clear when its own popover asks to close, so they never trample each other. */
function onMenuUpdate(menu: ChipMenu, value: boolean) {
  if (value) openMenu.value = menu;
  else if (openMenu.value === menu) openMenu.value = null;
}

/** The model popover is driven by ModelPicker itself; this keeps a single source of truth. */
function onModelPickerUpdate(next: boolean) {
  openMenu.value = next ? 'model' : null;
}

/** Open the model picker; returns false when no models are configured. */
function openModelPicker(): boolean {
  if (!chips.value.model.enabled) return false;
  openMenu.value = 'model';
  return true;
}

const pickerOpen = computed(() => openMenu.value === 'model');

const thinkingGroups = computed<MenuGroup[]>(() =>
  singleGroup(
    thinkingLevels.value.map<MenuEntry>((level) => ({
      key: level,
      label: level === 'off' || level === 'none' ? '关闭' : (THINKING_LABELS[level] ?? level),
      checked: thinkingLevel.value === level,
    })),
    '思考力度',
  ),
);

const permissionGroups = computed<MenuGroup[]>(() =>
  singleGroup(
    PERMISSION_MODES.map<MenuEntry>((mode) => ({
      key: mode,
      label: PERMISSION_LABELS[mode] ?? mode,
      checked: permission.value === mode,
      title: PERMISSION_HINTS[mode],
    })),
    '权限模式',
  ),
);

function onApplyModel(alias: string) {
  emit('switch-model', alias);
  openMenu.value = null;
}

function onApplyThinking(level: string) {
  emit('switch-thinking', level);
  openMenu.value = null;
}

function onApplyPermission(mode: string) {
  emit('switch-permission', mode);
  openMenu.value = null;
}

/* ── Primary button: send / stop two-state morph ─────────────────────────── */
type PrimaryAction = 'send' | 'stop';

/**
 * Primary button state: idle → send, busy → stop (independent of whether the input
 * holds text).
 *
 * The button used to morph into "queue" while busy with text in the box, squeezing
 * stop out — with any text present the user could not reach stop when a turn ran away.
 * Now a busy state always keeps the primary button on stop: stopping is always one
 * click away.
 * The queue entry point is not lost, it stays on the keyboard: Enter (while a turn
 * runs → enqueue) and ⌘S (inject now), see the placeholder copy and the title below.
 * The button handles stop, Enter handles queueing.
 */
const primaryAction = computed<PrimaryAction>(() => (props.busy ? 'stop' : 'send'));

const PRIMARY_META: Record<PrimaryAction, { icon: IconName; label: string; title: string }> = {
  send: { icon: 'arrow-up', label: '发送', title: '发送（回车）' },
  stop: { icon: 'stop', label: '停止', title: '停止当前回合' },
};

const primaryIcon = computed(() => PRIMARY_META[primaryAction.value].icon);
const primaryLabel = computed(() => PRIMARY_META[primaryAction.value].label);
/** With a draft while busy, stop is not the only way out: put the queue entry point (keyboard) in title — no dead ends. */
const primaryTitle = computed(() =>
  primaryAction.value === 'stop' && text.value.trim()
    ? `${PRIMARY_META.stop.title}（回车把当前输入排队，${MOD_KEY_LABEL}S 立即注入）`
    : PRIMARY_META[primaryAction.value].title,
);
const primaryDisabled = computed(
  () => primaryAction.value === 'send' && !text.value.trim(),
);

function onPrimaryClick() {
  if (primaryAction.value === 'stop') {
    abort();
    return;
  }
  void send();
}

/* ── Takeover strip: one-line bar for an in-flight Goal ──────────────────── */
const goalActive = computed(
  () => !!props.goal && (props.goal.status === 'active' || props.goal.status === 'paused' || props.goal.status === 'blocked'),
);
const goalDisabled = computed(() => offline.value || !props.sessionId);
const goalDisabledReason = computed(() =>
  offline.value ? '连接已断开，正在重连' : !props.sessionId ? '还没有打开会话' : '',
);

defineExpose({ insertText, insertDraft, openModelPicker });
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

    <!-- Takeover strip: one-line bar for an in-flight Goal (in flow, non-modal, it sits
         above the input without covering it). -->
    <GoalBar
      v-if="goalActive"
      :goal="goal ?? null"
      :busy="busy"
      :disabled="goalDisabled"
      :disabled-reason="goalDisabledReason"
      @pause="emit('goal-pause')"
      @resume="emit('goal-resume')"
      @cancel="emit('goal-cancel')"
      @edit="emit('goal-edit')"
    />

    <textarea
      ref="textareaRef"
      v-model="text"
      id="composer-input"
      name="message"
      class="composer-input"
      rows="1"
      :data-placeholder-state="placeholderKey"
      :placeholder="inputPlaceholder"
      @keydown="onKeydown"
      @compositionend="lastCompositionEndAt = Date.now()"
      @click="onCaretMove"
      @keyup="onCaretMove"
    />

    <!-- Capsule row: state and clickability all come from the chips computed. -->
    <div class="composer-capsule-row">
      <div class="composer-chips">
        <button
          v-if="variant === 'chat'"
          class="composer-chip"
          data-chip="mention"
          title="插入 @ 提及文件"
          @click="insertToken('@')"
        >
          <SvgIcon name="at" :size="14" /><span>提及</span>
        </button>
        <button
          class="composer-chip"
          data-chip="slash"
          :title="variant === 'home' ? '插入 / 触发技能' : '插入 / 触发指令'"
          @click="insertToken('/')"
        >
          <SvgIcon name="command" :size="14" /><span>{{ variant === 'home' ? '技能' : '指令' }}</span>
        </button>

        <!-- Workspace chip: in home it opens the picker popover; in chat it shows the session's directory read-only. -->
        <span v-if="chips.workspace.visible" class="chip-slot">
          <button
            class="composer-chip workspace-select"
            data-chip="workspace"
            :class="{ 'is-clickable': chips.workspace.enabled }"
            :disabled="!chips.workspace.enabled"
            :title="chips.workspace.title"
            :aria-haspopup="chips.workspace.enabled ? 'dialog' : undefined"
            :aria-expanded="openMenu === 'workspace' ? 'true' : 'false'"
            @click="toggleMenu('workspace', chips.workspace.enabled)"
          >
            <SvgIcon name="folder" :size="14" />
            <span class="chip-text">{{ chips.workspace.label }}</span>
            <SvgIcon v-if="chips.workspace.enabled" name="chevron-down" :size="12" />
          </button>
          <WorkspacePicker
            v-if="openMenu === 'workspace'"
            :current="preferredWorkDir ?? ''"
            :default-dir="serverWorkDir ?? ''"
            :recent-work-dirs="recentWorkDirs"
            @select="onWorkspaceSelect"
            @close="openMenu = null"
          />
        </span>

        <!-- Model chip: opens the existing ModelPicker popover. -->
        <span v-if="chips.model.visible" class="chip-slot">
          <button
            class="composer-chip model-select"
            data-chip="model"
            :class="{ 'is-clickable': chips.model.enabled }"
            :disabled="!chips.model.enabled"
            :title="chips.model.title"
            :aria-haspopup="chips.model.enabled ? 'dialog' : undefined"
            :aria-expanded="pickerOpen ? 'true' : 'false'"
            @click="toggleMenu('model', chips.model.enabled)"
          >
            <SvgIcon name="brain" :size="14" />
            <span class="chip-text">{{ chips.model.label }}</span>
            <SvgIcon v-if="chips.model.enabled" name="chevron-down" :size="12" />
          </button>
          <Transition name="picker">
            <ModelPicker
              v-if="pickerOpen"
              :models="models"
              :current-model="model"
              :current-thinking="thinkingLevel"
              @apply-model="onApplyModel"
              @apply-thinking="onApplyThinking"
              @close="openMenu = null"
            />
          </Transition>
        </span>

        <!-- Thinking chip: exists only when the current model carries thinkingLevels metadata. -->
        <MenuPopover
          v-if="chips.thinking.visible"
          class="chip-slot"
          label="思考力度"
          heading="思考力度"
          :groups="thinkingGroups"
          :open="openMenu === 'thinking'"
          placement="top"
          align="left"
          @update:open="onMenuUpdate('thinking', $event)"
          @select="onApplyThinking"
        >
          <button
            class="composer-chip"
            data-chip="thinking"
            :class="{ 'is-clickable': chips.thinking.enabled }"
            :disabled="!chips.thinking.enabled"
            :title="chips.thinking.title"
            aria-haspopup="menu"
            :aria-expanded="openMenu === 'thinking' ? 'true' : 'false'"
            @click="toggleMenu('thinking', chips.thinking.enabled)"
          >
            <SvgIcon name="activity" :size="14" />
            <span class="chip-text">{{ chips.thinking.label }}</span>
            <SvgIcon name="chevron-down" :size="12" />
          </button>
        </MenuPopover>

        <!-- Permission chip: goes through client.switchPermission (the existing session control channel). -->
        <MenuPopover
          v-if="chips.permission.visible"
          class="chip-slot"
          label="权限模式"
          :groups="permissionGroups"
          :open="openMenu === 'permission'"
          placement="top"
          align="left"
          @update:open="onMenuUpdate('permission', $event)"
          @select="onApplyPermission"
        >
          <button
            class="composer-chip"
            data-chip="permission"
            :class="['is-clickable', permissionClass]"
            :disabled="!chips.permission.enabled"
            :title="chips.permission.title"
            aria-haspopup="menu"
            :aria-expanded="openMenu === 'permission' ? 'true' : 'false'"
            @click="toggleMenu('permission', chips.permission.enabled)"
          >
            <SvgIcon name="shield" :size="14" />
            <span class="chip-text">{{ chips.permission.label }}</span>
            <SvgIcon name="chevron-down" :size="12" />
          </button>
        </MenuPopover>

        <!-- Context usage: ContextRing moved from the right-hand action area into the capsule row. -->
        <span
          v-if="chips.context.visible"
          class="composer-chip is-static"
          data-chip="context"
          :title="chips.context.title"
        >
          <ContextRing :usage="contextUsage" :size="14" />
          <span class="chip-text">{{ chips.context.label }}</span>
        </span>

        <!-- Queue depth: a status readout of the existing steer queue (sent when the turn ends), not clickable. -->
        <span
          v-if="steerQueue.length"
          class="composer-chip is-static"
          data-chip="queue"
          :title="`已排队 ${steerQueue.length} 条，当前回合结束后自动发送`"
        >
          <SvgIcon name="queue" :size="14" />
          <span class="chip-text">排队 {{ steerQueue.length }}</span>
        </span>
      </div>

      <!-- Single primary button: idle → send / busy → stop (stop stays one click away
           regardless of the input text). -->
      <button
        class="composer-primary"
        :data-action="primaryAction"
        :disabled="primaryDisabled"
        :title="primaryTitle"
        :aria-label="primaryLabel"
        @click="onPrimaryClick"
      >
        <SvgIcon :name="primaryIcon" :size="16" />
        <span v-if="primaryAction !== 'send'" class="primary-label">{{ primaryLabel }}</span>
      </button>
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

.composer-capsule-row {
  display: flex;
  align-items: center;
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

/* Capsule row: a row of state chips on the left (horizontal scroll on overflow), the
   single primary button on the right. */
.composer-chips {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.composer-chips::-webkit-scrollbar {
  display: none;
}
.chip-slot {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
}

/* A single capsule: 28px tall, fully rounded, borderless; hover only swaps the colour instantly. */
.composer-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 var(--space-2);
  flex-shrink: 0;
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-muted);
  font-family: inherit;
  font-size: var(--font-size-xs);
  white-space: nowrap;
  cursor: default;
  transition:
    color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}
.composer-chip .chip-text {
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.composer-chip.is-clickable {
  cursor: pointer;
}
.composer-chip.is-clickable:hover:not(:disabled) {
  color: var(--color-accent);
  background: var(--color-hover);
}
.composer-chip.is-clickable:active:not(:disabled) {
  transform: translateY(1px);
}
/* Not-clickable state: faint text + not-allowed, with the reason in title (no silent paths). */
.composer-chip:disabled {
  color: var(--color-text-faint);
  cursor: not-allowed;
}

/* Permission states reuse the existing semantic colours; the model chip keeps the
   .model-select class name (ModelPicker anchors its outside-click check on it). */
.composer-chip.perm-manual {
  background: var(--color-hover);
}
.composer-chip.perm-auto {
  color: var(--color-success);
  background: var(--color-success-soft);
}
.composer-chip.perm-auto:hover:not(:disabled) {
  color: var(--color-success);
}
.composer-chip.perm-yolo {
  color: var(--color-danger);
  background: var(--color-danger-soft);
}
.composer-chip.perm-yolo:hover:not(:disabled) {
  color: var(--color-danger);
}
.composer-chip.perm-bot {
  color: var(--color-accent);
  background: var(--color-accent-soft);
}
.composer-chip[data-chip='queue'] {
  color: var(--color-accent);
  background: var(--color-accent-soft);
}
.composer-chip[data-chip='context'] {
  gap: 5px;
  font-variant-numeric: tabular-nums;
}

/* Single primary button: data-action drives the shape (icon / label / colour follow the
   state), and a width transition makes idle→busy continuous instead of a flash. */
.composer-primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 32px;
  min-width: 32px;
  padding: 0 var(--space-2);
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-family: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
  box-shadow: var(--shadow-xs);
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out),
    filter var(--dur-base) var(--ease-out),
    opacity var(--dur-base) var(--ease-out),
    min-width var(--dur-base) var(--ease-out);
}
.composer-primary:hover:not(:disabled) {
  box-shadow: var(--glow-accent), var(--shadow-xs);
  transform: translateY(-1px);
  filter: brightness(1.04);
}
.composer-primary:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: var(--shadow-xs);
  filter: brightness(0.97);
}
.composer-primary:disabled {
  opacity: 0.45;
  cursor: default;
}
/* busy with no input → stop: danger colour, filled on hover only, so a running turn is not permanently red. */
.composer-primary[data-action='stop'] {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}
.composer-primary[data-action='stop']:hover:not(:disabled) {
  background: var(--color-danger);
  color: var(--color-on-accent);
  filter: none;
}
.primary-label {
  white-space: nowrap;
}

@media (max-width: 640px) {
  /* Raise the touch target to 40px; the selector must override .composer-chip's default 28px measure. */
  .composer-chips .composer-chip,
  .composer-primary {
    height: 40px;
  }
  .composer-chip .chip-text {
    max-width: 120px;
  }
  .composer-chip[data-chip='mention'] .chip-text,
  .composer-chip[data-chip='slash'] .chip-text,
  .composer-chip[data-chip='thinking'] .chip-text,
  .composer-chip[data-chip='context'] .chip-text {
    display: none;
  }
  .composer-primary {
    min-width: 40px;
  }
  .composer-primary .primary-label {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  /* Beyond the global escape hatch the morph itself stops too: switch shape with no transition. */
  .composer-primary {
    transition: none;
  }
}
</style>
