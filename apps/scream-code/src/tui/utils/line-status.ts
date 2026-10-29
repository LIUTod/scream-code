/**
 * Line daemon liveness check for the TUI footer (pidfile-based, mirrors
 * the channel-managed session guards for the same liveness semantics).
 */

import { readLineDaemonStatus } from '#/line/pidfile';

export async function checkLineDaemonActive(): Promise<boolean> {
  try {
    const status = await readLineDaemonStatus();
    return status.running;
  } catch {
    return false;
  }
}
