import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertSinglePlatformConfig,
  LineConfigError,
  getLineConfigPath,
  getLineDir,
  loadLineConfig,
  resolveFeishuOptions,
  resolveWeixinOptions,
  saveLineConfig,
} from '#/line/config';

const created: string[] = [];

function tempHome(prefix = 'line-config-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['SCREAM_CODE_HOME'];
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['SCREAM_CODE_HOME'];
  else process.env['SCREAM_CODE_HOME'] = savedHome;
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function useHome(home: string): void {
  process.env['SCREAM_CODE_HOME'] = home;
}

describe('loadLineConfig / saveLineConfig', () => {
  it('returns null when no config exists', async () => {
    useHome(tempHome());
    expect(await loadLineConfig()).toBeNull();
  });

  it('round-trips a saved config', async () => {
    const home = tempHome();
    useHome(home);
    await saveLineConfig({
      version: 1,
      feishu: { app_id: 'cli_a', app_secret: 'sec' },
      permissionMode: 'dontAsk',
      autoStart: false,
    });
    const loaded = await loadLineConfig();
    expect(loaded?.feishu?.app_id).toBe('cli_a');
    expect(loaded?.permissionMode).toBe('dontAsk');
    expect(loaded?.autoStart).toBe(false);
  });

  it('writes the config with 0600 permissions (contains the secret)', async () => {
    const home = tempHome();
    useHome(home);
    await saveLineConfig({
      version: 1,
      feishu: { app_id: 'cli_a', app_secret: 'sec' },
      permissionMode: 'yolo',
      autoStart: true,
    });
    const mode = statSync(getLineConfigPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('throws a typed error on malformed JSON (never silently resets)', async () => {
    const home = tempHome();
    useHome(home);
    mkdirSync(getLineDir(), { recursive: true });
    writeFileSync(getLineConfigPath(), '{not json');
    await expect(loadLineConfig()).rejects.toBeInstanceOf(LineConfigError);
  });

  it('throws a typed error on schema violations', async () => {
    const home = tempHome();
    useHome(home);
    mkdirSync(getLineDir(), { recursive: true });
    writeFileSync(
      getLineConfigPath(),
      JSON.stringify({ version: 1, permissionMode: 'chaos' }),
    );
    await expect(loadLineConfig()).rejects.toBeInstanceOf(LineConfigError);
  });

  it('applies schema defaults on load', async () => {
    const home = tempHome();
    useHome(home);
    mkdirSync(getLineDir(), { recursive: true });
    writeFileSync(
      getLineConfigPath(),
      JSON.stringify({ version: 1, feishu: { app_id: 'cli_a', app_secret: 'sec' } }),
    );
    const loaded = await loadLineConfig();
    // `auto` is the IM default: no approval surface, deny rules still apply.
    expect(loaded?.permissionMode).toBe('auto');
    expect(loaded?.autoStart).toBe(true);
    // The stored file keeps raw values; defaults only materialize in memory.
    const raw = readFileSync(getLineConfigPath(), 'utf-8');
    expect(raw).toContain('cli_a');
  });
});

describe('resolveWeixinOptions (legacy weixin defaults)', () => {
  it('applies the legacy defaults: ilink gateway, 35s long-poll, 300s dedup', () => {
    const o = resolveWeixinOptions({ token: 'tok' });
    expect(o.token).toBe('tok');
    expect(o.baseUrl).toBe('https://ilinkai.weixin.qq.com');
    expect(o.longPollTimeoutMs).toBe(35_000);
    expect(o.dedupWindowMs).toBe(300_000);
    expect(o.allowFrom).toEqual([]);
    expect(o.routeTag).toBe('');
  });

  it('honors explicit overrides', () => {
    const o = resolveWeixinOptions({
      token: 'tok',
      base_url: 'https://gw.example.com/',
      allow_from: 'a@im.wechat,b@im.wechat',
      route_tag: 'rt',
      long_poll_timeout_ms: 10_000,
      dedup_window_seconds: 60,
    });
    expect(o.baseUrl).toBe('https://gw.example.com');
    expect(o.allowFrom).toEqual(['a@im.wechat', 'b@im.wechat']);
    expect(o.routeTag).toBe('rt');
    expect(o.longPollTimeoutMs).toBe(10_000);
    expect(o.dedupWindowMs).toBe(60_000);
  });

  it('the schema accepts a weixin block alongside feishu', async () => {
    const home = tempHome();
    useHome(home);
    mkdirSync(getLineDir(), { recursive: true });
    writeFileSync(
      getLineConfigPath(),
      JSON.stringify({
        version: 1,
        feishu: { app_id: 'cli_a', app_secret: 's' },
        weixin: { token: 'wx_tok' },
        permissionMode: 'yolo',
        autoStart: true,
      }),
    );
    const loaded = await loadLineConfig();
    expect(loaded?.feishu?.app_id).toBe('cli_a');
    expect(loaded?.weixin?.token).toBe('wx_tok');
  });
});

describe('assertSinglePlatformConfig (single-channel invariant)', () => {
  const bothPlatforms = {
    version: 1 as const,
    feishu: { app_id: 'cli_a', app_secret: 's' },
    weixin: { token: 't' },
    permissionMode: 'yolo' as const,
    autoStart: true,
  };

  it('rejects a config containing both platforms', () => {
    expect(() => {
      assertSinglePlatformConfig(bothPlatforms);
    }).toThrow(LineConfigError);
    expect(() => {
      assertSinglePlatformConfig(bothPlatforms);
    }).toThrow(/单通道/);
  });

  it('accepts single-platform and empty configs', () => {
    expect(() => {
      assertSinglePlatformConfig({
        version: 1,
        feishu: { app_id: 'cli_a', app_secret: 's' },
        permissionMode: 'yolo',
        autoStart: true,
      });
    }).not.toThrow();
    expect(() => {
      assertSinglePlatformConfig({
        version: 1,
        weixin: { token: 't' },
        permissionMode: 'yolo',
        autoStart: true,
      });
    }).not.toThrow();
    expect(() => {
      assertSinglePlatformConfig({ version: 1, permissionMode: 'yolo', autoStart: true });
    }).not.toThrow();
  });
});

describe('resolveFeishuOptions (legacy platform defaults)', () => {
  it('applies the legacy defaults: OnIt receipt, no done emoji, mention required', () => {
    const o = resolveFeishuOptions({ app_id: 'cli_a', app_secret: 'sec' });
    expect(o.reactionEmoji).toBe('OnIt');
    expect(o.doneEmoji).toBe('');
    expect(o.requireMention).toBe(true);
    expect(o.shareSessionInChannel).toBe(false);
    expect(o.groupOnly).toBe(false);
    expect(o.domain).toBe('https://open.feishu.cn');
    expect(o.allowFrom).toEqual([]);
  });

  it('splits allow lists and honors none for emojis', () => {
    const o = resolveFeishuOptions({
      app_id: 'cli_a',
      app_secret: 'sec',
      allow_from: ' u1, u2 , ,u3 ',
      allow_chat: 'oc_1',
      require_mention: false,
      reaction_emoji: 'none',
      done_emoji: 'THUMBSUP',
      domain: 'https://open.larksuite.com',
    });
    expect(o.allowFrom).toEqual(['u1', 'u2', 'u3']);
    expect(o.allowChat).toEqual(['oc_1']);
    expect(o.requireMention).toBe(false);
    expect(o.reactionEmoji).toBe('');
    expect(o.doneEmoji).toBe('THUMBSUP');
    expect(o.domain).toBe('https://open.larksuite.com');
  });
});

describe('custom commands', () => {
  function baseConfig(commands: unknown) {
    return {
      version: 1,
      feishu: { app_id: 'cli_a', app_secret: 'secret', allow_from: 'ou_1' },
      commands,
    };
  }

  it('accepts prompt and exec commands and maps snake_case to camelCase', async () => {
    useHome(tempHome());
    await saveLineConfig(baseConfig([
      { name: '/standup', prompt: '总结：{args}' },
      { name: '/deploy', exec: './deploy.sh', work_dir: 'scripts' },
    ]) as never);

    const loaded = await loadLineConfig();
    const commands = loaded?.commands ?? [];
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({ name: '/standup', prompt: '总结：{args}' });
    expect(commands[1]).toMatchObject({ name: '/deploy', exec: './deploy.sh', work_dir: 'scripts' });
  });

  it('rejects prompt+exec together and neither of them', async () => {
    useHome(tempHome());
    await saveLineConfig(baseConfig([{ name: '/both', prompt: 'x', exec: 'y' }]) as never);
    await expect(loadLineConfig()).rejects.toThrow(/prompt|exec/);

    useHome(tempHome());
    await saveLineConfig(baseConfig([{ name: '/neither' }]) as never);
    await expect(loadLineConfig()).rejects.toThrow(/prompt|exec/);
  });

  it('rejects malformed names, reserved names and duplicates', async () => {
    for (const commands of [
      [{ name: 'standup', prompt: 'x' }],
      [{ name: '/bad name', prompt: 'x' }],
      [{ name: '/status', prompt: 'x' }],
      [
        { name: '/dup', prompt: 'x' },
        { name: '/dup', prompt: 'y' },
      ],
    ]) {
      useHome(tempHome());
      await saveLineConfig(baseConfig(commands) as never);
      await expect(loadLineConfig()).rejects.toThrow();
    }
  });
});
