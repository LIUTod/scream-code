export { ScreamHarness } from '#/scream-harness';
export { Session } from '#/session';
export { ScreamAuthFacade } from '#/auth';

export {
  applyCatalogProvider,
  catalogBaseUrl,
  catalogCachePath,
  catalogModelToAlias,
  catalogProviderModels,
  CatalogFetchError,
  DEFAULT_CATALOG_URL,
  fetchCatalog,
  inferWireType,
  loadBuiltInCatalog,
  loadCatalogCache,
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
} from '@scream-cli/agent-core';

// Diagnostic logging — public surface only.
// RootLogger / getRootLogger / LoggingConfig stay inside agent-core.
export {
  flushDiagnosticLogs,
  log,
  redact,
  resolveGlobalLogPath,
  resolveScreamHome,
} from '@scream-cli/agent-core';
export type { LogContext, LogLevel, LogPayload, Logger } from '@scream-cli/agent-core';

// Experimental feature flags — types only. Resolved values come from
// `ScreamHarness.getExperimentalFlags()` over RPC, not from a re-exported runtime value.
export type {
  ExperimentalFlagMap,
  FlagDefinition,
  FlagDefinitionInput,
  FlagId,
  FlagSurface,
} from '@scream-cli/agent-core';

export * from '#/events';
export type * from '#/types';
