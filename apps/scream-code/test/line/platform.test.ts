import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { FeishuClient, FeishuEventMessage } from '#/line/feishu/client';
import { normalizeReceiveEvent } from '#/line/feishu/client';
import {
  FeishuPlatform,
  UNAUTHORIZED_TEXT,
  allowListPasses,
  isBotMentioned,
  makeSessionKey,
  stripMentions,
  type LineDispatch,
} from '#/line/feishu/platform';
import type { FeishuRuntimeOptions } from '#/line/config';

function baseOptions(overrides: Partial<FeishuRuntimeOptions> = {}): FeishuRuntimeOptions {
  return {
    appId: 'cli_a',
    appSecret: 'sec',
    allowFrom: [],
    allowChat: [],
    groupOnly: false,
    requireMention: true,
    shareSessionInChannel: false,
    reactionEmoji: 'OnIt',
    doneEmoji: '',
    domain: 'https://open.feishu.cn',
    ...overrides,
  };
}

function msg(overrides: Partial<FeishuEventMessage> = {}): FeishuEventMessage {
  return {
    messageId: 'om_1',
    chatId: 'oc_chat',
    chatType: 'p2p',
    msgType: 'text',
    content: JSON.stringify({ text: 'hello' }),
    mentions: [],
    createTimeMs: Date.now(),
    senderUserId: 'ou_user',
    ...overrides,
  };
}

interface Harness {
  dispatched: LineDispatch[];
  client: {
    botOpenId: string | undefined;
    groupFilterActive: boolean;
    addReaction: ReturnType<typeof vi.fn>;
    removeReaction: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
    downloadImage: ReturnType<typeof vi.fn>;
    downloadResource: ReturnType<typeof vi.fn>;
    getMessage: ReturnType<typeof vi.fn>;
    uploadImage: ReturnType<typeof vi.fn>;
    uploadFile: ReturnType<typeof vi.fn>;
    sendToChat: ReturnType<typeof vi.fn>;
  };
  platform: FeishuPlatform;
}

function setup(
  optionOverrides: Partial<FeishuRuntimeOptions> = {},
  clientOverrides: Record<string, unknown> = {},
): Harness {
  const client = {
    botOpenId: 'bot_oid',
    groupFilterActive: true,
    addReaction: vi.fn(async () => 'reaction_1'),
    removeReaction: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    downloadImage: vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    downloadResource: vi.fn(async () => Buffer.from('file-bytes')),
    getMessage: vi.fn(async () => null),
    uploadImage: vi.fn(async () => 'img_key_1'),
    uploadFile: vi.fn(async () => 'file_key_1'),
    sendToChat: vi.fn(async () => {}),
    ...clientOverrides,
  };
  const dispatched: LineDispatch[] = [];
  const platform = new FeishuPlatform(
    client as unknown as FeishuClient,
    baseOptions(optionOverrides),
    async (d) => {
      dispatched.push(d);
    },
  );
  return { dispatched, client, platform };
}

describe('receive pipeline', () => {
  it('dispatches a plain p2p text message and adds the receipt reaction', async () => {
    const h = setup();
    await h.platform.handleEvent(msg());
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.text).toBe('hello');
    expect(h.client.addReaction).toHaveBeenCalledWith('om_1', 'OnIt');
  });

  it('drops duplicate message ids (at-least-once delivery)', async () => {
    const h = setup();
    await h.platform.handleEvent(msg());
    await h.platform.handleEvent(msg());
    expect(h.dispatched).toHaveLength(1);
    expect(h.client.addReaction).toHaveBeenCalledTimes(1);
  });

  it('drops messages created before the daemon started (replay guard)', async () => {
    const h = setup();
    await h.platform.handleEvent(msg({ createTimeMs: 1 }));
    expect(h.dispatched).toHaveLength(0);
  });

  it('drops group messages without @bot (fail-closed)', async () => {
    const h = setup();
    await h.platform.handleEvent(msg({ chatType: 'group' }));
    expect(h.dispatched).toHaveLength(0);
  });

  it('drops group messages even when mentioned while the filter is degraded (issue #1618)', async () => {
    const h = setup({}, { botOpenId: undefined, groupFilterActive: false });
    await h.platform.handleEvent(
      msg({ chatType: 'group', mentions: [{ key: '@_user_1', openId: 'bot_oid' }] }),
    );
    expect(h.dispatched).toHaveLength(0);
  });

  it('passes group messages that @bot the bot', async () => {
    const h = setup();
    await h.platform.handleEvent(
      msg({
        chatType: 'group',
        content: JSON.stringify({ text: '@_user_1 do it' }),
        mentions: [{ key: '@_user_1', openId: 'bot_oid' }],
      }),
    );
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.text).toBe('do it');
  });

  it('answers group messages without mention when require_mention is false', async () => {
    const h = setup({ requireMention: false });
    await h.platform.handleEvent(msg({ chatType: 'group' }));
    expect(h.dispatched).toHaveLength(1);
  });

  it('politely rejects unauthorized p2p users and never dispatches', async () => {
    const h = setup({ allowFrom: ['ou_allowed'] });
    await h.platform.handleEvent(msg({ senderUserId: 'ou_stranger' }));
    expect(h.dispatched).toHaveLength(0);
    expect(h.client.reply).toHaveBeenCalledTimes(1);
    expect(h.client.reply.mock.calls[0]?.[2]).toContain('allow_from');
    expect(JSON.parse(h.client.reply.mock.calls[0]?.[2] ?? '{}').text).toBe(UNAUTHORIZED_TEXT);
  });

  it('silently drops unauthorized group members (no reply flood)', async () => {
    const h = setup({ allowFrom: ['ou_allowed'], requireMention: false });
    await h.platform.handleEvent(msg({ chatType: 'group', senderUserId: 'ou_stranger' }));
    expect(h.dispatched).toHaveLength(0);
    expect(h.client.reply).not.toHaveBeenCalled();
  });

  it('silently drops groups outside allow_chat', async () => {
    const h = setup({ allowChat: ['oc_allowed'] });
    await h.platform.handleEvent(
      msg({
        chatType: 'group',
        chatId: 'oc_other',
        mentions: [{ key: '@_user_1', openId: 'bot_oid' }],
        content: JSON.stringify({ text: '@_user_1 hi' }),
      }),
    );
    expect(h.dispatched).toHaveLength(0);
    expect(h.client.reply).not.toHaveBeenCalled();
  });

  it('skips p2p when group_only is set', async () => {
    const h = setup({ groupOnly: true });
    await h.platform.handleEvent(msg());
    expect(h.dispatched).toHaveLength(0);
  });

  it('drops non-text message types in P1 (media is P2)', async () => {
    const h = setup();
    await h.platform.handleEvent(msg({ msgType: 'image', content: '{}' }));
    expect(h.dispatched).toHaveLength(0);
  });

  it('drops unparseable text content', async () => {
    const h = setup();
    await h.platform.handleEvent(msg({ content: 'not-json' }));
    expect(h.dispatched).toHaveLength(0);
  });

  it('strips the bot mention and keeps other @names as text', async () => {
    const h = setup();
    await h.platform.handleEvent(
      msg({
        content: JSON.stringify({ text: '@_user_1 ping @_user_2 please' }),
        mentions: [
          { key: '@_user_1', openId: 'bot_oid' },
          { key: '@_user_2', name: 'Alice' },
        ],
      }),
    );
    expect(h.dispatched[0]?.text).toBe('ping @Alice please');
  });
});

describe('finishMessage (receipt lifecycle)', () => {
  it('removes the receipt reaction and adds the done emoji', async () => {
    const h = setup({ doneEmoji: 'THUMBSUP' });
    await h.platform.handleEvent(msg());
    await h.platform.finishMessage('om_1');
    expect(h.client.removeReaction).toHaveBeenCalledWith('om_1', 'reaction_1');
    expect(h.client.addReaction).toHaveBeenLastCalledWith('om_1', 'THUMBSUP');
  });

  it('still adds the done emoji when no receipt reaction exists', async () => {
    const h = setup({ reactionEmoji: '', doneEmoji: 'THUMBSUP' });
    await h.platform.handleEvent(msg());
    await h.platform.finishMessage('om_1');
    expect(h.client.addReaction).toHaveBeenCalledTimes(1);
    expect(h.client.addReaction).toHaveBeenLastCalledWith('om_1', 'THUMBSUP');
  });
});

describe('session key derivation (port of makeSessionKey)', () => {
  it('isolates sessions per (chat, user) by default', () => {
    const a = makeSessionKey(msg({ chatId: 'oc_1', senderUserId: 'ou_1' }), false);
    const b = makeSessionKey(msg({ chatId: 'oc_1', senderUserId: 'ou_2' }), false);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^line-feishu-[0-9a-f]{16}$/);
  });

  it('is deterministic across calls', () => {
    const a = makeSessionKey(msg({ chatId: 'oc_1', senderUserId: 'ou_1' }), false);
    const b = makeSessionKey(msg({ chatId: 'oc_1', senderUserId: 'ou_1' }), false);
    expect(a).toBe(b);
  });

  it('shares one session per chat when share_session_in_channel is set', () => {
    const a = makeSessionKey(msg({ chatId: 'oc_1', senderUserId: 'ou_1' }), true);
    const b = makeSessionKey(msg({ chatId: 'oc_1', senderUserId: 'ou_2' }), true);
    expect(a).toBe(b);
  });
});

describe('normalizeReceiveEvent', () => {
  it('maps the raw im.message.receive_v1 payload', () => {
    const event = normalizeReceiveEvent({
      message: {
        message_id: 'om_9',
        chat_id: 'oc_9',
        chat_type: 'group',
        message_type: 'text',
        content: '{"text":"@_user_1 hi"}',
        mentions: [{ key: '@_user_1', id: { open_id: 'bot_oid' }, name: 'Bot' }],
        create_time: '1700000000000',
      },
      sender: { sender_id: { open_id: 'ou_9' } },
    });
    expect(event).toMatchObject({
      messageId: 'om_9',
      chatId: 'oc_9',
      chatType: 'group',
      msgType: 'text',
      createTimeMs: 1700000000000,
      senderUserId: 'ou_9',
    });
    expect(event?.mentions[0]).toEqual({ key: '@_user_1', openId: 'bot_oid', name: 'Bot' });
  });

  it('returns undefined for payloads without a message id', () => {
    expect(normalizeReceiveEvent({})).toBeUndefined();
  });
});

describe('helpers', () => {
  it('isBotMentioned requires the bot open id', () => {
    expect(isBotMentioned([{ key: '@x', openId: 'bot_oid' }], 'bot_oid')).toBe(true);
    expect(isBotMentioned([{ key: '@x', openId: 'other' }], 'bot_oid')).toBe(false);
    expect(isBotMentioned([{ key: '@x', openId: 'bot_oid' }], undefined)).toBe(false);
  });

  it('allowListPasses: empty list allows everyone', () => {
    expect(allowListPasses([], 'anyone')).toBe(true);
    expect(allowListPasses(['a'], 'a')).toBe(true);
    expect(allowListPasses(['a'], 'b')).toBe(false);
  });

  it('stripMentions removes bot mention keys and trims', () => {
    expect(stripMentions('@_u1  hello', [{ key: '@_u1', openId: 'bot' }], 'bot')).toBe('hello');
  });
});

describe('inbound media', () => {
  it('batches images that arrive together into one turn', async () => {
    vi.useFakeTimers();
    const { platform, dispatched } = setup();
    await platform.handleEvent(
      msg({ msgType: 'image', messageId: 'om_i1', content: JSON.stringify({ image_key: 'k1' }) }),
    );
    await platform.handleEvent(
      msg({ msgType: 'image', messageId: 'om_i2', content: JSON.stringify({ image_key: 'k2' }) }),
    );
    expect(dispatched).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(900);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.images).toHaveLength(2);
    // The batch is attributed to the newest image message.
    expect(dispatched[0]?.context.messageId).toBe('om_i2');
    platform.stop();
  });

  it('flushes a pending image batch before a following text message', async () => {
    vi.useFakeTimers();
    const { platform, dispatched } = setup();
    await platform.handleEvent(
      msg({ msgType: 'image', messageId: 'om_i1', content: JSON.stringify({ image_key: 'k1' }) }),
    );
    await platform.handleEvent(msg({ messageId: 'om_t', content: JSON.stringify({ text: '看图' }) }));

    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]?.images).toHaveLength(1);
    expect(dispatched[1]?.text).toBe('看图');
    platform.stop();
  });

  it('extracts text and inline images from a rich-text post', async () => {
    const { platform, dispatched, client } = setup();
    await platform.handleEvent(
      msg({
        msgType: 'post',
        messageId: 'om_post',
        content: JSON.stringify({
          title: '标题',
          content: [
            [{ tag: 'text', text: '第一段' }, { tag: 'img', image_key: 'pk1' }],
            [{ tag: 'a', text: '链接', href: 'https://example.com' }],
          ],
        }),
      }),
    );

    expect(client.downloadImage).toHaveBeenCalledTimes(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.text).toContain('标题');
    expect(dispatched[0]?.text).toContain('第一段');
    expect(dispatched[0]?.text).toContain('链接');
    expect(dispatched[0]?.images).toHaveLength(1);
  });

  it('saves a file under the Scream home and hands the path over', async () => {
    const { platform, dispatched, client } = setup();
    await platform.handleEvent(
      msg({
        msgType: 'file',
        messageId: 'om_file',
        content: JSON.stringify({ file_key: 'fk1', file_name: '../evil/报告.pdf' }),
      }),
    );

    expect(client.downloadResource).toHaveBeenCalledWith('om_file', 'fk1', 'file', expect.any(Number));
    expect(dispatched).toHaveLength(1);
    const path = dispatched[0]?.files?.[0] ?? '';
    // Sanitized name, and never inside the user's cwd.
    expect(path).toContain('/line/inbox/');
    expect(path.endsWith('-报告.pdf')).toBe(true);
    expect(path).not.toContain('evil/');
  });

  it('replies once when an image cannot be downloaded', async () => {
    const { platform, client } = setup({}, {
      downloadImage: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await platform.handleEvent(
      msg({ msgType: 'image', messageId: 'om_bad', content: JSON.stringify({ image_key: 'k' }) }),
    );
    expect(client.reply).toHaveBeenCalledTimes(1);
    // reply(messageId, msgType, body)
    const args = client.reply.mock.calls[0] as unknown[];
    expect(String(args[2])).toContain('图片下载失败');
  });

  it('stop() cancels a pending batch', async () => {
    vi.useFakeTimers();
    const { platform, dispatched } = setup();
    await platform.handleEvent(
      msg({ msgType: 'image', messageId: 'om_i9', content: JSON.stringify({ image_key: 'k9' }) }),
    );
    platform.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dispatched).toHaveLength(0);
  });
});

describe('outbound media', () => {
  it('uploads then posts an image to the chat that owns the session', async () => {
    const { platform, client } = setup();
    const internals = platform as unknown as { chatBySession: Map<string, string> };
    internals.chatBySession.set('line-feishu-x', 'oc_chat');

    const dir = mkdtempSync(join(tmpdir(), 'out-'));
    const file = join(dir, 'shot.png');
    writeFileSync(file, Buffer.from('png'));
    await platform.sendMedia('line-feishu-x', 'image', file);
    rmSync(dir, { recursive: true, force: true });

    expect(client.uploadImage).toHaveBeenCalledTimes(1);
    expect(client.sendToChat).toHaveBeenCalledWith('oc_chat', 'image', JSON.stringify({ image_key: 'img_key_1' }));
  });

  it('uploads files with the extension-derived file_type', async () => {
    const { platform, client } = setup();
    const internals = platform as unknown as { chatBySession: Map<string, string> };
    internals.chatBySession.set('k', 'oc_chat');
    const dir = mkdtempSync(join(tmpdir(), 'out-'));
    const file = join(dir, '报告.pdf');
    writeFileSync(file, Buffer.from('pdf'));

    await platform.sendMedia('k', 'file', file);
    rmSync(dir, { recursive: true, force: true });

    expect(client.uploadFile).toHaveBeenCalledWith(expect.any(Buffer), '报告.pdf', 'pdf');
    expect(client.sendToChat).toHaveBeenCalledWith('oc_chat', 'file', JSON.stringify({ file_key: 'file_key_1' }));
  });

  it('fails clearly when the chat is unknown (restart before any inbound)', async () => {
    const { platform } = setup();
    await expect(platform.sendMedia('unknown', 'image', '/tmp/x.png')).rejects.toThrow(/no chat recorded/);
  });
});

describe('quoted replies', () => {
  it('prefixes the quoted text and keeps the reply in order', async () => {
    const { platform, dispatched, client } = setup({}, {
      getMessage: vi.fn(async () => ({
        messageId: 'om_parent',
        msgType: 'text',
        content: JSON.stringify({ text: '原始问题是什么' }),
      })),
    });
    await platform.handleEvent(
      msg({ messageId: 'om_reply', parentId: 'om_parent', content: JSON.stringify({ text: '那再解释一下' }) }),
    );

    expect(client.getMessage).toHaveBeenCalledWith('om_parent');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.text).toBe('[引用: 原始问题是什么]\n那再解释一下');
  });

  it('pulls images carried by the quoted message', async () => {
    const { platform, dispatched } = setup({}, {
      getMessage: vi.fn(async () => ({
        messageId: 'om_parent',
        msgType: 'image',
        content: JSON.stringify({ image_key: 'quoted_key' }),
      })),
    });
    await platform.handleEvent(
      msg({ messageId: 'om_reply2', parentId: 'om_parent', content: JSON.stringify({ text: '这张图什么意思' }) }),
    );

    expect(dispatched[0]?.images).toHaveLength(1);
    expect(dispatched[0]?.text).toContain('这张图什么意思');
  });

  it('degrades to a plain reply when the parent cannot be fetched', async () => {
    const { platform, dispatched } = setup({}, {
      getMessage: vi.fn(async () => {
        throw new Error('message not found');
      }),
    });
    await platform.handleEvent(
      msg({ messageId: 'om_reply3', parentId: 'om_missing', content: JSON.stringify({ text: '还在吗' }) }),
    );

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.text).toBe('还在吗');
  });

  it('flattens a quoted rich-text post into one line', async () => {
    const { platform, dispatched } = setup({}, {
      getMessage: vi.fn(async () => ({
        messageId: 'om_parent',
        msgType: 'post',
        content: JSON.stringify({ title: '周报', content: [[{ tag: 'text', text: '第二段' }]] }),
      })),
    });
    await platform.handleEvent(
      msg({ messageId: 'om_reply4', parentId: 'om_parent', content: JSON.stringify({ text: '第三段呢' }) }),
    );

    expect(dispatched[0]?.text).toBe('[引用: 周报 第二段]\n第三段呢');
  });
});

describe('quoted replies with media', () => {
  it('keeps the quoted text when the reply itself is a photo (no batching)', async () => {
    const { platform, dispatched } = setup({}, {
      getMessage: vi.fn(async () => ({
        messageId: 'om_parent',
        msgType: 'text',
        senderId: 'ou_actor',
        content: JSON.stringify({ text: '这张图是什么' }),
      })),
    });
    await platform.handleEvent(
      msg({
        msgType: 'image',
        messageId: 'om_img_reply',
        parentId: 'om_parent',
        content: JSON.stringify({ image_key: 'k1' }),
      }),
    );

    // Dispatched immediately: a batch would send `text: ''` and lose the quote.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.text).toBe('[引用: 这张图是什么]\n');
    expect(dispatched[0]?.images).toHaveLength(1);
  });

  it('forwards a quoted file only when the quoting user sent it', async () => {
    const same = setup({}, {
      getMessage: vi.fn(async () => ({
        messageId: 'om_parent',
        msgType: 'file',
        senderId: 'ou_actor',
        content: JSON.stringify({ file_key: 'fk_quoted', file_name: 'a.pdf' }),
      })),
    });
    await same.platform.handleEvent(
      msg({
        messageId: 'om_reply_file',
        parentId: 'om_parent',
        senderUserId: 'ou_actor',
        content: JSON.stringify({ text: '这个文件呢' }),
      }),
    );
    expect(same.dispatched[0]?.files).toHaveLength(1);

    const other = setup({}, {
      getMessage: vi.fn(async () => ({
        messageId: 'om_parent',
        msgType: 'file',
        senderId: 'ou_someone_else',
        content: JSON.stringify({ file_key: 'fk_quoted', file_name: 'a.pdf' }),
      })),
    });
    await other.platform.handleEvent(
      msg({
        messageId: 'om_reply_file2',
        parentId: 'om_parent',
        senderUserId: 'ou_actor',
        content: JSON.stringify({ text: '这个文件呢' }),
      }),
    );
    // Different sender: the attachment never leaves the sandbox.
    expect(other.dispatched[0]?.files ?? []).toHaveLength(0);
    expect(other.dispatched[0]?.text).toContain('这个文件呢');
  });
});
