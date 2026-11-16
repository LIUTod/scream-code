import { formatTokenLimit } from '#/utils/usage/token-limit';
import { formatTokenCount } from '#/utils/usage/usage-format';

/**
 * Short receipts the IM channels send outside a turn's own reply.
 *
 * Kept apart from the routers so the wording has one home: the same sentence is
 * sent from the Feishu and WeChat paths, and both need to answer the two
 * questions a silent queue leaves open — "did you get my message" and "can I get
 * out of this".
 */

/**
 * Sent when a message had to wait behind a running turn.
 *
 * @param position how many turns are ahead of this message (1 = one running).
 */
export function queuedNotice(position: number): string {
  return `收到，前面还有 ${position} 条在处理中。回复 /stop 可中止当前任务。`;
}

/**
 * The reply when the session token limit stopped the turn before a model
 * request. An IM user cannot raise the limit (`/budget` is a TUI command), so
 * the way forward offered here is the one that is theirs: `/new`.
 */
export function tokenCapNotice(cap: { readonly usedTokens: number; readonly limitTokens: number }): string {
  return `本会话 token 用量已达上限（${formatTokenCount(cap.usedTokens)} / ${formatTokenLimit(cap.limitTokens)}），已停止调用模型。发送 /new 开启新会话即重新计算额度。`;
}

/**
 * The reply for a turn the limit cut short: whatever the model had already
 * written, then the notice. A multi-step turn can trip the limit after its first
 * step has produced text, and dropping that text would throw away work the user
 * already paid for (the step-budget cut keeps it too).
 */
export function tokenCapReply(
  partialText: string,
  cap: { readonly usedTokens: number; readonly limitTokens: number },
): string {
  const partial = partialText.trim();
  return partial.length > 0 ? `${partial}\n\n${tokenCapNotice(cap)}` : tokenCapNotice(cap);
}
