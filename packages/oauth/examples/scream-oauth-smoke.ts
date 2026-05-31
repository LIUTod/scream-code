import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyManagedScreamCodeConfig,
  SCREAM_CODE_PROVIDER_NAME,
  ScreamOAuthToolkit,
  type DeviceAuthorization,
  type ScreamHostIdentity,
  type ManagedScreamConfigShape,
} from '@scream-cli/scream-code-oauth';

async function main(): Promise<void> {
  const explicitHomeDir = process.env['SCREAM_OAUTH_SMOKE_HOME'];
  const homeDir = explicitHomeDir ?? (await mkdtemp(join(tmpdir(), 'scream-oauth-smoke-')));
  const keepToken = shouldKeepToken(explicitHomeDir !== undefined);
  const forceLogin = process.env['SCREAM_OAUTH_SMOKE_FORCE_LOGIN'] === '1';
  const config: ManagedScreamConfigShape = { providers: {} };

  const toolkit = new ScreamOAuthToolkit<ManagedScreamConfigShape>({
    homeDir,
    identity: smokeIdentityFromEnv(),
    configAdapter: {
      read: () => config,
      write: () => {},
      apply: applyManagedScreamCodeConfig,
      configPath: '<memory>',
    },
  });

  process.stdout.write(`home: ${homeDir}\n`);

  try {
    if (forceLogin) {
      await toolkit.logout(SCREAM_CODE_PROVIDER_NAME);
      process.stdout.write('cleared existing smoke token\n');
    }

    const login = await toolkit.login(SCREAM_CODE_PROVIDER_NAME, {
      onDeviceCode: printDeviceCode,
    });
    const status = await toolkit.status(SCREAM_CODE_PROVIDER_NAME);
    const accessToken = await toolkit.tokenProvider(SCREAM_CODE_PROVIDER_NAME).getAccessToken();
    const usage = await toolkit.getManagedUsage(SCREAM_CODE_PROVIDER_NAME);

    if (login.provision?.defaultModel === undefined) {
      throw new Error('login did not provision a default model');
    }
    if (status.providers[0]?.hasToken !== true) {
      throw new Error('status did not report a stored token after login');
    }
    if (accessToken.length === 0) {
      throw new Error('token provider returned an empty access token');
    }
    if (config.providers[SCREAM_CODE_PROVIDER_NAME] === undefined) {
      throw new Error('managed provider was not written to config');
    }

    process.stdout.write(`provider: ${login.providerName}\n`);
    process.stdout.write(`default model: ${login.provision.defaultModel}\n`);
    process.stdout.write(`models: ${String(login.provision.models.length)}\n`);
    printUsage(usage);
    process.stdout.write('oauth smoke passed\n');
  } finally {
    if (!keepToken) {
      await toolkit.logout(SCREAM_CODE_PROVIDER_NAME).catch(() => {});
    }
    if (explicitHomeDir === undefined && !keepToken) {
      await rm(homeDir, { recursive: true, force: true });
    }
  }
}

function smokeIdentityFromEnv(): ScreamHostIdentity {
  const version = process.env['SCREAM_CODE_SMOKE_VERSION'];
  if (version === undefined || version.trim().length === 0) {
    throw new Error('SCREAM_CODE_SMOKE_VERSION is required for Scream OAuth smoke.');
  }
  return {
    userAgentProduct: "scream-code-cli",
    version,
  };
}

function printDeviceCode(auth: DeviceAuthorization): void {
  process.stdout.write(
    [
      'Complete Scream OAuth device login:',
      `  URL: ${auth.verificationUriComplete || auth.verificationUri}`,
      `  Code: ${auth.userCode}`,
      auth.expiresIn === null ? undefined : `  Expires in: ${String(auth.expiresIn)}s`,
      '',
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n'),
  );
}

function printUsage(
  usage: Awaited<ReturnType<ScreamOAuthToolkit<ManagedScreamConfigShape>['getManagedUsage']>>,
): void {
  if (usage.kind === 'error') {
    process.stderr.write(`usage request returned: ${usage.message}\n`);
    return;
  }
  const summary = usage.summary;
  if (summary === null) {
    process.stdout.write(`usage: no summary, limits=${String(usage.limits.length)}\n`);
    return;
  }
  process.stdout.write(
    `usage: ${summary.label} ${String(summary.used)}/${String(summary.limit)}\n`,
  );
}

function shouldKeepToken(hasExplicitHomeDir: boolean): boolean {
  const value = process.env['SCREAM_OAUTH_SMOKE_KEEP_TOKEN'];
  if (value !== undefined) return value === '1' || value === 'true';
  return hasExplicitHomeDir;
}

try {
  await main();
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
