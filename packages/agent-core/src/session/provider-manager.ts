import type { Logger } from '#/logging/types';
import {
  APIStatusError,
  createKeyRing,
  createProvider,
  UNKNOWN_CAPABILITY,
  type ChatProvider,
  type KeyRing,
  type ProviderConfig as LtodProviderConfig,
  type ModelCapability,
  type ProviderRequestAuth,
} from '@scream-code/ltod';
import type { ScreamConfig, ModelAlias, OAuthRef, ProviderConfig } from '../config';
import { ErrorCodes, isScreamError, ScreamError } from '../errors';

export interface BearerTokenProvider {
  getAccessToken(options?: { readonly force?: boolean }): Promise<string>;
}

export type OAuthTokenProviderResolver = (
  providerName: string,
  oauthRef?: OAuthRef,
) => BearerTokenProvider | undefined;

export interface ResolvedRuntimeProvider {
  readonly providerName: string;
  readonly provider: LtodProviderConfig;
  readonly modelCapabilities: ModelCapability;
}

/** Request wrapper produced by {@link ModelProvider.resolveAuth}: it resolves
 *  the OAuth bearer token immediately before each request and refreshes it on
 *  401. Callers pass their request as the callback and receive the auth. */
export type AuthorizedRequest = <T>(
  request: (auth: ProviderRequestAuth) => Promise<T>,
) => Promise<T>;

/**
 * A model alias resolved into a ready-to-use chat provider for auxiliary
 * ("housekeeping") LLM calls. Produced by {@link ModelProvider.tryResolveChatModel}.
 */
export interface ResolvedChatModel {
  /** Chat provider built exactly like the session model's `config.provider`
   *  (`createProvider(resolveProviderConfig(alias).provider)`), so per-call
   *  overrides (`withThinking`, generation kwargs) behave identically. */
  readonly provider: ChatProvider;
  /** The alias name the model is configured under — the name `usage.record`
   *  and user-facing error messages key on, NOT the underlying provider model
   *  id (which lives on `provider.modelName`). */
  readonly modelName: string;
  readonly capabilities: ModelCapability;
  /** OAuth request wrapper for the alias's provider; undefined when the
   *  provider authenticates with its own constructor-level API key. */
  readonly authRequest: AuthorizedRequest | undefined;
}

interface ProviderManagerOptions {
  readonly config: ScreamConfig | (() => ScreamConfig);
  readonly screamRequestHeaders?: Record<string, string>;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver;
  readonly promptCacheKey?: string;
}

/** Failure codes that mean "this alias cannot be used" — every other error
 *  escaping resolution is a bug and must surface, not silently fall back. */
const UNRESOLVABLE_MODEL_CODES = new Set<string>([
  ErrorCodes.CONFIG_INVALID,
  ErrorCodes.MODEL_NOT_CONFIGURED,
  ErrorCodes.MODEL_CONFIG_INVALID,
]);

export interface ModelProvider {
  readonly defaultModel?: string;
  resolveProviderConfig(model: string): ResolvedRuntimeProvider;
  resolveAuth?(model: string, options?: { readonly log?: Logger }): AuthorizedRequest | undefined;
  /**
   * Best-effort alias resolution for auxiliary ("housekeeping") LLM calls
   * (e.g. compaction summarization on a cheaper model). Resolves through the
   * same path as {@link resolveProviderConfig} — same alias table, same
   * provider construction — but returns `undefined` instead of throwing when
   * `model` is not a usable alias (unknown name, missing provider, bad
   * context size), so callers can fall back to the session model. Errors
   * outside model resolution propagate.
   */
  tryResolveChatModel(model: string): ResolvedChatModel | undefined;
}

export class SingleModelProvider implements ModelProvider {
  private readonly keyRings = new ProviderKeyRings(newAffinitySeed());

  constructor(
    private readonly providerConfig: LtodProviderConfig,
    private readonly modelCapabilities: ModelCapability = UNKNOWN_CAPABILITY,
  ) {}

  get defaultModel(): string {
    return this.providerConfig.model;
  }

  resolveProviderConfig(model: string): ResolvedRuntimeProvider {
    if (model !== this.providerConfig.model) {
      throw new ScreamError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${model}" is not supported by SingleModelProvider.`,
      );
    }
    return {
      modelCapabilities: this.modelCapabilities,
      providerName: 'single-model-provider',
      provider: withProviderKeyRing(this.keyRings, 'single-model-provider', this.providerConfig),
    }
  }

  tryResolveChatModel(model: string): ResolvedChatModel | undefined {
    try {
      const resolved = this.resolveProviderConfig(model);
      // No OAuth layer exists on SingleModelProvider (resolveAuth is not
      // implemented), so the provider always authenticates with its own
      // constructor-level key.
      return {
        provider: createProvider(resolved.provider),
        modelName: model,
        capabilities: resolved.modelCapabilities,
        authRequest: undefined,
      };
    } catch {
      // SingleModelProvider supports exactly one model; anything else is the
      // "unknown alias" case and falls back.
      return undefined;
    }
  }
}

export class ProviderManager implements ModelProvider {
  /**
   * One key ring per configured provider name, shared by every provider
   * instance built for it (`createProvider` runs per call). Seeded with the
   * session id so concurrent sessions start on different keys of a pool.
   */
  private readonly keyRings: ProviderKeyRings;

  constructor(private readonly options: ProviderManagerOptions) {
    this.keyRings = new ProviderKeyRings(options.promptCacheKey ?? newAffinitySeed());
  }

  private get config(): ScreamConfig {
    const { config } = this.options;
    return typeof config === 'function' ? config() : config;
  }

  resolveProviderConfig(model: string): ResolvedRuntimeProvider {
    const alias = this.config.models?.[model];
    if (alias === undefined) {
      throw new ScreamError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${model}" is not configured in config.toml. Add a [models."${model}"] entry with max_context_size.`,
      );
    }

    const providerName = alias.provider ?? this.config.defaultProvider;
    if (providerName === undefined) {
      throw new ScreamError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${model}" must define a provider in config.toml.`,
      );
    }

    const providerConfig = this.config.providers[providerName];
    if (providerConfig === undefined) {
      throw new ScreamError(
        ErrorCodes.CONFIG_INVALID,
        `Provider "${providerName}" for model "${model}" is not configured.`,
      );
    }

    if (!Number.isInteger(alias.maxContextSize) || alias.maxContextSize <= 0) {
      throw new ScreamError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${model}" must define a positive max_context_size in config.toml.`,
      );
    }

    const provider = withProviderKeyRing(
      this.keyRings,
      providerName,
      toLtodProviderConfig(
        providerConfig,
        alias.model,
        this.options.screamRequestHeaders,
        alias.maxOutputSize,
        alias.reasoningKey,
        this.options.promptCacheKey,
        alias.adaptiveThinking,
        alias.forceThinking,
        alias.cacheRetention,
      ),
    );

    return {
      providerName,
      provider,
      modelCapabilities: resolveModelCapabilities(alias, provider),
    };
  }

  resolveAuth(
    model: string,
    options?: { readonly log?: Logger },
  ): AuthorizedRequest | undefined {
    const { providerName } = this.resolveProviderConfig(model);
    const providerConfig = this.config.providers[providerName];
    if (providerConfig?.oauth === undefined) return undefined;

    if (providerApiKey(providerConfig) !== undefined) {
      // oauth + apiKey on the same provider makes request auth ambiguous:
      // provider construction would prefer apiKey while runtime auth resolves
      // OAuth. Reject it so misconfiguration surfaces at model resolution.
      throw new ScreamError(
        ErrorCodes.CONFIG_INVALID,
        `Provider "${providerName}" has both apiKey and oauth set in config.toml — they are mutually exclusive. Remove one.`,
      );
    }

    const loginRequired = (cause?: unknown): ScreamError =>
      new ScreamError(
        ErrorCodes.AUTH_LOGIN_REQUIRED,
        `OAuth provider "${providerName}" requires login before it can be used.`,
        cause === undefined ? undefined : { cause },
      );

    const tokenProvider = this.options.resolveOAuthTokenProvider?.(providerName, providerConfig.oauth);
    if (tokenProvider === undefined) {
      return async () => {
        throw loginRequired();
      };
    }

    const log = options?.log;
    const fetchAuth = async (force: boolean): Promise<ProviderRequestAuth> => {
      let apiKey: string;
      try {
        apiKey = await tokenProvider.getAccessToken(force ? { force: true } : undefined);
      } catch (error) {
        if (!isScreamError(error) || error.code !== ErrorCodes.AUTH_LOGIN_REQUIRED) {
          log?.warn('oauth token fetch failed', { providerName, error });
        }
        throw loginRequired(error);
      }
      if (apiKey.trim().length === 0) throw loginRequired();
      return { apiKey };
    };

    return async (request) => {
      let auth = await fetchAuth(false);
      for (let refreshed = false; ; refreshed = true) {
        try {
          return await request(auth);
        } catch (error) {
          if (!(error instanceof APIStatusError) || error.statusCode !== 401) throw error;
          if (refreshed) {
            throw new ScreamError(
              ErrorCodes.AUTH_LOGIN_REQUIRED,
              'OAuth provider credentials were rejected. Send /login to login.',
              {
                cause: error,
                details: { statusCode: error.statusCode, requestId: error.requestId },
              },
            );
          }
          auth = await fetchAuth(true);
        }
      }
    };
  }

  tryResolveChatModel(model: string): ResolvedChatModel | undefined {
    try {
      const resolved = this.resolveProviderConfig(model);
      return {
        provider: createProvider(resolved.provider),
        modelName: model,
        capabilities: resolved.modelCapabilities,
        // Resolving auth may itself throw a config error (e.g. oauth + apiKey
        // set on the same provider) — that is the same "alias not usable"
        // bucket and is caught below, so the caller falls back instead of
        // failing the housekeeping call.
        authRequest: this.resolveAuth(model),
      };
    } catch (error) {
      if (isScreamError(error) && UNRESOLVABLE_MODEL_CODES.has(error.code)) return undefined;
      throw error;
    }
  }
}

/**
 * Session-scoped pool of {@link KeyRing}s, one per configured provider name.
 *
 * Providers are built per call (`createProvider(resolveProviderConfig().provider)`),
 * so the ring — not the provider — is what persists: every provider built for
 * the same config entry shares the cursor and cooldowns, and `rotateApiKey()`
 * on any instance advances the pool for the whole session. The start index is
 * hashed from a stable seed (the session id when the host has one) so
 * concurrent sessions spread their first request across the pool.
 */
class ProviderKeyRings {
  private readonly rings = new Map<string, { readonly signature: string; readonly ring: KeyRing }>();

  constructor(private readonly seed: string) {}

  resolve(providerName: string, apiKey: string | string[] | undefined): KeyRing | undefined {
    const keys = Array.isArray(apiKey) ? apiKey : apiKey === undefined ? [] : [apiKey];
    const usable = keys.map((key) => key.trim()).filter((key) => key.length > 0);
    if (usable.length === 0) return undefined;
    // Rebuild when the configured pool changed (config reload) so a stale
    // ring never keeps serving keys the user removed.
    const signature = usable.join('\u0000');
    const existing = this.rings.get(providerName);
    if (existing !== undefined && existing.signature === signature) return existing.ring;
    const ring = createKeyRing(usable, {
      startIndex: affinityIndex(this.seed, providerName, usable.length),
    });
    this.rings.set(providerName, { signature, ring });
    return ring;
  }
}

let affinitySeedCounter = 0;

/** Stable per-instance seed for hosts without a session id. */
function newAffinitySeed(): string {
  affinitySeedCounter += 1;
  return `${Date.now().toString(36)}-${affinitySeedCounter.toString(36)}`;
}

/** FNV-1a hash of `seed:providerName`, folded onto the pool size. */
function affinityIndex(seed: string, providerName: string, size: number): number {
  const input = `${seed}:${providerName}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.codePointAt(index) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash) % size;
}

/**
 * Attach the session-scoped key ring to a rotation-capable provider config.
 * Scream / Google / Vertex keep their single-key credential: their adapters
 * take `apiKey: string` and have no rotation path.
 */
function withProviderKeyRing(
  rings: ProviderKeyRings,
  providerName: string,
  provider: LtodProviderConfig,
): LtodProviderConfig {
  const withRing = (
    target: Extract<LtodProviderConfig, { type: 'anthropic' | 'openai' | 'openai_responses' }>,
  ): LtodProviderConfig => {
    const ring = rings.resolve(providerName, target.apiKey);
    return ring === undefined ? target : { ...target, keyRing: ring };
  };

  switch (provider.type) {
    case 'anthropic':
      return withRing(provider);
    case 'openai':
      return withRing(provider);
    case 'openai_responses':
      return withRing(provider);
    case 'scream':
    case 'google-genai':
    case 'vertexai':
      return provider;
    default: {
      const exhaustive: never = provider;
      throw new ScreamError(
        ErrorCodes.MODEL_CONFIG_INVALID,
        `Unsupported provider type: ${String(exhaustive)}`,
      );
    }
  }
}

function resolveModelCapabilities(
  alias: ModelAlias,
  provider: LtodProviderConfig,
): ModelCapability {
  const declared = new Set((alias.capabilities ?? []).map((c) => c.trim().toLowerCase()));
  const probe = createProvider(providerForCapabilityProbe(provider));
  const detected = probe.getCapability?.(provider.model) ?? UNKNOWN_CAPABILITY;

  return {
    image_in: declared.has('image_in') || detected.image_in,
    video_in: declared.has('video_in') || detected.video_in,
    audio_in: declared.has('audio_in') || detected.audio_in,
    thinking: declared.has('thinking') || declared.has('always_thinking') || detected.thinking,
    tool_use: declared.has('tool_use') || detected.tool_use,
    max_context_tokens: alias.maxContextSize,
  };
}

function sessionHeaderFields(
  provider: ProviderConfig,
  sessionId: string | undefined,
): Record<string, string> {
  const name = provider.sessionHeader;
  if (name === undefined || sessionId === undefined || sessionId.length === 0) return {};
  return { [name]: sessionId };
}

/**
 * The first-party product identity handed to third-party provider SDKs.
 *
 * The OpenAI/Anthropic JS SDKs stamp their own default User-Agent
 * (`OpenAI/JS x.y.z`) whenever the client sends none, so gateway operators
 * see the SDK instead of the product. Only the UA is carried over here —
 * the `X-Msh-*` device headers in `screamRequestHeaders` stay host-scoped
 * and must not leak to third-party endpoints. Providers can still override
 * it via `customHeaders` (merged later by the callers).
 */
function firstPartyUserAgentFields(
  screamRequestHeaders: Record<string, string> | undefined,
): Record<string, string> {
  const userAgent = screamRequestHeaders?.['User-Agent'];
  return userAgent === undefined ? {} : { 'User-Agent': userAgent };
}

function resolvedHeaderFields(
  provider: ProviderConfig,
  sessionId: string | undefined,
  screamRequestHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const headers = {
    ...sessionHeaderFields(provider, sessionId),
    ...firstPartyUserAgentFields(screamRequestHeaders),
    ...provider.customHeaders,
  };
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function toLtodProviderConfig(
  provider: ProviderConfig,
  model: string,
  screamRequestHeaders: Record<string, string> | undefined,
  maxOutputSize: number | undefined,
  reasoningKey: string | undefined,
  promptCacheKey: string | undefined,
  adaptiveThinking: boolean | undefined,
  forceThinking: boolean | undefined,
  cacheRetention: 'short' | 'long' | undefined,
): LtodProviderConfig {
  switch (provider.type) {
    case 'anthropic':
      return {
        type: 'anthropic',
        model,
        baseUrl: providerValue(provider.baseUrl, provider.env, 'ANTHROPIC_BASE_URL'),
        apiKey: providerKeyPool(provider, 'ANTHROPIC_API_KEY'),
        ...(maxOutputSize !== undefined ? { defaultMaxTokens: maxOutputSize } : {}),
        ...(adaptiveThinking !== undefined ? { adaptiveThinking } : {}),
        ...(cacheRetention !== undefined ? { cacheRetention } : {}),
        ...defaultHeadersField(
          resolvedHeaderFields(provider, promptCacheKey, screamRequestHeaders),
        ),
      };
    case 'openai':
      return {
        type: 'openai',
        model,
        baseUrl: providerValue(provider.baseUrl, provider.env, 'OPENAI_BASE_URL'),
        apiKey: providerKeyPool(provider, 'OPENAI_API_KEY'),
        reasoningKey,
        ...(forceThinking !== undefined ? { forceThinking } : {}),
        ...defaultHeadersField(
          resolvedHeaderFields(provider, promptCacheKey, screamRequestHeaders),
        ),
      };
    case 'scream':
      return {
        type: 'scream',
        model,
        baseUrl: providerValue(provider.baseUrl, provider.env, 'SCREAM_BASE_URL'),
        apiKey: singleApiKey(providerKeyPool(provider, 'SCREAM_API_KEY')),
        generationKwargs: { prompt_cache_key: promptCacheKey },
        ...(forceThinking !== undefined ? { forceThinking } : {}),
        ...defaultHeadersField({ ...screamRequestHeaders, ...provider.customHeaders }),
      };
    case 'google-genai':
      return {
        type: 'google-genai',
        model,
        apiKey: singleApiKey(providerKeyPool(provider, 'GOOGLE_API_KEY')),
        baseUrl: providerValue(provider.baseUrl, provider.env, 'GOOGLE_GENAI_BASE_URL'),
      };
    case 'openai_responses':
      return {
        type: 'openai_responses',
        model,
        baseUrl: providerValue(provider.baseUrl, provider.env, 'OPENAI_BASE_URL'),
        apiKey: providerKeyPool(provider, 'OPENAI_API_KEY'),
        ...defaultHeadersField(
          resolvedHeaderFields(provider, promptCacheKey, screamRequestHeaders),
        ),
      };
    case 'vertexai': {
      const useServiceAccount = hasVertexAIServiceEnv(provider);
      return {
        type: 'vertexai',
        model,
        vertexai: useServiceAccount,
        apiKey: useServiceAccount ? undefined : singleApiKey(providerKeyPool(provider, 'VERTEXAI_API_KEY')),
        project: vertexAIProject(provider),
        location: vertexAILocation(provider),
      };
    }
    default: {
      const exhaustive: never = provider.type;
      throw new ScreamError(
        ErrorCodes.MODEL_CONFIG_INVALID,
        `Unsupported provider type: ${String(exhaustive)}`,
      );
    }
  }
}

// Returns a fresh `defaultHeaders` field for a ltod provider config so
// resolved instances never share a header object. Omits the key entirely when
// there are no headers — callers and tests rely on `'defaultHeaders' in provider`.
function defaultHeadersField(
  headers: Record<string, string> | undefined,
): { defaultHeaders?: Record<string, string> } {
  if (headers === undefined || Object.keys(headers).length === 0) return {};
  return { defaultHeaders: { ...headers } };
}

function providerForCapabilityProbe(provider: LtodProviderConfig): LtodProviderConfig {
  const configured = Array.isArray(provider.apiKey) ? provider.apiKey[0] : provider.apiKey;
  const apiKey =
    configured !== undefined && configured.length > 0 ? configured : 'capability-probe';
  if (provider.type === 'vertexai') {
    return { ...provider, vertexai: false, project: undefined, location: undefined, apiKey };
  }
  return { ...provider, apiKey };
}

/**
 * Configured credential, or a rotation pool for the adapters that support one
 * (`anthropic`, `openai`, `openai_responses`). An array passes through with
 * blank entries dropped; an unusable array falls back to the provider `env`
 * entry, exactly like an unset `apiKey`.
 */
function providerKeyPool(
  provider: ProviderConfig,
  envKey: string,
): string | string[] | undefined {
  if (Array.isArray(provider.apiKey)) {
    const keys = provider.apiKey.map((key) => key.trim()).filter((key) => key.length > 0);
    return keys.length === 0 ? envValue(provider.env, envKey) : keys;
  }
  return providerValue(provider.apiKey, provider.env, envKey);
}

function providerApiKey(provider: ProviderConfig): string | string[] | undefined {
  switch (provider.type) {
    case 'anthropic':
      return providerKeyPool(provider, 'ANTHROPIC_API_KEY');
    case 'openai':
    case 'openai_responses':
      return providerKeyPool(provider, 'OPENAI_API_KEY');
    case 'scream':
      return providerValue(provider.apiKey, provider.env, 'SCREAM_API_KEY');
    case 'google-genai':
      return providerValue(provider.apiKey, provider.env, 'GOOGLE_API_KEY');
    case 'vertexai':
      return (
        nonEmptyString(singleApiKey(provider.apiKey)) ??
        envValue(provider.env, 'VERTEXAI_API_KEY') ??
        envValue(provider.env, 'GOOGLE_API_KEY')
      );
    default: {
      const exhaustive: never = provider.type;
      throw new ScreamError(
        ErrorCodes.MODEL_CONFIG_INVALID,
        `Unsupported provider type: ${String(exhaustive)}`,
      );
    }
  }
}

/** First entry of a configured credential: the single-key providers take one. */
function singleApiKey(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hasVertexAIServiceEnv(provider: ProviderConfig): boolean {
  return vertexAIProject(provider) !== undefined && vertexAILocation(provider) !== undefined;
}

function vertexAIProject(provider: ProviderConfig): string | undefined {
  return envValue(provider.env, 'GOOGLE_CLOUD_PROJECT');
}

function vertexAILocation(provider: ProviderConfig): string | undefined {
  return (
    envValue(provider.env, 'GOOGLE_CLOUD_LOCATION') ??
    locationFromVertexAIBaseUrl(provider.baseUrl)
  );
}

function providerValue(
  configured: string | string[] | undefined,
  env: Record<string, string> | undefined,
  envKey: string,
): string | undefined {
  return nonEmptyString(singleApiKey(configured)) ?? envValue(env, envKey);
}

function envValue(env: Record<string, string> | undefined, key: string): string | undefined {
  return nonEmptyString(env?.[key]);
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function locationFromVertexAIBaseUrl(baseUrl: string | undefined): string | undefined {
  const url = nonEmptyString(baseUrl);
  if (url === undefined) return undefined;
  try {
    const host = new URL(url).hostname;
    const suffix = '-aiplatform.googleapis.com';
    return host.endsWith(suffix) ? nonEmptyString(host.slice(0, -suffix.length)) : undefined;
  } catch {
    return undefined;
  }
}
