/**
 * Line daemon liveness + configured-channel probe for the TUI footer
 * (lock- and config-based, mirrors the channel-managed session guards for
 * the same liveness semantics).
 */

import { loadLineConfig } from '#/line/config';
import { readHostStatus } from '#/host/control';

export type LinePlatform = 'lark' | 'wechat';

export interface LineFooterStatus {
  /** The daemon process is alive. */
  active: boolean;
  /** Configured channel (`null` = /line not configured). */
  platform: LinePlatform | null;
}

/** Platform block present in the line config, or `null` when unconfigured. */
export async function readLinePlatform(): Promise<LinePlatform | null> {
  try {
    const config = await loadLineConfig();
    if (config?.feishu !== undefined) return 'lark';
    if (config?.weixin !== undefined) return 'wechat';
    return null;
  } catch {
    // A corrupted config must never break footer rendering — the channel just
    // reads as unconfigured.
    return null;
  }
}

export async function checkLineDaemonActive(): Promise<boolean> {
  try {
    const status = await readHostStatus();
    return status.running;
  } catch {
    return false;
  }
}

export async function readLineFooterStatus(): Promise<LineFooterStatus> {
  const [active, platform] = await Promise.all([checkLineDaemonActive(), readLinePlatform()]);
  return { active, platform };
}
