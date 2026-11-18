/**
 * Channel-managed sessions — sessions the /line channel daemon (Feishu/Lark
 * and WeChat) owns rather than the TUI.
 *
 * A channel session must not be opened, deleted or batch-deleted from the TUI:
 * the daemon holds it live and would recreate or keep writing it. It carries a
 * platform badge in the picker instead.
 */

interface ChannelSessionMeta {
  source?: unknown;
  platform?: unknown;
}

export function isChannelManagedSession(metadata: ChannelSessionMeta | undefined): boolean {
  return metadata?.source === 'line';
}

/**
 * A background task's run (see `host/job-runner.ts`). Its sessions are the
 * task's run history: listed under the task in `/jobs`, never in `/sessions`,
 * so a daily task does not bury the person's own conversations.
 */
export function isJobRunSession(metadata: ChannelSessionMeta | undefined): boolean {
  return metadata?.source === 'job';
}

/**
 * Whether `scream -C` ("continue the most recent session here") may pick this
 * session. Only the person's own conversations qualify: a channel session is
 * the daemon's (see above), so continuing it would open a session another
 * process is writing, and a task run is the task's.
 */
export function isContinuableSession(metadata: ChannelSessionMeta | undefined): boolean {
  return !isChannelManagedSession(metadata) && !isJobRunSession(metadata);
}

/** Badge text for channel sessions (undefined for normal sessions). */
export function channelSessionPlatform(metadata: ChannelSessionMeta | undefined): string | undefined {
  if (metadata?.source === 'line') {
    return typeof metadata.platform === 'string' && metadata.platform !== '' ? metadata.platform : 'line';
  }
  return undefined;
}
