<script setup lang="ts">
import { computed, ref } from 'vue';
import type { UseScreamWebClientReturn } from '../composables/useScreamWebClient';
import { useSlashCommands } from '../composables/useSlashCommands';
import { openDockTab } from '../utils/fileTabState';
import ApprovalCard from './ApprovalCard.vue';
import Composer from './Composer.vue';
import ConversationHeader from './ConversationHeader.vue';
import InfoPanel from './InfoPanel.vue';
import MessageList from './MessageList.vue';
import SessionStatsPanel from './SessionStatsPanel.vue';

const props = defineProps<{ client: UseScreamWebClientReturn }>();

const emit = defineEmits<{ (e: 'home'): void }>();

const {
  connectionStatus,
  messages,
  pendingApprovals,
  status,
  sessionId,
  workDir,
  isBusy,
  models,
  sendPrompt,
  sendCommand,
  clearMessages,
  appendSystemMessage,
  abort,
  resolveApproval,
  exportSession,
  fetchSnapshot,
  switchModel,
  switchThinking,
  switchPermission,
  goal,
  pauseGoal,
  resumeGoal,
  cancelGoal,
} = props.client;

/**
 * A session switch closes the old socket and establishes the new one on the
 * next task.  Slash commands (including REST-backed skill activation and
 * `/revoke`) must wait for that handshake or they are rejected as offline.
 */
async function ensureSessionReady(): Promise<boolean> {
  const targetSessionId = props.client.sessionId.value;
  if (!targetSessionId) return false;
  if (props.client.connectionStatus.value === 'idle') return false;
  // The fallback keeps this view compatible with older host integrations that
  // provide the pre-waiter client shape while still avoiding a dropped command
  // whenever the current transport already reports connected.
  const ready = await (props.client.waitForConnected?.() ?? Promise.resolve(props.client.connectionStatus.value === 'connected'));
  return ready && props.client.sessionId.value === targetSessionId && props.client.connectionStatus.value === 'connected';
}

const composerRef = ref<InstanceType<typeof Composer> | null>(null);
const statsOpen = ref(false);
const infoVisible = ref(false);
const infoMode = ref<'status' | 'usage'>('status');

/** Current-turn token total from WS-pushed usage (status.usage.currentTurn). */
const turnTokens = computed(() => {
  const t = status.value.usage?.currentTurn;
  if (!t) return null;
  const n = t.inputOther + t.output + t.inputCacheRead + t.inputCacheCreation;
  return n > 0 ? n : null;
});

const currentTitle = computed(() => {
  const s = props.client.sessions.value.find((x) => x.sessionId === props.client.currentSessionId.value);
  const stored = s?.title;
  if (stored && stored !== '新会话' && stored !== 'New Session') return stored;
  const firstUser = messages.value.find((m) => m.role === 'user');
  if (firstUser) {
    const text = firstUser.content.replace(/\s+/g, ' ').trim();
    if (text) return text.length > 24 ? `${text.slice(0, 24)}…` : text;
  }
  return stored ?? null;
});

/**
 * Turn count for the top-bar stats pill: take the last message carrying a
 * server-side turn number, falling back to the loaded user message count. Both
 * sources are real data (turnStats.turn in the journal / the messages themselves),
 * never an estimate.
 */
const turnCount = computed(() => {
  for (let i = messages.value.length - 1; i >= 0; i -= 1) {
    const turn = messages.value[i]?.turnStats?.turn;
    if (turn) return turn;
  }
  return messages.value.filter((m) => m.role === 'user').length;
});

/**
 * The top bar is not shown in the empty-session transient: with lazy session
 * creation an empty journal only exists for the instant "send in flight" (the
 * message has not echoed back yet), when rename/export/clear all have nothing to
 * act on. The workbench home view has no top bar to begin with.
 */
const isEmptyConversation = computed(() => messages.value.length === 0 && !isBusy.value);

function onEditResend(content: string) {
  composerRef.value?.insertText(content);
}

/**
 * Landing point for "try it" in the skills centre: push the text into the input.
 * When the host (WebShell) gets false it falls back to the clipboard rather than
 * failing silently.
 */
function insertDraft(content: string, options?: { activate?: boolean }): boolean {
  if (!composerRef.value) return false;
  composerRef.value.insertDraft(content, options);
  return true;
}

defineExpose({ insertDraft });

/** Cancel an in-flight goal: same confirmation bar as GoalPanel's "cancel". */
async function onCancelGoal(): Promise<void> {
  if (!window.confirm('取消目标会让它进入已结束态，确定继续？')) return;
  await cancelGoal();
}

/** Edit goal: the right-dock Goal panel already carries the full form (budget / completion criteria / AI optimisation); do not rebuild it here. */
function onEditGoal(): void {
  openDockTab('goal');
}

function showInfo(mode: 'status' | 'usage') {
  void fetchSnapshot();
  infoMode.value = mode;
  infoVisible.value = true;
}

/** Delegate to the composer's picker; the shared dispatch prints the status
 *  message when no picker could open. */
function openModelPicker(): boolean {
  return composerRef.value?.openModelPicker() ?? false;
}

// Shared slash-command dispatch (see useSlashCommands). The chat view always
// has an active session, so no ensureSession hook is needed here.
const { onCommand } = useSlashCommands({
  sendCommand,
  clearMessages,
  appendSystemMessage,
  ensureSession: ensureSessionReady,
  onNew: () => emit('home'),
  openModelPicker,
  showInfo,
  currentModel: () => status.value.model,
});

function onRename(title: string) {
  sendCommand('title', title);
}

function retryLastUser() {
  if (isBusy.value || !connectionStatus.value) return;
  const lastUser = [...messages.value].reverse().find((m) => m.role === 'user');
  if (lastUser) sendPrompt(lastUser.content);
}

const loadingOlder = ref(false);
async function onLoadOlder(): Promise<void> {
  loadingOlder.value = true;
  await props.client.loadOlderMessages();
  loadingOlder.value = false;
}

function onFork(): void {
  if (isBusy.value) return;
  sendCommand('fork');
}
</script>

<template>
  <div class="conversation">
    <ConversationHeader
      v-if="!isEmptyConversation"
      :title="currentTitle"
      :busy="isBusy"
      :stats-open="statsOpen"
      :turn-tokens="turnTokens"
      :turn-count="turnCount"
      @home="emit('home')"
      @rename="onRename"
      @export="sessionId && exportSession(sessionId)"
      @fork="onFork"
      @clear="clearMessages"
      @controls="openDockTab('control')"
      @agents="openDockTab('agents')"
      @toggle-stats="statsOpen = !statsOpen"
    />

    <!-- Stats dropdown: anchored to the header's right edge; becomes a bottom
         sheet on small screens (see .stats-anchor media query). -->
    <div v-if="statsOpen" class="stats-anchor">
      <SessionStatsPanel
        :status="status"
        :fetch-usage="props.client.fetchSessionUsage"
        :fetch-context="props.client.fetchSessionContext"
        @close="statsOpen = false"
      />
    </div>

    <div class="chat-stage">
      <div class="chat-column">
        <MessageList
          :messages="messages"
          :busy="isBusy"
          :work-dir="workDir"
          :session-id="sessionId ?? ''"
          :connected="connectionStatus === 'connected'"
          :older-available="props.client.olderAvailable.value"
          :older-loading="loadingOlder"
          @edit="onEditResend"
          @retry-connection="props.client.reconnectNow()"
          @retry-message="retryLastUser"
          @load-older="onLoadOlder"
          @fork="onFork"
        />
        <div class="composer-dock">
          <ApprovalCard :approvals="pendingApprovals" @resolve="resolveApproval" />
          <Composer
            ref="composerRef"
            :busy="isBusy"
            :status="status"
            :session-id="sessionId"
            :models="models"
            :work-dir="workDir || ''"
            :messages="messages"
            :connection-status="connectionStatus"
            :goal="goal"
            @send="sendPrompt"
            @abort="abort"
            @command="onCommand"
            @switch-model="switchModel"
            @switch-thinking="switchThinking"
            @switch-permission="switchPermission"
            @goal-pause="pauseGoal"
            @goal-resume="resumeGoal"
            @goal-cancel="onCancelGoal"
            @goal-edit="onEditGoal"
          />
        </div>
      </div>
    </div>

    <InfoPanel
      v-if="infoVisible"
      :mode="infoMode"
      :status="status"
      :session-id="sessionId"
      :work-dir="workDir"
      @close="infoVisible = false"
    />
  </div>
</template>

<style scoped>
.conversation {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: transparent;
}
/* Stats dropdown floats below the header's right edge; z-dock keeps it above
   the message column without covering the mobile top bar. */
.stats-anchor {
  position: absolute;
  top: calc(56px + var(--space-2));
  right: var(--space-4);
  z-index: var(--z-dock);
}
@media (max-width: 640px) {
  .stats-anchor {
    top: auto;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    justify-content: stretch;
    z-index: var(--z-overlay);
  }
  .stats-anchor :deep(.stats-panel) {
    width: 100%;
    max-width: none;
    max-height: 70vh;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    border-bottom: none;
    box-shadow: var(--shadow-xl);
  }
}
.chat-stage {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  justify-content: center;
}
/* `flex: 1` sets flex-basis, which silently overrides `width` — the 840px cap
   never applied and the whole conversation ran edge-to-edge. Cap with
   max-width so the column grows to --content-max and stops there, matching the
   home view's measure. */
.chat-column {
  flex: 1 1 auto;
  min-width: 0;
  max-width: var(--content-max);
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.chat-column > :first-child {
  flex: 1;
  min-height: 0;
}
.composer-dock {
  flex-shrink: 0;
  padding: var(--space-2) var(--space-5) var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
@media (max-width: 640px) {
  .composer-dock {
    padding: var(--space-2) var(--space-3) var(--space-3);
  }
}
</style>
