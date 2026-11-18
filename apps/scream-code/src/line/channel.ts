/**
 * The Feishu/WeChat chat channel inside the background host: build the
 * session driver for a channel config, start its platform, and wire the
 * driver's ways back to the chat (replies to scheduled tasks, media).
 *
 * Its log lines are Chinese like every other line-channel text: the channel
 * serves Chinese chat platforms.
 */

import { log, type ScreamHarness } from '@scream-code/scream-code-sdk';

import { hostErr, hostOut } from '#/host/log';

import {
  resolveCustomCommands,
  resolveFeishuOptions,
  resolveTurnTimeoutMs,
  resolveWeixinOptions,
  type FeishuPlatformConfig,
  type LineConfig,
  type WeixinPlatformConfig,
} from './config';
import { FeishuClient, FeishuCredentialError, validateFeishuCredentials } from './feishu/client';
import { buildReplyContent, truncateForLine } from './feishu/format';
import { FeishuPlatform } from './feishu/platform';
import { queuedNotice } from './notices';
import type { ProactiveDelivery } from './proactive';
import { LineSessionDriver } from './session-driver';
import { WeixinClient, WeixinApiError, validateWeixinToken } from './weixin/client';
import { WeixinPlatform } from './weixin/platform';

const GROUP_FILTER_RETRY_INTERVAL_MS = 5 * 60 * 1000;

/** The session driver for a channel config, sharing the host's harness. */
export function createChannelDriver(config: LineConfig, harness: ScreamHarness): LineSessionDriver {
  const resolvedWorkDir = config.workDir ?? process.cwd();
  if (config.workDir === undefined) {
    hostErr(`警告（line）：配置未设置 workDir，本次以启动目录作为工作目录：${resolvedWorkDir}（建议在 /line 向导里固定它）`);
  } else {
    hostOut(`工作目录：${resolvedWorkDir}`);
  }
  hostOut(`单轮上限：${Math.round(resolveTurnTimeoutMs(config) / 60_000)} 分钟（config.json 的 turnTimeoutMinutes）`);
  return new LineSessionDriver({
    harness,
    permissionMode: config.permissionMode,
    workDir: config.workDir,
    platform: config.feishu !== undefined ? 'feishu' : 'weixin',
    commands: resolveCustomCommands(config.commands),
    turnTimeoutMs: resolveTurnTimeoutMs(config),
  });
}

export interface PlatformHandle {
  name: 'feishu' | 'weixin';
  /** Unsolicited send, for scheduled tasks that have no inbound message. */
  sendProactive: (sessionKey: string, text: string) => Promise<ProactiveDelivery>;
  /** Upload + send an image/file; target resolved from the platform's cache. */
  sendMedia: (
    sessionKey: string,
    kind: 'image' | 'file' | 'voice',
    path: string,
  ) => Promise<string>;
  close: () => Promise<void>;
}

/** Start the configured platform and wire the driver's ways back to the chat. */
export async function startChannel(
  config: LineConfig,
  driver: LineSessionDriver,
  handles: PlatformHandle[],
  failures: string[],
): Promise<void> {
  try {
    await driver.init();
  } catch (error) {
    failures.push(`会话驱动：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  // Host capability probe: voice is the one path that depends on the local
  // ffmpeg build, and the answer belongs in `/status` rather than in a failed
  // send.
  await driver.probeVoice();

  if (config.feishu) {
    try {
      handles.push(await startFeishu(config.feishu, driver));
    } catch (error) {
      failures.push(`飞书：${error instanceof FeishuCredentialError || error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (config.weixin) {
    try {
      handles.push(await startWeixin(config.weixin, driver));
    } catch (error) {
      failures.push(`微信：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Scheduled tasks fire inside a session, not from an inbound message, so the
  // driver needs its own way back to the chat. Route by session-key prefix —
  // the keys are hashed, so the platform cannot be inferred from the chat id.
  const proactivePlatforms = new Map(handles.map((handle) => [handle.name, handle]));
  const platformOf = (sessionKey: string): PlatformHandle | undefined => {
    const name = sessionKey.startsWith('line-feishu-')
      ? 'feishu'
      : sessionKey.startsWith('line-weixin-')
        ? 'weixin'
        : undefined;
    return name === undefined ? undefined : proactivePlatforms.get(name);
  };
  driver.setProactiveSender(async (sessionKey, text) => {
    const platform = platformOf(sessionKey);
    if (platform === undefined) return 'no-target';
    return platform.sendProactive(sessionKey, text);
  });
  driver.setMediaSenderResolver((sessionKey) => {
    const platform = platformOf(sessionKey);
    if (platform === undefined) return undefined;
    return (kind, path) => platform.sendMedia(sessionKey, kind, path);
  });
}

// ─── Platform starters ────────────────────────────────────────────────────

async function startFeishu(cfg: FeishuPlatformConfig, driver: LineSessionDriver): Promise<PlatformHandle> {
  const options = resolveFeishuOptions(cfg);
  try {
    await validateFeishuCredentials(options.appId, options.appSecret, options.domain);
  } catch (error) {
    const message = error instanceof FeishuCredentialError ? error.message : String(error);
    throw new Error(`凭证校验失败：${message}`, { cause: error });
  }

  const client = new FeishuClient(options);
  const platform = new FeishuPlatform(client, options, async (message) => {
    try {
      // Outbound media from the model is routed back through this chat.
      driver.setMediaSender(message.sessionKey, (kind, path) =>
        platform.sendMedia(message.sessionKey, kind, path),
      );
      const outcome = await driver.submit({
        sessionKey: message.sessionKey,
        text: message.text,
        images: message.images,
        files: message.files,
        onQueued: (position) => {
          // A silent queue reads as a dead bot; one line buys the turn time.
          const notice = buildReplyContent(queuedNotice(position));
          void client
            .reply(message.context.messageId, notice.msgType, notice.body)
            .catch((error: unknown) => {
              log.warn('line: feishu queued notice failed', { error: String(error) });
            });
        },
      });
      if (outcome.silent === true) return;
      const outbound = buildReplyContent(truncateForLine(outcome.text));
      await client.reply(message.context.messageId, outbound.msgType, outbound.body);
    } catch (error) {
      log.error('line: feishu reply failed', { messageId: message.context.messageId, error: String(error) });
    } finally {
      // Must run on every path — including the `/stop` one that returns above —
      // or the "received" reaction stays on the message and its id stays in
      // `receipts` for the lifetime of the daemon.
      await platform.finishMessage(message.context.messageId).catch(() => {});
    }
  });

  // Before any event: a scheduled task resumed at boot may fire right away
  // and must already know which chat it reports to.
  await platform.loadChats();
  await client.connect(async (event) => {
    try {
      await platform.handleEvent(event);
    } catch (error) {
      log.error('line: handle feishu event failed', { messageId: event.messageId, error: String(error) });
    }
  });

  // Bot identity: required for the group mention filter. Fail-closed when
  // unreachable — supervised retry heals transient outages without a restart.
  const fetched = await client.fetchBotOpenId();
  if (!fetched) {
    hostErr('警告（飞书）：未能获取机器人 open_id，群聊消息过滤处于降级状态（群消息将被忽略），每 5 分钟自动重试。');
    scheduleGroupFilterSupervisor(client);
  } else {
    log.info('line: feishu bot identity fetched', { openId: client.botOpenId });
  }
  log.info('line: feishu platform started', { appId: options.appId, domain: options.domain });
  return {
    name: 'feishu',
    sendProactive: (sessionKey, text) => platform.sendProactive(sessionKey, text),
    sendMedia: (sessionKey, kind, path) => platform.sendMedia(sessionKey, kind, path),
    close: async () => {
      platform.stop();
      await client.close();
    },
  };
}

async function startWeixin(cfg: WeixinPlatformConfig, driver: LineSessionDriver): Promise<PlatformHandle> {
  const options = resolveWeixinOptions(cfg);
  const check = await validateWeixinToken(options).catch((error: unknown) => {
    throw new Error(
      `token 校验失败：${error instanceof WeixinApiError ? error.message : String(error)}`,
      { cause: error },
    );
  });
  if (check.sessionExpired) {
    hostErr('提示（微信）：token 有效但会话已过期——启动后用允许的微信账号给机器人发一条消息即可激活。');
  }

  const client = new WeixinClient(options);
  const platform = new WeixinPlatform(options, client, async (message) => {
    const stopTyping = platform.startTyping(message.context);
    try {
      driver.setMediaSender(message.sessionKey, (kind, path) =>
        platform.sendMedia(message.sessionKey, kind, path),
      );
      const outcome = await driver.submit({
        sessionKey: message.sessionKey,
        text: message.text,
        images: message.images,
        files: message.files,
        onQueued: (position) => {
          void platform.replyText(message.context, queuedNotice(position)).catch((error: unknown) => {
            log.warn('line: weixin queued notice failed', { error: String(error) });
          });
        },
      });
      if (outcome.silent === true) return;
      await platform.replyText(message.context, outcome.text);
    } catch (error) {
      log.error('line: weixin reply failed', { messageId: message.context.messageId, error: String(error) });
    } finally {
      stopTyping();
    }
  });
  await platform.start(() => {
    log.info('line: weixin platform ready (first getUpdates round-trip ok)', {});
  });
  log.info('line: weixin platform started', { baseUrl: options.baseUrl });
  return {
    name: 'weixin',
    sendProactive: (sessionKey, text) => platform.sendProactive(sessionKey, text),
    sendMedia: (sessionKey, kind, path) => platform.sendMedia(sessionKey, kind, path),
    close: async () => {
      await platform.stop();
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Supervised bot-identity retry while degraded (issue #1618 (fail-closed group filter)). */
function scheduleGroupFilterSupervisor(client: FeishuClient): void {
  const timer = setInterval(() => {
    void client
      .fetchBotOpenId()
      .then((ok) => {
        if (ok) {
          clearInterval(timer);
          log.info('line: bot identity recovered, group filter active', { openId: client.botOpenId });
        }
      })
      .catch(() => {});
  }, GROUP_FILTER_RETRY_INTERVAL_MS);
  timer.unref();
}
