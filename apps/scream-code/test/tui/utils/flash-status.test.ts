import { describe, expect, it, vi } from 'vitest';

import { flashStatus } from '#/tui/utils/flash-status';

describe('flashStatus', () => {
  it('shows a toast, and writes nothing to the transcript, when the host has one', () => {
    const showStatus = vi.fn();
    const flash = vi.fn();
    flashStatus({ showStatus, flash }, 'copied', '#00ff00');
    expect(flash).toHaveBeenCalledWith('copied');
    expect(showStatus).not.toHaveBeenCalled();
  });

  it('falls back to a transcript row, with its colour, when the host has no toast', () => {
    const showStatus = vi.fn();
    flashStatus({ showStatus }, 'cancelled', '#888888');
    expect(showStatus).toHaveBeenCalledWith('cancelled', '#888888');
  });

  it('passes no colour on when there is none', () => {
    const showStatus = vi.fn();
    flashStatus({ showStatus }, 'copied');
    expect(showStatus).toHaveBeenCalledWith('copied');
  });
});
