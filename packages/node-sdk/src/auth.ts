import {
  type BearerTokenProvider,
  type OAuthRef,
} from '@scream-cli/agent-core';

export interface ScreamAuthFacadeOptions {
  readonly homeDir: string;
  readonly configPath: string;
}

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

export interface ScreamAuthSubmitFeedbackInput {
  readonly content: string;
  readonly sessionId: string;
  readonly version: string;
  readonly os: string;
  readonly model: string | null;
}

export class ScreamAuthFacade {
  constructor(private readonly options: ScreamAuthFacadeOptions) {}

  async getManagedUsage(_providerName?: string | undefined): Promise<
    | { readonly kind: 'ok'; readonly summary: unknown; readonly limits: readonly unknown[] }
    | { readonly kind: 'error'; readonly message: string }
  > {
    return {
      kind: 'error',
      message: 'Managed usage requires OAuth login. Use /config to set up a custom model provider.',
    };
  }

  async getCachedAccessToken(_providerName?: string): Promise<string | undefined> {
    return undefined;
  }

  readonly resolveOAuthTokenProvider = (
    _providerName: string,
    _oauthRef?: OAuthRef | undefined,
  ): BearerTokenProvider | undefined => {
    return undefined;
  };
}
