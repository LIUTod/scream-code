import { t } from '@scream-code/config';
import { DEFAULT_OAUTH_PROVIDER_NAME } from '#/constant/app';

export { DEFAULT_OAUTH_PROVIDER_NAME, PRODUCT_NAME } from '#/constant/app';

export function getLlmNotSetMessage(): string { return t('constant.llm_not_set'); }
export function getNoActiveSessionMessage(): string { return t('constant.no_active_session'); }
export function getCtrlDHint(): string { return t('constant.ctrl_d_hint'); }
export function getCtrlCHint(): string { return t('constant.ctrl_c_hint'); }

export const MAIN_AGENT_ID = 'main';
export const EXIT_CONFIRM_WINDOW_MS = 1500;

/** Repository page opened by Ctrl+F while the chat is empty (feedback / star). */
export const EMPTY_SESSION_HINT_URL = 'https://github.com/LIUTod/scream-code';

/** Tips shown in rotation above the editor when the chat is empty.
 *  `isAd` marks the partner tip - only it responds to Ctrl+F. */
export interface SessionTip {
  readonly i18nKey: string;
  readonly isAd: boolean;
}

export const SESSION_TIPS: readonly SessionTip[] = [
  { i18nKey: 'editor.tip_ad', isAd: true },
  { i18nKey: 'editor.tip_1', isAd: false },
  { i18nKey: 'editor.tip_2', isAd: false },
  { i18nKey: 'editor.tip_3', isAd: false },
  { i18nKey: 'editor.tip_4', isAd: false },
  { i18nKey: 'editor.tip_5', isAd: false },
  { i18nKey: 'editor.tip_6', isAd: false },
  { i18nKey: 'editor.tip_7', isAd: false },
  { i18nKey: 'editor.tip_8', isAd: false },
  { i18nKey: 'editor.tip_9', isAd: false },
  { i18nKey: 'editor.tip_10', isAd: false },
  { i18nKey: 'editor.tip_11', isAd: false },
  { i18nKey: 'editor.tip_12', isAd: false },
  { i18nKey: 'editor.tip_13', isAd: false },
  { i18nKey: 'editor.tip_14', isAd: false },
];

/** Interval for random tip rotation (ms). */
export const TIP_ROTATION_INTERVAL_MS = 6000;

export function isManagedUsageProvider(
  providerKey: string | undefined,
): providerKey is typeof DEFAULT_OAUTH_PROVIDER_NAME {
  return providerKey === DEFAULT_OAUTH_PROVIDER_NAME;
}
