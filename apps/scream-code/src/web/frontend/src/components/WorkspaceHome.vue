<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { ModelInfo, SessionStatus } from '../types';
import { useWorkspacePreference } from '../composables/useWorkspacePreference';
import Composer from './Composer.vue';
import ModeSwitch, { type WorkspaceMode } from './ModeSwitch.vue';
import logoUrl from '../assets/logo-v2.svg';

const props = withDefaults(
  defineProps<{
    models: ModelInfo[];
    status?: SessionStatus;
    busy: boolean;
    /** Owned by the shell so the choice survives the home view being unmounted. */
    mode?: WorkspaceMode;
    /** Deduplicated list of workspaces from existing sessions, passed through to the Composer's workspace popover. */
    recentWorkDirs?: string[];
  }>(),
  { status: undefined, mode: 'chat', recentWorkDirs: () => [] },
);

const emit = defineEmits<{
  (e: 'send', text: string, mode: WorkspaceMode): void;
  (e: 'command', name: string, args?: string): void;
  (e: 'switch-model', alias: string): void;
  (e: 'switch-thinking', level: string): void;
  (e: 'update:mode', mode: WorkspaceMode): void;
  // "Turn running" can also happen on the home view (a draft creates the session
  // on consumption, or the home view is waiting for its first frame); the primary
  // button is then in its stop state, and not forwarding abort would leave a dead
  // button that does nothing when pressed.
  (e: 'abort'): void;
}>();

const isGoalMode = computed(() => props.mode === 'goal');
const modeHint = computed(() =>
  isGoalMode.value
    ? '任务模式：提交后将创建执行目标（Goal），Agent 持续执行到完成或预算耗尽；抽屉「Goal 管理」可查看与暂停。'
    : '直接对话：提问后 Agent 按需调用工具完成你的请求。',
);

/* ── Connection / model status (small type + dot, mirrored from the shell's
   status push: receiving one at all means the wire is live) ─────────────── */
const isConnected = computed(() => props.status !== undefined);
const statusModel = computed(() => props.status?.model);

/* ── Quick start: recent prompts recorded by the client (the localStorage
   key is a stable contract), falling back to neutral starter questions ──── */
const RECENT_KEY = 'scream-recent-prompts';
const recentPrompts = ref<string[]>([]);
const { fetchServerWorkDir } = useWorkspacePreference();
onMounted(() => {
  // Fetch the server default workspace once: the workspace chip relies on it to show a full path when the user has never picked a directory.
  void fetchServerWorkDir();
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) recentPrompts.value = parsed.filter((x): x is string => typeof x === 'string').slice(0, 4);
    }
  } catch {
    recentPrompts.value = [];
  }
});

const STARTERS: Record<WorkspaceMode, string[]> = {
  chat: ['梳理当前项目结构', '解释最近的代码改动', '帮我排查一个报错'],
  goal: ['修复构建并跑通测试', '完成一次小型重构', '整理项目文档'],
};
const hasRecents = computed(() => recentPrompts.value.length > 0);
const chips = computed(() => (hasRecents.value ? recentPrompts.value : STARTERS[props.mode]));

/* ── Chips fill the composer (insertText is exposed by Composer) rather than
   auto-sending — a quick start, not a commit ────────────────────────────── */
const composerRef = ref<InstanceType<typeof Composer> | null>(null);
function pickChip(text: string) {
  composerRef.value?.insertText(text);
}

/**
 * Landing point for "try it" in the skills centre while on the home view: WebShell
 * calls this after switching to home (the draft is consumed by onWorkspaceSend and
 * the session is only created at send time). Returns false = the input is not
 * mounted yet.
 */
function insertDraft(text: string): boolean {
  const composer = composerRef.value;
  if (!composer) return false;
  composer.insertDraft(text, { activate: true });
  return true;
}

defineExpose({ insertDraft });
</script>

<template>
  <div class="workspace">
    <section class="workspace-hero">
      <h1 class="workspace-brand">
        <img class="brand-logo" :src="logoUrl" alt="scream" />
      </h1>
      <p class="workspace-tagline">你的智能协作伙伴</p>
      <p class="workspace-status" aria-label="连接与模型状态">
        <span class="status-dot" :class="isConnected ? 'on' : 'off'" aria-hidden="true" />
        <span class="status-item">{{ isConnected ? '已连接' : '等待连接' }}</span>
        <template v-if="statusModel">
          <span class="status-sep">·</span>
          <span class="status-item status-model">{{ statusModel }}</span>
        </template>
      </p>
    </section>

    <section class="workspace-launch">
      <ModeSwitch
        class="workspace-mode"
        :model-value="props.mode"
        @update:model-value="(v) => emit('update:mode', v)"
      />
      <p class="mode-hint"><span :key="String(isGoalMode)" class="hint-fade">{{ modeHint }}</span></p>
      <div class="quick-start">
        <span class="quick-label">{{ hasRecents ? '最近' : '试试' }}</span>
        <div class="quick-chips">
          <button
            v-for="(c, i) in chips"
            :key="`${i}-${c}`"
            class="quick-chip"
            :title="c"
            @click="pickChip(c)"
          >
            {{ c }}
          </button>
        </div>
      </div>
    </section>

    <section class="workspace-composer">
      <Composer
        ref="composerRef"
        :busy="busy"
        :status="status"
        :models="models"
        :recent-work-dirs="recentWorkDirs"
        variant="home"
        :placeholder="isGoalMode ? '描述你要完成的目标，Enter 创建并开始执行…' : '输入 @ 引用知识库 / 使用技能 / 或者直接提问...'"
        @send="(t: string) => emit('send', t, props.mode)"
        @abort="emit('abort')"
        @command="(n, a) => emit('command', n, a)"
        @switch-model="(a) => emit('switch-model', a)"
        @switch-thinking="(l) => emit('switch-thinking', l)"
      />
    </section>
  </div>
</template>

<style scoped>
.workspace {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-7);
  padding: var(--space-6) var(--space-5);
  overflow-y: auto;
  background: transparent;
}
/* Static ambience only: the shared monochrome glow token, no motion. */
.workspace::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--ambient-glow);
  pointer-events: none;
}
.workspace > section {
  position: relative;
}

.workspace-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  text-align: center;
  animation: home-in var(--dur-slower) var(--ease-out) both;
}
.workspace-brand {
  display: flex;
  justify-content: center;
  line-height: 1;
  color: var(--color-text);
}
/* The wordmark's letter band is ~59% of its canvas height, so the image needs
   to run taller than the text it replaces to hold the same visual weight.
   The home keeps the brand restrained: smaller than the in-chat header. */
.brand-logo {
  display: block;
  height: 44px;
  width: auto;
}
:root[data-theme='dark'] .brand-logo {
  filter: invert(1) grayscale(1);
}
.workspace-tagline {
  margin: 0;
  font-size: var(--font-size-xl);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--color-text);
}

/* Connection + model: small type with a color dot, no box. */
.workspace-status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-faint);
}
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-text-faint);
}
.status-dot.on {
  background: var(--color-success);
  box-shadow: 0 0 6px var(--color-success);
}
.status-sep { opacity: 0.4; }
.status-item { white-space: nowrap; }
.status-model {
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 240px;
}

/* Mode switch + hint + quick start: the launch layer between brand and input. */
.workspace-launch {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  animation: home-in var(--dur-slower) var(--ease-out) var(--dur-fast) both;
}
/* Segmented restyle (ModeSwitch itself stays untouched): a hairline-track
   pill around the tabs. Color swaps are instant — only transform/opacity
   are allowed to transition. */
.workspace-mode {
  padding: var(--space-1);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
}
.workspace-mode :deep(.mode-pill) {
  border-radius: var(--radius-full);
  transition:
    transform var(--dur-fast) var(--ease-out),
    opacity var(--dur-fast) var(--ease-out);
}
.workspace-mode :deep(.mode-pill.active) {
  box-shadow: var(--shadow-xs);
}
.mode-hint {
  margin: 0;
  max-width: 560px;
  color: var(--color-text-faint);
  font-size: var(--font-size-xs);
  line-height: 1.5;
  text-align: center;
}
/* The hint text swaps when the mode flips; re-keyed span fades it in. */
.hint-fade {
  animation: hint-in 0.3s var(--ease-out) both;
}
@keyframes hint-in {
  from { opacity: 0; transform: translateY(2px); }
  to { opacity: 1; transform: none; }
}

/* Quick start: one quiet label + hairline chips, no card. */
.quick-start {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  max-width: 100%;
}
.quick-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-faint);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.quick-chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
  max-width: 560px;
}
.quick-chip {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
  /* Instant color swap on hover/active — no color transitions. */
  transition: none;
}
.quick-chip:hover {
  border-color: var(--color-accent-bd);
  color: var(--color-text);
  background: var(--color-hover);
}

.workspace-composer {
  width: min(var(--content-max), 100%);
  animation: home-rise var(--dur-slower) var(--ease-out) var(--dur-slow) both;
}

@keyframes home-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
@keyframes home-rise {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: none; }
}

@media (max-width: 640px) {
  .workspace {
    justify-content: flex-start;
    padding-top: 10vh;
    gap: var(--space-6);
  }
  .workspace-brand .brand-logo {
    height: 36px;
  }
  .workspace-tagline {
    font-size: var(--font-size-lg);
  }
  .status-model {
    max-width: 160px;
  }
  .quick-chip {
    max-width: 200px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .workspace-hero,
  .workspace-launch,
  .workspace-composer {
    animation: none;
  }
  .hint-fade {
    animation: none;
  }
}
</style>
