import type { SessionSummary } from '@scream-code/scream-code-sdk';
import { describe, expect, it } from 'vitest';

import { isEmptySessionShell, sessionRowsForPicker } from '#/tui/utils/session-picker-rows';

function summary(input: {
  readonly id: string;
  readonly title?: string;
  readonly lastPrompt?: string;
}): SessionSummary {
  return {
    id: input.id,
    title: input.title,
    lastPrompt: input.lastPrompt,
    workDir: '/tmp/project',
    sessionDir: `/tmp/home/sessions/${input.id}`,
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('sessionRowsForPicker', () => {
  it('omits the current session when the TUI session has no content', () => {
    const rows = sessionRowsForPicker(
      [
        summary({ id: 'ses_current', title: 'New Session' }),
        summary({ id: 'ses_previous', title: 'Earlier work', lastPrompt: 'Earlier work' }),
      ],
      'ses_current',
      false,
    );

    expect(rows.map((row) => row.id)).toEqual(['ses_previous']);
  });

  it('keeps the current session when the TUI session has content', () => {
    const rows = sessionRowsForPicker(
      [
        summary({
          id: 'ses_current',
          title: 'Implement feature',
          lastPrompt: 'Implement feature',
        }),
      ],
      'ses_current',
      true,
    );

    expect(rows.map((row) => row.id)).toEqual(['ses_current']);
  });

  it('hides empty sessions other than the current one', () => {
    const rows = sessionRowsForPicker(
      [
        summary({ id: 'ses_current', title: 'New Session' }),
        summary({ id: 'ses_previous_empty', title: 'New Session' }),
        summary({ id: 'ses_untitled' }),
        summary({ id: 'ses_prompted', lastPrompt: 'fix the build' }),
        summary({ id: 'ses_renamed', title: 'Release notes' }),
      ],
      'ses_current',
      false,
    );

    expect(rows.map((row) => row.id)).toEqual(['ses_prompted', 'ses_renamed']);
  });

  it('keeps an archived session even with no prompt', () => {
    const rows = sessionRowsForPicker([{ ...summary({ id: 'ses_archived' }), archived: true }], 'ses_current', false);
    expect(rows.map((row) => row.id)).toEqual(['ses_archived']);
  });
});

describe('isEmptySessionShell', () => {
  it('treats no prompt plus no title, or the placeholder title, as empty', () => {
    expect(isEmptySessionShell({ archived: false, lastPrompt: undefined, title: undefined })).toBe(true);
    expect(isEmptySessionShell({ archived: false, lastPrompt: undefined, title: 'New Session' })).toBe(true);
    expect(isEmptySessionShell({ archived: false, lastPrompt: undefined, title: '  ' })).toBe(true);
  });

  it('keeps anything with a prompt, a real title, or the archive flag', () => {
    expect(isEmptySessionShell({ archived: false, lastPrompt: 'hi', title: undefined })).toBe(false);
    expect(isEmptySessionShell({ archived: false, lastPrompt: undefined, title: 'Mine' })).toBe(false);
    expect(isEmptySessionShell({ archived: true, lastPrompt: undefined, title: undefined })).toBe(false);
  });
});
