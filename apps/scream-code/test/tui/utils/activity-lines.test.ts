import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACTIVITY_GROUP_COLLAPSED_LINES,
  ACTIVITY_GROUP_THINKING_EXCERPT_LINES,
  ACTIVITY_GROUP_TOOL_EXPANDED_LINES,
  ACTIVITY_GROUP_EDIT_PREVIEW_LINES,
} from '#/tui/constant/rendering';

interface StoredLines {
  activityCollapsedLines?: number;
  activityExpandedToolLines?: number;
  activityExpandedThinkingLines?: number;
  activityEditPreviewLines?: number;
}

const { stored } = vi.hoisted(() => ({ stored: {} as StoredLines }));

vi.mock('#/tui/utils/ui-preferences', () => ({
  readActivityLinePrefs: (): StoredLines => ({ ...stored }),
  writeActivityLinePref: (key: keyof StoredLines, value: number): void => {
    stored[key] = value;
  },
}));

const {
  ACTIVITY_LINE_SETTINGS,
  findActivityLineSetting,
  getActivityLineValue,
  getActivityLines,
  isActivityLineKey,
  refreshActivityLines,
  setActivityLineValue,
} = await import('#/tui/utils/activity-lines');

describe('activity line budgets', () => {
  beforeEach(() => {
    delete stored.activityCollapsedLines;
    delete stored.activityExpandedToolLines;
    delete stored.activityExpandedThinkingLines;
    delete stored.activityEditPreviewLines;
    refreshActivityLines();
  });

  it('falls back to the documented defaults', () => {
    expect(getActivityLines()).toEqual({
      collapsed: ACTIVITY_GROUP_COLLAPSED_LINES,
      expandedTool: ACTIVITY_GROUP_TOOL_EXPANDED_LINES,
      expandedThinking: ACTIVITY_GROUP_THINKING_EXCERPT_LINES,
      editPreview: ACTIVITY_GROUP_EDIT_PREVIEW_LINES,
    });
  });

  it('uses stored values that are on the menu', () => {
    stored.activityCollapsedLines = 5;
    stored.activityExpandedToolLines = 30;
    stored.activityExpandedThinkingLines = 20;
    stored.activityEditPreviewLines = 0;
    refreshActivityLines();

    expect(getActivityLines()).toEqual({ collapsed: 5, expandedTool: 30, expandedThinking: 20, editPreview: 0 });
  });

  it('ignores off-menu values so a hand-edited file cannot change the layout', () => {
    stored.activityCollapsedLines = 99;
    stored.activityExpandedToolLines = -4;
    stored.activityExpandedThinkingLines = Number.NaN;
    stored.activityEditPreviewLines = 3;
    refreshActivityLines();

    expect(getActivityLines()).toEqual({
      collapsed: ACTIVITY_GROUP_COLLAPSED_LINES,
      expandedTool: ACTIVITY_GROUP_TOOL_EXPANDED_LINES,
      expandedThinking: ACTIVITY_GROUP_THINKING_EXCERPT_LINES,
      editPreview: ACTIVITY_GROUP_EDIT_PREVIEW_LINES,
    });
  });

  it('persists a choice and applies it without a restart', () => {
    expect(getActivityLineValue('activityExpandedToolLines')).toBe(
      ACTIVITY_GROUP_TOOL_EXPANDED_LINES,
    );

    setActivityLineValue('activityExpandedToolLines', 5);

    expect(stored.activityExpandedToolLines).toBe(5);
    expect(getActivityLineValue('activityExpandedToolLines')).toBe(5);
    expect(getActivityLines().expandedTool).toBe(5);
  });

  it('only recognises keys that exist in the settings table', () => {
    for (const setting of ACTIVITY_LINE_SETTINGS) {
      expect(isActivityLineKey(setting.key)).toBe(true);
      expect(findActivityLineSetting(setting.key)).toBe(setting);
    }
    expect(isActivityLineKey('activityNope')).toBe(false);
  });
});
