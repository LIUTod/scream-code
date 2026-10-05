/**
 * Registry of providers with OAuth sign-in support.
 *
 * Adding a provider = implement `OAuthProviderModule` under `providers/` and
 * register it here. The array order is the selector display order.
 */

import { provider as anthropic } from './providers/anthropic';
import { provider as githubCopilot } from './providers/github-copilot';
import { provider as googleAntigravity } from './providers/google-antigravity';
import { provider as googleGeminiCli } from './providers/google-gemini-cli';
import { provider as kimiCoding } from './providers/kimi-coding';
import { provider as meta } from './providers/meta';
import { provider as openaiChatgpt } from './providers/openai-chatgpt';
import { provider as openaiCodex } from './providers/openai-codex';
import { provider as openrouter } from './providers/openrouter';
import { provider as radius } from './providers/radius';
import { provider as xai } from './providers/xai';
import type { LoginProviderInfo, OAuthProviderModule } from './types';

export const OAUTH_PROVIDERS: readonly OAuthProviderModule[] = [
  anthropic,
  openaiChatgpt,
  openaiCodex,
  githubCopilot,
  googleAntigravity,
  googleGeminiCli,
  openrouter,
  xai,
  kimiCoding,
  meta,
  radius,
];

export function findOAuthProvider(providerId: string): OAuthProviderModule | undefined {
  return OAUTH_PROVIDERS.find((provider) => provider.id === providerId);
}

export function listLoginProviders(): readonly LoginProviderInfo[] {
  return OAUTH_PROVIDERS.map(({ id, name, isSubscription, loginLabel, flowLabel, providerConfigType }) => ({
    id,
    name,
    isSubscription,
    loginLabel,
    flowLabel,
    providerConfigType,
  }));
}
