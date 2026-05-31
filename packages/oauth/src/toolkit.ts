import { homedir } from 'node:os';
import { join } from 'node:path';

import { SCREAM_CODE_FLOW_CONFIG } from './constants';
import { OAuthUnauthorizedError } from './errors';
import { assertScreamHostIdentity, createScreamDeviceHeaders, type ScreamHostIdentity } from './identity';
import {
  fetchSubmitFeedback,
  screamCodeFeedbackUrl,
  type FetchSubmitFeedbackResult,
  type SubmitFeedbackBody,
} from './managed-feedback';
import {
  SCREAM_CODE_OAUTH_KEY,
  SCREAM_CODE_PROVIDER_NAME,
  provisionManagedScreamCodeConfig,
  type ManagedScreamCodeProvisionResult,
  type ManagedScreamConfigAdapter,
} from './managed-scream-code';
import {
  fetchManagedUsage,
  screamCodeUsageUrl,
  type FetchManagedUsageError,
  type ParsedManagedUsage,
} from './managed-usage';
import { OAuthManager, type LoginOptions, type OAuthManagerOptions } from './oauth-manager';
import { FileTokenStorage, type TokenStorage } from './storage';
import type { OAuthFlowConfig } from './types';

export interface BearerTokenProvider {
  getAccessToken(options?: { readonly force?: boolean | undefined }): Promise<string>;
}

export interface AuthProviderStatus {
  readonly providerName: string;
  readonly hasToken: boolean;
}

export interface AuthStatus {
  readonly providers: readonly AuthProviderStatus[];
}

export interface ScreamOAuthToolkitOptions<TConfig = unknown> {
  readonly identity?: ScreamHostIdentity | undefined;
  readonly homeDir?: string | undefined;
  readonly credentialsDir?: string | undefined;
  readonly storage?: TokenStorage | undefined;
  readonly flowConfig?: OAuthFlowConfig | undefined;
  readonly configAdapter?: ManagedScreamConfigAdapter<TConfig> | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: OAuthManagerOptions['now'];
  readonly sleep?: OAuthManagerOptions['sleep'];
  readonly deviceCodeTimeoutMs?: number | undefined;
  readonly refreshThreshold?: OAuthManagerOptions['refreshThreshold'];
  readonly onRefresh?: OAuthManagerOptions['onRefresh'];
}

export interface ScreamOAuthLoginOptions extends LoginOptions {
  readonly provisionConfig?: boolean | undefined;
  readonly baseUrl?: string | undefined;
}

export interface ScreamOAuthTokenRef {
  readonly key?: string | undefined;
}

export interface ScreamOAuthLoginResult {
  readonly providerName: string;
  readonly ok: true;
  readonly provision?: ManagedScreamCodeProvisionResult | undefined;
}

export interface ScreamOAuthLogoutResult {
  readonly providerName: string;
  readonly ok: true;
}

export type AuthManagedUsageResult =
  | {
      readonly kind: 'ok';
      readonly summary: ParsedManagedUsage['summary'];
      readonly limits: ParsedManagedUsage['limits'];
    }
  | FetchManagedUsageError;

export class ScreamOAuthToolkit<TConfig = unknown> {
  private readonly homeDir: string;
  private readonly identity: ScreamHostIdentity | undefined;
  private readonly storage: TokenStorage;
  private readonly flowConfig: OAuthFlowConfig;
  private readonly configAdapter: ManagedScreamConfigAdapter<TConfig> | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly managerOptions: Pick<
    OAuthManagerOptions,
    'now' | 'sleep' | 'deviceCodeTimeoutMs' | 'refreshThreshold' | 'onRefresh'
  >;
  private readonly managers = new Map<string, OAuthManager>();

  constructor(options: ScreamOAuthToolkitOptions<TConfig>) {
    this.identity =
      options.identity === undefined ? undefined : assertScreamHostIdentity(options.identity);
    this.homeDir = options.homeDir ?? defaultScreamHome();
    const credentialsDir = options.credentialsDir ?? join(this.homeDir, 'credentials');
    this.storage = options.storage ?? new FileTokenStorage(credentialsDir);
    this.flowConfig = options.flowConfig ?? SCREAM_CODE_FLOW_CONFIG;
    this.configAdapter = options.configAdapter;
    this.fetchImpl = options.fetchImpl;
    this.managerOptions = {
      now: options.now,
      sleep: options.sleep,
      deviceCodeTimeoutMs: options.deviceCodeTimeoutMs,
      refreshThreshold: options.refreshThreshold,
      onRefresh: options.onRefresh,
    };
  }

  async status(providerName?: string | undefined): Promise<AuthStatus> {
    const name = providerName ?? SCREAM_CODE_PROVIDER_NAME;
    return {
      providers: [
        {
          providerName: name,
          hasToken: await this.managerFor(name).hasToken(),
        },
      ],
    };
  }

  async login(
    providerName?: string | undefined,
    options: ScreamOAuthLoginOptions = {},
  ): Promise<ScreamOAuthLoginResult> {
    const name = providerName ?? SCREAM_CODE_PROVIDER_NAME;
    const manager = this.managerFor(name);
    const hadToken = await manager.hasToken();
    let accessToken: string;
    if (hadToken) {
      try {
        accessToken = await manager.ensureFresh();
      } catch (error) {
        if (!(error instanceof OAuthUnauthorizedError)) throw error;
        accessToken = (
          await manager.login({
            signal: options.signal,
            onDeviceCode: options.onDeviceCode,
          })
        ).accessToken;
      }
    } else {
      accessToken = (
        await manager.login({
          signal: options.signal,
          onDeviceCode: options.onDeviceCode,
        })
      ).accessToken;
    }

    const shouldProvision = options.provisionConfig ?? this.configAdapter !== undefined;
    const provision =
      shouldProvision && this.configAdapter !== undefined
        ? await provisionManagedScreamCodeConfig({
            accessToken,
            adapter: this.configAdapter,
            baseUrl: options.baseUrl,
            preserveDefaultModel: hadToken,
            fetchImpl: this.fetchImpl,
          })
        : undefined;

    return { providerName: name, ok: true, provision };
  }

  async logout(providerName?: string | undefined): Promise<ScreamOAuthLogoutResult> {
    const name = providerName ?? SCREAM_CODE_PROVIDER_NAME;
    await this.managerFor(name).logout();
    if (this.configAdapter?.remove !== undefined && name === SCREAM_CODE_PROVIDER_NAME) {
      const config = await this.configAdapter.read();
      this.configAdapter.remove(config);
      await this.configAdapter.write(config);
    }
    return { providerName: name, ok: true };
  }

  async ensureFresh(
    providerName?: string | undefined,
    options: { readonly force?: boolean | undefined } = {},
  ): Promise<string> {
    const name = providerName ?? SCREAM_CODE_PROVIDER_NAME;
    return this.managerFor(name).ensureFresh(options);
  }

  async getCachedAccessToken(
    providerName?: string,
    oauthRef?: ScreamOAuthTokenRef,
  ): Promise<string | undefined> {
    const name = providerName ?? SCREAM_CODE_PROVIDER_NAME;
    const oauthKey = oauthRef?.key ?? SCREAM_CODE_OAUTH_KEY;
    return this.managerFor(name, oauthKey).getCachedAccessToken();
  }

  tokenProvider(
    providerName?: string | undefined,
    oauthRef?: ScreamOAuthTokenRef | undefined,
  ): BearerTokenProvider {
    const name = providerName ?? SCREAM_CODE_PROVIDER_NAME;
    const oauthKey = oauthRef?.key ?? SCREAM_CODE_OAUTH_KEY;
    return {
      getAccessToken: (options) => this.managerFor(name, oauthKey).ensureFresh(options),
    };
  }

  async getManagedUsage(providerName?: string | undefined): Promise<AuthManagedUsageResult> {
    const name = providerName ?? SCREAM_CODE_PROVIDER_NAME;
    try {
      const accessToken = await this.ensureFresh(name);
      const result = await fetchManagedUsage(screamCodeUsageUrl(), accessToken);
      if (result.kind === 'error') return result;
      return {
        kind: 'ok',
        summary: result.parsed.summary,
        limits: result.parsed.limits,
      };
    } catch (error) {
      return {
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async submitFeedback(
    body: SubmitFeedbackBody,
    providerName?: string | undefined,
  ): Promise<FetchSubmitFeedbackResult> {
    const name = providerName ?? SCREAM_CODE_PROVIDER_NAME;
    try {
      const accessToken = await this.ensureFresh(name);
      return await fetchSubmitFeedback(screamCodeFeedbackUrl(), accessToken, body);
    } catch (error) {
      return {
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  managerFor(providerName: string, oauthKey = SCREAM_CODE_OAUTH_KEY): OAuthManager {
    const storageName = resolveScreamTokenStorageName({ providerName, oauthKey });
    let manager = this.managers.get(storageName);
    if (manager !== undefined) return manager;

    const identity = this.identity;
    manager = new OAuthManager({
      config: {
        ...this.flowConfig,
        name: storageName,
      },
      storage: this.storage,
      configDir: this.homeDir,
      deviceHeaders:
        identity === undefined
          ? undefined
          : () =>
              createScreamDeviceHeaders({
                homeDir: this.homeDir,
                version: identity.version,
              }),
      ...this.managerOptions,
    });
    this.managers.set(storageName, manager);
    return manager;
  }
}

export function resolveScreamTokenStorageName(input: {
  readonly providerName?: string | undefined;
  readonly oauthKey?: string | undefined;
}): string {
  const providerName = input.providerName ?? SCREAM_CODE_PROVIDER_NAME;
  if (providerName !== SCREAM_CODE_PROVIDER_NAME) {
    throw new Error(`No OAuth manager configured for provider "${providerName}".`);
  }

  const key = input.oauthKey ?? SCREAM_CODE_OAUTH_KEY;
  if (key === 'scream-code' || key === SCREAM_CODE_OAUTH_KEY) return 'scream-code';

  const prefix = 'oauth/';
  if (key.startsWith(prefix) && key.slice(prefix.length).length > 0) {
    return key.slice(prefix.length);
  }

  if (!key.includes('/') && !key.startsWith('.')) return key;
  throw new Error(`Invalid Scream OAuth token key: "${key}".`);
}

function defaultScreamHome(): string {
  const override = process.env['SCREAM_CODE_HOME'];
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), '.scream-code');
}
