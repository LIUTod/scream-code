/**
 * Channel-managed sessions — sessions owned by an IM channel runtime rather
 * than the TUI. Two sources exist:
 *  - 'line'       — the /line native channel daemon (Feishu/Lark & WeChat)
 *  - 'cc-connect' — sessions driven by an independently installed external
 *                   channel daemon (legacy npm integration); it may still be
 *                   running on the machine, so its sessions keep the same
 *                   protections as line sessions.
 *
 * Channel sessions are channel-owned: they must not be deleted or batch-deleted
 * from the TUI (the daemon would recreate or hold them), and they carry a
 * platform badge in the picker.
 */

interface ChannelSessionMeta {
  source?: unknown;
  agentType?: unknown;
  platform?: unknown;
}

export function isChannelManagedSession(metadata: ChannelSessionMeta | undefined): boolean {
  return metadata?.source === 'line' || metadata?.source === 'cc-connect';
}

/** Badge text for channel sessions (undefined for normal sessions). */
export function channelSessionPlatform(metadata: ChannelSessionMeta | undefined): string | undefined {
  if (metadata?.source === 'line') {
    return typeof metadata.platform === 'string' && metadata.platform !== '' ? metadata.platform : 'line';
  }
  if (metadata?.source === 'cc-connect') {
    return typeof metadata.agentType === 'string' && metadata.agentType !== '' ? metadata.agentType : 'cc';
  }
  return undefined;
}
