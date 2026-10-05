/**
 * Google Cloud Code Assist (Gemini CLI) OAuth provider.
 *
 * Standard Google authorization-code flow on a fixed loopback port, followed
 * by project resolution against the Cloud Code Assist API: an existing project
 * is reused when the account already has one, otherwise the account is onboarded
 * onto the tier the API reports (defaulting to the free tier) and the resulting
 * project id is stored with the credential. Refresh keeps that project id.
 *
 * The `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID` environment variables
 * name the project for accounts that have to be scoped to an existing one;
 * without them an unscoped account that needs a project fails with the reason
 * rather than guessing.
 */

import { abortableSleep } from '../device-code';
import type { OAuthCredential, OAuthProviderModule, ProviderAuthInteraction } from '../types';
import {
  GoogleCloudCodeError,
  googleFetch,
  loginGoogleCloudCode,
  refreshGoogleCloudCode,
  type GoogleCloudCodeLoginConfig,
  type ProjectDiscoveryContext,
} from './google-cloud-code';

/** Public client credentials of the Google sign-in these surfaces use. */
const CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
] as const;
const CALLBACK_PORT = 8085;
const CALLBACK_PATH = '/oauth2callback';

const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const LOAD_CODE_ASSIST_URL = `${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`;
const ONBOARD_USER_URL = `${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`;
const TIER_FREE = 'free-tier';
const TIER_LEGACY = 'legacy-tier';
const TIER_STANDARD = 'standard-tier';
/** Client metadata sent by the native control-plane requests. */
const CLIENT_METADATA = 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI';
const CLIENT_METADATA_IDE = 'IDE_UNSPECIFIED';
const CLIENT_METADATA_PLATFORM = 'PLATFORM_UNSPECIFIED';
const CLIENT_METADATA_PLUGIN = 'GEMINI';
/** Client version reported in the control-plane user agent; env-overridable. */
const VERSION_ENV = 'SCREAM_CODE_GEMINI_CLI_VERSION';
const DEFAULT_VERSION = '0.46.0';
/** Model id reported in the control-plane user agent. */
const CLIENT_MODEL_ID = 'gemini-3.1-pro-preview';
const PROJECT_ENV = 'GOOGLE_CLOUD_PROJECT';
const PROJECT_ID_ENV = 'GOOGLE_CLOUD_PROJECT_ID';
const WORKSPACE_PROJECT_DOCS = 'https://goo.gle/gemini-cli-auth-docs#workspace-gca';

/**
 * Operation poll cadence and bound: provisioning normally completes within a
 * few polls, and the attempt cap turns a stuck operation into a bounded
 * sign-in error instead of an unbounded loop.
 */
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_ATTEMPTS = 24;

interface LoadCodeAssistPayload {
  cloudaicompanionProject?: string;
  currentTier?: { id?: string };
  allowedTiers?: { id?: string; isDefault?: boolean }[];
}

interface LongRunningOperationResponse {
  name?: string;
  done?: boolean;
  response?: { cloudaicompanionProject?: { id?: string } };
}

interface CloudCodeContext {
  readonly headers: Record<string, string>;
  readonly signal: AbortSignal;
}

const WORKSPACE_PROJECT_MESSAGE =
  `This account requires setting the ${PROJECT_ENV} or ${PROJECT_ID_ENV} environment variable. ` +
  `See ${WORKSPACE_PROJECT_DOCS}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Client user agent for the control-plane requests: the same shape the native
 * client sends, which is what the backend gates account tiers and rate limits
 * on.
 */
function getUserAgent(): string {
  const version = readNonEmptyString(process.env[VERSION_ENV]) ?? DEFAULT_VERSION;
  return `GeminiCLI/${version}/${CLIENT_MODEL_ID} (${process.platform}; ${process.arch}; terminal)`;
}

function createHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': getUserAgent(),
    'Client-Metadata': CLIENT_METADATA,
  };
}

/** The project named by the environment, when one is configured. */
function envProjectId(): string | undefined {
  return (
    readNonEmptyString(process.env[PROJECT_ENV]) ??
    readNonEmptyString(process.env[PROJECT_ID_ENV])
  );
}

/**
 * An account whose organization enforces a security policy has no tier to
 * onboard onto: it is treated as already provisioned.
 */
function isVpcScAffectedUser(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  const error = payload['error'];
  if (!isRecord(error)) return false;
  const details = error['details'];
  if (!Array.isArray(details)) return false;
  return details.some((detail) => isRecord(detail) && detail['reason'] === 'SECURITY_POLICY_VIOLATED');
}

function readLoadCodeAssistPayload(payload: unknown): LoadCodeAssistPayload {
  if (!isRecord(payload)) {
    throw new GoogleCloudCodeError('failed to unmarshal LoadCodeAssistResponse');
  }
  const currentTier = isRecord(payload['currentTier']) ? {} : undefined;
  const allowedTiers = Array.isArray(payload['allowedTiers'])
    ? payload['allowedTiers'].flatMap((tier) => {
        if (!isRecord(tier)) return [];
        return [
          {
            id: readNonEmptyString(tier['id']),
            isDefault: tier['isDefault'] === true,
          },
        ];
      })
    : undefined;
  return {
    currentTier,
    allowedTiers,
    cloudaicompanionProject: readNonEmptyString(payload['cloudaicompanionProject']),
  };
}

function readLongRunningOperation(payload: unknown): LongRunningOperationResponse {
  if (!isRecord(payload)) {
    throw new GoogleCloudCodeError('failed to unmarshal the onboarding operation');
  }
  const response = isRecord(payload['response'])
    ? {
        cloudaicompanionProject: isRecord(payload['response']['cloudaicompanionProject'])
          ? {
              id: readNonEmptyString(payload['response']['cloudaicompanionProject']['id']),
            }
          : undefined,
      }
    : undefined;
  return {
    name: readNonEmptyString(payload['name']),
    done: payload['done'] === true,
    response,
  };
}

/** Tier the account should be onboarded onto; unscoped accounts get `legacy-tier`. */
function getDefaultTier(allowedTiers?: { id?: string; isDefault?: boolean }[]): string {
  if (allowedTiers === undefined || allowedTiers.length === 0) return TIER_LEGACY;
  return allowedTiers.find((tier) => tier.isDefault)?.id ?? TIER_LEGACY;
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  context: CloudCodeContext,
): Promise<Response> {
  if (context.signal.aborted) throw new Error('Login cancelled');
  return googleFetch(
    url,
    {
      method: 'POST',
      headers: context.headers,
      body: JSON.stringify(body),
    },
    { signal: context.signal },
  );
}

/** Follows the onboarding operation until it reports completion. */
async function pollOperation(
  operationName: string,
  context: CloudCodeContext,
  progress: (message: string) => void,
): Promise<LongRunningOperationResponse> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      progress(
        `Waiting for project provisioning (attempt ${attempt + 1}/${POLL_MAX_ATTEMPTS})...`,
      );
      await abortableSleep(POLL_INTERVAL_MS, context.signal, 'Login cancelled');
    }
    if (context.signal.aborted) throw new Error('Login cancelled');

    const response = await googleFetch(
      `${CODE_ASSIST_ENDPOINT}/v1internal/${operationName}`,
      { method: 'GET', headers: context.headers },
      { signal: context.signal },
    );
    if (!response.ok) {
      throw new GoogleCloudCodeError(
        `Failed to poll operation: ${response.status} ${response.statusText}`,
      );
    }
    const data = readLongRunningOperation(await response.json());
    if (data.done === true) return data;
  }

  throw new GoogleCloudCodeError(
    `Project provisioning did not complete after ${POLL_MAX_ATTEMPTS} attempts`,
  );
}

async function discoverProject(context: ProjectDiscoveryContext): Promise<string> {
  const projectIdFromEnv = envProjectId();
  const cloud: CloudCodeContext = {
    headers: createHeaders(context.accessToken),
    signal: context.signal,
  };

  context.progress('Checking for existing Cloud Code Assist project...');
  const loadResponse = await postJson(
    LOAD_CODE_ASSIST_URL,
    {
      cloudaicompanionProject: projectIdFromEnv,
      metadata: {
        ideType: CLIENT_METADATA_IDE,
        platform: CLIENT_METADATA_PLATFORM,
        pluginType: CLIENT_METADATA_PLUGIN,
        duetProject: projectIdFromEnv,
      },
    },
    cloud,
  );

  let data: LoadCodeAssistPayload;
  if (!loadResponse.ok) {
    let errorPayload: unknown;
    try {
      errorPayload = await loadResponse.clone().json();
    } catch {
      errorPayload = undefined;
    }
    if (isVpcScAffectedUser(errorPayload)) {
      data = { currentTier: { id: TIER_STANDARD } };
    } else {
      const errorText = await loadResponse.text();
      throw new GoogleCloudCodeError(
        `loadCodeAssist failed: ${loadResponse.status} ${loadResponse.statusText}: ${errorText}`,
      );
    }
  } else {
    data = readLoadCodeAssistPayload(await loadResponse.json());
  }

  if (data.currentTier !== undefined) {
    if (data.cloudaicompanionProject !== undefined) return data.cloudaicompanionProject;
    if (projectIdFromEnv !== undefined) return projectIdFromEnv;
    throw new GoogleCloudCodeError(WORKSPACE_PROJECT_MESSAGE);
  }

  const tierId = getDefaultTier(data.allowedTiers);
  if (tierId !== TIER_FREE && projectIdFromEnv === undefined) {
    throw new GoogleCloudCodeError(WORKSPACE_PROJECT_MESSAGE);
  }

  context.progress('Provisioning Cloud Code Assist project (this may take a moment)...');
  const onboardBody: Record<string, unknown> = {
    tierId,
    metadata: {
      ideType: CLIENT_METADATA_IDE,
      platform: CLIENT_METADATA_PLATFORM,
      pluginType: CLIENT_METADATA_PLUGIN,
    },
  };
  if (tierId !== TIER_FREE && projectIdFromEnv !== undefined) {
    onboardBody['cloudaicompanionProject'] = projectIdFromEnv;
    (onboardBody['metadata'] as Record<string, unknown>)['duetProject'] = projectIdFromEnv;
  }

  const onboardResponse = await postJson(ONBOARD_USER_URL, onboardBody, cloud);
  if (!onboardResponse.ok) {
    const errorText = await onboardResponse.text();
    throw new GoogleCloudCodeError(
      `onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}: ${errorText}`,
    );
  }

  let operation = readLongRunningOperation(await onboardResponse.json());
  if (operation.done !== true && operation.name !== undefined) {
    operation = await pollOperation(operation.name, cloud, context.progress);
  }

  const projectId = operation.response?.cloudaicompanionProject?.id;
  if (projectId !== undefined) return projectId;
  if (projectIdFromEnv !== undefined) return projectIdFromEnv;

  throw new GoogleCloudCodeError(
    'Could not discover or provision a Google Cloud project. ' +
      `Try setting the ${PROJECT_ENV} or ${PROJECT_ID_ENV} environment variable. ` +
      `See ${WORKSPACE_PROJECT_DOCS}`,
  );
}

const config: GoogleCloudCodeLoginConfig = {
  providerId: 'google-gemini-cli',
  providerName: 'Google Cloud Code Assist',
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  scopes: SCOPES,
  callbackPort: CALLBACK_PORT,
  callbackPath: CALLBACK_PATH,
  discoverProject,
};

export const provider: OAuthProviderModule = {
  id: 'google-gemini-cli',
  name: 'Google Cloud Code Assist (Gemini CLI)',
  isSubscription: true,
  loginLabel: 'Sign in with Google (Gemini CLI)',
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
   * points the entry at the Cloud Code Assist host.
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
        endpoint: CODE_ASSIST_ENDPOINT,
      }),
      baseUrl: CODE_ASSIST_ENDPOINT,
    };
  },
};
