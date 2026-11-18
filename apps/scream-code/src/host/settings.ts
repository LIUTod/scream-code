/**
 * The host's own settings (`<home>/host/settings.json`), changed from the
 * `/service` panel. Missing or unreadable means the defaults.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getHostDir } from './control';

export interface HostSettings {
  /** Keep the computer awake while work runs, on mains power (default on). */
  readonly keepAwake: boolean;
  /** Whether the one-time "keep Scream running in the background?" offer was made. */
  readonly serviceOffered: boolean;
  /** Daily token limit on the host's unattended work; 0 = none (see `usage.ts`). */
  readonly dailyTokenLimit: number;
  /** Whether the one-time "send a daily brief?" offer was made (after turning the service on). */
  readonly briefOffered: boolean;
  /** System notifications when something needs the person (default on). */
  readonly desktopNotifications: boolean;
}

const DEFAULTS: HostSettings = {
  keepAwake: true,
  serviceOffered: false,
  dailyTokenLimit: 0,
  briefOffered: false,
  desktopNotifications: true,
};

function settingsPath(): string {
  return join(getHostDir(), 'settings.json');
}

export function readHostSettings(): HostSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<HostSettings>;
    return {
      keepAwake: typeof raw.keepAwake === 'boolean' ? raw.keepAwake : DEFAULTS.keepAwake,
      serviceOffered: raw.serviceOffered === true,
      briefOffered: raw.briefOffered === true,
      desktopNotifications: raw.desktopNotifications !== false,
      dailyTokenLimit:
        typeof raw.dailyTokenLimit === 'number' && Number.isFinite(raw.dailyTokenLimit) && raw.dailyTokenLimit > 0
          ? Math.round(raw.dailyTokenLimit)
          : 0,
    };
  } catch {
    return DEFAULTS;
  }
}

export function writeHostSettings(patch: Partial<HostSettings>): HostSettings {
  const next = { ...readHostSettings(), ...patch };
  mkdirSync(getHostDir(), { recursive: true });
  const temp = `${settingsPath()}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(temp, settingsPath());
  return next;
}
