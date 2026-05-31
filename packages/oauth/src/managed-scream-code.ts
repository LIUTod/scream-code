import { readApiErrorMessage } from './api-error';
import { screamCodeBaseUrl } from './managed-usage';
import { isRecord } from './utils';

export const SCREAM_CODE_PLATFORM_ID = 'scream-code';
export const SCREAM_CODE_PROVIDER_NAME = 'managed:scream-code';
export const SCREAM_CODE_OAUTH_KEY = 'oauth/scream-code';

export interface ManagedScreamCodeModelInfo {
  readonly id: string;
  readonly contextLength: number;
  readonly supportsReasoning: boolean;
  readonly supportsImageIn: boolean;
  readonly supportsVideoIn: boolean;
  readonly supportsToolUse?: boolean;
  readonly displayName?: string | undefined;
}

export interface ManagedScreamCodeProvisionResult {
  readonly providerName: typeof SCREAM_CODE_PROVIDER_NAME;
  readonly defaultModel: string;
  readonly defaultThinking: boolean;
  readonly models: readonly ManagedScreamCodeModelInfo[];
  readonly configPath?: string | undefined;
}

export interface FetchManagedScreamCodeModelsOptions {
  readonly accessToken: string;
  readonly baseUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface ManagedScreamCodeApplyResult {
  readonly defaultModel: string;
  readonly defaultThinking: boolean;
}

export interface ManagedScreamCodeCleanupResult {
  readonly providerName: typeof SCREAM_CODE_PROVIDER_NAME;
  readonly removedProvider: boolean;
  readonly removedModels: readonly string[];
  readonly defaultModelCleared: boolean;
  readonly removedServices: readonly string[];
}

export interface ManagedScreamOAuthRef {
  readonly storage: 'file';
  readonly key: typeof SCREAM_CODE_OAUTH_KEY;
}

export interface ManagedScreamProviderConfig {
  type: 'scream';
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  oauth?: ManagedScreamOAuthRef | undefined;
  readonly [key: string]: unknown;
}

export interface ManagedScreamModelAlias {
  provider: string;
  model: string;
  maxContextSize: number;
  capabilities?: string[] | undefined;
  displayName?: string | undefined;
  readonly [key: string]: unknown;
}

export interface ManagedScreamServiceConfig {
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  oauth?: ManagedScreamOAuthRef | undefined;
}

export interface ManagedScreamServicesConfig {
  screamCliSearch?: ManagedScreamServiceConfig | undefined;
  screamCliFetch?: ManagedScreamServiceConfig | undefined;
  readonly [key: string]: unknown;
}

export interface ManagedScreamConfigShape {
  providers: Record<string, ManagedScreamProviderConfig | Record<string, unknown>>;
  models?: Record<string, ManagedScreamModelAlias | Record<string, unknown>> | undefined;
  defaultModel?: string | undefined;
  defaultThinking?: boolean | undefined;
  services?: ManagedScreamServicesConfig | undefined;
  [key: string]: unknown;
}

export interface ManagedScreamConfigAdapter<TConfig> {
  read(): Promise<TConfig> | TConfig;
  write(config: TConfig): Promise<void> | void;
  apply(
    config: TConfig,
    input: {
      readonly models: readonly ManagedScreamCodeModelInfo[];
      readonly baseUrl?: string | undefined;
      readonly preserveDefaultModel?: boolean | undefined;
    },
  ): ManagedScreamCodeApplyResult;
  remove?(config: TConfig): void;
  readonly configPath?: string | undefined;
}

export interface ProvisionManagedScreamCodeConfigOptions<TConfig> {
  readonly adapter: ManagedScreamConfigAdapter<TConfig>;
  readonly accessToken: string;
  readonly baseUrl?: string | undefined;
  readonly preserveDefaultModel?: boolean | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

function managedModelKey(modelId: string): string {
  return `${SCREAM_CODE_PLATFORM_ID}/${modelId}`;
}

interface SelectedDefaultModel {
  readonly modelKey: string;
  readonly thinking: boolean;
}

function capabilitiesForModel(model: ManagedScreamCodeModelInfo): string[] | undefined {
  const caps = new Set<string>();
  if (model.supportsReasoning) caps.add('thinking');
  if (model.supportsImageIn) caps.add('image_in');
  if (model.supportsVideoIn) caps.add('video_in');
  if (model.supportsToolUse ?? true) caps.add('tool_use');
  return caps.size > 0 ? [...caps] : undefined;
}

function defaultBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? screamCodeBaseUrl()).replace(/\/+$/, '');
}

function toModelInfo(item: unknown): ManagedScreamCodeModelInfo | undefined {
  if (!isRecord(item) || typeof item['id'] !== 'string' || item['id'].length === 0) {
    return undefined;
  }
  const contextLength = Number(item['context_length']);
  if (!Number.isInteger(contextLength) || contextLength <= 0) {
    throw new Error(`Scream Code model "${item['id']}" must include a positive context_length.`);
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

export async function fetchManagedScreamCodeModels(
  options: FetchManagedScreamCodeModelsOptions,
): Promise<ManagedScreamCodeModelInfo[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = defaultBaseUrl(options.baseUrl);
  const response = await fetchImpl(`${baseUrl}/models`, {
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(
      await readApiErrorMessage(
        response,
        `Failed to list Scream Code models (HTTP ${response.status}).`,
      ),
    );
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload['data'])) {
    throw new Error(`Unexpected models response for ${baseUrl}.`);
  }
  return payload['data']
    .map((item) => toModelInfo(item))
    .filter((item): item is ManagedScreamCodeModelInfo => item !== undefined);
}

export function applyManagedScreamCodeConfig(
  config: ManagedScreamConfigShape,
  options: {
    readonly models: readonly ManagedScreamCodeModelInfo[];
    readonly baseUrl?: string | undefined;
    readonly preserveDefaultModel?: boolean | undefined;
  },
): ManagedScreamCodeApplyResult {
  if (options.models.length === 0) {
    throw new Error('No models available for Scream Code.');
  }
  for (const model of options.models) {
    assertPositiveContextLength(model);
  }

  const baseUrl = defaultBaseUrl(options.baseUrl);
  const existingModels = config.models ?? {};
  const selectedDefault = selectDefaultModel(config, options.models, {
    preserveExisting: options.preserveDefaultModel === true,
  });

  config.providers[SCREAM_CODE_PROVIDER_NAME] = {
    type: 'scream',
    baseUrl,
    apiKey: '',
    oauth: { storage: 'file', key: SCREAM_CODE_OAUTH_KEY },
  };

  for (const [key, model] of Object.entries(existingModels)) {
    if (isRecord(model) && model['provider'] === SCREAM_CODE_PROVIDER_NAME) {
      delete existingModels[key];
    }
  }
  for (const model of options.models) {
    const capabilities = capabilitiesForModel(model);
    existingModels[managedModelKey(model.id)] = {
      provider: SCREAM_CODE_PROVIDER_NAME,
      model: model.id,
      maxContextSize: model.contextLength,
      capabilities,
      displayName: model.displayName,
    };
  }

  config.models = existingModels;
  config.defaultModel = selectedDefault.modelKey;
  config.defaultThinking = selectedDefault.thinking;
  config.services = {
    screamCliSearch: {
      baseUrl: `${baseUrl}/search`,
      apiKey: '',
      oauth: { storage: 'file', key: SCREAM_CODE_OAUTH_KEY },
    },
    screamCliFetch: {
      baseUrl: `${baseUrl}/fetch`,
      apiKey: '',
      oauth: { storage: 'file', key: SCREAM_CODE_OAUTH_KEY },
    },
  };

  return {
    defaultModel: selectedDefault.modelKey,
    defaultThinking: selectedDefault.thinking,
  };
}

export function applyManagedScreamCodeLogoutConfig(config: ManagedScreamConfigShape): void {
  delete config.providers[SCREAM_CODE_PROVIDER_NAME];

  let removedDefaultModel = false;
  const existingModels = config.models ?? {};
  for (const [key, model] of Object.entries(existingModels)) {
    if (!isRecord(model) || model['provider'] !== SCREAM_CODE_PROVIDER_NAME) continue;
    delete existingModels[key];
    if (config.defaultModel === key) removedDefaultModel = true;
  }
  config.models = existingModels;

  if (removedDefaultModel) {
    config.defaultModel = undefined;
  }

  if (config['defaultProvider'] === SCREAM_CODE_PROVIDER_NAME) {
    config['defaultProvider'] = undefined;
  }

  if (config.services !== undefined) {
    delete config.services.screamCliSearch;
    delete config.services.screamCliFetch;
    if (Object.keys(config.services).length === 0) {
      config.services = undefined;
    }
  }
}

function selectDefaultModel(
  config: ManagedScreamConfigShape,
  models: readonly ManagedScreamCodeModelInfo[],
  options: { readonly preserveExisting: boolean },
): SelectedDefaultModel {
  const firstModel = models[0];
  if (firstModel === undefined) {
    throw new Error('No models available for Scream Code.');
  }

  const managedModels = new Map(models.map((model) => [managedModelKey(model.id), model]));
  const existingModels = config.models ?? {};
  const currentDefault =
    typeof config.defaultModel === 'string' && config.defaultModel.length > 0
      ? config.defaultModel
      : undefined;

  if (
    options.preserveExisting &&
    currentDefault !== undefined &&
    canPreserveDefaultModel(existingModels, currentDefault, managedModels)
  ) {
    const preservedModel = managedModels.get(currentDefault);
    return {
      modelKey: currentDefault,
      thinking: config.defaultThinking ?? preservedModel?.supportsReasoning ?? false,
    };
  }

  return {
    modelKey: managedModelKey(firstModel.id),
    thinking: config.defaultThinking ?? firstModel.supportsReasoning,
  };
}

function canPreserveDefaultModel(
  existingModels: Record<string, ManagedScreamModelAlias | Record<string, unknown>>,
  defaultModel: string,
  managedModels: ReadonlyMap<string, ManagedScreamCodeModelInfo>,
): boolean {
  if (managedModels.has(defaultModel)) return true;
  const existing = existingModels[defaultModel];
  return isRecord(existing) && existing['provider'] !== SCREAM_CODE_PROVIDER_NAME;
}

export function clearManagedScreamCodeConfig(
  config: ManagedScreamConfigShape,
): ManagedScreamCodeCleanupResult {
  const removedProvider = Object.hasOwn(config.providers, SCREAM_CODE_PROVIDER_NAME);
  delete config.providers[SCREAM_CODE_PROVIDER_NAME];

  const removedModels: string[] = [];
  const models = config.models;
  if (models !== undefined) {
    for (const [key, model] of Object.entries(models)) {
      if (!isRecord(model) || model['provider'] !== SCREAM_CODE_PROVIDER_NAME) continue;
      delete models[key];
      removedModels.push(key);
    }
  }

  let defaultModelCleared = false;
  if (typeof config.defaultModel === 'string' && removedModels.includes(config.defaultModel)) {
    config.defaultModel = undefined;
    defaultModelCleared = true;
  }

  const removedServices: string[] = [];
  if (config.services?.screamCliSearch !== undefined) {
    delete config.services.screamCliSearch;
    removedServices.push('screamCliSearch');
  }
  if (config.services?.screamCliFetch !== undefined) {
    delete config.services.screamCliFetch;
    removedServices.push('screamCliFetch');
  }
  if (config.services !== undefined && Object.keys(config.services).length === 0) {
    config.services = undefined;
  }

  return {
    providerName: SCREAM_CODE_PROVIDER_NAME,
    removedProvider,
    removedModels,
    defaultModelCleared,
    removedServices,
  };
}

function assertPositiveContextLength(model: ManagedScreamCodeModelInfo): void {
  if (!Number.isInteger(model.contextLength) || model.contextLength <= 0) {
    throw new Error(`Scream Code model "${model.id}" must include a positive context_length.`);
  }
}

export async function provisionManagedScreamCodeConfigAfterLogin(
  options: ProvisionManagedScreamCodeConfigOptions<ManagedScreamConfigShape>,
): Promise<ManagedScreamCodeProvisionResult> {
  return provisionManagedScreamCodeConfig(options);
}

export async function provisionManagedScreamCodeConfig<TConfig>(
  options: ProvisionManagedScreamCodeConfigOptions<TConfig>,
): Promise<ManagedScreamCodeProvisionResult> {
  const models = await fetchManagedScreamCodeModels(options);
  const config = await options.adapter.read();
  const applied = options.adapter.apply(config, {
    models,
    baseUrl: options.baseUrl,
    preserveDefaultModel: options.preserveDefaultModel,
  });
  await options.adapter.write(config);
  return {
    providerName: SCREAM_CODE_PROVIDER_NAME,
    defaultModel: applied.defaultModel,
    defaultThinking: applied.defaultThinking,
    models,
    configPath: options.adapter.configPath,
  };
}
