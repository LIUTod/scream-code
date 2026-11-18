export { ScreamHarness } from '#/scream-harness';
export { Session } from '#/session';
export { ScreamAuthFacade } from '#/auth';
export type { ThinkingEffort } from '@scream-code/ltod';
export { addCost, estimateCost, formatUsd, priceForUsageKey } from '@scream-code/ltod';
export type { ModelPrice } from '@scream-code/ltod';
export { isOrphanedToolCallError } from '@scream-code/ltod';

export {
  applyCatalogProvider,
  catalogBaseUrl,
  catalogCachePath,
  catalogModelToAlias,
  catalogProviderModels,
  CatalogFetchError,
  DEFAULT_CATALOG_URL,
  fetchCatalog,
  saveCatalogCacheMeta,
  loadCatalogCacheMeta,
  fetchCatalogWithMeta,
  inferWireType,
  loadBuiltInCatalog,
  loadCatalogCache,
  resolveCatalogSessionHeader,
  saveCatalogCache,
} from '#/catalog';
export type {
  ApplyCatalogProviderOptions,
  Catalog,
  CatalogModel,
  CatalogProviderEntry,
} from '#/catalog';

export {
  ErrorCodes,
  ScreamError,
  type ScreamErrorCode,
  type ScreamErrorInfo,
  type ScreamErrorOptions,
  type ScreamErrorPayload,
  SCREAM_ERROR_INFO,
  fromScreamErrorPayload,
  isScreamError,
  toScreamErrorPayload,
} from '@scream-code/agent-core';

// Plugin-owned MCP runtime names share this predicate with the core's plugin
// hot-apply pass, so `/mcp` cannot drift from the naming contract.
export { isPluginMcpRuntimeName, pluginIdFromMcpRuntimeName } from '@scream-code/agent-core';
// Shared with the core's MCP config loader: the TUI uses the same path chain
// to tell "user-declared" apart from "project-declared" servers on uninstall.
export { resolveMcpJsonPaths } from '@scream-code/agent-core';

// Replay window shared with the TUI: the core trims replay payloads to the
// last REPLAY_TURN_LIMIT user turns, and the TUI renders the same window. The
// TUI cuts that window with the same "what starts a user turn" rule, so the
// predicate is exported here instead of being reimplemented in the TUI.
export { REPLAY_TURN_LIMIT, isRealUserPrompt } from '@scream-code/agent-core';

// RLM recursion-cap grammar shared with the core setter: the TUI
// `/rlm-max-depth` command validates through the same helpers so the two
// cannot drift apart.
export { normalizeRlmMaxDepth, parseRlmMaxDepthArg } from '@scream-code/agent-core';
export type { RlmMaxDepthParseResult } from '@scream-code/agent-core';

// Diagnostic logging — public surface only.
// RootLogger / getRootLogger / LoggingConfig stay inside agent-core;
// `__resetRootLoggerForTest` is the test-only hook e2e suites reset the
// process-global logger with.
export {
  __resetRootLoggerForTest,
  flushDiagnosticLogs,
  log,
  redact,
  resolveGlobalLogPath,
  resolveScreamHome,
} from '@scream-code/agent-core';
export type { LogContext, LogLevel, LogPayload, Logger } from '@scream-code/agent-core';

// Experimental feature flags — types only. Resolved values come from
// `ScreamHarness.getExperimentalFlags()` over RPC, not from a re-exported runtime value.
export type {
  ExperimentalFlagMap,
  FlagDefinition,
  FlagDefinitionInput,
  FlagId,
  FlagSurface,
} from '@scream-code/agent-core';
export type { GoalSnapshotData, TodoItem, TodoStatus } from '@scream-code/agent-core';
export { subagentRoster } from '@scream-code/agent-core';

// App-facing surface for the balance probe, config access, and web-layer
// session-index admin. AGENTS.md requires app code to reach core only
// through this package.
export {
  fetchProviderBalance,
  isSupportedBalanceProvider,
  readConfigFile,
} from '@scream-code/agent-core';
export type { ProviderBalance, ScreamConfig } from '@scream-code/agent-core';
export {
  appendSessionIndexEntry,
  encodeWorkDirKey,
  normalizeWorkDir,
  readSessionIndex,
  removeSessionIndexEntry,
} from '@scream-code/agent-core';

// Process locks: one live process per name (the resident host, a session),
// held by a listening socket for exactly the holder's lifetime.
export {
  acquireProcessLock,
  queryProcessLock,
  readOrCreateControlToken,
  requestProcessLock,
  requestSessionHandover,
  sessionLockHolder,
  sessionLockScope,
} from '@scream-code/agent-core';
// The running-work register: sessions with a turn in flight, which the
// background host continues after an interruption or a handoff.
export { listRunningWork, readRunningWork, removeRunningWork } from '@scream-code/agent-core';
export type { RunningWorkKind, RunningWorkRecord } from '@scream-code/agent-core';
// Background tasks (jobs): standing instructions the background host runs.
export {
  JOB_FATIGUE_LIMIT,
  JOB_RUNS_KEPT,
  JobError,
  JobStore,
  MAX_ENABLED_JOBS,
} from '@scream-code/agent-core';
export type { Job, JobDoes, JobRun, JobStarts, JobUntil, NewJob } from '@scream-code/agent-core';
// The "waiting for you" inbox: what unattended work could not decide alone.
export {
  decideInboxItem,
  listInbox,
  patchInboxItem,
  readInboxItem,
  saveInboxMemories,
} from '@scream-code/agent-core';
export type { InboxDecision, InboxItem } from '@scream-code/agent-core';
// Self-evolution: the change history of skills and memories, and tool friction.
export {
  collectFriction,
  evolutionDir,
  listEvolution,
  renderFrictionBlock,
  rollbackEvolution,
  showEvolutionChange,
  snapshotEvolution,
} from '@scream-code/agent-core';
export type { EvolutionChange, EvolutionResult, FrictionReport, ToolFriction } from '@scream-code/agent-core';
export type {
  BusyProcessLock,
  HeldProcessLock,
  ProcessLockIdentity,
  ProcessLockRequest,
} from '@scream-code/agent-core';

export * from '#/events';
export type * from '#/types';
