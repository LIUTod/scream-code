import { createScreamDeviceId, SCREAM_CODE_PROVIDER_NAME } from '@scream-cli/scream-code-oauth';
import { initializeTelemetry } from '@scream-cli/scream-telemetry';
import { resolveScreamHome, type ScreamConfig, type ScreamHarness } from '@scream-cli/scream-code-sdk';

import { CLI_USER_AGENT_PRODUCT } from '#/constant/app';

export interface CliTelemetryBootstrap {
  readonly homeDir: string;
  readonly deviceId: string;
  readonly firstLaunch: boolean;
}

export interface InitializeCliTelemetryOptions {
  readonly harness: ScreamHarness;
  readonly bootstrap: CliTelemetryBootstrap;
  readonly config: Pick<ScreamConfig, 'defaultModel' | 'telemetry'>;
  readonly version: string;
  readonly uiMode: string;
  readonly model?: string;
}

export function createCliTelemetryBootstrap(): CliTelemetryBootstrap {
  let firstLaunch = false;
  const homeDir = resolveScreamHome();
  const deviceId = createScreamDeviceId(homeDir, {
    onFirstLaunch: () => {
      firstLaunch = true;
    },
  });
  return { homeDir, deviceId, firstLaunch };
}

export function initializeCliTelemetry(options: InitializeCliTelemetryOptions): void {
  initializeTelemetry({
    homeDir: options.harness.homeDir,
    deviceId: options.bootstrap.deviceId,
    enabled: options.config.telemetry !== false,
    appName: CLI_USER_AGENT_PRODUCT,
    version: options.version,
    uiMode: options.uiMode,
    model: options.model ?? options.config.defaultModel,
    getAccessToken: async () =>
      (await options.harness.auth.getCachedAccessToken(SCREAM_CODE_PROVIDER_NAME)) ?? null,
  });
  if (options.bootstrap.firstLaunch) {
    options.harness.track('first_launch');
  }
}
