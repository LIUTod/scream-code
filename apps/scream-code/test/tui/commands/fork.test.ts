/**
 * `/fork` opens the copy with its scheduled tasks held: the switch that follows
 * subscribes and replays the history first, then starts them, so an overdue
 * task copied from the source cannot fire unseen.
 */
import { describe, expect, it, vi } from 'vitest';

import { handleForkCommand } from '#/tui/commands/session';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

function host(forked: unknown) {
  const h = {
    session: { id: 'ses-src', summary: { title: 'Source' } },
    state: { appState: { sessionTitle: 'Source' } },
    harness: { forkSession: vi.fn(async () => forked) },
    switchToSession: vi.fn(async () => {}),
    showError: vi.fn(),
  };
  return h;
}

describe('/fork', () => {
  it('forks with scheduled tasks held, then hands the fork to switchToSession', async () => {
    const forked = { id: 'ses-fork' };
    const h = host(forked);
    await handleForkCommand(h as unknown as SlashCommandHost, '');
    expect(h.harness.forkSession).toHaveBeenCalledWith({
      id: 'ses-src',
      title: 'Fork: Source',
      scheduledTasks: false,
    });
    expect(h.switchToSession).toHaveBeenCalledWith(forked, expect.stringContaining('ses-fork'));
    expect(h.showError).not.toHaveBeenCalled();
  });
});
