import type { Logger } from '#/logging/types';
import type { ProviderConfig as LtodProviderConfig, ModelCapability, ProviderRequestAuth } from '@scream-code/ltod';
import { APIStatusError, createProvider, UNKNOWN_CAPABILITY } from '@scream-code/ltod';
import type { ScreamConfig, ModelAlias, OAuthRef, ProviderConfig } from '../config';
import { ErrorCodes, isScreamError, ScreamError } from '../errors';

export interface BearerTokenProvider {
  getAccessToken(options?: BearerTokenRequestOptions): Promise<string>;
  /**
   * Optional richer form: full request auth derived from the same credential
   * (bearer headers, provider base URL). When present the runtime prefers it
   * over `getAccessToken`, letting OAuth sessions carry provider-specific
   * request shaping (bearer headers, base URL overrides) without per-provider
   * plumbing.
   */
  getRequestAuth?(options?: BearerTokenRequestOptions): Promise<ProviderRequestAuth>;
}

export interface BearerTokenRequestOptions {
  /** The request that asked for this token was rejected; refresh it. */
  readonly force?: boolean;
  /**
   * Access token that request was rejected with. A forced refresh is skipped
   * when the stored credential no longer holds it (another request already
   * rotated it), so a recoverable 401 is not turned into a second rotation.
   */
  readonly rejectedAccess?: string;
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

interface ProviderManagerOptions {
  readonly config: ScreamConfig | (() => ScreamConfig);
  readonly screamRequestHeaders?: Record<string, string>;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver;
  readonly promptCacheKey?: string;
}

type AuthorizedRequest = <T>(
  request: (auth: ProviderRequestAuth) => Promise<T>,
) => Promise<T>;

export interface ModelProvider {
  readonly defaultModel?: string;
  resolveProviderConfig(model: string): ResolvedRuntimeProvider;
  resolveAuth?(model: string, options?: { readonly log?: Logger }): AuthorizedRequest | undefined;
}

export class SingleModelProvider implements ModelProvider {
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
      provider: this.providerConfig,
    }
  }
}

export class ProviderManager implements ModelProvider {
  constructor(private readonly options: ProviderManagerOptions) {}

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

    const provider = toLtodProviderConfig(
      providerConfig,
      alias.model,
      this.options.screamRequestHeaders,
      alias.maxOutputSize,
      alias.reasoningKey,
      this.options.promptCacheKey,
      alias.adaptiveThinking,
      alias.forceThinking,
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

    if (nonEmptyString(providerConfig.apiKey) !== undefined) {
      // oauth + apiKey on the same provider makes request auth ambiguous:
      // provider construction would prefer apiKey while runtime auth resolves
      // OAuth. Reject it so misconfiguration surfaces at model resolution.
      //
      // Only a literal `apiKey` field is reported: that is the field /login
      // clears and the one this message tells the user to remove. A key
      // inherited from the entry's `env` table is not part of this conflict.
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
    const fetchAuth = async (request?: BearerTokenRequestOptions): Promise<ProviderRequestAuth> => {
      try {
        if (tokenProvider.getRequestAuth !== undefined) {
          const auth = await tokenProvider.getRequestAuth(request);
          const hasApiKey = (auth.apiKey ?? '').trim().length > 0;
          const hasHeaders = auth.headers !== undefined && Object.keys(auth.headers).length > 0;
          if (!hasApiKey && !hasHeaders && auth.baseUrl === undefined) throw loginRequired();
          return auth;
        }
        const apiKey = await tokenProvider.getAccessToken(request);
        if (apiKey.trim().length === 0) throw loginRequired();
        return { apiKey };
      } catch (error) {
        if (!isScreamError(error) || error.code !== ErrorCodes.AUTH_LOGIN_REQUIRED) {
          log?.warn('oauth token fetch failed', { providerName, error });
        }
        throw loginRequired(error);
      }
    };

    return async (request) => {
      let auth = await fetchAuth();
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
          // Hand the forced refresh the token this request was rejected with:
          // if the store already rotated past it, no second rotation happens.
          auth = await fetchAuth({ force: true, rejectedAccess: rejectedAccessToken(auth) });
        }
      }
    };
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
  screamRequestHeaders: Record<string, string> | undefined,
): Record<string, string> {
  const name = provider.sessionHeader;
  if (name === undefined || sessionId === undefined || sessionId.length === 0) return {};
  const out: Record<string, string> = { [name]: sessionId };
  // Gateways that ask for a session header also want a first-party User-Agent.
  // Only attached when the session header is enabled so ordinary
  // OpenAI-compatible providers keep the SDK default UA.
  const userAgent = screamRequestHeaders?.['User-Agent'];
  if (userAgent !== undefined) out['User-Agent'] = userAgent;
  return out;
}

function resolvedHeaderFields(
  provider: ProviderConfig,
  sessionId: string | undefined,
  screamRequestHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const headers = {
    ...sessionHeaderFields(provider, sessionId, screamRequestHeaders),
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
): LtodProviderConfig {
  switch (provider.type) {
    case 'anthropic':
      return {
        type: 'anthropic',
        model,
        baseUrl: providerValue(provider.baseUrl, provider.env, 'ANTHROPIC_BASE_URL'),
        apiKey: providerApiKey(provider),
        ...(maxOutputSize !== undefined ? { defaultMaxTokens: maxOutputSize } : {}),
        ...(adaptiveThinking !== undefined ? { adaptiveThinking } : {}),
        ...defaultHeadersField(
          resolvedHeaderFields(provider, promptCacheKey, screamRequestHeaders),
        ),
      };
    case 'openai':
      return {
        type: 'openai',
        model,
        baseUrl: providerValue(provider.baseUrl, provider.env, 'OPENAI_BASE_URL'),
        apiKey: providerApiKey(provider),
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
        apiKey: providerApiKey(provider),
        generationKwargs: { prompt_cache_key: promptCacheKey },
        ...(forceThinking !== undefined ? { forceThinking } : {}),
        ...defaultHeadersField({ ...screamRequestHeaders, ...provider.customHeaders }),
      };
    case 'google-genai':
      return {
        type: 'google-genai',
        model,
        apiKey: providerApiKey(provider),
        baseUrl: providerValue(provider.baseUrl, provider.env, 'GOOGLE_GENAI_BASE_URL'),
      };
    case 'google-cloud-code':
      return {
        type: 'google-cloud-code',
        model,
        // Structured Cloud Code Assist credentials travel on the api-key
        // channel as JSON; the sign-in writes them per request, so the
        // configured value is only a fallback for hand-written entries.
        apiKey: providerApiKey(provider),
        baseUrl: providerValue(provider.baseUrl, provider.env, 'GOOGLE_CLOUD_CODE_BASE_URL'),
      };
    case 'openai-codex':
      return {
        type: 'openai-codex',
        model,
        // Structured Codex credentials ({ token, accountId }) travel on the
        // api-key channel as JSON; the sign-in writes them per request, so the
        // configured value is only a fallback for hand-written entries.
        apiKey: providerApiKey(provider),
        baseUrl: providerValue(provider.baseUrl, provider.env, 'OPENAI_CODEX_BASE_URL'),
      };
    case 'openai_responses':
      return {
        type: 'openai_responses',
        model,
        baseUrl: providerValue(provider.baseUrl, provider.env, 'OPENAI_BASE_URL'),
        apiKey: providerApiKey(provider),
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
        apiKey: useServiceAccount ? undefined : providerApiKey(provider),
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
  const apiKey = provider.apiKey && provider.apiKey.length > 0 ? provider.apiKey : 'capability-probe';
  if (provider.type === 'vertexai') {
    return { ...provider, vertexai: false, project: undefined, location: undefined, apiKey };
  }
  return { ...provider, apiKey };
}

function providerApiKey(provider: ProviderConfig): string | undefined {
  switch (provider.type) {
    case 'anthropic':
      return providerValue(provider.apiKey, provider.env, 'ANTHROPIC_API_KEY');
    case 'openai':
    case 'openai_responses':
      return providerValue(provider.apiKey, provider.env, 'OPENAI_API_KEY');
    case 'scream':
      return providerValue(provider.apiKey, provider.env, 'SCREAM_API_KEY');
    case 'google-genai':
      return providerValue(provider.apiKey, provider.env, 'GOOGLE_API_KEY');
    case 'google-cloud-code':
      return providerValue(provider.apiKey, provider.env, 'GOOGLE_CLOUD_CODE_API_KEY');
    case 'openai-codex':
      return providerValue(provider.apiKey, provider.env, 'OPENAI_CODEX_API_KEY');
    case 'vertexai':
      return (
        nonEmptyString(provider.apiKey) ??
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

function hasVertexAIServiceEnv(provider: ProviderConfig): boolean {
  return vertexAIProject(provider) !== undefined && vertexAILocation(provider) !== undefined;
}

/**
 * The access token a failed request authenticated with, so a forced refresh can
 * tell "this token was rejected" apart from "another request already rotated
 * it". Read from the same two places request auth carries a bearer credential:
 * the request key, then a bearer authorization header.
 */
function rejectedAccessToken(auth: ProviderRequestAuth): string | undefined {
  const apiKey = nonEmptyString(auth.apiKey);
  if (apiKey !== undefined) return structuredCredentialToken(apiKey) ?? apiKey;
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (name.toLowerCase() !== 'authorization') continue;
    if (!value.startsWith('Bearer ')) return undefined;
    return nonEmptyString(value.slice('Bearer '.length));
  }
  return undefined;
}

/**
 * Access token carried inside a structured credential. Several providers send
 * their request key as JSON (`{"token":…,"accountId":…}`), because the request
 * layer needs more than a bare token. The value the store compares against its
 * own `access` is the token inside, so it has to be unwrapped here: handing
 * over the whole JSON blob would never match the stored bare token and every
 * forced refresh after a 401 would be skipped, replaying the rejected token.
 *
 * The lookup chains the spellings in the order the aliasing request-layer
 * parsers read them (`token`, then `access_token`, then `access`): when a
 * hand-written credential carries several spellings with different values, the
 * guard must compare the token that is actually sent, or it can never match. A
 * parser without an alias chain reads the primary spelling only, so a
 * credential written in another spelling cannot match the stored token either
 * way.
 *
 * Anything that is not a JSON object with a non-empty string token field is
 * left to the caller (plain keys, non-JSON blobs).
 */
function structuredCredentialToken(apiKey: string): string | undefined {
  if (!apiKey.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(apiKey);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  for (const field of ['token', 'access_token', 'access']) {
    const value = record[field];
    if (typeof value === 'string') {
      const token = nonEmptyString(value);
      if (token !== undefined) return token;
    }
  }
  return undefined;
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
  configured: string | undefined,
  env: Record<string, string> | undefined,
  envKey: string,
): string | undefined {
  return nonEmptyString(configured) ?? envValue(env, envKey);
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
