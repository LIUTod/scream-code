<script setup lang="ts">
import type { ConnectionStatus, SessionStatus } from '../types';

const props = defineProps<{
  connectionStatus: ConnectionStatus;
  status: SessionStatus;
  sessionId?: string | null;
  workDir?: string | null;
}>();

const labels: Record<ConnectionStatus, string> = {
  connecting: '连接中...',
  connected: '已连接',
  reconnecting: '重连中...',
  disconnected: '已断开',
};

function formatTokens(n?: number): string {
  if (n === undefined) return '-';
  return n.toLocaleString();
}

function shortId(id?: string | null): string {
  return id ? id.slice(0, 8) : '-';
}
</script>

<template>
  <header class="status-bar">
    <div class="brand">
      <span class="logo">■</span>
      <span class="title">Scream Web UI</span>
    </div>

    <div class="info">
      <span class="info-item" :title="sessionId ?? undefined">Session: {{ shortId(sessionId) }}</span>
      <span v-if="status.model" class="info-item">Model: {{ status.model }}</span>
      <span v-if="status.contextTokens !== undefined && status.maxContextTokens" class="info-item">
        Tokens: {{ formatTokens(status.contextTokens) }} / {{ formatTokens(status.maxContextTokens) }}
      </span>
    </div>

    <div :class="['connection', connectionStatus]">
      <span class="dot" />
      <span class="label">{{ labels[connectionStatus] }}</span>
    </div>
  </header>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 20px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}
.logo {
  color: var(--accent);
  font-size: 18px;
}
.info {
  flex: 1;
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--text-dim);
  overflow-x: auto;
  white-space: nowrap;
}
.connection {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-dim);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}
.connection.connected .dot { background: var(--accent); }
.connection.connecting .dot, .connection.reconnecting .dot { background: var(--yellow); animation: pulse 1s infinite; }
.connection.disconnected .dot { background: var(--red); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

@media (max-width: 640px) {
  .status-bar {
    padding: 10px 12px;
    gap: 10px;
  }
  .info {
    display: none;
  }
}
</style>
