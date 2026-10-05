import type { ChatProvider } from '../provider';
import { AnthropicChatProvider, type AnthropicOptions } from './anthropic';
import { GoogleGenAIChatProvider, type GoogleGenAIOptions } from './google-genai';
import { ScreamChatProvider, type ScreamOptions } from './scream';
import { OpenAILegacyChatProvider, type OpenAILegacyOptions } from './openai-legacy';
import { OpenAIResponsesChatProvider, type OpenAIResponsesOptions } from './openai-responses';

export type ProviderConfig =
  | ({ type: 'anthropic' } & AnthropicOptions)
  | ({ type: 'openai' } & OpenAILegacyOptions)
  | ({ type: 'scream' } & ScreamOptions)
  | ({ type: 'google-genai' } & GoogleGenAIOptions)
  | ({ type: 'openai_responses' } & OpenAIResponsesOptions)
  | ({ type: 'vertexai' } & GoogleGenAIOptions);

type VertexModeGuard<T extends ProviderConfig> = T extends { type: 'vertexai' }
  ? T extends { vertexai: infer TVertex }
    ? false extends TVertex
      ? never
      : unknown
    : unknown
  : unknown;

export type ProviderType = ProviderConfig['type'];

export function createProvider<const T extends ProviderConfig>(
  config: T & VertexModeGuard<T>,
): ChatProvider {
  const providerConfig: ProviderConfig = config;
  switch (providerConfig.type) {
    case 'anthropic':
      return new AnthropicChatProvider(providerConfig);
    case 'openai':
      return new OpenAILegacyChatProvider(providerConfig);
    case 'scream':
      return new ScreamChatProvider(providerConfig);
    case 'google-genai':
      return new GoogleGenAIChatProvider(providerConfig);
    case 'openai_responses':
      return new OpenAIResponsesChatProvider(providerConfig);
    case 'vertexai':
      return new GoogleGenAIChatProvider({ ...providerConfig, vertexai: true });
    default: {
      const exhaustive: never = providerConfig;
      throw new Error(`Unknown provider type: ${String(exhaustive)}`);
    }
  }
}
