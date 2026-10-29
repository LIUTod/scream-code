/**
 * Line daemon entry point (`scream line`).
 *
 * Boot sequence: load config → claim the pidfile (O_EXCL, no double daemon)
 * → init the session driver → start every configured platform (feishu WS
 * long connection, weixin ilink long-poll) independently. The daemon is
 * "up" when at least one platform is live; a platform failure is reported
 * and the remaining platforms keep serving.
 *
 * Per message: platform receive pipeline → session driver turn → reply
 * (feishu: text/post-md + receipt reactions; weixin: chunked text + typing
 * indicator) — all platform-specific behavior lives in the platform modules.
 */

import { open, readFile, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';

import { log } from '@scream-code/scream-code-sdk';

import {
  assertSinglePlatformConfig,
  getLinePidFile,
  loadLineConfig,
  resolveFeishuOptions,
  resolveWeixinOptions,
  type FeishuPlatformConfig,
  type WeixinPlatformConfig,
} from './config';
import { FeishuClient, FeishuCredentialError, validateFeishuCredentials } from './feishu/client';
import { buildReplyContent, truncateForLine } from './feishu/format';
import { FeishuPlatform } from './feishu/platform';
import { LineSessionDriver } from './session-driver';
import { WeixinClient, WeixinApiError, validateWeixinToken } from './weixin/client';
import { WeixinPlatform } from './weixin/platform';

const GROUP_FILTER_RETRY_INTERVAL_MS = 5 * 60 * 1000;
const SHUTDOWN_GRACE_MS = 10_000;

interface PlatformHandle {
  name: 'feishu' | 'weixin';
  close: () => Promise<void>;
}

function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

function err(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Run the daemon in the foreground; resolves on graceful shutdown. */
export async function runLineDaemon(): Promise<void> {
  const lineConfig = await loadLineConfig();
  if (!lineConfig) {
    err('未找到 line 配置（~/.scream-code/line/config.json）。请先在 scream 里运行 /line 完成配置向导。');
    process.exitCode = 2;
    return;
  }
  if (!lineConfig.feishu && !lineConfig.weixin) {
    err('line 配置中没有任何平台。请先在 scream 里运行 /line 完成配置向导（飞书或微信）。');
    process.exitCode = 2;
    return;
  }
  try {
    assertSinglePlatformConfig(lineConfig);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  // Claim the pidfile: O_EXCL create; tolerate a stale file from a crashed
  // predecessor, refuse when another daemon is genuinely running.
  if (!(await claimPidfile())) {
    err(`line 守护进程已在运行（pid 见 ${getLinePidFile()}）。`);
    process.exitCode = 1;
    return;
  }

  const driver = new LineSessionDriver({
    permissionMode: lineConfig.permissionMode,
    workDir: lineConfig.workDir,
    platform: lineConfig.feishu !== undefined ? 'feishu' : 'weixin',
  });

  const handles: PlatformHandle[] = [];
  const failures: string[] = [];

  let shuttingDown = false;
  function shutdownRun(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('line: shutting down', { signal });
    const forceTimer = setTimeout(() => {
      err(`line: shutdown exceeded ${SHUTDOWN_GRACE_MS / 1000}s, forcing exit`);
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceTimer.unref();
    void gracefulShutdown(handles, driver).finally(() => {
      clearTimeout(forceTimer);
      process.exit(0);
    });
  }
  // Uncaught exception: broken state — best-effort cleanup then a hard exit.
  function fatalExit(error: unknown): void {
    log.error('line: uncaught exception, exiting', { error: String(error) });
    // Broken state — skip the graceful wait (a session may be wedged),
    // clear the pidfile synchronously and exit.
    rmSync(getLinePidFile(), { force: true });
    process.exit(1);
  }
  process.on('SIGTERM', () => {
    shutdownRun('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdownRun('SIGINT');
  });
  process.on('uncaughtException', (error) => {
    fatalExit(error);
  });
  process.on('unhandledRejection', (reason) => {
    // A single failed turn must not kill the daemon (the reference parity).
    log.error('line: unhandled rejection (daemon keeps running)', { reason: String(reason) });
  });

  try {
    await driver.init();
  } catch (error) {
    err(`line 守护进程初始化失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    await gracefulShutdown(handles, driver);
    process.exit(1);
  }

  if (lineConfig.feishu) {
    try {
      handles.push(await startFeishu(lineConfig.feishu, driver));
    } catch (error) {
      failures.push(`飞书：${error instanceof FeishuCredentialError || error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (lineConfig.weixin) {
    try {
      handles.push(await startWeixin(lineConfig.weixin, driver));
    } catch (error) {
      failures.push(`微信：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const failure of failures) {
    err(`平台启动失败：${failure}`);
  }
  if (handles.length === 0) {
    err('所有平台启动失败，line 守护进程退出。');
    process.exitCode = 1;
    await gracefulShutdown(handles, driver);
    process.exit(1);
  }

  log.info('line: daemon started', {
    platforms: handles.map((h) => h.name),
    permissionMode: lineConfig.permissionMode,
    workDir: lineConfig.workDir ?? process.cwd(),
  });
  out(`line 守护进程已启动（${handles.map((h) => h.name).join(' + ')}）。按 Ctrl+C 退出。`);
  // Platform loops keep the event loop alive; park until shutdown.
  await new Promise<void>(() => {});
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
      const outcome = await driver.submit({ sessionKey: message.sessionKey, text: message.text });
      const outbound = buildReplyContent(truncateForLine(outcome.text));
      await client.reply(message.context.messageId, outbound.msgType, outbound.body);
    } catch (error) {
      log.error('line: feishu reply failed', { messageId: message.context.messageId, error: String(error) });
    }
    await platform.finishMessage(message.context.messageId).catch(() => {});
  });

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
    err('警告（飞书）：未能获取机器人 open_id，群聊消息过滤处于降级状态（群消息将被忽略），每 5 分钟自动重试。');
    scheduleGroupFilterSupervisor(client);
  } else {
    log.info('line: feishu bot identity fetched', { openId: client.botOpenId });
  }
  log.info('line: feishu platform started', { appId: options.appId, domain: options.domain });
  return {
    name: 'feishu',
    close: async () => {
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
    err('提示（微信）：token 有效但会话已过期——启动后用允许的微信账号给机器人发一条消息即可激活。');
  }

  const client = new WeixinClient(options);
  const platform = new WeixinPlatform(options, client, async (message) => {
    const stopTyping = platform.startTyping(message.context);
    try {
      const outcome = await driver.submit({ sessionKey: message.sessionKey, text: message.text });
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
    close: async () => {
      await platform.stop();
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Claim `daemon.pid` with O_EXCL; stale files are replaced, live daemons refuse. */
async function claimPidfile(): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = await open(getLinePidFile(), 'wx');
      await fd.write(`${process.pid}\n`, 0).catch(() => {});
      await fd.close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Existing pidfile — alive?
      const raw = (await readFile(getLinePidFile(), 'utf-8').catch(() => undefined)) ?? '';
      const pid = Number.parseInt(raw.trim(), 10);
      const alive = Number.isInteger(pid) && pid > 0 && isPidAlive(pid);
      if (alive) return false;
      // Stale — remove and retry once.
      await rm(getLinePidFile(), { force: true });
    }
  }
  return false;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

async function gracefulShutdown(handles: PlatformHandle[], driver: LineSessionDriver): Promise<void> {
  for (const handle of handles) {
    try {
      await handle.close();
    } catch {
      // best-effort
    }
  }
  try {
    await driver.close();
  } catch {
    // best-effort
  }
  await rm(getLinePidFile(), { force: true }).catch(() => {});
  log.info('line: daemon stopped');
}
