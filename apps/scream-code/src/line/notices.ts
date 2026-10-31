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
