/**
 * Scream host and device identity header factories.
 *
 * The caller owns the host identity (product name + host app version)
 * and the `homeDir` where the stable device id is stored. This module
 * intentionally keeps no global CLI version or environment-derived
 * production state.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, hostname, release, type } from 'node:os';
import { join } from 'node:path';

import type { DeviceHeaders } from './types';

export const SCREAM_CODE_PLATFORM = 'scream_code_cli';

export interface ScreamHostIdentity {
  readonly userAgentProduct: string;
  readonly version: string;
  readonly userAgentSuffix?: string | undefined;
}

export interface ScreamIdentityOptions extends ScreamHostIdentity {
  readonly homeDir: string;
}

export interface CreateScreamDeviceIdOptions {
  /** Invoked synchronously the first time a device id is minted on this machine. */
  readonly onFirstLaunch?: ((id: string) => void) | undefined;
}

export function createScreamDeviceId(
  homeDir: string,
  options: CreateScreamDeviceIdOptions = {},
): string {
  const deviceIdPath = join(homeDir, 'device_id');
  if (existsSync(deviceIdPath)) {
    try {
      const text = readFileSync(deviceIdPath, 'utf-8').trim();
      if (text.length > 0) return text;
    } catch {
      // Fall through to regenerate.
    }
  }

  const id = randomUUID();
  try {
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    writeFileSync(deviceIdPath, id, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Best-effort: requests can still use the in-memory id.
  }
  if (options.onFirstLaunch !== undefined) {
    try {
      options.onFirstLaunch(id);
    } catch {
      // Telemetry callback must not affect device id creation.
    }
  }
  return id;
}

export function createScreamDeviceHeaders(options: {
  readonly homeDir: string;
  readonly version: string;
}): DeviceHeaders {
  return {
    'X-Msh-Platform': SCREAM_CODE_PLATFORM,
    'X-Msh-Version': requiredAsciiHeader(options.version, 'Scream identity version'),
    'X-Msh-Device-Name': asciiHeader(hostname()),
    'X-Msh-Device-Model': asciiHeader(deviceModel()),
    'X-Msh-Os-Version': asciiHeader(release()),
    'X-Msh-Device-Id': createScreamDeviceId(options.homeDir),
  };
}

export function createScreamUserAgent(options: {
  readonly userAgentProduct: string;
  readonly version: string;
  readonly userAgentSuffix?: string | undefined;
}): string {
  const product = requiredAsciiHeader(options.userAgentProduct, 'Scream identity product');
  const version = requiredAsciiHeader(options.version, 'Scream identity version');
  const suffix =
    options.userAgentSuffix === undefined ? undefined : asciiHeader(options.userAgentSuffix, '');
  return suffix === undefined || suffix.length === 0
    ? `${product}/${version}`
    : `${product}/${version} (${suffix})`;
}

export function createScreamDefaultHeaders(options: ScreamIdentityOptions): Record<string, string> {
  return {
    'User-Agent': createScreamUserAgent(options),
    ...createScreamDeviceHeaders({
      homeDir: options.homeDir,
      version: options.version,
    }),
  };
}

export function assertScreamHostIdentity(identity: ScreamHostIdentity | undefined): ScreamHostIdentity {
  if (identity === undefined) {
    throw new Error('Scream host identity is required. Pass the host product name and version.');
  }
  requiredAsciiHeader(identity.userAgentProduct, 'Scream identity product');
  requiredAsciiHeader(identity.version, 'Scream identity version');
  return identity;
}

function deviceModel(): string {
  const os = type();
  const version = release();
  const osArch = arch();
  if (os === 'Darwin') return `macOS ${macOsProductVersion() ?? version} ${osArch}`;
  if (os === 'Windows_NT') return `Windows ${version} ${osArch}`;
  return `${os} ${version} ${osArch}`.trim();
}

function macOsProductVersion(): string | undefined {
  try {
    const version = execFileSync('/usr/bin/sw_vers', ['-productVersion'], {
      encoding: 'utf-8',
      timeout: 1000,
    }).trim();
    return version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

function asciiHeader(value: string, fallback = 'unknown'): string {
  const cleaned = value.replaceAll(/[^\u0020-\u007E]/g, '').trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function requiredAsciiHeader(value: string, fieldName: string): string {
  const cleaned = asciiHeader(value, '');
  if (cleaned.length === 0) {
    throw new Error(`${fieldName} must be a non-empty ASCII string.`);
  }
  return cleaned;
}
