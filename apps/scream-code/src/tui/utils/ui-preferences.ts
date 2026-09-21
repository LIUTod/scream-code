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

/**
 * How Mermaid blocks are drawn in the transcript (`/mermaid`).
 *
 * - `on`    — draw with box-drawing glyphs. Default.
 * - `ascii` — draw with an ASCII frame, for terminals that render box-drawing
 *             glyphs double-width, which would skew every frame.
 * - `off`   — never draw; the block stays a code block.
 *
 * Drawing always waits for the reply to finish: a frame redrawn every few
 * tokens reads as flicker, so there is nothing to choose there.
 */
export type MermaidDisplay = 'on' | 'ascii' | 'off';

export const MERMAID_DISPLAYS: readonly MermaidDisplay[] = ['on', 'ascii', 'off'];

export interface UiPreferences {
  /** User pressed Ctrl+B to permanently hide the empty-session provider hint. */
  emptySessionHintDismissed?: boolean;
  /** Whether the per-turn elapsed marker (session snapshot timer) is shown. */
  turnElapsedEnabled?: boolean;
  /** Whether user messages render with a highlight background block (/hl). */
  userMessageHighlightEnabled?: boolean;
  /** Whether fenced code blocks render as a background panel (/codebg). */
  codeBlockPanelEnabled?: boolean;
  /** How Mermaid blocks are drawn (/mermaid). Default `on`. */
  mermaidDisplay?: MermaidDisplay;
  /** Rows of a collapsed activity block, header included (/blockrows). */
  activityCollapsedLines?: number;
  /** Body rows one tool row may show while the block is expanded. */
  activityExpandedToolLines?: number;
  /** Rows one reasoning run may show while the block is expanded. */
  activityExpandedThinkingLines?: number;
}

/** The activity row budgets, as stored (callers clamp and default them). */
export interface StoredActivityLines {
  activityCollapsedLines?: number;
  activityExpandedToolLines?: number;
  activityExpandedThinkingLines?: number;
}

export type ActivityLineKey = keyof StoredActivityLines;

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

/** Row budgets of the activity block as stored, without clamping (see
 *  `utils/activity-lines.ts`, which owns the ranges and defaults). */
export function readActivityLinePrefs(): StoredActivityLines {
  const prefs = readUiPreferences();
  return {
    activityCollapsedLines: prefs.activityCollapsedLines,
    activityExpandedToolLines: prefs.activityExpandedToolLines,
    activityExpandedThinkingLines: prefs.activityExpandedThinkingLines,
  };
}

/** Persist one activity row budget. Persisted immediately. */
export function writeActivityLinePref(key: ActivityLineKey, value: number): void {
  const prefs = readUiPreferences();
  prefs[key] = value;
  writeUiPreferences(prefs);
}

/**
 * Whether fenced code blocks render as a background panel (default on).
 *
 * Cached: the markdown renderer asks once per code line, and reading the file
 * each time would hit the disk on every frame. `/codebg` updates the cache.
 */
let codeBlockPanelCache: boolean | undefined;

export function isCodeBlockPanelEnabled(): boolean {
  codeBlockPanelCache ??= readUiPreferences().codeBlockPanelEnabled !== false;
  return codeBlockPanelCache;
}

/** Toggle the code-block panel via /codebg. Returns the new state. */
export function toggleCodeBlockPanel(): boolean {
  const prefs = readUiPreferences();
  const enabled = prefs.codeBlockPanelEnabled !== false;
  prefs.codeBlockPanelEnabled = !enabled;
  writeUiPreferences(prefs);
  codeBlockPanelCache = !enabled;
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

/**
 * The Mermaid drawing mode (`/mermaid`). Cached because the markdown renderer
 * asks once per block per frame; `/mermaid` updates the cache.
 */
let mermaidDisplayCache: MermaidDisplay | undefined;

export function getMermaidDisplay(): MermaidDisplay {
  // Cache first: this is the first thing the markdown transform asks, once per
  // block per frame, and a synchronous read here would hit disk on every render.
  if (mermaidDisplayCache !== undefined) return mermaidDisplayCache;
  const stored = readUiPreferences().mermaidDisplay;
  mermaidDisplayCache = MERMAID_DISPLAYS.includes(stored as MermaidDisplay) ? stored! : 'on';
  return mermaidDisplayCache;
}

/** Whether diagrams are drawn at all — `on` and `ascii` both draw. */
export function isMermaidDrawing(): boolean {
  return getMermaidDisplay() !== 'off';
}

/** Whether frames use the ASCII alphabet instead of box-drawing glyphs. */
export function useMermaidAsciiFrames(): boolean {
  return getMermaidDisplay() === 'ascii';
}

/** Set the Mermaid drawing mode via /mermaid. Persisted immediately. */
export function setMermaidDisplay(value: MermaidDisplay): void {
  const prefs = readUiPreferences();
  prefs.mermaidDisplay = value;
  writeUiPreferences(prefs);
  mermaidDisplayCache = value;
}
