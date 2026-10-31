/**
 * Unsolicited delivery — the one capability scheduled tasks need.
 *
 * Every other message on a channel is a *reply*: it carries the inbound
 * message's context and the platform can route it. A fired cron task has no
 * inbound message, so the platform has to be told where the chat is from
 * memory instead. Both channels keep that memory already (Lark caches the
 * chat id per session, WeChat the peer and its context token); this type is
 * the shared answer shape so the driver never has to guess whether a send
 * worked.
 */

export type ProactiveDelivery =
  /** Handed to the platform and accepted. */
  | 'sent'
  /** No cached target yet — e.g. right after a restart, before any message. */
  | 'no-target'
  /** The platform rejected the send; the reason is logged by the platform. */
  | 'failed';
