import {
  type BearerTokenProvider,
  type OAuthRef,
} from '@scream-code/agent-core';

export interface ScreamAuthFacadeOptions {
  readonly homeDir: string;
  readonly configPath: string;
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
