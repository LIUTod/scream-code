/**
 * Feishu receive pipeline for the line daemon.
 *
 * Direct port of the reference `platform/feishu/feishu.go::onMessage`
 * (L1696-1894) plus `stripMentions`/`isBotMentioned`/`makeSessionKey`,
 * preserving the filter order: dedup → old-message drop (restart replay
 * guard) → group @mention filter (fail-closed even when the bot identity is
 * unknown, issue #1618) → allow_from (user whitelist, polite rejection when
 * directly addressed) → allow_chat (group whitelist, silent) → group_only →
 * mention stripping → receipt reaction → async dispatch.
 *
 * P1 deviations (documented): no recall tracking, no group history share,
 * text messages only (media types are logged and dropped — P2).
 */

import { createHash } from 'node:crypto';

import { log } from '@scream-code/scream-code-sdk';

import type { FeishuClient, FeishuEventMessage } from './client';
import { buildTextJSON } from './format';
import { MessageDedup } from '../dedup';
import type { FeishuRuntimeOptions } from '../config';

export interface LineDispatchContext {
  messageId: string;
  chatId: string;
  chatType: string;
  userId: string;
}

export interface LineDispatch {
  /** Scream session key (`line-feishu-<hash>`). */
  sessionKey: string;
  text: string;
  context: LineDispatchContext;
}

export const UNAUTHORIZED_TEXT =
  '抱歉，你还不在本机器人的授权名单中，无法使用。请联系机器人主人把你的用户 ID 加入 allow_from 白名单。';

// ─── Ports of the reference helpers ──────────────────────────────────────────

/** the reference isBotMentioned (L4013): any mention whose open_id is the bot. */
export function isBotMentioned(mentions: FeishuEventMessage['mentions'], botOpenId: string | undefined): boolean {
  if (!botOpenId) return false;
  return mentions.some((m) => m.openId !== undefined && m.openId === botOpenId);
}

/**
 * the reference stripMentions (L4146): the bot's own @mention is removed, other
 * @mentions become `@Name` so the agent keeps the reference.
 */
export function stripMentions(
  text: string,
  mentions: FeishuEventMessage['mentions'],
  botOpenId: string | undefined,
): string {
  if (mentions.length === 0) return text;
  for (const m of mentions) {
    if (!m.key) continue;
    if (botOpenId && m.openId && m.openId === botOpenId) {
      text = text.replaceAll(m.key, '');
    } else if (m.name) {
      text = text.replaceAll(m.key, `@${m.name}`);
    } else {
      text = text.replaceAll(m.key, '');
    }
  }
  return text.trim();
}

/** the reference allow-list semantics: empty list = allow everyone. */
export function allowListPasses(list: string[], value: string): boolean {
  if (list.length === 0) return true;
  return list.includes(value);
}

/** the reference makeSessionKey (L4167), then hashed into a scream session id. */
export function makeSessionKey(event: FeishuEventMessage, shareSessionInChannel: boolean): string {
  const ccKey = shareSessionInChannel
    ? `feishu:${event.chatId}`
    : `feishu:${event.chatId}:${event.senderUserId}`;
  const hash = createHash('sha1').update(ccKey).digest('hex').slice(0, 16);
  return `line-feishu-${hash}`;
}

// ─── Platform ─────────────────────────────────────────────────────────────

export class FeishuPlatform {
  private readonly dedup = new MessageDedup();
  /** Process start time — messages created earlier are dropped (replay guard). */
  private readonly startMs = Date.now();
  /** messageId → reaction id for the receipt emoji (removed on completion). */
  private readonly receipts = new Map<string, string>();

  constructor(
    private readonly client: FeishuClient,
    private readonly options: FeishuRuntimeOptions,
    private readonly dispatch: (message: LineDispatch) => Promise<void> | void,
  ) {}

  /** Inbound message entry point (wired to the WS event dispatcher). */
  async handleEvent(event: FeishuEventMessage): Promise<void> {
    // Dedup — Feishu delivery is at-least-once (the reference dedup.IsDuplicate).
    if (this.dedup.isDuplicate(event.messageId)) {
      log.debug('line: duplicate message ignored', { messageId: event.messageId });
      return;
    }
    // Old message after restart — the server replays unacked events.
    if (event.createTimeMs > 0 && event.createTimeMs < this.startMs) {
      log.debug('line: old message ignored after restart', { messageId: event.messageId });
      return;
    }

    const isGroup = event.chatType === 'group';
    const botMentioned = isBotMentioned(event.mentions, this.client.botOpenId);

    // Group @mention filter — fail-closed: when the bot identity is unknown
    // (degraded) group messages are dropped, never answered wholesale
    // (issue #1618 (fail-closed group filter)).
    if (isGroup && this.options.requireMention) {
      if (!this.client.groupFilterActive || !botMentioned) {
        log.debug('line: group message without bot mention (or filter degraded)', {
          chatId: event.chatId,
          messageId: event.messageId,
          filterActive: this.client.groupFilterActive,
        });
        return;
      }
    }

    // User whitelist — reply politely only when directly addressed.
    if (!allowListPasses(this.options.allowFrom, event.senderUserId)) {
      log.debug('line: message from unauthorized user', { userId: event.senderUserId });
      if (!isGroup || botMentioned) {
        await this.safeReply(event.messageId, buildTextJSON(UNAUTHORIZED_TEXT));
      }
      return;
    }

    // Group whitelist — silent drop (the reference behavior).
    if (isGroup && !allowListPasses(this.options.allowChat, event.chatId)) {
      log.debug('line: message from unauthorized chat', { chatId: event.chatId });
      return;
    }

    if (!isGroup && this.options.groupOnly) {
      log.debug('line: p2p message skipped (group_only)', { messageId: event.messageId });
      return;
    }

    // P1: text messages only. Media/post/interactive types are dropped with a
    // log entry (media support is P2).
    if (event.msgType !== 'text') {
      log.debug('line: unsupported message type dropped', { msgType: event.msgType, messageId: event.messageId });
      return;
    }

    let text = '';
    try {
      const parsed = JSON.parse(event.content) as { text?: string };
      text = typeof parsed.text === 'string' ? parsed.text : '';
    } catch {
      log.warn('line: unparseable text content', { messageId: event.messageId });
      return;
    }
    text = stripMentions(text, event.mentions, this.client.botOpenId);
    if (!text.trim()) {
      log.debug('line: empty text after mention stripping', { messageId: event.messageId });
      return;
    }

    // Receipt reaction — visible "on it" acknowledgement (the reference default
    // reaction_emoji = OnIt). Removed when the turn finishes.
    if (this.options.reactionEmoji) {
      const reactionId = await this.client.addReaction(event.messageId, this.options.reactionEmoji);
      if (reactionId) this.receipts.set(event.messageId, reactionId);
    }

    const sessionKey = makeSessionKey(event, this.options.shareSessionInChannel);
    log.debug('line: dispatching inbound message', {
      messageId: event.messageId,
      sessionKey,
      chatType: event.chatType,
    });
    await this.dispatch({
      sessionKey,
      text,
      context: {
        messageId: event.messageId,
        chatId: event.chatId,
        chatType: event.chatType,
        userId: event.senderUserId,
      },
    });
  }

  /** Turn finished: remove the receipt reaction, add the done emoji. */
  async finishMessage(messageId: string): Promise<void> {
    const reactionId = this.receipts.get(messageId);
    if (reactionId) {
      this.receipts.delete(messageId);
      await this.client.removeReaction(messageId, reactionId);
    }
    if (this.options.doneEmoji) {
      await this.client.addReaction(messageId, this.options.doneEmoji);
    }
  }

  private async safeReply(messageId: string, body: string): Promise<void> {
    try {
      await this.client.reply(messageId, 'text', body);
    } catch (error) {
      log.warn('line: reply failed', { messageId, error: String(error) });
    }
  }
}
