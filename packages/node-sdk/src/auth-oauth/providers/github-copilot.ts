/**
 * GitHub Copilot OAuth provider (device-code sign-in).
 *
 * The device flow yields a GitHub access token, which is then exchanged for a
 * short-lived Copilot API token bound to the account. The GitHub token is kept
 * as the credential's `refresh` value and the exchange is re-run whenever the
 * short-lived token approaches its expiry, so `refresh()` walks the same path
 * as the tail of `login()`.
 *
 * GitHub Enterprise hosts get their own endpoints derived from the domain the
 * user enters; the resolved host is stored with the credential and reused by
 * later refreshes.
 */

import { pollOAuthDeviceCodeFlow } from '../device-code';
import type { OAuthCredential, OAuthProviderModule, ProviderAuthInteraction } from '../types';

/** Public client id of the device flow. */
const CLIENT_ID = Buffer.from('SXYxLmI1MDdhMDhjODdlY2ZlOTg=', 'base64').toString('utf-8');
const DEFAULT_DOMAIN = 'github.com';
const DEVICE_CODE_SCOPE = 'read:user';
/** Short-lived API tokens are treated as expired this long before their stated expiry. */
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;
/** Upper bound on a single request to GitHub or the Copilot API. */
const REQUEST_TIMEOUT_MS = 30 * 1000;

/** Headers the API token endpoint identifies its clients by. */
const COPILOT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
} as const;

type DeviceCodeResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds?: number;
  expiresInSeconds: number;
};

type ProviderUrls = {
  deviceCodeUrl: string;
  accessTokenUrl: string;
  apiTokenUrl: string;
};

function normalizeDomain(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname;
  } catch {
    return null;
  }
}

function getUrls(domain: string): ProviderUrls {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
    apiTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
  };
}

/**
 * Derive the API base URL from the proxy endpoint embedded in an API token.
 * Token format: `tid=...;exp=...;proxy-ep=proxy.individual.example.com;...`
 */
function getBaseUrlFromToken(token: string): string | null {
  const match = token.match(/proxy-ep=([^;]+)/);
  if (!match) return null;
  const proxyHost = match[1] ?? '';
  return `https://${proxyHost.replace(/^proxy\./, 'api.')}`;
}

function getBaseUrl(token: string | undefined, enterpriseDomain: string | undefined): string {
  // Prefer the endpoint the token itself was issued for.
  if (token) {
    const fromToken = getBaseUrlFromToken(token);
    if (fromToken) return fromToken;
  }
  if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
  return 'https://api.individual.githubcopilot.com';
}

/**
 * Bound a request: the interactive signal only fires when the user cancels, so
 * a stalled endpoint needs its own deadline.
 */
function requestSignal(signal: AbortSignal | null | undefined): AbortSignal {
  return AbortSignal.any([
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    signal ?? new AbortController().signal,
  ]);
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: requestSignal(init.signal) });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return response.json();
}

async function startDeviceFlow(domain: string, signal: AbortSignal): Promise<DeviceCodeResponse> {
  const urls = getUrls(domain);
  const raw = await fetchJson(urls.deviceCodeUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'GitHubCopilotChat/0.35.0',
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      scope: DEVICE_CODE_SCOPE,
    }),
    signal,
  });

  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid device code response');
  }

  const data = raw as Record<string, unknown>;
  const deviceCode = data['device_code'];
  const userCode = data['user_code'];
  const verificationUri = data['verification_uri'];
  const interval = data['interval'];
  const expiresIn = data['expires_in'];

  if (
    typeof deviceCode !== 'string' ||
    typeof userCode !== 'string' ||
    typeof verificationUri !== 'string' ||
    (interval !== undefined && typeof interval !== 'number') ||
    typeof expiresIn !== 'number'
  ) {
    throw new Error('Invalid device code response fields');
  }

  // The verification URI is opened in the user's browser; only http(s) URLs are trusted.
  let parsedUri: URL;
  try {
    parsedUri = new URL(verificationUri);
  } catch {
    throw new Error('Untrusted verification_uri in device code response');
  }
  if (parsedUri.protocol !== 'https:' && parsedUri.protocol !== 'http:') {
    throw new Error('Untrusted verification_uri in device code response');
  }

  return {
    deviceCode,
    userCode,
    verificationUri: parsedUri.href,
    intervalSeconds: interval,
    expiresInSeconds: expiresIn,
  };
}

async function pollForGitHubAccessToken(
  domain: string,
  device: DeviceCodeResponse,
  signal: AbortSignal,
): Promise<string> {
  const urls = getUrls(domain);
  return pollOAuthDeviceCodeFlow<string>({
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds,
    waitBeforeFirstPoll: true,
    signal,
    poll: async () => {
      const raw = await fetchJson(urls.accessTokenUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'GitHubCopilotChat/0.35.0',
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          device_code: device.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
        signal,
      });

      if (raw && typeof raw === 'object') {
        const data = raw as Record<string, unknown>;
        if (typeof data['access_token'] === 'string') {
          return { status: 'complete', value: data['access_token'] };
        }
        if (typeof data['error'] === 'string') {
          const error = data['error'];
          const description = data['error_description'];
          if (error === 'authorization_pending') {
            return { status: 'pending' };
          }
          if (error === 'slow_down') {
            const interval = data['interval'];
            return { status: 'slow_down', intervalSeconds: typeof interval === 'number' ? interval : undefined };
          }
          const descriptionSuffix = typeof description === 'string' && description ? `: ${description}` : '';
          return { status: 'failed', message: `Device flow failed: ${error}${descriptionSuffix}` };
        }
      }

      return { status: 'failed', message: 'Invalid device token response' };
    },
  });
}

/** Exchange a GitHub access token for a short-lived API token. */
async function exchangeForApiToken(
  refreshToken: string,
  enterpriseDomain: string | undefined,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  const domain =
    enterpriseDomain === undefined || enterpriseDomain === '' ? DEFAULT_DOMAIN : enterpriseDomain;
  const urls = getUrls(domain);

  const raw = await fetchJson(urls.apiTokenUrl, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${refreshToken}`,
      ...COPILOT_HEADERS,
    },
    signal,
  });

  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid Copilot token response');
  }

  const data = raw as Record<string, unknown>;
  const token = data['token'];
  const expiresAt = data['expires_at'];

  if (typeof token !== 'string' || typeof expiresAt !== 'number') {
    throw new TypeError('Invalid Copilot token response fields');
  }

  return {
    type: 'oauth',
    refresh: refreshToken,
    access: token,
    expires: expiresAt * 1000 - TOKEN_EXPIRY_MARGIN_MS,
    enterpriseUrl: enterpriseDomain,
  };
}

function copilotEnterpriseDomain(credential: OAuthCredential): string | undefined {
  const enterpriseUrl = credential['enterpriseUrl'];
  if (typeof enterpriseUrl !== 'string' || !enterpriseUrl) return undefined;
  return normalizeDomain(enterpriseUrl) ?? undefined;
}

async function loginGitHubCopilot(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
  const input = await interaction.prompt({
    type: 'text',
    message: 'GitHub Enterprise URL/domain (blank for github.com)',
    placeholder: 'company.ghe.com',
    // The blank answer is a documented, valid choice (github.com); the input
    // widget must let the user submit it instead of swallowing the Enter key.
    allowEmpty: true,
  });
  if (interaction.signal.aborted) throw new Error('Login cancelled');

  const trimmed = input.trim();
  const enterpriseDomain = normalizeDomain(input);
  if (trimmed && !enterpriseDomain) throw new Error('Invalid GitHub Enterprise URL/domain');
  const domain =
    enterpriseDomain === null || enterpriseDomain === '' ? DEFAULT_DOMAIN : enterpriseDomain;

  const device = await startDeviceFlow(domain, interaction.signal);
  interaction.notify({
    type: 'device_code',
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds,
  });

  const githubAccessToken = await pollForGitHubAccessToken(domain, device, interaction.signal);
  return exchangeForApiToken(githubAccessToken, enterpriseDomain ?? undefined, interaction.signal);
}

export const provider: OAuthProviderModule = {
  id: 'github-copilot',
  name: 'GitHub Copilot',
  isSubscription: true,
  loginLabel: 'Sign in with GitHub Copilot',
  flowLabel: 'device code',
  providerConfigType: 'openai',

  /**
   * Two capabilities of the upstream sign-in are intentionally not ported here.
   * Neither has a user-visible effect in this repository today; recorded so the
   * next reader does not treat them as oversights.
   *
   * 1. Model catalog / policy activation: upstream fetches `/models` after
   *    sign-in, POSTs `/models/{id}/policy` for entries the account has not
   *    enabled yet, and stores the resulting id list on the credential (refresh
   *    carries it forward). This repository has no consumer for such a list —
   *    the model picker is driven by `config.toml` aliases — so the extra
   *    requests would only add write traffic at login. Consequence: a model
   *    whose policy is still `unconfigured` is not enabled on the user's
   *    behalf.
   * 2. Multi-protocol routing: this module declares the single config type
   *    `'openai'` (below), whereas upstream lets one Copilot credential serve
   *    anthropic-messages / openai-completions / openai-responses models
   *    selected per model in its catalog. A login here writes exactly one
   *    provider entry, and `resolveTokenProvider` matches on that config key, so
   *    a second entry cannot share the same credential. Consequence: Copilot's
   *    Anthropic-protocol models are not routable through this entry.
   */
  login: loginGitHubCopilot,

  refresh: (credential, signal) =>
    exchangeForApiToken(credential.refresh, copilotEnterpriseDomain(credential), signal),

  /**
   * Derive the credential-specific proxy endpoint for each request. No fixed
   * headers are attached: the extra headers this API expects are computed per
   * request from the conversation, not from the credential.
   */
  toAuth(credential) {
    return {
      apiKey: credential.access,
      baseUrl: getBaseUrl(credential.access, copilotEnterpriseDomain(credential)),
    };
  },
};
