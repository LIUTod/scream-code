/**
 * Row budgets of the activity block.
 *
 * The defaults are the constants in `constant/rendering.ts`; `/blockrows` writes
 * overrides into ui-preferences.json so the block can be tuned without a rebuild.
 * Values are cached in memory because a block reads them on every rebuild — and
 * rebuilds happen on every throttled streaming tick — while the file only changes
 * when the user runs the command.
 *
 * Anything out of range (hand-edited file, stale value, non-number) falls back to
 * the default rather than changing how much content a row may occupy.
 */

import {
  ACTIVITY_GROUP_COLLAPSED_LINES,
  ACTIVITY_GROUP_THINKING_EXCERPT_LINES,
  ACTIVITY_GROUP_TOOL_EXPANDED_LINES,
} from '#/tui/constant/rendering';
import {
  readActivityLinePrefs,
  writeActivityLinePref,
  type ActivityLineKey,
} from './ui-preferences';

export interface ActivityLines {
  /** Total rows of a collapsed block, header included. */
  readonly collapsed: number;
  /** Body rows a single tool row may show while the block is expanded. */
  readonly expandedTool: number;
  /** Rows one reasoning run may show while the block is expanded. */
  readonly expandedThinking: number;
}

export interface ActivityLineSetting {
  readonly key: ActivityLineKey;
  /** Label key for the picker, one per budget. */
  readonly label: string;
  /** Selectable values, ascending. */
  readonly values: readonly number[];
  /** Used when nothing valid is stored. */
  readonly fallback: number;
}

export const ACTIVITY_LINE_SETTINGS: readonly ActivityLineSetting[] = [
  {
    key: 'activityCollapsedLines',
    label: 'blockrows.item_collapsed',
    values: [2, 5, 8],
    fallback: ACTIVITY_GROUP_COLLAPSED_LINES,
  },
  {
    key: 'activityExpandedToolLines',
    label: 'blockrows.item_tool',
    values: [5, 10, 15, 20, 30],
    fallback: ACTIVITY_GROUP_TOOL_EXPANDED_LINES,
  },
  {
    key: 'activityExpandedThinkingLines',
    label: 'blockrows.item_thinking',
    values: [5, 10, 15, 20],
    fallback: ACTIVITY_GROUP_THINKING_EXCERPT_LINES,
  },
];

let cache: ActivityLines | undefined;

function isActivityLineKey(value: string): value is ActivityLineKey {
  return ACTIVITY_LINE_SETTINGS.some((setting) => setting.key === value);
}

export { isActivityLineKey };

export function findActivityLineSetting(key: ActivityLineKey): ActivityLineSetting {
  const setting = ACTIVITY_LINE_SETTINGS.find((candidate) => candidate.key === key);
  // The table above is the only source of keys, so this cannot be missing.
  return setting ?? ACTIVITY_LINE_SETTINGS[0]!;
}

function resolve(stored: number | undefined, setting: ActivityLineSetting): number {
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return setting.fallback;
  return setting.values.includes(stored) ? stored : setting.fallback;
}

function load(): ActivityLines {
  const stored = readActivityLinePrefs();
  const settings = ACTIVITY_LINE_SETTINGS as readonly [
    ActivityLineSetting,
    ActivityLineSetting,
    ActivityLineSetting,
  ];
  return {
    collapsed: resolve(stored.activityCollapsedLines, settings[0]),
    expandedTool: resolve(stored.activityExpandedToolLines, settings[1]),
    expandedThinking: resolve(stored.activityExpandedThinkingLines, settings[2]),
  };
}

/** Current row budgets. Cached: call `refreshActivityLines` after a change. */
export function getActivityLines(): ActivityLines {
  cache ??= load();
  return cache;
}

/** Value currently in effect for one budget (never undefined). */
export function getActivityLineValue(key: ActivityLineKey): number {
  const lines = getActivityLines();
  if (key === 'activityCollapsedLines') return lines.collapsed;
  if (key === 'activityExpandedToolLines') return lines.expandedTool;
  return lines.expandedThinking;
}

/** Persist one budget and drop the cache so the next render picks it up. */
export function setActivityLineValue(key: ActivityLineKey, value: number): void {
  writeActivityLinePref(key, value);
  cache = undefined;
}

/** Forget the cached budgets (tests, and any external preference change). */
export function refreshActivityLines(): void {
  cache = undefined;
}
