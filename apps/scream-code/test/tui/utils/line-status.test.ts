import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadLineConfig: vi.fn(),
  readLineDaemonStatus: vi.fn(),
}));

vi.mock('#/line/config', () => ({ loadLineConfig: mocks.loadLineConfig }));
vi.mock('#/line/pidfile', () => ({ readLineDaemonStatus: mocks.readLineDaemonStatus }));

import { readLineFooterStatus, readLinePlatform } from '#/tui/utils/line-status';

describe('readLinePlatform', () => {
  beforeEach(() => {
    mocks.loadLineConfig.mockReset();
    mocks.readLineDaemonStatus.mockReset();
  });

  it('maps the feishu block to lark and the weixin block to wechat', async () => {
    mocks.loadLineConfig.mockResolvedValue({ version: 1, feishu: { appId: 'a' } });
    expect(await readLinePlatform()).toBe('lark');

    mocks.loadLineConfig.mockResolvedValue({ version: 1, weixin: { botToken: 't' } });
    expect(await readLinePlatform()).toBe('wechat');
  });

  it('returns null when /line is not configured', async () => {
    mocks.loadLineConfig.mockResolvedValue(null);
    expect(await readLinePlatform()).toBeNull();
  });

  it('returns null instead of throwing on a corrupted config file', async () => {
    mocks.loadLineConfig.mockRejectedValue(new Error('broken json'));
    expect(await readLinePlatform()).toBeNull();
  });
});

describe('readLineFooterStatus', () => {
  beforeEach(() => {
    mocks.loadLineConfig.mockReset();
    mocks.readLineDaemonStatus.mockReset();
  });

  it('reports the configured channel together with the daemon liveness', async () => {
    mocks.loadLineConfig.mockResolvedValue({ version: 1, weixin: { botToken: 't' } });
    mocks.readLineDaemonStatus.mockResolvedValue({ running: true, pid: 42 });
    expect(await readLineFooterStatus()).toEqual({ active: true, platform: 'wechat' });
  });

  it('treats an unreadable pidfile as "not running"', async () => {
    mocks.loadLineConfig.mockResolvedValue({ version: 1, feishu: { appId: 'a' } });
    mocks.readLineDaemonStatus.mockRejectedValue(new Error('boom'));
    expect(await readLineFooterStatus()).toEqual({ active: false, platform: 'lark' });
  });
});
