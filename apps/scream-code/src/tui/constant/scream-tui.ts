import { t } from '@scream-code/config';
import { DEFAULT_OAUTH_PROVIDER_NAME } from '#/constant/app';

export { DEFAULT_OAUTH_PROVIDER_NAME, PRODUCT_NAME } from '#/constant/app';

export function getLlmNotSetMessage(): string { return t('constant.llm_not_set'); }
export function getNoActiveSessionMessage(): string { return t('constant.no_active_session'); }
export function getCtrlDHint(): string { return t('constant.ctrl_d_hint'); }
export function getCtrlCHint(): string { return t('constant.ctrl_c_hint'); }

export const MAIN_AGENT_ID = 'main';
export const EXIT_CONFIRM_WINDOW_MS = 1500;

/** Partner model-provider page opened by Ctrl+F while the chat is empty. */
export const EMPTY_SESSION_HINT_URL = 'https://opencode.ai/go?ref=75NKVRZQCY';

export function isManagedUsageProvider(
  providerKey: string | undefined,
): providerKey is typeof DEFAULT_OAUTH_PROVIDER_NAME {
  return providerKey === DEFAULT_OAUTH_PROVIDER_NAME;
}
