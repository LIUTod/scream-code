/**
 * /cc-connect slash command — interactive cc-connect platform config.
 *
 * Typing /cc-connect opens a scrollable platform picker list. Select one,
 * config is auto-generated (correct scream path + work_dir), and the
 * next terminal commands are shown.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

import { t } from '@scream-code/config';

import { ChoicePickerComponent, type ChoiceOption } from "../components/dialogs/choice-picker";
import type { SlashCommandHost } from "./dispatch";
import { getDaemonInstructions } from "../../cli/cc-connect-daemon";

// ─── Platform definitions ──────────────────────────────────────────────────

interface PlatformDef {
  name: string;
  type: string;
  setupCmd: string;
  note?: string;
}

export function getPlatforms(): PlatformDef[] {
  return [
    { name: "微信", type: "weixin", setupCmd: "weixin setup --project default" },
    { name: "飞书", type: "feishu", setupCmd: "feishu setup --project default" },
    { name: "Telegram", type: "telegram", setupCmd: "telegram setup --project default", note: t('ccconnect.note_botfather') },
    { name: "钉钉", type: "dingtalk", setupCmd: "dingtalk setup --project default" },
    { name: "Discord", type: "discord", setupCmd: "discord setup --project default" },
    { name: "Slack", type: "slack", setupCmd: "slack setup --project default" },
    { name: "QQ", type: "qq", setupCmd: "qq setup --project default", note: t('ccconnect.note_napcat') },
    { name: "企业微信", type: "wecom", setupCmd: "wecom setup --project default", note: t('ccconnect.note_wecom') },
    { name: "QQ 官方 bot", type: "qqbot", setupCmd: "qqbot setup --project default" },
    { name: "LINE", type: "line", setupCmd: "line setup --project default" },
    { name: "微博", type: "weibo", setupCmd: "weibo setup --project default" },
    { name: "WPS 协作", type: "wps-xiezuo", setupCmd: "wps-xiezuo setup --project default" },
    { name: "Matrix", type: "matrix", setupCmd: "matrix setup --project default", note: t('ccconnect.note_matrix') },
    { name: "Cisco Webex", type: "webex", setupCmd: "webex setup --project default", note: t('ccconnect.note_webex') },
    { name: "MAX", type: "max", setupCmd: "max setup --project default", note: t('ccconnect.note_max') },
    { name: "Google Chat", type: "googlechat", setupCmd: "googlechat setup --project default", note: t('ccconnect.note_googlechat') },
    { name: "Cloud Web", type: "cloud_web", setupCmd: "cloud_web setup --project default", note: t('ccconnect.note_cloud_web') },
    { name: "腾讯元宝", type: "yuanbao", setupCmd: "yuanbao setup --project default", note: t('ccconnect.note_yuanbao') },
    { name: "Tuitui", type: "tuitui", setupCmd: "tuitui setup --project default", note: t('ccconnect.note_tuitui') },
    { name: "WPS 数字员工", type: "wps-agentspace", setupCmd: "wps-agentspace setup --project default", note: t('ccconnect.note_wps_agentspace') },
  ];
}

/**
 * Platform types introduced by cc-connect v1.4/v1.5. Older cc-connect
 * binaries do not recognise these, so the post-config notice tells the user
 * to update cc-connect first.
 */
const NEW_PLATFORM_TYPES = new Set([
  "matrix",
  "webex",
  "max",
  "googlechat",
  "cloud_web",
  "yuanbao",
  "tuitui",
  "wps-agentspace",
]);

const CONFIG_PATH = join(homedir(), ".cc-connect", "config.toml");

// ─── Helpers ───────────────────────────────────────────────────────────────

function checkCcConnect(): { installed: boolean; version?: string } {
  try {
    const out = execSync("cc-connect --version 2>&1", { encoding: "utf-8", timeout: 5000 });
    const match = out.match(/v(\d+\.\d+\.\d+)/);
    return { installed: true, version: match?.[1] ?? "" };
  } catch {
    return { installed: false };
  }
}

/** Auto-detect the path to the scream binary, including the stream-json subcommand. */
function detectScreamPath(): string {
  // 1. Running as a bundled binary (process.execPath is the binary itself)
  const execBase = process.execPath.toLowerCase();
  if (execBase.endsWith("/scream") || execBase.endsWith("\\scream") || execBase.endsWith("scream.exe")) {
    return `${quoteShellPath(process.execPath)} stream-json`;
  }

  // 2. Running from the monorepo dist via node
  if (execBase.includes("node") && process.argv[1]) {
    const arg1 = process.argv[1];
    if (arg1.includes("scream-code") || arg1.includes("scream")) {
      return `node ${quoteShellPath(arg1)} stream-json`;
    }
  }

  // 3. scream on PATH
  try {
    const cmd = process.platform === "win32" ? "where scream" : "which scream 2>/dev/null";
    const which = execSync(cmd, { encoding: "utf-8", timeout: 3000 }).trim();
    // Windows `where` can return multiple matches (one per line).
    // TOML strings must be single-line, so take only the first match.
    const first = which.split(/[\r\n]+/)[0]?.trim() ?? "";
    if (first) return `${quoteShellPath(first)} stream-json`;
  } catch { /* not found */ }

  // 4. Fallback
  return "scream stream-json";
}

/**
 * Double-quote a path for shell parsing. cc-connect runs `cmd` through a
 * shell, so an unquoted path containing spaces would be split apart.
 */
export function quoteShellPath(path: string): string {
  return `"${path.replaceAll(/"/g, '\\"')}"`;
}

/** Parse every configured platform type from config.toml content. */
export function parseConfiguredTypes(content: string): string[] {
  const types: string[] = [];
  let inPlatforms = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Allow a trailing comment after the section header.
    if (trimmed.startsWith("[[projects.platforms]]")) {
      inPlatforms = true;
      continue;
    }
    if (trimmed.startsWith("[")) {
      inPlatforms = false;
      continue;
    }
    if (inPlatforms) {
      // TOML allows both basic ("...") and literal ('...') strings.
      const m = trimmed.match(/^type\s*=\s*["']([^"']+)["']/);
      if (m?.[1]) types.push(m[1]);
    }
  }
  return types;
}

function readConfiguredTypes(): string[] {
  if (!existsSync(CONFIG_PATH)) return [];
  try {
    return parseConfiguredTypes(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return [];
  }
}

/** True when config content already has an active (non-comment) platform of this type. */
export function hasPlatformConfigured(content: string, type: string): boolean {
  const escaped = type.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Anchored to line start so commented-out lines (`# type = "..."`) never match;
  // no end anchor so a trailing comment after the value still counts as configured.
  return new RegExp(`^\\s*type\\s*=\\s*["']${escaped}["']`, "m").test(content);
}

/** Minimal semver-ish check: "1.5.0" >= "1.5.0". */
export function isVersionAtLeast(version: string | undefined, min: string): boolean {
  if (!version) return false;
  const parse = (v: string): number[] => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [a = 0, b = 0, c = 0] = parse(version);
  const [x = 0, y = 0, z = 0] = parse(min);
  return a > x || (a === x && (b > y || (b === y && c >= z)));
}

/**
 * Quote a value for TOML. Literal strings ('...') cannot contain a single
 * quote at all (no escape mechanism), so values with one fall back to a
 * basic string ("...") where backslash and double-quote are escaped.
 */
export function tomlString(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replaceAll(/\\/g, "\\\\").replaceAll(/"/g, '\\"')}"`;
}

function generateConfig(platform: PlatformDef): void {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const platformBlock = `\n[[projects.platforms]]\ntype = "${platform.type}"\n`;

  // If config already exists, append the new platform instead of overwriting.
  if (existsSync(CONFIG_PATH)) {
    const existing = readFileSync(CONFIG_PATH, "utf-8");
    if (hasPlatformConfigured(existing, platform.type)) {
      // Same platform already configured — nothing to do.
      return;
    }
    writeFileSync(CONFIG_PATH, existing + platformBlock, "utf-8");
    return;
  }

  // Fresh config file
  const content = buildConfigContent(platform, detectScreamPath(), process.cwd());

  writeFileSync(CONFIG_PATH, content, "utf-8");
}

/** Build the full config.toml content for a fresh setup. */
export function buildConfigContent(platform: PlatformDef, screamCmd: string, cwd: string): string {
  return [
    t('ccconnect.config_comment_attachment'),
    'attachment_send = "on"',
    '',
    '[[projects]]',
    'name = "default"',
    '',
    '[projects.agent]',
    'type = "claudecode"',
    '',
    '[projects.agent.options]',
    `cmd = ${tomlString(screamCmd)}`,
    `work_dir = ${tomlString(cwd)}`,
    // Remote chat cannot confirm tool calls interactively — default to auto.
    '# Permission mode: default (confirm each tool) | acceptEdits | plan | auto | bypassPermissions (yolo) | dontAsk',
    'mode = "auto"',
    '',
    '[[projects.platforms]]',
    `type = "${platform.type}"`,
    '',
  ].join("\n");
}

// ─── Notice builders ────────────────────────────────────────────────────────

const SEP = "──".repeat(20);

/**
 * Build the full notice text shown after platform selection.
 * Common management commands come first; detailed setup steps follow.
 */
function buildNoticeText(
  platform: PlatformDef,
  isReconfigure: boolean,
  installedVersion?: string,
): string {
  const configDir = dirname(CONFIG_PATH);
  const daemon = getDaemonInstructions(configDir);

  const parts: string[] = [];

  // ── Header ──
  if (isReconfigure) {
    parts.push(t('ccconnect.reconfigured', { name: platform.name }));
    parts.push("");
    parts.push(t('ccconnect.config_path', { path: CONFIG_PATH }));
  } else {
    parts.push(t('ccconnect.config_done', { name: platform.name }));
    parts.push("");
    parts.push(t('ccconnect.config_written', { path: CONFIG_PATH }));
  }

  // Newer platforms only exist in recent cc-connect releases; skip the hint
  // when the installed cc-connect is already new enough.
  if (NEW_PLATFORM_TYPES.has(platform.type) && !isVersionAtLeast(installedVersion, "1.5.0")) {
    parts.push("");
    parts.push(t('ccconnect.new_platform_version_hint'));
  }

  // ── Quick Reference (front & center) ──
  parts.push("");
  parts.push(t('ccconnect.quick_ref'));
  parts.push("");
  parts.push(t('ccconnect.pm2_status'));
  parts.push(t('ccconnect.pm2_restart'));
  parts.push(t('ccconnect.pm2_stop'));
  parts.push(t('ccconnect.pm2_logs'));
  parts.push(t('ccconnect.pm2_delete'));
  if (isReconfigure) {
    parts.push("");
    parts.push(t('ccconnect.reconfigure_warning'));
    parts.push(t('ccconnect.reconfigure_change'));
  }

  // ── Detailed setup steps ──
  parts.push("");
  parts.push(SEP);
  parts.push("");
  parts.push(t('ccconnect.init_steps'));
  parts.push("");

  // Step 1: Platform auth
  const noteTag = platform.note ? `（${platform.note}）` : "";
  parts.push(t('ccconnect.step_platform_auth', { note: noteTag }));
  parts.push(`    cc-connect ${platform.setupCmd}`);
  parts.push("");

  // Step 2+: Daemon steps
  if (daemon.warning) {
    parts.push(`  ⚠ ${daemon.warning}`);
    parts.push("");
  }
  let stepNum = 2;
  for (const step of daemon.steps) {
    const onceTag = step.once ? t('ccconnect.once_tag') : "";
    const isAutoDone = step.command.includes("cc-connect-startup.bat");
    parts.push(t('ccconnect.step_n', { num: stepNum, label: step.label, once: onceTag }));
    if (isAutoDone) {
      // Bat file already written by ScreamCode — not a command to run.
      parts.push(t('ccconnect.auto_done', { command: step.command }));
    } else {
      parts.push(`    ${step.command}`);
    }
    stepNum++;
  }

  // ── Help ──
  parts.push("");
  parts.push(SEP);
  parts.push("");
  parts.push(t('ccconnect.more_commands', { method: daemon.method }));
  for (const cmd of daemon.helpCommands) {
    parts.push(`  ${cmd}`);
  }

  parts.push("");
  parts.push(t('ccconnect.attachment_hint'));
  parts.push(t('ccconnect.bind_setup'));
  parts.push("");
  parts.push(t('ccconnect.autostart_hint'));
  parts.push(t('ccconnect.manual_restart'));

  return parts.join("\n");
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleChannelCommand(host: SlashCommandHost, _args: string): Promise<void> {
  const cc = checkCcConnect();
  if (!cc.installed) {
    host.showNotice(
      t('ccconnect.not_installed'),
      t('ccconnect.install_guide'),
    );
    return;
  }

  const configuredTypes = readConfiguredTypes();

  const options: ChoiceOption[] = getPlatforms().map((p) => {
    const isConfigured = configuredTypes.includes(p.type);
    return {
      value: p.type,
      label: isConfigured ? t('ccconnect.already_configured', { name: p.name }) : p.name,
      description: p.note,
    };
  });

  const picker = new ChoicePickerComponent({
    title: t('ccconnect.picker_title'),
    hint: t('ccconnect.picker_hint'),
    options,
    currentValue: configuredTypes[0],
    colors: host.state.theme.colors,
    onSelect: (value: string) => {
      host.restoreEditor();

      const platform = getPlatforms().find((p) => p.type === value);
      if (!platform) {
        host.showError(t('error.internal'));
        return;
      }

      if (configuredTypes.includes(value)) {
        host.showNotice(t('ccconnect.reconfigured', { name: platform.name }), buildNoticeText(platform, true, cc.version));
        return;
      }

      generateConfig(platform);
      host.showNotice(t('ccconnect.config_done', { name: platform.name }), buildNoticeText(platform, false, cc.version));
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });

  host.mountEditorReplacement(picker);
}
