/**
 * Antigravity OAuth provider (Google account sign-in for the Antigravity
 * coding surfaces).
 *
 * Standard Google authorization-code flow on a fixed loopback port. Once the
 * tokens are issued the credential is bound to a Cloud Code Assist project:
 * the sign-in checks the account's tier, provisions the free tier through the
 * long-running onboarding operation when the account has none, and stores the
 * resulting project id with the credential. Refresh keeps that project id.
 */

import { abortableSleep } from '../device-code';
import type { OAuthCredential, OAuthProviderModule, ProviderAuthInteraction } from '../types';
import {
  GoogleCloudCodeError,
  loginGoogleCloudCode,
  refreshGoogleCloudCode,
  googleFetch,
  type GoogleCloudCodeLoginConfig,
  type ProjectDiscoveryContext,
} from './google-cloud-code';

/** Public client credentials of the Google sign-in these surfaces use. */
const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
] as const;
const CALLBACK_PORT = 51121;
const CALLBACK_PATH = '/oauth-callback';

const CLOUD_CODE_ASSIST_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
const LOAD_CODE_ASSIST_URL = `${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`;
const ONBOARD_USER_URL = `${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`;
const OPERATIONS_URL = `${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal`;
/** Cloud Code Assist metadata sent by the native control-plane requests. */
const LOAD_CODE_ASSIST_METADATA = { ideType: 'ANTIGRAVITY' } as const;
const FREE_TIER_ID = 'free-tier';
const ONBOARD_TIMEOUT_MS = 30_000;
const ONBOARD_POLL_INTERVAL_MS = 1_000;
/** Client version reported in the control-plane user agent; env-overridable. */
const VERSION_ENV = 'SCREAM_CODE_ANTIGRAVITY_VERSION';
const DEFAULT_VERSION = '2.19.1';
/** Client identity pinned to the build the control plane was captured from. */
const CLIENT_OS = 'darwin';
const CLIENT_ARCH = 'arm64';
const CLIENT_CHANGELIST = '963137146';

interface UserTier {
  id?: string;
}

interface IneligibleTier {
  tierId?: string;
  reasonMessage?: string;
  validationUrl?: string;
}

interface LoadCodeAssistResponse {
  currentTier?: UserTier | null;
  paidTier?: UserTier | null;
  allowedTiers?: UserTier[];
  ineligibleTiers?: IneligibleTier[];
  cloudaicompanionProject?: string;
}

interface OperationError {
  code?: number;
  message?: string;
}

interface OnboardOperation {
  name?: string;
  done?: boolean;
  error?: OperationError | null;
  response?: { cloudaicompanionProject?: string } | null;
}

interface CloudCodeContext {
  readonly headers: Record<string, string>;
  readonly signal: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Client user agent for the control-plane requests. The backend gates newer
 * models on the reported client build, so the version tracks the current
 * client release and can be overridden through the environment.
 */
function getUserAgent(): string {
  const version = readNonEmptyString(process.env[VERSION_ENV]) ?? DEFAULT_VERSION;
  return `antigravity/hub/${version} (aidev_client; os_type=${CLIENT_OS}; arch=${CLIENT_ARCH}; cl=${CLIENT_CHANGELIST})`;
}

function readTier(value: unknown): UserTier | undefined {
  if (!isRecord(value)) return undefined;
  const id = readNonEmptyString(value['id']);
  return id === undefined ? {} : { id };
}

function parseLoadCodeAssistResponse(payload: unknown): LoadCodeAssistResponse {
  if (!isRecord(payload)) {
    throw new GoogleCloudCodeError('failed to unmarshal LoadCodeAssistResponse');
  }
  const allowedTiers = Array.isArray(payload['allowedTiers'])
    ? payload['allowedTiers'].flatMap((tier) => {
        const parsed = readTier(tier);
        return parsed === undefined ? [] : [parsed];
      })
    : undefined;
  const ineligibleTiers = Array.isArray(payload['ineligibleTiers'])
    ? payload['ineligibleTiers'].flatMap((tier) => {
        if (!isRecord(tier)) return [];
        return [
          {
            tierId: readNonEmptyString(tier['tierId']),
            reasonMessage: readNonEmptyString(tier['reasonMessage']),
            validationUrl: readNonEmptyString(tier['validationUrl']),
          },
        ];
      })
    : undefined;

  return {
    currentTier: readTier(payload['currentTier']),
    paidTier: readTier(payload['paidTier']),
    allowedTiers,
    ineligibleTiers,
    cloudaicompanionProject: readNonEmptyString(payload['cloudaicompanionProject']),
  };
}

function parseOnboardOperation(payload: unknown): OnboardOperation {
  if (!isRecord(payload)) {
    throw new GoogleCloudCodeError('failed to unmarshal OnboardUser operation');
  }
  const error = isRecord(payload['error'])
    ? {
        code: typeof payload['error']['code'] === 'number' ? payload['error']['code'] : undefined,
        message: readNonEmptyString(payload['error']['message']),
      }
    : undefined;
  const response = isRecord(payload['response'])
    ? { cloudaicompanionProject: readNonEmptyString(payload['response']['cloudaicompanionProject']) }
    : undefined;

  return {
    name: readNonEmptyString(payload['name']),
    done: typeof payload['done'] === 'boolean' ? payload['done'] : undefined,
    error,
    response,
  };
}

function hasTier(payload: LoadCodeAssistResponse, field: 'currentTier' | 'paidTier'): boolean {
  return payload[field] !== undefined && payload[field] !== null;
}

function isFreeTierAllowed(payload: LoadCodeAssistResponse): boolean {
  return payload.allowedTiers?.some((tier) => tier.id === FREE_TIER_ID) === true;
}

function assertFreeTierEligible(payload: LoadCodeAssistResponse): void {
  if (isFreeTierAllowed(payload)) return;
  const tier = payload.ineligibleTiers?.find((candidate) => candidate.tierId === FREE_TIER_ID);
  if (tier?.reasonMessage === undefined) return;
  const validation =
    tier.validationUrl === undefined ? '' : `\n${tier.validationUrl}`;
  throw new GoogleCloudCodeError(`${tier.reasonMessage}${validation}`);
}

/** Sends one control-plane request; a non-200 status is a provisioning failure. */
async function requestCloudCodeAssist(options: {
  label: string;
  url: string;
  method: 'GET' | 'POST';
  context: CloudCodeContext;
  body?: string;
  timeoutMs?: number;
}): Promise<unknown> {
  const { context, label, url, method, body, timeoutMs } = options;
  if (context.signal.aborted) throw new Error('Login cancelled');
  const init: RequestInit =
    body === undefined
      ? { method, headers: context.headers }
      : { method, headers: context.headers, body };
  const response = await googleFetch(url, init, { signal: context.signal, timeoutMs });
  if (response.status !== 200) {
    const errorText = await response.text();
    throw new GoogleCloudCodeError(
      `${label} failed: ${response.status} ${response.statusText}: ${errorText}`,
    );
  }
  return response.json();
}

async function postLoadCodeAssist(
  context: CloudCodeContext,
  body: Record<string, unknown>,
): Promise<LoadCodeAssistResponse> {
  return parseLoadCodeAssistResponse(
    await requestCloudCodeAssist({
      label: 'loadCodeAssist',
      url: LOAD_CODE_ASSIST_URL,
      method: 'POST',
      context,
      body: JSON.stringify(body),
    }),
  );
}

/**
 * Reads the account's tier, re-asking with the discovered project when the
 * response carries a project but no paid tier — the second call is what
 * reports the tier the account is actually entitled to.
 */
async function loadCodeAssist(context: CloudCodeContext): Promise<LoadCodeAssistResponse> {
  let payload = await postLoadCodeAssist(context, {
    metadata: LOAD_CODE_ASSIST_METADATA,
  });
  const projectId = payload.cloudaicompanionProject;
  if (!hasTier(payload, 'paidTier') && projectId !== undefined) {
    payload = await postLoadCodeAssist(context, {
      cloudaicompanionProject: projectId,
      metadata: LOAD_CODE_ASSIST_METADATA,
    });
  }
  return payload;
}

function remainingOnboardTime(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining > 0) return remaining;
  throw new GoogleCloudCodeError(`onboardUser timed out after ${ONBOARD_TIMEOUT_MS}ms`);
}

function describeOperationError(error: OperationError): string {
  if (error.message !== undefined) {
    return typeof error.code === 'number' ? `${error.code}: ${error.message}` : error.message;
  }
  return JSON.stringify(error);
}

/** Provisions the free tier, following the onboarding operation to completion. */
async function onboardUser(context: CloudCodeContext): Promise<void> {
  const deadline = Date.now() + ONBOARD_TIMEOUT_MS;
  let operation = parseOnboardOperation(
    await requestCloudCodeAssist({
      label: 'onboardUser',
      url: ONBOARD_USER_URL,
      method: 'POST',
      context,
      body: JSON.stringify({
        tierId: FREE_TIER_ID,
        metadata: LOAD_CODE_ASSIST_METADATA,
      }),
      timeoutMs: remainingOnboardTime(deadline),
    }),
  );

  for (;;) {
    if (operation.done === true) {
      if (operation.error !== undefined && operation.error !== null) {
        throw new GoogleCloudCodeError(
          `OnboardUser operation failed: ${describeOperationError(operation.error)}`,
        );
      }
      if (operation.response === undefined || operation.response === null) {
        throw new GoogleCloudCodeError('failed to unmarshal OnboardUserResponse');
      }
      return;
    }

    await abortableSleep(
      Math.min(ONBOARD_POLL_INTERVAL_MS, remainingOnboardTime(deadline)),
      context.signal,
      'Login cancelled',
    );
    const operationName = operation.name ?? '';
    if (operationName.length === 0) {
      throw new GoogleCloudCodeError('onboardUser returned an operation without a name');
    }
    operation = parseOnboardOperation(
      await requestCloudCodeAssist({
        label: 'onboardUser operation',
        url: `${OPERATIONS_URL}/${operationName}`,
        method: 'GET',
        context,
        timeoutMs: remainingOnboardTime(deadline),
      }),
    );
  }
}

async function discoverProject(context: ProjectDiscoveryContext): Promise<string> {
  const cloud: CloudCodeContext = {
    headers: {
      Authorization: `Bearer ${context.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': getUserAgent(),
    },
    signal: context.signal,
  };

  context.progress('Checking Cloud Code Assist account status...');
  const initial = await loadCodeAssist(cloud);
  assertFreeTierEligible(initial);
  if (!hasTier(initial, 'currentTier')) {
    context.progress('Provisioning the Antigravity free tier...');
    await onboardUser(cloud);
  }

  context.progress('Refreshing Cloud Code Assist project...');
  const refreshed = await loadCodeAssist(cloud);
  const projectId = refreshed.cloudaicompanionProject;
  if (projectId !== undefined) return projectId;
  throw new GoogleCloudCodeError('loadCodeAssist did not return a cloudaicompanionProject');
}

const config: GoogleCloudCodeLoginConfig = {
  providerId: 'google-antigravity',
  providerName: 'Antigravity',
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  scopes: SCOPES,
  callbackPort: CALLBACK_PORT,
  callbackPath: CALLBACK_PATH,
  discoverProject,
  describeDiscoveryFailure: (message) => `Could not discover an Antigravity project. ${message}`,
};

export const provider: OAuthProviderModule = {
  id: 'google-antigravity',
  name: 'Antigravity (Gemini 3, Claude, GPT-OSS)',
  isSubscription: true,
  loginLabel: 'Sign in with Google (Antigravity)',
  flowLabel: 'browser',
  providerConfigType: 'google-cloud-code',

  login: (interaction: ProviderAuthInteraction): Promise<OAuthCredential> =>
    loginGoogleCloudCode(interaction, config),

  refresh: (credential, signal) => refreshGoogleCloudCode(credential, signal, config),

  /**
   * Cloud Code Assist requests authenticate with structured credentials: the
   * access token, the Cloud Code Assist project the account is provisioned
   * for, and the host to address. The runtime carries the whole bundle on the
   * api-key channel as a JSON string — the adapter parses it — and `baseUrl`
   * points the entry at the Antigravity Cloud Code Assist host.
   *
   * A credential without a project id still maps to auth; the adapter then
   * reports the missing project and asks for a fresh sign-in.
   */
  toAuth: (credential) => {
    const projectId = readNonEmptyString(credential['projectId']);
    return {
      apiKey: JSON.stringify({
        token: credential.access,
        ...(projectId !== undefined ? { projectId } : {}),
        endpoint: CLOUD_CODE_ASSIST_ENDPOINT,
      }),
      baseUrl: CLOUD_CODE_ASSIST_ENDPOINT,
    };
  },
};
