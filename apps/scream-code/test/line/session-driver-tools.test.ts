import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LineSessionDriver,
  LINE_SEND_MEDIA_TOOL,
  MAX_OUTBOUND_MEDIA_BYTES,
  type LineMediaSender,
} from '#/line/session-driver';
import type { LineSessionDriverOptions } from '#/line/session-driver';

/**
 * The `line_send_media` bridge is the only way the model can push a file back
 * over the chat, so its guards (workdir sandbox, size, kind) are security
 * boundaries, not conveniences.
 */

interface HostToolCall {
  name?: string;
  sessionId?: string;
  args: unknown;
}

function makeDriver(workDir: string): {
  driver: LineSessionDriver;
  call: (request: HostToolCall) => Promise<{ output: string; isError?: boolean }>;
  register: (sessionKey: string, sender: LineMediaSender) => void;
  /** Installs the daemon-level fallback used by scheduled-task turns. */
  useResolver: (resolver: (sessionKey: string) => LineMediaSender | undefined) => void;
  bindSession: (sessionKey: string, sessionId: string) => void;
} {
  const driver = new LineSessionDriver({
    platform: 'feishu',
    workDir,
    permissionMode: 'yolo',
  } as unknown as LineSessionDriverOptions);
  // Private surfaces used by the host callback; exercising them directly keeps
  // the test free of a live harness.
  const internals = driver as unknown as {
    handleHostToolCall(request: HostToolCall): Promise<{ output: string; isError?: boolean }>;
    sessionKeyBySessionId: Map<string, string>;
    mediaSenders: Map<string, LineMediaSender>;
  };
  return {
    driver,
    call: (request) => internals.handleHostToolCall(request),
    register: (sessionKey, sender) => internals.mediaSenders.set(sessionKey, sender),
    useResolver: (resolver) => {
      driver.setMediaSenderResolver(resolver);
    },
    bindSession: (sessionKey, sessionId) => internals.sessionKeyBySessionId.set(sessionId, sessionKey),
  };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeWorkDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scream-line-tool-'));
  dirs.push(dir);
  return dir;
}

describe('line_send_media host tool', () => {
  it('rejects unknown host tools', async () => {
    const { call } = makeDriver(await makeWorkDir());
    const result = await call({ name: 'other_tool', args: {} });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('未知的宿主工具');
  });

  it('refuses calls from a session with no channel sender', async () => {
    const { call, bindSession } = makeDriver(await makeWorkDir());
    bindSession('line-feishu-x', 'sess-1');
    const result = await call({ name: LINE_SEND_MEDIA_TOOL, sessionId: 'sess-1', args: { path: 'a.png' } });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('没有可用的发送通道');
  });

  it('sends a file inside the working directory and infers the image kind', async () => {
    const workDir = await makeWorkDir();
    await writeFile(join(workDir, 'shot.png'), Buffer.from('png'));
    const { call, register, bindSession } = makeDriver(workDir);
    const sender = vi.fn(async () => {});
    register('line-feishu-x', sender);
    bindSession('line-feishu-x', 'sess-1');

    const result = await call({
      name: LINE_SEND_MEDIA_TOOL,
      sessionId: 'sess-1',
      args: { path: 'shot.png' },
    });
    expect(result.isError).toBeUndefined();
    // macOS resolves /var → /private/var, so compare the resolved tail.
    const [kind, sentPath] = sender.mock.calls[0] as unknown as [string, string];
    expect(kind).toBe('image');
    expect(sentPath.endsWith('/shot.png')).toBe(true);
    expect(result.output).toContain('shot.png');
  });

  it('respects an explicit kind for a non-image extension', async () => {
    const workDir = await makeWorkDir();
    await writeFile(join(workDir, 'notes.txt'), Buffer.from('hello'));
    const { call, register, bindSession } = makeDriver(workDir);
    const sender = vi.fn(async () => {});
    register('s', sender);
    bindSession('s', 'sess-2');

    await call({ name: LINE_SEND_MEDIA_TOOL, sessionId: 'sess-2', args: { path: 'notes.txt' } });
    const [kind, sentPath] = sender.mock.calls[0] as unknown as [string, string];
    expect(kind).toBe('file');
    expect(sentPath.endsWith('/notes.txt')).toBe(true);
  });

  it('allows a dot-prefixed file name that is not a parent traversal', async () => {
    const workDir = await makeWorkDir();
    await writeFile(join(workDir, '..notes.png'), Buffer.from('png'));
    const { call, register, bindSession } = makeDriver(workDir);
    const sender = vi.fn(async () => {});
    register('s', sender);
    bindSession('s', 'sess-dot');

    const result = await call({
      name: LINE_SEND_MEDIA_TOOL,
      sessionId: 'sess-dot',
      args: { path: '..notes.png' },
    });
    expect(result.isError).toBeUndefined();
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('infers voice from an audio extension and honours kind=audio', async () => {
    const workDir = await makeWorkDir();
    await writeFile(join(workDir, 'note.mp3'), Buffer.from('mp3'));
    await writeFile(join(workDir, 'blob.bin'), Buffer.from('x'));
    const { call, register, bindSession } = makeDriver(workDir);
    const sender = vi.fn(async (_kind: string, _path: string): Promise<string> => '（已转语音）');
    register('s', sender);
    bindSession('s', 'sess-audio');

    const inferred = await call({
      name: LINE_SEND_MEDIA_TOOL,
      sessionId: 'sess-audio',
      args: { path: 'note.mp3' },
    });
    expect(sender.mock.calls[0]?.[0]).toBe('voice');
    expect(inferred.output).toContain('已发送语音');
    expect(inferred.output).toContain('已转语音');

    await call({
      name: LINE_SEND_MEDIA_TOOL,
      sessionId: 'sess-audio',
      args: { path: 'blob.bin', kind: 'audio' },
    });
    expect(sender.mock.calls[1]?.[0]).toBe('voice');
  });

  it('blocks paths outside the working directory (including traversal)', async () => {
    const workDir = await makeWorkDir();
    const { call, register, bindSession } = makeDriver(workDir);
    const sender = vi.fn(async () => {});
    register('s', sender);
    bindSession('s', 'sess-3');

    for (const path of ['../outside.png', '/etc/hosts']) {
      const result = await call({ name: LINE_SEND_MEDIA_TOOL, sessionId: 'sess-3', args: { path } });
      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/工作目录|不存在/);
    }
    expect(sender).not.toHaveBeenCalled();
  });

  it('rejects a missing file and an oversized file', async () => {
    const workDir = await makeWorkDir();
    const big = join(workDir, 'big.bin');
    await writeFile(big, Buffer.alloc(MAX_OUTBOUND_MEDIA_BYTES + 1));
    const { call, register, bindSession } = makeDriver(workDir);
    const sender = vi.fn(async () => {});
    register('s', sender);
    bindSession('s', 'sess-4');

    const missing = await call({ name: LINE_SEND_MEDIA_TOOL, sessionId: 'sess-4', args: { path: 'nope.png' } });
    expect(missing.isError).toBe(true);

    const tooBig = await call({ name: LINE_SEND_MEDIA_TOOL, sessionId: 'sess-4', args: { path: 'big.bin' } });
    expect(tooBig.isError).toBe(true);
    expect(tooBig.output).toContain('过大');
    expect(sender).not.toHaveBeenCalled();
  });

  it('validates the argument shape', async () => {
    const { call, register, bindSession } = makeDriver(await makeWorkDir());
    register('s', vi.fn(async () => {}));
    bindSession('s', 'sess-5');
    for (const args of [null, {}, { path: '' }, { path: 'a.png', kind: 'video' }]) {
      const result = await call({ name: LINE_SEND_MEDIA_TOOL, sessionId: 'sess-5', args });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('参数无效');
    }
  });

  it('reports a sender failure as a tool error instead of throwing', async () => {
    const workDir = await makeWorkDir();
    await writeFile(join(workDir, 'shot.png'), Buffer.from('png'));
    const { call, register, bindSession } = makeDriver(workDir);
    register('s', async () => {
      throw new Error('upload rejected');
    });
    bindSession('s', 'sess-6');

    const result = await call({ name: LINE_SEND_MEDIA_TOOL, sessionId: 'sess-6', args: { path: 'shot.png' } });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('upload rejected');
  });
});

describe('session resolution', () => {
  it('creates one session when a command and a turn race for the same chat', async () => {
    const { driver } = makeDriver(await makeWorkDir());
    const internals = driver as unknown as {
      harness: unknown;
      getOrCreateSession: (...args: unknown[]) => Promise<unknown>;
      resolveSession(sessionKey: string): Promise<unknown>;
    };
    internals.harness = {};
    const session = {
      id: 'sess-race',
      setRuntimeSystemPrompt: vi.fn(async () => {}),
      registerTool: vi.fn(async () => {}),
      onEvent: vi.fn(() => () => {}),
    };
    const create = vi.fn(async () => {
      // Widen the window the race used to exploit.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return session;
    });
    internals.getOrCreateSession = create;

    const [first, second] = await Promise.all([
      internals.resolveSession('line-feishu-race'),
      internals.resolveSession('line-feishu-race'),
    ]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(session.registerTool).toHaveBeenCalledTimes(1);
  });
});

describe('custom exec commands', () => {
  it('runs a shell command inside the work dir and returns its output', async () => {
    const { driver } = makeDriver(await makeWorkDir());
    const internals = driver as unknown as {
      runCustomExec(command: unknown, arg: string): Promise<string>;
    };
    await expect(internals.runCustomExec({ name: '/say', exec: 'printf hello' }, '')).resolves.toBe('hello');
  });

  it('substitutes the quoted argument and exposes it as LINE_ARGS', async () => {
    const { driver } = makeDriver(await makeWorkDir());
    const internals = driver as unknown as {
      runCustomExec(command: unknown, arg: string): Promise<string>;
    };
    const out = await internals.runCustomExec(
      { name: '/echo', exec: 'printf "%s|%s" {args} "$LINE_ARGS"' },
      'a b',
    );
    expect(out).toBe('a b|a b');
  });

  it.skipIf(process.platform === 'win32')('does not expand `$` patterns in {args}', async () => {
    const { driver } = makeDriver(await makeWorkDir());
    const internals = driver as unknown as {
      runCustomExec(command: unknown, arg: string): Promise<string>;
    };
    const out = await internals.runCustomExec(
      { name: '/echo', exec: 'printf "%s" {args}' },
      "$& $' $HOME",
    );
    // Literal: no shell/JS replacement semantics applied to the argument.
    expect(out).toBe("$& $' $HOME");
  });

  it('refuses a work_dir that escapes the sandbox', async () => {
    const { driver } = makeDriver(await makeWorkDir());
    const internals = driver as unknown as {
      runCustomExec(command: unknown, arg: string): Promise<string>;
    };
    const out = await internals.runCustomExec(
      { name: '/x', exec: 'echo hi', workDir: '../outside' },
      '',
    );
    expect(out).toContain('工作目录越界');
  });

  it('reports a failing command instead of throwing', async () => {
    const { driver } = makeDriver(await makeWorkDir());
    const internals = driver as unknown as {
      runCustomExec(command: unknown, arg: string): Promise<string>;
    };
    const out = await internals.runCustomExec({ name: '/fail', exec: 'exit 3' }, '');
    expect(out).toContain('命令执行失败');
  });
});

describe('session lifecycle guards', () => {
  it('refuses new turns while a reset is running', async () => {
    const { driver } = makeDriver(await makeWorkDir());
    const internals = driver as unknown as {
      harness: unknown;
      resetting: Set<string>;
      submit(job: { sessionKey: string; text: string }): Promise<{ ok: boolean; text: string }>;
    };
    internals.harness = {};
    internals.resetting.add('line-feishu-busy');

    const outcome = await internals.submit({ sessionKey: 'line-feishu-busy', text: 'hi' });
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain('正在重置');
  });

  it('prunes reverse mappings and media senders when a session is reset', async () => {
    const { driver } = makeDriver(await makeWorkDir());
    const internals = driver as unknown as {
      harness: { deleteSession: (key: string) => Promise<void> };
      sessions: Map<string, unknown>;
      sessionKeyBySessionId: Map<string, string>;
      mediaSenders: Map<string, unknown>;
      resetSession(sessionKey: string): Promise<void>;
    };
    const deleted: string[] = [];
    internals.harness = { deleteSession: async (key: string) => { deleted.push(key); } };
    const session = { id: 'sess-old', close: async () => {} };
    internals.sessions.set('k', session);
    internals.sessionKeyBySessionId.set('sess-old', 'k');
    internals.mediaSenders.set('k', () => {});

    await internals.resetSession('k');

    expect(internals.sessions.has('k')).toBe(false);
    expect(internals.sessionKeyBySessionId.has('sess-old')).toBe(false);
    expect(internals.mediaSenders.has('k')).toBe(false);
    expect(deleted).toEqual(['k']);
  });

  it('cancels a turn that never settles and reports a timeout', async () => {
    vi.useFakeTimers();
    const { driver } = makeDriver(await makeWorkDir());
    const cancel = vi.fn(async () => {});
    const internals = driver as unknown as {
      harness: unknown;
      sessions: Map<string, unknown>;
      runTurn(job: { sessionKey: string; text: string }): Promise<{ ok: boolean; text: string }>;
    };
    internals.harness = {};
    internals.sessions.set('k-timeout', {
      id: 'sess-timeout',
      prompt: () => new Promise<void>(() => {}), // never settles
      onEvent: () => () => {},
      setRuntimeSystemPrompt: async () => {},
      registerTool: async () => {},
      setApprovalHandler: () => {},
      setQuestionHandler: () => {},
      cancel,
    });

    const pending = internals.runTurn({ sessionKey: 'k-timeout', text: 'hang forever' });
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 10);
    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain('超时');
    expect(cancel).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('media sender fallback', () => {
  it('uses the platform resolver when no per-message sender exists', async () => {
    // Scheduled-task turns have no inbound message to register a sender for;
    // without this fallback their `line_send_media` calls would fail.
    const workDir = await makeWorkDir();
    await writeFile(join(workDir, 'chart.png'), Buffer.from('png'));
    const { call, bindSession, useResolver } = makeDriver(workDir);
    const sender = vi.fn(async () => {});
    useResolver((sessionKey) => (sessionKey === 'line-feishu-cron' ? sender : undefined));
    bindSession('line-feishu-cron', 'sess-cron');

    const result = await call({
      name: LINE_SEND_MEDIA_TOOL,
      sessionId: 'sess-cron',
      args: { path: 'chart.png' },
    });

    expect(result.isError).toBeUndefined();
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('still rejects a session the resolver does not know', async () => {
    const workDir = await makeWorkDir();
    const { call, bindSession, useResolver } = makeDriver(workDir);
    useResolver(() => undefined);
    bindSession('line-weixin-unknown', 'sess-x');

    const result = await call({
      name: LINE_SEND_MEDIA_TOOL,
      sessionId: 'sess-x',
      args: { path: 'a.png' },
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('没有可用的发送通道');
  });
});
