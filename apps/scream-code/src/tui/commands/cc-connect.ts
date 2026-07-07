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

function getPlatforms(): PlatformDef[] {
  return [
    { name: "微信", type: "weixin", setupCmd: "weixin setup --project default" },
    { name: "飞书", type: "feishu", setupCmd: "feishu setup --project default" },
    { name: "Telegram", type: "telegram", setupCmd: "telegram setup --project default", note: t('ccconnect.note_botfather') },
    { name: "钉钉", type: "dingtalk", setupCmd: "dingtalk setup --project default" },
    { name: "Discord", type: "discord", setupCmd: "discord setup --project default" },
    { name: "Slack", type: "slack", setupCmd: "slack setup --project default" },
    { name: "QQ", type: "qq", setupCmd: "qq setup --project default", note: t('ccconnect.note_napcat') },
    { name: "企业微信", type: "wecom", setupCmd: "wecom setup --project default", note: t('ccconnect.note_wecom') },
  ];
}

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

function detectScreamPath(): string {
  try {
    const cmd = process.platform === "win32" ? "where scream" : "which scream 2>/dev/null";
    const which = execSync(cmd, { encoding: "utf-8", timeout: 3000 }).trim();
    // Windows `where` can return multiple matches (one per line).
    // TOML strings must be single-line, so take only the first match.
    const first = which.split(/[\r\n]+/)[0]?.trim() ?? "";
    if (first) return `${first} stream-json`;
  } catch { /* not found */ }
  return "scream stream-json";
}

function readConfiguredType(): string | undefined {
  if (!existsSync(CONFIG_PATH)) return undefined;
  try {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    let inPlatforms = false;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "[[projects.platforms]]") {
        inPlatforms = true;
        continue;
      }
      if (trimmed.startsWith("[[") && trimmed !== "[[projects.platforms]]") {
        inPlatforms = false;
        continue;
      }
      if (inPlatforms) {
        const m = line.match(/^type\s*=\s*"(\S+)"/);
        if (m) return m[1];
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function escapeSingleQuotes(str: string): string {
  return str.replaceAll('\'', "\\'");
}

function generateConfig(platform: PlatformDef): void {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const platformBlock = `\n[[projects.platforms]]\ntype = "${platform.type}"\n`;

  // If config already exists, append the new platform instead of overwriting.
  if (existsSync(CONFIG_PATH)) {
    const existing = readFileSync(CONFIG_PATH, "utf-8");
    if (existing.includes(`type = "${platform.type}"`)) {
      // Same platform already configured — nothing to do.
      return;
    }
    writeFileSync(CONFIG_PATH, existing + platformBlock, "utf-8");
    return;
  }

  // Fresh config file
  const content = [
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
    `cli_path = '${escapeSingleQuotes(detectScreamPath())}'`,
    `work_dir = '${escapeSingleQuotes(process.cwd())}'`,
    'mode = "default"',
    '',
    '[[projects.platforms]]',
    `type = "${platform.type}"`,
    '',
  ].join("\n");

  writeFileSync(CONFIG_PATH, content, "utf-8");
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

  const configuredType = readConfiguredType();

  const options: ChoiceOption[] = getPlatforms().map((p) => {
    const isConfigured = configuredType === p.type;
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
    currentValue: configuredType,
    colors: host.state.theme.colors,
    onSelect: (value: string) => {
      host.restoreEditor();

      const platform = getPlatforms().find((p) => p.type === value);
      if (!platform) {
        host.showError(t('error.internal'));
        return;
      }

      if (configuredType === value) {
        host.showNotice(t('ccconnect.reconfigured', { name: platform.name }), buildNoticeText(platform, true));
        return;
      }

      generateConfig(platform);
      host.showNotice(t('ccconnect.config_done', { name: platform.name }), buildNoticeText(platform, false));
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });

  host.mountEditorReplacement(picker);
}
