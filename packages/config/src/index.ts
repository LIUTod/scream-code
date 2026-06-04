export {
  applyOpenPlatformConfig,
  fetchOpenPlatformModels,
  filterModelsByPrefix,
  getOpenPlatformById,
  isOpenPlatformId,
  OPEN_PLATFORMS,
  OpenPlatformApiError,
  removeOpenPlatformConfig,
} from './open-platform';
export type {
  ApplyOpenPlatformResult,
  OpenPlatformDefinition,
} from './open-platform';

export {
  applyManagedScreamCodeConfig,
  applyManagedScreamCodeLogoutConfig,
  capabilitiesForModel,
  clearManagedScreamCodeConfig,
  fetchManagedScreamCodeModels,
  provisionManagedScreamCodeConfig,
  SCREAM_CODE_PLATFORM_ID,
  SCREAM_CODE_PROVIDER_NAME,
} from './model-types';
export type {
  FetchManagedScreamCodeModelsOptions,
  ManagedScreamCodeApplyResult,
  ManagedScreamCodeCleanupResult,
  ManagedScreamCodeModelInfo,
  ManagedScreamCodeProvisionResult,
  ManagedScreamConfigAdapter,
  ManagedScreamConfigShape,
  ManagedScreamModelAlias,
  ManagedScreamOAuthRef,
  ManagedScreamProviderConfig,
  ManagedScreamServiceConfig,
  ManagedScreamServicesConfig,
  ProvisionManagedScreamCodeConfigOptions,
} from './model-types';

export { extractApiErrorMessage, readApiErrorMessage } from './api-error';

export {
  assertScreamHostIdentity,
  createScreamDefaultHeaders,
  createScreamDeviceHeaders,
  createScreamDeviceId,
  createScreamUserAgent,
  SCREAM_CODE_PLATFORM,
} from './identity';
export type {
  CreateScreamDeviceIdOptions,
  DeviceHeaders,
  ScreamHostIdentity,
  ScreamIdentityOptions,
} from './identity';

export { SCREAM_CODE_BASE_URL } from './constants';

export { isRecord } from './utils';
