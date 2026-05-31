import { readConfigFile, writeConfigFile, type ScreamConfig, type OAuthRef } from '@scream-cli/agent-core';
import {
  applyManagedScreamCodeConfig,
  applyManagedScreamCodeLogoutConfig,
  SCREAM_CODE_PROVIDER_NAME,
  ScreamOAuthToolkit,
  type AuthManagedUsageResult,
  type AuthStatus,
  type BearerTokenProvider,
  type FetchSubmitFeedbackResult,
  type ScreamHostIdentity,
  type ScreamOAuthLoginOptions,
  type ManagedScreamConfigShape,
  type OAuthRefreshOutcome,
} from '@scream-cli/scream-code-oauth';

export interface ScreamAuthSubmitFeedbackInput {
  readonly content: string;
  readonly sessionId: string;
  readonly version: string;
  readonly os: string;
  readonly model: string | null;
}

export type ScreamAuthLoginOptions = Omit<ScreamOAuthLoginOptions, 'provisionConfig'>;

export interface ScreamAuthLoginResult {
  readonly providerName: string;
  readonly ok: true;
  readonly defaultModel: string;
  readonly defaultThinking: boolean;
  readonly configPath?: string | undefined;
}

export interface ScreamAuthLogoutResult {
  readonly providerName: string;
  readonly ok: true;
}

export interface ScreamAuthFacadeOptions {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity?: ScreamHostIdentity | undefined;
  readonly onConfigUpdated?: ((config: ScreamConfig) => void) | undefined;
  readonly onRefresh?: ((outcome: OAuthRefreshOutcome) => void) | undefined;
}

type SDKManagedConfig = ScreamConfig & ManagedScreamConfigShape;

export class ScreamAuthFacade {
  private readonly toolkit: ScreamOAuthToolkit<SDKManagedConfig>;

  constructor(private readonly options: ScreamAuthFacadeOptions) {
    this.toolkit = new ScreamOAuthToolkit<SDKManagedConfig>({
      homeDir: options.homeDir,
      identity: options.identity,
      onRefresh: options.onRefresh,
      configAdapter: {
        configPath: options.configPath,
        read: () => readConfigFile(options.configPath) as SDKManagedConfig,
        write: async (config) => {
          await writeConfigFile(options.configPath, config);
        },
        apply: applyManagedScreamCodeConfig,
        remove: applyManagedScreamCodeLogoutConfig,
      },
    });
  }

  async status(providerName?: string | undefined): Promise<AuthStatus> {
    return this.toolkit.status(providerName);
  }

  async login(
    providerName: string | undefined = SCREAM_CODE_PROVIDER_NAME,
    options: ScreamAuthLoginOptions = {},
  ): Promise<ScreamAuthLoginResult> {
    const result = await this.toolkit.login(providerName, { ...options, provisionConfig: true });
    if (result.provision === undefined) {
      throw new Error('Scream auth login did not provision model config.');
    }
    const updated = readConfigFile(this.options.configPath);
    this.options.onConfigUpdated?.(updated);
    return {
      providerName: result.providerName,
      ok: true,
      defaultModel: result.provision.defaultModel,
      defaultThinking: result.provision.defaultThinking,
      configPath: result.provision.configPath,
    };
  }

  async logout(providerName?: string | undefined): Promise<ScreamAuthLogoutResult> {
    const result = await this.toolkit.logout(providerName);
    const updated = readConfigFile(this.options.configPath);
    this.options.onConfigUpdated?.(updated);
    return {
      providerName: result.providerName,
      ok: result.ok,
    };
  }

  async getManagedUsage(providerName?: string | undefined): Promise<AuthManagedUsageResult> {
    return this.toolkit.getManagedUsage(providerName);
  }

  async submitFeedback(
    input: ScreamAuthSubmitFeedbackInput,
    providerName?: string | undefined,
  ): Promise<FetchSubmitFeedbackResult> {
    return this.toolkit.submitFeedback(
      {
        session_id: input.sessionId,
        content: input.content,
        version: input.version,
        os: input.os,
        model: input.model,
      },
      providerName,
    );
  }

  async getCachedAccessToken(providerName?: string): Promise<string | undefined> {
    return this.toolkit.getCachedAccessToken(providerName);
  }

  readonly resolveOAuthTokenProvider = (
    providerName: string,
    oauthRef?: OAuthRef | undefined,
  ): BearerTokenProvider => {
    return this.toolkit.tokenProvider(providerName, oauthRef);
  };
}
