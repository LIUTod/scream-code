import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleUpdateCommand } from '#/tui/commands/update';
import { createMockTUIState } from '../fixtures/mock-host';

function makeHost(version: string) {
  const state = createMockTUIState({ appState: { version } });
  return { state, showStatus: vi.fn(), showError: vi.fn(), setAppState: vi.fn() };
}

const { refresh, read } = vi.hoisted(() => ({ refresh: vi.fn(), read: vi.fn() }));
vi.mock('#/cli/update/refresh', () => ({ refreshUpdateCache: () => refresh() }));
vi.mock('#/cli/update/cache', () => ({ readUpdateCache: () => read() }));

describe('/update when the version check fails', () => {
  beforeEach(() => {
    refresh.mockReset();
    read.mockReset();
  });

  it('says it could not check instead of claiming the latest version', async () => {
    refresh.mockRejectedValue(new Error('getaddrinfo ENOTFOUND registry.npmjs.org'));
    read.mockResolvedValue({ source: 'npm', checkedAt: '', latest: null });
    const host = makeHost('0.21.6');

    await handleUpdateCommand(host as never);

    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('无法检查新版本'));
    const statuses = host.showStatus.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(statuses.some((text) => text.includes('最新'))).toBe(false);
  });

  it('still says up to date when the check worked', async () => {
    refresh.mockResolvedValue({ source: 'npm', checkedAt: '', latest: '0.21.6' });
    read.mockResolvedValue({ source: 'npm', checkedAt: '', latest: '0.21.6' });
    const host = makeHost('0.21.6');

    await handleUpdateCommand(host as never);

    expect(host.showError).not.toHaveBeenCalled();
  });
});
