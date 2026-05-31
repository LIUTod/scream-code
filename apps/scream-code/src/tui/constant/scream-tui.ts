import { DEFAULT_OAUTH_PROVIDER_NAME } from '#/constant/app';

export { DEFAULT_OAUTH_PROVIDER_NAME, PRODUCT_NAME } from '#/constant/app';

export const LLM_NOT_SET_MESSAGE = 'LLM 未设置，运行 /config 自定义模型配置';
export const NO_ACTIVE_SESSION_MESSAGE = '没有活动会话。运行 /config 自定义模型配置。';
export const CTRL_D_HINT = '再次按 Ctrl+D 退出';
export const CTRL_C_HINT = '再次按 Ctrl+C 退出';
export const MAIN_AGENT_ID = 'main';
export const EXIT_CONFIRM_WINDOW_MS = 1500;

export function isManagedUsageProvider(
  providerKey: string | undefined,
): providerKey is typeof DEFAULT_OAUTH_PROVIDER_NAME {
  return providerKey === DEFAULT_OAUTH_PROVIDER_NAME;
}
