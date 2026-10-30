import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getWeixinContextTokensFile, type WeixinRuntimeOptions } from '#/line/config';
import { WeixinApiError, type IlinkMessage } from '#/line/weixin/client';
import { encryptAesEcb } from '#/line/weixin/cdn';
import { FfmpegUnavailableError } from '#/line/weixin/voice';
import { MAX_WEIXIN_CHUNK } from '#/line/weixin/format';
import { WeixinPlatform, allowListPasses, makeWeixinSessionKey } from '#/line/weixin/platform';

const created: string[] = [];
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['SCREAM_CODE_HOME'];
  process.env['SCREAM_CODE_HOME'] = mkdtempSync(join(tmpdir(), 'line-wx-'));
  created.push(process.env['SCREAM_CODE_HOME']);
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['SCREAM_CODE_HOME'];
  else process.env['SCREAM_CODE_HOME'] = savedHome;
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function baseOptions(overrides: Partial<WeixinRuntimeOptions> = {}): WeixinRuntimeOptions {
  return {
    token: 'tok',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    allowFrom: [],
    routeTag: '',
    longPollTimeoutMs: 1000,
    dedupWindowMs: 300_000,
    ...overrides,
  };
}

interface MockClient {
  getConfig: ReturnType<typeof vi.fn>;
  sendText: ReturnType<typeof vi.fn>;
  sendTyping: ReturnType<typeof vi.fn>;
  newClientId: ReturnType<typeof vi.fn>;
  fetchCdnBytes: ReturnType<typeof vi.fn>;
  uploadMedia: ReturnType<typeof vi.fn>;
  sendMediaItem: ReturnType<typeof vi.fn>;
}

function setup(
  optionOverrides: Partial<WeixinRuntimeOptions> = {},
  clientOverrides: Partial<MockClient> = {},
): {
  platform: WeixinPlatform;
  dispatched: Array<{ sessionKey: string; text: string; images?: unknown[]; files?: string[] }>;
  client: MockClient;
} {
  const client: MockClient = {
    getConfig: vi.fn(async () => 'ticket1'),
    sendText: vi.fn(async () => {}),
    sendTyping: vi.fn(async () => {}),
    newClientId: vi.fn(() => 'line-deadbeef1234'),
    fetchCdnBytes: vi.fn(async () => Buffer.from('not-a-real-image')),
    uploadMedia: vi.fn(async () => ({
      downloadParam: 'dl-param',
      aesKey: Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
      cipherSize: 32,
      rawSize: 8,
    })),
    sendMediaItem: vi.fn(async () => {}),
    ...clientOverrides,
  };
  const dispatched: Array<{ sessionKey: string; text: string; images?: unknown[]; files?: string[] }> = [];
  const platform = new WeixinPlatform(
    baseOptions(optionOverrides),
    client as unknown as import('#/line/weixin/client').WeixinClient,
    async (d) => {
      dispatched.push({ sessionKey: d.sessionKey, text: d.text, images: d.images, files: d.files });
    },
  );
  return { platform, dispatched, client };
}

function msg(overrides: Partial<IlinkMessage> = {}): IlinkMessage {
  return {
    message_id: 101,
    seq: 1,
    from_user_id: 'user@im.wechat',
    message_type: 1,
    create_time_ms: Date.now(),
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
    context_token: 'ctx_1',
    ...overrides,
  };
}

function wxContext(): { peerUserId: string; contextToken: string; messageId: string; userId: string } {
  return { peerUserId: 'user@im.wechat', contextToken: 'ctx_1', messageId: '101', userId: 'user@im.wechat' };
}

describe('receive pipeline', () => {
  it('dispatches a plain inbound text message', async () => {
    const { platform, dispatched } = setup();
    await platform.dispatchInbound(msg());
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.text).toBe('hello');
    expect(dispatched[0]?.sessionKey).toMatch(/^line-weixin-[0-9a-f]{16}$/);
  });

  it('skips bot-echo and unknown message types', async () => {
    const { platform, dispatched } = setup();
    await platform.dispatchInbound(msg({ message_type: 2 }));
    await platform.dispatchInbound(msg({ message_type: 9 }));
    expect(dispatched).toHaveLength(0);
  });

  it('silently drops senders outside allow_from (no unauthorized reply)', async () => {
    const { platform, dispatched } = setup({ allowFrom: ['allowed@im.wechat'] });
    await platform.dispatchInbound(msg({ from_user_id: 'stranger@im.wechat' }));
    expect(dispatched).toHaveLength(0);
  });

  it('drops messages created before the daemon started (replay guard)', async () => {
    const { platform, dispatched } = setup();
    await platform.dispatchInbound(msg({ create_time_ms: 1 }));
    expect(dispatched).toHaveLength(0);
  });

  it('drops duplicate (from|id|seq|time|client) combos within the dedup window', async () => {
    const { platform, dispatched } = setup();
    const same = msg();
    await platform.dispatchInbound(same);
    await platform.dispatchInbound(same);
    expect(dispatched).toHaveLength(1);
  });

  it('persists the inbound context_token for replies (0600 cache)', async () => {
    const { platform } = setup();
    await platform.dispatchInbound(msg());
    const raw = readFileSync(getWeixinContextTokensFile(), 'utf-8');
    expect(JSON.parse(raw)).toEqual({ 'user@im.wechat': 'ctx_1' });
  });

  it('keeps voice ASR text and drops an empty media item silently', async () => {
    const { platform, dispatched } = setup();
    await platform.dispatchInbound(msg({ item_list: [{ type: 3, voice_item: { text: '语音内容' } }] }));
    await platform.dispatchInbound(msg({ item_list: [{ type: 2 }], message_id: 102, context_token: 'ctx_2' }));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.text).toBe('语音内容');
  });

  it('downloads, decrypts and forwards an inbound image', async () => {
    // 32 hex chars = raw 16-byte key, the shape inbound images use.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // The CDN body is AES-ECB encrypted with the item's key.
    const ciphertext = encryptAesEcb(png, Buffer.alloc(16));
    const { platform, dispatched, client } = setup({}, {
      fetchCdnBytes: vi.fn(async () => ciphertext),
    });
    await platform.dispatchInbound(
      msg({
        item_list: [
          {
            type: 2,
            image_item: { media: { encrypt_query_param: 'abc' }, aeskey: '00'.repeat(16) },
          },
        ],
        message_id: 103,
      }),
    );
    expect(client.fetchCdnBytes).toHaveBeenCalledTimes(1);
    expect(String((client.fetchCdnBytes.mock.calls[0] as unknown[])[0])).toContain(
      '/download?encrypted_query_param=abc',
    );
    // Decryption must actually run: same length but different bytes.
    const forwarded = dispatched[0]?.images?.[0] as { data: Buffer; mime: string } | undefined;
    expect(forwarded?.data.equals(png)).toBe(true);
    expect(forwarded?.mime).toBe('image/png');
  });

  it('answers once when a media-only message cannot be decoded', async () => {
    const { platform, client } = setup({}, {
      fetchCdnBytes: vi.fn(async () => {
        throw new Error('cdn down');
      }),
    });
    await platform.dispatchInbound(
      msg({
        item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'abc' }, aeskey: '00'.repeat(16) } }],
        message_id: 104,
      }),
    );
    const lastCall = client.sendText.mock.calls.at(-1) as unknown[];
    expect(String(lastCall[1])).toContain('媒体接收失败');
  });
});

describe('replyText (port of sendChunks)', () => {
  const longReply = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');

  it('sends long replies as balanced chunks with the stored context token', async () => {
    const { platform, client } = setup();
    await platform.dispatchInbound(msg()); // stores ctx_1 for the peer
    await platform.replyText({ peerUserId: 'user@im.wechat', contextToken: '', messageId: '101', userId: 'u' }, longReply);
    const callCount = client.sendText.mock.calls.length;
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(callCount).toBeLessThanOrEqual(Math.ceil(longReply.length / MAX_WEIXIN_CHUNK));
    const firstCall = client.sendText.mock.calls[0] as unknown[];
    expect(firstCall[0]).toBe('user@im.wechat');
    expect(firstCall[2]).toBe('ctx_1');
    for (const call of client.sendText.mock.calls) {
      expect(String((call as unknown[])[3])).toMatch(/^line-[0-9a-f]{12}$/);
    }
  });

  it('fails with a clear error when no context token is known', async () => {
    const { platform } = setup();
    await expect(
      platform.replyText({ peerUserId: 'unknown@im.wechat', contextToken: '', messageId: '1', userId: 'u' }, 'hi'),
    ).rejects.toThrow('context_token');
  });

  it('sends the partial-delivery notice on non-throttle failures, not on throttles', async () => {
    // Throttle (ret=-2) on the second chunk: no notice — sending more escalates.
    let throttledCalls = 0;
    const throttledSend = vi.fn(async (_to: string, _text: string) => {
      throttledCalls += 1;
      if (throttledCalls === 2) {
        throw new WeixinApiError('weixin: sendMessage: ret=-2', 'ret', -2);
      }
      return;
    });
    const throttled = setup({}, { sendText: throttledSend });
    await throttled.platform.dispatchInbound(msg());
    await expect(throttled.platform.replyText(wxContext(), longReply)).rejects.toThrow('ret=-2');
    expect(throttled.client.sendText).toHaveBeenCalledTimes(2); // chunk ok + throttled chunk, no notice

    // Plain failure on the second chunk: notice IS sent.
    let plainCalls = 0;
    const plainSend = vi.fn(async (_to: string, _text: string) => {
      plainCalls += 1;
      if (plainCalls === 2) throw new Error('boom');
      return;
    });
    const plain = setup({}, { sendText: plainSend });
    await plain.platform.dispatchInbound(msg());
    await expect(plain.platform.replyText(wxContext(), longReply)).rejects.toThrow('boom');
    expect(plain.client.sendText).toHaveBeenCalledTimes(3); // chunk + failed chunk + notice
    expect(String((plain.client.sendText.mock.calls[2] as unknown[])[1])).toContain('不完整');
  });
});

describe('typing lifecycle (port of StartTyping)', () => {
  it('uses a cached ticket and sends start/stop around the turn', async () => {
    vi.useFakeTimers();
    try {
      const { platform, client } = setup();
      await platform.dispatchInbound(msg()); // prefetch ticket (getConfig mocked)
      const stop = platform.startTyping({ peerUserId: 'user@im.wechat', contextToken: 'ctx_1', messageId: '101', userId: 'u' });
      await vi.advanceTimersByTimeAsync(0);
      expect(client.sendTyping).toHaveBeenCalledWith('user@im.wechat', 'ticket1', 1);
      stop();
      expect(client.sendTyping).toHaveBeenLastCalledWith('user@im.wechat', 'ticket1', 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is a no-op when getConfig yields no ticket', async () => {
    const { platform, client } = setup({}, { getConfig: vi.fn(async () => '') });
    const stop = platform.startTyping({ peerUserId: 'user@im.wechat', contextToken: 'ctx', messageId: '1', userId: 'u' });
    await Promise.resolve();
    stop();
    expect(client.sendTyping).not.toHaveBeenCalled();
  });
});

describe('session key derivation (port of weixin:dm:)', () => {
  it('one session per peer, deterministic and namespaced', () => {
    const a = makeWeixinSessionKey('u1@im.wechat');
    const b = makeWeixinSessionKey('u2@im.wechat');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^line-weixin-[0-9a-f]{16}$/);
    expect(makeWeixinSessionKey('u1@im.wechat')).toBe(a);
  });
});

describe('allowListPasses', () => {
  it('empty list allows everyone; non-empty filters', () => {
    expect(allowListPasses([], 'any@im.wechat')).toBe(true);
    expect(allowListPasses(['a@im.wechat'], 'a@im.wechat')).toBe(true);
    expect(allowListPasses(['a@im.wechat'], 'b@im.wechat')).toBe(false);
  });
});

describe('outbound media', () => {
  it('uploads an image and sends the exact ilink item payload', async () => {
    const { platform, client } = setup();
    const internals = platform as unknown as {
      latestTargets: Map<string, { peerUserId: string; contextToken: string }>;
    };
    internals.latestTargets.set('line-weixin-x', { peerUserId: 'peer', contextToken: 'ctx' });

    const dir = mkdtempSync(join(tmpdir(), 'out-'));
    const file = join(dir, 'shot.png');
    writeFileSync(file, Buffer.from('png'));
    await platform.sendMedia('line-weixin-x', 'image', file);
    rmSync(dir, { recursive: true, force: true });

    expect(client.uploadMedia).toHaveBeenCalledTimes(1);
    const uploadArgs = (client.uploadMedia.mock.calls[0] as unknown[])[0] as {
      mediaType: number;
      toUserId: string;
    };
    expect(uploadArgs.mediaType).toBe(1);
    expect(uploadArgs.toUserId).toBe('peer');

    const item = (client.sendMediaItem.mock.calls[0] as unknown[])[3] as {
      type: number;
      image_item: { media: { encrypt_query_param: string; aes_key: string; encrypt_type: number }; mid_size: number };
    };
    expect(item.type).toBe(2);
    expect(item.image_item.media.encrypt_query_param).toBe('dl-param');
    // base64 of the 32-char hex form, not of the raw bytes.
    expect(item.image_item.media.aes_key).toBe(
      Buffer.from('00112233445566778899aabbccddeeff', 'latin1').toString('base64'),
    );
    expect(item.image_item.media.encrypt_type).toBe(1);
    expect(item.image_item.mid_size).toBe(32);
  });

  it('sends non-image files as file items and mp4 as video', async () => {
    const { platform, client } = setup();
    const internals = platform as unknown as {
      latestTargets: Map<string, { peerUserId: string; contextToken: string }>;
    };
    internals.latestTargets.set('k', { peerUserId: 'peer', contextToken: 'ctx' });
    const dir = mkdtempSync(join(tmpdir(), 'out-'));
    const doc = join(dir, '报告.pdf');
    const video = join(dir, 'clip.mp4');
    writeFileSync(doc, Buffer.from('pdf'));
    writeFileSync(video, Buffer.from('mp4'));

    await platform.sendMedia('k', 'file', doc);
    await platform.sendMedia('k', 'file', video);
    rmSync(dir, { recursive: true, force: true });

    const fileItem = (client.sendMediaItem.mock.calls[0] as unknown[])[3] as {
      type: number;
      file_item: { file_name: string; len: string };
    };
    expect(fileItem.type).toBe(4);
    expect(fileItem.file_item.file_name).toBe('报告.pdf');
    expect(fileItem.file_item.len).toBe('8');

    const videoItem = (client.sendMediaItem.mock.calls[1] as unknown[])[3] as {
      type: number;
      video_item: { video_size: number };
    };
    expect(videoItem.type).toBe(5);
    expect(videoItem.video_item.video_size).toBe(32);
    expect((client.uploadMedia.mock.calls[1] as unknown[])[0]).toMatchObject({ mediaType: 2 });
  });
});

describe('voice outbound', () => {
  it('sends AMR audio as a voice bubble', async () => {
    const { platform, client } = setup();
    const internals = platform as unknown as {
      latestTargets: Map<string, { peerUserId: string; contextToken: string }>;
    };
    internals.latestTargets.set('k', { peerUserId: 'peer', contextToken: 'ctx' });
    const dir = mkdtempSync(join(tmpdir(), 'voice-'));
    const file = join(dir, 'note.amr');
    writeFileSync(file, Buffer.concat([Buffer.from('#!AMR\n', 'latin1'), Buffer.from([1, 2])]));

    const note = await platform.sendMedia('k', 'voice', file);
    rmSync(dir, { recursive: true, force: true });

    expect(note).toBe('');
    const upload = (client.uploadMedia.mock.calls[0] as unknown[])[0] as { mediaType: number };
    expect(upload.mediaType).toBe(3);
    const item = (client.sendMediaItem.mock.calls[0] as unknown[])[3] as {
      type: number;
      voice_item: { encode_type: number; media: { encrypt_type: number } };
    };
    expect(item.type).toBe(3);
    expect(item.voice_item.encode_type).toBe(0);
    expect(item.voice_item.media.encrypt_type).toBe(1);
  });

  it('falls back to a file message when ffmpeg cannot convert', async () => {
    const { platform, client } = setup();
    const internals = platform as unknown as {
      latestTargets: Map<string, { peerUserId: string; contextToken: string }>;
      convertVoiceToAmr(data: Buffer): Promise<Buffer>;
    };
    internals.latestTargets.set('k', { peerUserId: 'peer', contextToken: 'ctx' });
    internals.convertVoiceToAmr = async () => {
      throw new FfmpegUnavailableError();
    };
    const dir = mkdtempSync(join(tmpdir(), 'voice-'));
    const file = join(dir, 'note.wav');
    writeFileSync(file, Buffer.from('RIFF....WAVEfmt '));

    const note = await platform.sendMedia('k', 'voice', file);
    rmSync(dir, { recursive: true, force: true });

    expect(note).toContain('未转成语音');
    const item = (client.sendMediaItem.mock.calls[0] as unknown[])[3] as {
      type: number;
      file_item: { file_name: string };
    };
    expect(item.type).toBe(4);
    expect(item.file_item.file_name).toBe('note.wav');
  });
});
