<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ConnectionStatus } from '../composables/useScreamWebClient';
import type { GitStatus, SessionStatus } from '../types';
import ContextRing from './ContextRing.vue';

const props = withDefaults(
  defineProps<{
    connectionStatus: ConnectionStatus;
    status: SessionStatus;
    sessionId?: string | null;
    workDir?: string | null;
    gitStatus?: GitStatus | null;
  }>(),
  { sessionId: null, workDir: null, gitStatus: null },
);

const emit = defineEmits<{
  (e: 'refresh-git'): void;
  (e: 'toggle-sidebar'): void;
}>();

const showDiff = ref(false);

function toggleDiff() {
  showDiff.value = !showDiff.value;
  if (showDiff.value) emit('refresh-git');
}

const labels: Record<ConnectionStatus, string> = {
  connecting: '连接中…',
  connected: '已连接',
  reconnecting: '重连中…',
  disconnected: '已断开',
};

const usagePercent = computed(() => {
  const u = props.status.contextUsage;
  if (u === undefined) return null;
  return Math.round((u > 1 ? u / 100 : u) * 100);
});

function formatTokens(n?: number): string {
  if (n === undefined) return '-';
  return n.toLocaleString();
}

function shortId(id?: string | null): string {
  return id ? id.slice(0, 8) : '-';
}

const tokenTitle = computed(() =>
  `Tokens: ${formatTokens(props.status.contextTokens)} / ${formatTokens(props.status.maxContextTokens)}`,
);

/* ── Git status ──────────────────────────────────────────────────────────── */
const gitSync = computed(() => {
  const g = props.gitStatus;
  if (!g) return '';
  const parts: string[] = [];
  if (g.ahead) parts.push(`↑${g.ahead}`);
  if (g.behind) parts.push(`↓${g.behind}`);
  return parts.join(' ');
});

const gitDiff = computed(() => {
  const g = props.gitStatus;
  if (!g) return '';
  const parts: string[] = [];
  if (g.adds) parts.push(`+${g.adds}`);
  if (g.dels) parts.push(`-${g.dels}`);
  return parts.join(' ');
});

const gitTitle = computed(() => {
  const g = props.gitStatus;
  if (!g) return '';
  const lines = [`分支：${g.branch ?? '(detached)'}`];
  if (g.changed) lines.push(`变更文件：${g.changed}`);
  if (g.ahead) lines.push(`领先远端 ${g.ahead} 个提交`);
  if (g.behind) lines.push(`落后远端 ${g.behind} 个提交`);
  lines.push('点击查看 diff 统计');
  return lines.join('\n');
});
</script>

<template>
  <header class="status-bar">
    <div class="brand">
      <button class="hamburger" aria-label="会话列表" title="会话列表" @click="emit('toggle-sidebar')">☰</button>
      <img src="/icon.ico" alt="Scream" class="logo" />
      <span class="title">Scream Web UI</span>
    </div>

    <div class="info">
      <span class="info-item" :title="sessionId ?? undefined">Session {{ shortId(sessionId) }}</span>
      <span v-if="status.model" class="info-item model">
        {{ status.model }}
        <span v-if="status.thinkingLevel && status.thinkingLevel !== 'none'" class="thinking-level">
          · {{ status.thinkingLevel }}
        </span>
      </span>
      <span
        v-if="usagePercent !== null"
        class="info-item context"
        :title="tokenTitle"
      >
        <ContextRing :usage="status.contextUsage" :size="18" />
        <span>{{ usagePercent }}%</span>
      </span>
      <span v-if="workDir" class="info-item workdir" :title="workDir">{{ workDir }}</span>
      <button
        v-if="gitStatus"
        class="info-item git"
        :title="gitTitle"
        @click="toggleDiff"
      >
        <span class="git-icon">⎇</span>
        <span class="git-branch">{{ gitStatus.branch ?? 'detached' }}</span>
        <span v-if="gitSync" class="git-sync">{{ gitSync }}</span>
        <span v-if="gitDiff" class="git-diff">{{ gitDiff }}</span>
      </button>
    </div>

    <div :class="['connection', connectionStatus]">
      <span class="dot" />
      <span class="label">{{ labels[connectionStatus] }}</span>
    </div>

    <Teleport to="body">
      <div v-if="showDiff && gitStatus" class="diff-overlay" @click.self="showDiff = false">
        <div class="diff-modal" role="dialog" aria-label="Git diff 统计">
          <div class="diff-header">
            <span class="diff-title">⎇ {{ gitStatus.branch ?? 'detached' }} — diff 统计</span>
            <button class="diff-close" title="关闭" @click="showDiff = false">✕</button>
          </div>
          <pre v-if="gitStatus.diffStat" class="diff-body">{{ gitStatus.diffStat }}</pre>
          <div v-else class="diff-empty">工作区干净，没有变更。</div>
        </div>
      </div>
    </Teleport>
  </header>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  gap: var(--space-5);
  padding: var(--space-3) var(--space-5);
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-line);
  box-shadow: var(--shadow-xs);
  flex-shrink: 0;
}
.brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-weight: 600;
  font-size: var(--font-size-base);
}
.hamburger {
  display: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  cursor: pointer;
  font-size: var(--font-size-base);
  line-height: 1;
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.hamburger:hover {
  background: var(--color-hover);
  border-color: var(--color-line-strong);
}
.hamburger:active {
  transform: scale(0.92);
}
.logo {
  width: 24px;
  height: 24px;
  object-fit: contain;
  filter: drop-shadow(0 0 6px var(--color-accent-glow));
}
.info {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-5);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  overflow-x: auto;
  white-space: nowrap;
  scrollbar-width: none;
}
.info::-webkit-scrollbar {
  display: none;
}
.info-item {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
}
.info-item.model {
  font-family: var(--font-mono);
  color: var(--color-text);
}
.thinking-level {
  color: var(--color-text-faint);
}
.info-item.context {
  font-variant-numeric: tabular-nums;
}
.info-item.workdir {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
  direction: rtl;
  text-align: left;
}
.info-item.git {
  font-family: var(--font-mono);
  color: var(--color-text);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-full);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-xs);
  padding: 3px 10px;
  cursor: pointer;
  transition:
    border-color var(--dur-base) var(--ease-out),
    background var(--dur-base) var(--ease-out),
    box-shadow var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}
.info-item.git:hover {
  border-color: var(--color-accent-bd);
  background: var(--color-accent-soft);
  box-shadow: var(--shadow-sm), 0 0 10px var(--color-accent-glow);
  transform: translateY(-1px);
}
.git-icon {
  color: var(--color-accent);
}
.git-branch {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.git-sync {
  color: var(--color-info);
}
.git-diff {
  color: var(--color-text-muted);
}

.diff-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-modal);
}
.diff-modal {
  width: min(640px, 90vw);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}
.diff-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-line);
}
.diff-title {
  font-weight: 600;
  font-size: var(--font-size-sm);
  color: var(--color-text);
}
.diff-close {
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: var(--font-size-base);
  padding: var(--space-1);
}
.diff-close:hover {
  color: var(--color-text);
}
.diff-body {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  overflow: auto;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  line-height: 1.5;
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-all;
}
.diff-empty {
  padding: var(--space-5);
  text-align: center;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.connection {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  flex-shrink: 0;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: currentColor;
}
.connection.connected .dot { background: var(--color-success); }
.connection.connecting .dot,
.connection.reconnecting .dot {
  background: var(--color-warning);
  animation: pulse 1s infinite;
}
.connection.disconnected .dot { background: var(--color-danger); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

@media (max-width: 640px) {
  .status-bar {
    padding: var(--space-2) var(--space-3);
    gap: var(--space-3);
  }
  .hamburger {
    display: inline-flex;
  }
  .info-item.workdir,
  .info-item:not(.context):not(.model) {
    display: none;
  }
  .connection .label {
    display: none;
  }
}
</style>
