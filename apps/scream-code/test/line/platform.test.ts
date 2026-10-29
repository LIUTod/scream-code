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
  };
  platform: FeishuPlatform;
}

function setup(
  optionOverrides: Partial<FeishuRuntimeOptions> = {},
  clientOverrides: { botOpenId?: string; groupFilterActive?: boolean } = {},
): Harness {
  const client = {
    botOpenId: 'bot_oid',
    groupFilterActive: true,
    addReaction: vi.fn(async () => 'reaction_1'),
    removeReaction: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
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
