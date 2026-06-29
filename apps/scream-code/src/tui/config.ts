/**
 * TUI-owned configuration.
 *
 * Agent/runtime settings live in core's `config.toml`; this file owns only
 * terminal UI preferences for the scream-code client.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

import { getDataDir } from '#/utils/paths';

export const INVALID_TUI_CONFIG_MESSAGE =
  '~/.scream-code/tui.toml 中的 TUI 配置无效；使用默认配置。';

export const TuiThemeSchema = z.enum(['dark', 'light', 'auto']);

export const NotificationConditionSchema = z.enum(['unfocused', 'always']);

export const NotificationsConfigSchema = z.object({
  enabled: z.boolean(),
  condition: NotificationConditionSchema,
});
export const TuiLikePreferencesSchema = z.object({
  nickname: z.string().optional(),
  tone: z.string().optional(),
  other: z.string().optional(),
});

export type TuiLikePreferences = z.infer<typeof TuiLikePreferencesSchema>;

export const TuiConfigFileSchema = z.object({
  theme: TuiThemeSchema.optional(),
  editor: z
    .object({
      command: z.string().optional(),
    })
    .optional(),
  notifications: z
    .object({
      enabled: z.boolean().optional(),
      notification_condition: NotificationConditionSchema.optional(),
    })
    .optional(),
  like: TuiLikePreferencesSchema.optional(),
  fusionPlan: z
    .object({
      timeoutSeconds: z.number().int().min(30).max(3600).optional(),
      workerCount: z.number().int().min(1).max(8).optional(),
    })
    .optional(),
  subagentModels: z.record(z.string(), z.string()).optional(),
});

export const TuiConfigSchema = z.object({
  theme: TuiThemeSchema,
  editorCommand: z.string().nullable(),
  notifications: NotificationsConfigSchema,
  like: TuiLikePreferencesSchema,
  fusionPlan: z.object({
    timeoutSeconds: z.number().int().min(30).max(3600),
    workerCount: z.number().int().min(1).max(8),
  }),
  subagentModels: z.record(z.string(), z.string()),
});


export type TuiConfigFileShape = z.infer<typeof TuiConfigFileSchema>;
export type TuiConfig = z.infer<typeof TuiConfigSchema>;
export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;

export const DEFAULT_NOTIFICATIONS_CONFIG: NotificationsConfig = {
  enabled: true,
  condition: 'unfocused',
};
export const DEFAULT_TUI_CONFIG: TuiConfig = TuiConfigSchema.parse({
  theme: 'auto',
  editorCommand: null,
  notifications: DEFAULT_NOTIFICATIONS_CONFIG,
  like: {},
  fusionPlan: {
    timeoutSeconds: 600,
    workerCount: 3,
  },
  subagentModels: {},
});

/**
 * Thrown by `loadTuiConfig` when the on-disk TOML cannot be parsed.
 * Carries `fallback` so the caller can recover without re-running the
 * discovery code.
 */
export class TuiConfigParseError extends Error {
  override readonly name = 'TuiConfigParseError';
  readonly fallback: TuiConfig;
  constructor(fallback: TuiConfig) {
    super(INVALID_TUI_CONFIG_MESSAGE);
    this.fallback = fallback;
  }
}

export function getTuiConfigPath(): string {
  return join(getDataDir(), 'tui.toml');
}

export async function loadTuiConfig(filePath: string = getTuiConfigPath()): Promise<TuiConfig> {
  if (!existsSync(filePath)) {
    await saveTuiConfig(DEFAULT_TUI_CONFIG, filePath);
    return DEFAULT_TUI_CONFIG;
  }

  try {
    const text = await readFile(filePath, 'utf-8');
    return parseTuiConfig(text);
  } catch {
    throw new TuiConfigParseError(DEFAULT_TUI_CONFIG);
  }
}

export function parseTuiConfig(tomlText: string): TuiConfig {
  if (tomlText.trim().length === 0) {
    return DEFAULT_TUI_CONFIG;
  }
  const raw = parseToml(tomlText) as Record<string, unknown>;
  const parsed = TuiConfigFileSchema.parse(raw);
  return normalizeTuiConfig(parsed);
}

export async function saveTuiConfig(
  config: TuiConfig,
  filePath: string = getTuiConfigPath(),
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, renderTuiConfig(config), 'utf-8');
}

export function normalizeTuiConfig(config: TuiConfigFileShape): TuiConfig {
  const command = config.editor?.command?.trim();
  const like = config.like ?? {};
  const fusionPlan = config.fusionPlan ?? {};
  return TuiConfigSchema.parse({
    theme: config.theme ?? DEFAULT_TUI_CONFIG.theme,
    editorCommand: command === undefined || command.length === 0 ? null : command,
    notifications: {
      enabled: config.notifications?.enabled ?? DEFAULT_NOTIFICATIONS_CONFIG.enabled,
      condition:
        config.notifications?.notification_condition ?? DEFAULT_NOTIFICATIONS_CONFIG.condition,
    },
    like: {
      nickname: normalizeOptionalString(like.nickname),
      tone: normalizeOptionalString(like.tone),
      other: normalizeOptionalString(like.other),
    },
    fusionPlan: {
      timeoutSeconds: fusionPlan.timeoutSeconds ?? DEFAULT_TUI_CONFIG.fusionPlan.timeoutSeconds,
      workerCount: fusionPlan.workerCount ?? DEFAULT_TUI_CONFIG.fusionPlan.workerCount,
    },
    subagentModels: normalizeSubagentModels(config.subagentModels),
  });
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSubagentModels(
  raw: Record<string, string> | undefined,
): Record<string, string> {
  if (raw === undefined) return {};
  const out: Record<string, string> = {};
  for (const [profileName, alias] of Object.entries(raw)) {
    const key = profileName.trim();
    const val = typeof alias === 'string' ? alias.trim() : '';
    if (key.length > 0 && val.length > 0) out[key] = val;
  }
  return out;
}

export function renderTuiConfig(config: TuiConfig): string {
  const nickname = escapeTomlBasicString(config.like.nickname ?? '');
  const tone = escapeTomlBasicString(config.like.tone ?? '');
  const other = escapeTomlBasicString(config.like.other ?? '');
  const subagentModelsBlock = renderSubagentModelsBlock(config.subagentModels);
  return `# ~/.scream-code/tui.toml
# Terminal UI preferences for scream-code.
# Agent/runtime settings stay in ~/.scream-code/config.toml.

theme = "${config.theme}" # "auto" | "dark" | "light"

[editor]
command = "${escapeTomlBasicString(config.editorCommand ?? '')}" # Empty uses $VISUAL / $EDITOR

[notifications]
enabled = ${String(config.notifications.enabled)} # true | false
notification_condition = "${config.notifications.condition}" # "unfocused" | "always"

[like]
nickname = "${nickname}"
tone = "${tone}"
other = "${other}"

[fusionPlan]
timeoutSeconds = ${config.fusionPlan.timeoutSeconds} # 30..3600, default 600
workerCount = ${config.fusionPlan.workerCount} # 1..8, default 3${subagentModelsBlock}`;
}

function renderSubagentModelsBlock(models: Record<string, string>): string {
  const entries = Object.entries(models);
  if (entries.length === 0) return '\n';
  const lines = entries.map(
    ([name, alias]) => `${name} = "${escapeTomlBasicString(alias)}"`,
  );
  return `\n\n[subagentModels]\n${lines.join('\n')}\n`;
}

function escapeTomlBasicString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\b', '\\b')
    .replaceAll('\t', '\\t')
    .replaceAll('\n', '\\n')
    .replaceAll('\f', '\\f')
    .replaceAll('\r', '\\r');
}
