/**
 * Line daemon configuration (`~/.scream-code/line/config.json`).
 *
 * Feishu option names mirror the reference (`app_id`, `allow_from`,
 * `require_mention`, …) so an existing the reference configuration can be
 * imported verbatim and behaves identically. Defaults follow the reference's
 * `newPlatform` (platform/feishu/feishu.go L334-518): receipt emoji defaults
 * to `OnIt`, done emoji is off by default, group messages require an @mention.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { getDataDir } from '#/utils/paths';

export const LINE_DIR_NAME = 'line';

export function getLineDir(): string {
  return join(getDataDir(), LINE_DIR_NAME);
}

export function getLineConfigPath(): string {
  return join(getLineDir(), 'config.json');
}

export function getLinePidFile(): string {
  return join(getLineDir(), 'daemon.pid');
}

export function getLineLogFile(): string {
  return join(getLineDir(), 'daemon.log');
}

/** Per-platform state dir for the weixin long-poll cursor and context tokens. */
export function getWeixinStateDir(): string {
  return join(getLineDir(), 'weixin');
}

export function getWeixinCursorFile(): string {
  return join(getWeixinStateDir(), 'get_updates.buf');
}

export function getWeixinContextTokensFile(): string {
  return join(getWeixinStateDir(), 'context_tokens.json');
}

// ─── Schema (option names aligned with the reference) ────────────────────────

const feishuPlatformSchema = z.object({
  /** Feishu app id (`cli_...`). */
  app_id: z.string().min(1),
  app_secret: z.string().min(1),
  /** Comma-separated user id whitelist. Empty/omitted = allow everyone (the reference parity). */
  allow_from: z.string().optional(),
  /** Comma-separated group chat id whitelist (groups only). */
  allow_chat: z.string().optional(),
  /** Only respond in group chats. */
  group_only: z.boolean().optional(),
  /**
   * Group messages require @bot (default true, fail-closed).
   * `require_mention: false` ≡ the reference's `group_reply_all: true`.
   */
  require_mention: z.boolean().optional(),
  /** One shared session per chat instead of per (chat, user) pair. */
  share_session_in_channel: z.boolean().optional(),
  /** Receipt emoji type, default `OnIt`; `none` disables. */
  reaction_emoji: z.string().optional(),
  /** Done emoji type, added on completion; default off; `none` also off. */
  done_emoji: z.string().optional(),
  /** Override API domain (e.g. Lark international `https://open.larksuite.com`). */
  domain: z.string().optional(),
});

const weixinPlatformSchema = z.object({
  /** ilink bot Bearer token (WeChat official bot gateway). */
  token: z.string().min(1),
  /** Override gateway root (default https://ilinkai.weixin.qq.com). */
  base_url: z.string().optional(),
  /** Comma-separated ilink user id whitelist (`xxx@im.wechat`). Empty = allow everyone. */
  allow_from: z.string().optional(),
  /** Optional `SKRouteTag` header (carrier requirement). */
  route_tag: z.string().optional(),
  long_poll_timeout_ms: z.number().int().positive().optional(),
  /** ilink retransmits on ACK delay — dedup window default 300s (the reference #1667). */
  dedup_window_seconds: z.number().int().positive().optional(),
});

export const lineConfigSchema = z.object({
  version: z.literal(1).default(1),
  feishu: feishuPlatformSchema.optional(),
  weixin: weixinPlatformSchema.optional(),
  /** Unattended permission mode for line sessions. */
  permissionMode: z.enum(['yolo', 'dontAsk']).default('yolo'),
  /** TUI boot auto-starts the daemon when configured and not running. */
  autoStart: z.boolean().default(true),
  /** Working directory for line sessions (default: daemon start cwd). */
  workDir: z.string().optional(),
});

export type LineConfig = z.infer<typeof lineConfigSchema>;
export type FeishuPlatformConfig = NonNullable<LineConfig['feishu']>;
export type WeixinPlatformConfig = NonNullable<LineConfig['weixin']>;

export class LineConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LineConfigError';
  }
}

// ─── Load / save ──────────────────────────────────────────────────────────

/** Load config; `null` when no config file exists (feature not configured). */
export async function loadLineConfig(): Promise<LineConfig | null> {
  let raw: string;
  try {
    raw = await readFile(getLineConfigPath(), 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new LineConfigError(
      `line 配置文件损坏（${getLineConfigPath()}）：${error instanceof Error ? error.message : String(error)}。修复或删除该文件后重试。`,
    );
  }
  const result = lineConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new LineConfigError(`line 配置不合法（${getLineConfigPath()}）：${issues}`);
  }
  return result.data;
}

/**
 * Single-channel invariant: `/line` serves exactly one platform at a time.
 * Both blocks present is a hand-edited-config error — refuse loudly instead
 * of silently running two channels.
 */
export function assertSinglePlatformConfig(config: LineConfig): void {
  if (config.feishu !== undefined && config.weixin !== undefined) {
    throw new LineConfigError(
      'line 单通道约束：配置同时包含飞书与微信。请运行 /line → 卸载，清除后再选择一个通道重新配置。',
    );
  }
}

/** Persist config with 0600 (contains app_secret). Atomic-ish: write + rename. */
export async function saveLineConfig(config: LineConfig): Promise<void> {
  const dir = getLineDir();
  await mkdir(dir, { recursive: true });
  const target = getLineConfigPath();
  const tmp = `${target}.tmp`;
  const body = JSON.stringify(config, null, 2) + '\n';
  await writeFile(tmp, body, { encoding: 'utf-8' });
  await chmod(tmp, 0o600);
  await rename(tmp, target);
}

/** Remove the whole line data directory (uninstall). */
export async function removeLineDir(): Promise<void> {
  await rm(getLineDir(), { recursive: true, force: true });
}

// ─── Resolved runtime options (the reference defaults applied) ───────────────

export interface FeishuRuntimeOptions {
  appId: string;
  appSecret: string;
  allowFrom: string[];
  allowChat: string[];
  groupOnly: boolean;
  /** Group messages require @bot (fail-closed default). */
  requireMention: boolean;
  shareSessionInChannel: boolean;
  /** Receipt emoji type ('' = disabled). */
  reactionEmoji: string;
  /** Done emoji type ('' = disabled). */
  doneEmoji: string;
  domain: string;
}

export const DEFAULT_FEISHU_DOMAIN = 'https://open.feishu.cn';

/** Apply the reference `newPlatform` defaults on top of the stored options. */
export function resolveFeishuOptions(cfg: FeishuPlatformConfig): FeishuRuntimeOptions {
  const reactionRaw = cfg.reaction_emoji?.trim() ?? '';
  const doneRaw = cfg.done_emoji?.trim() ?? '';
  return {
    appId: cfg.app_id,
    appSecret: cfg.app_secret,
    allowFrom: splitAllowList(cfg.allow_from),
    allowChat: splitAllowList(cfg.allow_chat),
    groupOnly: cfg.group_only ?? false,
    requireMention: cfg.require_mention ?? true,
    shareSessionInChannel: cfg.share_session_in_channel ?? false,
    reactionEmoji: reactionRaw.toLowerCase() === 'none' ? '' : reactionRaw !== '' ? reactionRaw : 'OnIt',
    doneEmoji: doneRaw.toLowerCase() === 'none' ? '' : doneRaw,
    domain: cfg.domain?.trim() !== '' && cfg.domain !== undefined ? cfg.domain.trim() : DEFAULT_FEISHU_DOMAIN,
  };
}

function splitAllowList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

// ─── Weixin runtime options (the reference newPlatform defaults applied) ─────

export interface WeixinRuntimeOptions {
  token: string;
  baseUrl: string;
  allowFrom: string[];
  routeTag: string;
  longPollTimeoutMs: number;
  dedupWindowMs: number;
}

export const DEFAULT_WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const DEFAULT_WEIXIN_LONG_POLL_MS = 35_000;
export const DEFAULT_WEIXIN_DEDUP_WINDOW_MS = 300_000;

/** Apply the reference `New` defaults on top of the stored weixin options. */
export function resolveWeixinOptions(cfg: WeixinPlatformConfig): WeixinRuntimeOptions {
  return {
    token: cfg.token,
    baseUrl:
      cfg.base_url !== undefined && cfg.base_url.trim().replace(/\/+$/, '') !== ''
        ? cfg.base_url.trim().replace(/\/+$/, '')
        : DEFAULT_WEIXIN_BASE_URL,
    allowFrom: splitAllowList(cfg.allow_from),
    routeTag: cfg.route_tag?.trim() ?? '',
    longPollTimeoutMs: cfg.long_poll_timeout_ms ?? DEFAULT_WEIXIN_LONG_POLL_MS,
    dedupWindowMs:
      (cfg.dedup_window_seconds ?? 0) > 0
        ? (cfg.dedup_window_seconds as number) * 1000
        : DEFAULT_WEIXIN_DEDUP_WINDOW_MS,
  };
}
