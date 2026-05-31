import type { OAuthFlowConfig } from './types';

export const SCREAM_CODE_FLOW_CONFIG: OAuthFlowConfig = {
  name: 'scream-code',
  oauthHost:
    process.env['SCREAM_CODE_OAUTH_HOST'] ??
    process.env['SCREAM_OAUTH_HOST'] ??
    'https://auth.scream.com',
  clientId: '17e5f671-d194-4dfb-9706-5516cb48c098',
};
