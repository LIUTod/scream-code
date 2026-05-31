import { readApiErrorMessage } from './api-error';
import { isRecord } from './utils';
import type {
  ManagedScreamCodeModelInfo,
  ManagedScreamConfigShape,
} from './managed-scream-code';

export type { ManagedScreamConfigShape };

export interface OpenPlatformDefinition {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly allowedPrefixes?: readonly string[] | undefined;
}

export const OPEN_PLATFORMS: readonly OpenPlatformDefinition[] = [
  {
    id: 'scream-cli-cn',
    name: 'ScreamCli AI Open Platform (scream-cli.cn)',
    baseUrl: 'https://api.scream-cli.cn/v1',
    allowedPrefixes: ['scream-k'],
  },
  {
    id: 'scream-cli-ai',
    name: 'ScreamCli AI Open Platform (scream-cli.ai)',
    baseUrl: 'https://api.scream-cli.ai/v1',
    allowedPrefixes: ['scream-k'],
  },
];

export function getOpenPlatformById(id: string): OpenPlatformDefinition | undefined {
  return OPEN_PLATFORMS.find((p) => p.id === id);
}

export function isOpenPlatformId(id: string): boolean {
  return OPEN_PLATFORMS.some((p) => p.id === id);
}

function toModelInfo(item: unknown): ManagedScreamCodeModelInfo | undefined {
  if (!isRecord(item) || typeof item['id'] !== 'string' || item['id'].length === 0) {
    return undefined;
  }
  const contextLength = Number(item['context_length']);
  if (!Number.isInteger(contextLength) || contextLength <= 0) {
    throw new Error(`Model "${item['id']}" must include a positive context_length.`);
  }
  const displayName = item['display_name'];
  const normalizedDisplayName =
    typeof displayName === 'string' && displayName.length > 0 ? displayName : undefined;
  const supportsToolUse = Object.hasOwn(item, 'supports_tool_use')
    ? Boolean(item['supports_tool_use'])
    : true;
  return {
    id: item['id'],
    contextLength,
    supportsReasoning: Boolean(item['supports_reasoning']),
    supportsImageIn: Boolean(item['supports_image_in']),
    supportsVideoIn: Boolean(item['supports_video_in']),
    supportsToolUse,
    displayName: normalizedDisplayName,
  };
}

export function capabilitiesForModel(model: ManagedScreamCodeModelInfo): string[] | undefined {
  const caps = new Set<string>();
  if (model.supportsReasoning) caps.add('thinking');
  if (model.supportsImageIn) caps.add('image_in');
  if (model.supportsVideoIn) caps.add('video_in');
  if (model.supportsToolUse ?? true) caps.add('tool_use');
  return caps.size > 0 ? [...caps] : undefined;
}

export class OpenPlatformApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function fetchOpenPlatformModels(
  platform: OpenPlatformDefinition,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ManagedScreamCodeModelInfo[]> {
  const res = await fetchImpl(`${platform.baseUrl.replace(/\/+$/, '')}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    signal,
  });
  if (!res.ok) {
    throw new OpenPlatformApiError(
      await readApiErrorMessage(res, `Failed to list models (HTTP ${res.status}).`),
      res.status,
    );
  }
  const payload: unknown = await res.json();
  if (!isRecord(payload) || !Array.isArray(payload['data'])) {
    throw new Error(`Unexpected models response for ${platform.baseUrl}.`);
  }
  return payload['data']
    .map((item) => toModelInfo(item))
    .filter((item): item is ManagedScreamCodeModelInfo => item !== undefined);
}

export function filterModelsByPrefix(
  models: ManagedScreamCodeModelInfo[],
  platform: OpenPlatformDefinition,
): ManagedScreamCodeModelInfo[] {
  if (!platform.allowedPrefixes || platform.allowedPrefixes.length === 0) {
    return models;
  }
  const prefixes = platform.allowedPrefixes;
  return models.filter((m) => prefixes.some((p) => m.id.startsWith(p)));
}

export interface ApplyOpenPlatformResult {
  readonly defaultModel: string;
  readonly defaultThinking: boolean;
}

export function applyOpenPlatformConfig(
  config: ManagedScreamConfigShape,
  options: {
    readonly platform: OpenPlatformDefinition;
    readonly models: readonly ManagedScreamCodeModelInfo[];
    readonly selectedModel: ManagedScreamCodeModelInfo;
    readonly thinking: boolean;
    readonly apiKey: string;
  },
): ApplyOpenPlatformResult {
  const providerKey = options.platform.id;
  const modelKey = `${providerKey}/${options.selectedModel.id}`;

  config.providers[providerKey] = {
    type: 'scream',
    baseUrl: options.platform.baseUrl,
    apiKey: options.apiKey,
  };

  const existingModels = config.models ?? {};
  for (const [key, model] of Object.entries(existingModels)) {
    if (isRecord(model) && model['provider'] === providerKey) {
      delete existingModels[key];
    }
  }

  for (const model of options.models) {
    const aliasKey = `${providerKey}/${model.id}`;
    existingModels[aliasKey] = {
      provider: providerKey,
      model: model.id,
      maxContextSize: model.contextLength,
      capabilities: capabilitiesForModel(model),
      displayName: model.displayName,
    };
  }

  config.models = existingModels;
  config.defaultModel = modelKey;
  config.defaultThinking = options.thinking;

  return { defaultModel: modelKey, defaultThinking: options.thinking };
}

export function removeOpenPlatformConfig(
  config: ManagedScreamConfigShape,
  platformId: string,
): void {
  delete config.providers[platformId];

  let removedDefault = false;
  const existingModels = config.models ?? {};
  for (const [key, model] of Object.entries(existingModels)) {
    if (!isRecord(model) || model['provider'] !== platformId) continue;
    delete existingModels[key];
    if (config.defaultModel === key) removedDefault = true;
  }
  config.models = existingModels;

  if (removedDefault) {
    config.defaultModel = undefined;
  }

  if (config['defaultProvider'] === platformId) {
    config['defaultProvider'] = undefined;
  }
}
