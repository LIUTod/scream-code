import { onBeforeUnmount } from 'vue';
import { createClientContext, type ConnectionStatus } from './webClient/state';
import type { UseScreamWebClientReturn } from './webClient/types';
import { createQueueModule } from './webClient/queue';
import { createStreamingModule } from './webClient/streaming';
import { createSnapshotsModule } from './webClient/snapshots';
import { createMessagesModule } from './webClient/messages';
import { createSessionsModule } from './webClient/sessions';
import { createModelsModule } from './webClient/models';
import { createGoalsModule } from './webClient/goals';
import { createControlModule } from './webClient/control';
import { createExtensionsModule } from './webClient/extensions';
import { createMcpModule } from './webClient/mcp';
import { createConfigModule } from './webClient/config';
import { createConnectionModule } from './webClient/connection';

export type { ConnectionStatus };
export type { UseScreamWebClientReturn };

/**
 * Web session client facade.
 *
 * The implementation lives in ./webClient domains (connection, snapshots,
 * streaming, messages, queue, sessions, goals, control, extensions, mcp,
 * config). Each call creates fresh shared state and assembles the domains
 * explicitly — there are no module-level singletons, so two hosts each get
 * an independent client. This function only wires the domains together and
 * exposes the stable public shape consumed by the web components.
 */
export function useScreamWebClient(): UseScreamWebClientReturn {
  const ctx = createClientContext();
  const s = ctx.s;

  // Domain assembly. Every factory installs its cross-domain dependencies on
  // ctx; nothing runs (and nothing may call a registry method) until the
  // initial connect() at the bottom.
  createQueueModule(ctx);
  const streaming = createStreamingModule(ctx);
  const snapshots = createSnapshotsModule(ctx);
  const messages = createMessagesModule(ctx);
  const sessions = createSessionsModule(ctx);
  const models = createModelsModule(ctx);
  const goals = createGoalsModule(ctx);
  const control = createControlModule(ctx);
  const extensions = createExtensionsModule(ctx);
  const mcp = createMcpModule(ctx);
  const config = createConfigModule(ctx);
  const connection = createConnectionModule(ctx);

  // Initial connection.
  connection.connect();
  void sessions.fetchSessions();
  void models.fetchModels();

  const handleOnline = () => {
    connection.connect();
  };
  const handleVisibilityChange = () => {
    if (!document.hidden && s.connectionStatus.value !== 'connected') connection.connect();
  };
  window.addEventListener('online', handleOnline);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  onBeforeUnmount(() => {
    s.disposed = true;
    streaming.disposeStreaming();
    window.removeEventListener('online', handleOnline);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    connection.stopHeartbeat();
    if (s.reconnectTimer !== null) {
      clearTimeout(s.reconnectTimer);
      s.reconnectTimer = null;
    }
    if (s.snapshotRetryTimer !== null) {
      clearTimeout(s.snapshotRetryTimer);
      s.snapshotRetryTimer = null;
    }
    if (s.ws) {
      s.ws.onclose = null;
      s.ws.close();
      s.ws = null;
    }
  });

  return {
    connectionStatus: s.connectionStatus,
    messages: s.messages,
    pendingApprovals: s.pendingApprovals,
    status: s.status,
    goal: s.goal,
    todos: s.todos,
    goalRequestPending: s.goalRequestPending,
    goalRequestError: s.goalRequestError,
    error: s.error,
    sessionId: s.sessionId,
    workDir: s.workDir,
    isBusy: s.isBusy,
    isArchived: s.isArchived,
    sessions: s.sessions,
    currentSessionId: s.currentSessionId,
    gitStatus: s.gitStatus,
    models: s.models,
    like: s.like,
    fetchLike: models.fetchLike,
    updateLike: models.updateLike,
    sendPrompt: messages.sendPrompt,
    sendCommand: messages.sendCommand,
    clearMessages: messages.clearMessages,
    appendSystemMessage: messages.appendSystemMessage,
    abort: messages.abort,
    resolveApproval: messages.resolveApproval,
    fetchSessions: sessions.fetchSessions,
    fetchGitStatus: sessions.fetchGitStatus,
    fetchModels: models.fetchModels,
    reconnectNow: connection.reconnectNow,
    olderAvailable: s.olderAvailable,
    oldestSeq: s.oldestSeq,
    loadOlderMessages: messages.loadOlderMessages,
    switchModel: models.switchModel,
    switchThinking: models.switchThinking,
    refineGoal: goals.refineGoal,
    createGoal: goals.createGoal,
    updateGoal: goals.updateGoal,
    pauseGoal: goals.pauseGoal,
    resumeGoal: goals.resumeGoal,
    cancelGoal: goals.cancelGoal,
    createSession: sessions.createSession,
    switchSession: sessions.switchSession,
    deleteSession: sessions.deleteSession,
    exportSession: sessions.exportSession,
    fetchSnapshot: snapshots.fetchSnapshot,
    // Session-control / resource / global exposure (server.ts REST endpoints).
    fetchSessionStatus: control.fetchSessionStatus,
    fetchSessionUsage: control.fetchSessionUsage,
    fetchSessionContext: control.fetchSessionContext,
    fetchSessionPlan: control.fetchSessionPlan,
    sessionPlan: s.sessionPlan,
    clearPlan: control.clearPlan,
    switchPermission: control.switchPermission,
    switchPlanMode: control.switchPlanMode,
    switchWolfpack: control.switchWolfpack,
    switchRlm: control.switchRlm,
    undoHistory: control.undoHistory,
    compact: control.compact,
    skills: s.skills,
    fetchSkills: extensions.fetchSkills,
    activateSkill: extensions.activateSkill,
    removeSkill: extensions.removeSkill,
    plugins: s.plugins,
    pluginInfo: s.pluginInfo,
    fetchPlugins: extensions.fetchPlugins,
    fetchPluginInfo: extensions.fetchPluginInfo,
    installPlugin: extensions.installPlugin,
    setPluginEnabled: extensions.setPluginEnabled,
    setPluginMcpServerEnabled: extensions.setPluginMcpServerEnabled,
    removePlugin: extensions.removePlugin,
    reloadPlugins: extensions.reloadPlugins,
    activatePlugin: extensions.activatePlugin,
    deactivatePlugin: extensions.deactivatePlugin,
    injectPlugin: extensions.injectPlugin,
    mcpServers: s.mcpServers,
    mcpStartupMetrics: s.mcpStartupMetrics,
    fetchMcpServers: mcp.fetchMcpServers,
    fetchMcpStartupMetrics: mcp.fetchMcpStartupMetrics,
    addMcpServer: mcp.addMcpServer,
    reconnectMcpServer: mcp.reconnectMcpServer,
    stopMcpServer: mcp.stopMcpServer,
    removeMcpServer: mcp.removeMcpServer,
    backgroundTasks: s.backgroundTasks,
    backgroundTaskOutput: s.backgroundTaskOutput,
    fetchBackgroundTasks: mcp.fetchBackgroundTasks,
    fetchBackgroundTaskOutput: mcp.fetchBackgroundTaskOutput,
    stopBackgroundTask: mcp.stopBackgroundTask,
    config: s.config,
    fetchConfig: config.fetchConfig,
    setConfig: config.setConfig,
    removeProvider: config.removeProvider,
    experimentalFlags: s.experimentalFlags,
    fetchExperimentalFlags: config.fetchExperimentalFlags,
    preflightOk: s.preflightOk,
    preflight: config.preflight,
  };
}
