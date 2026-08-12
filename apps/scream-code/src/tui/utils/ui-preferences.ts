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
  /** Whether the per-turn elapsed marker (session snapshot timer) is shown. */
  turnElapsedEnabled?: boolean;
  /** Whether user messages render with a highlight background block (/hl). */
  userMessageHighlightEnabled?: boolean;
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

/** Whether the per-turn elapsed marker is enabled (default on). */
export function isTurnElapsedEnabled(): boolean {
  return readUiPreferences().turnElapsedEnabled !== false;
}

/** Toggle the per-turn elapsed marker via /snaptimer. Returns the new state:
 *  true = shown, false = hidden. Persisted immediately. */
export function toggleTurnElapsed(): boolean {
  const prefs = readUiPreferences();
  const enabled = prefs.turnElapsedEnabled !== false;
  prefs.turnElapsedEnabled = !enabled;
  writeUiPreferences(prefs);
  return !enabled;
}

/** Whether user messages render with a highlight background block (default on). */
export function isUserMessageHighlightEnabled(): boolean {
  return readUiPreferences().userMessageHighlightEnabled !== false;
}

/** Toggle the user-message highlight block via /hl. Returns the new state:
 *  true = highlighted, false = default (no background). Persisted immediately. */
export function toggleUserMessageHighlight(): boolean {
  const prefs = readUiPreferences();
  const enabled = prefs.userMessageHighlightEnabled !== false;
  prefs.userMessageHighlightEnabled = !enabled;
  writeUiPreferences(prefs);
  return !enabled;
}
