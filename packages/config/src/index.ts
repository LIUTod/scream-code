export {
  assertScreamHostIdentity,
  createScreamDefaultHeaders,
  createScreamDeviceHeaders,
  createScreamDeviceId,
  createScreamUserAgent,
  SCREAM_CODE_PLATFORM,
} from './identity';
export type {
  DeviceHeaders,
  ScreamHostIdentity,
  ScreamIdentityOptions,
} from './identity';

export { isRecord } from './utils';

export { t, getLocale, setLocale } from './i18n';
export type { Locale } from './i18n';
