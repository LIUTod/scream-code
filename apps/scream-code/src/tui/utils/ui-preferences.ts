/**
 * TUI-local UI preferences persisted to `<dataDir>/ui-preferences.json`.
 * Distinct from agent/SDK config files (which are owned by core) — this file
 * stores lightweight view-state knobs owned by the TUI itself, e.g. whether
 * the empty-session provider hint has been dismissed by the user.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { SCREAM_CODE_UI_PREFERENCES_FILE_NAME } from '#/constant/app';
import { getDataDir } from '#/utils/paths';

export interface UiPreferences {
  /** User pressed Ctrl+B to permanently hide the empty-session provider hint. */
  emptySessionHintDismissed?: boolean;
}

const EMPTY: UiPreferences = {};

export function getUiPreferencesPath(): string {
  return join(getDataDir(), SCREAM_CODE_UI_PREFERENCES_FILE_NAME);
}

export function readUiPreferences(): UiPreferences {
  try {
    const file = getUiPreferencesPath();
    if (!existsSync(file)) return { ...EMPTY };
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as UiPreferences;
    return { ...EMPTY, ...parsed };
  } catch {
    // Corrupt/unreadable prefs are treated as defaults; never crash the TUI.
    return { ...EMPTY };
  }
}

export function writeUiPreferences(prefs: UiPreferences): void {
  try {
    const file = getUiPreferencesPath();
    // Ensure the data dir exists (it is not created at startup).
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(prefs, null, 2), 'utf8');
  } catch {
    // Best-effort persistence; a failure must never surface.
  }
}

export function isEmptySessionHintDismissed(): boolean {
  return readUiPreferences().emptySessionHintDismissed === true;
}

/** Toggle the empty-session hint on/off (Ctrl+B). Returns the new state:
 *  true = hidden, false = shown. Persisted immediately. */
export function toggleEmptySessionHint(): boolean {
  const prefs = readUiPreferences();
  const dismissed = prefs.emptySessionHintDismissed !== true;
  prefs.emptySessionHintDismissed = dismissed;
  writeUiPreferences(prefs);
  return dismissed;
}
