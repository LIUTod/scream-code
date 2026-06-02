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

const PLATFORMS: PlatformDef[] = [
  { name: "微信", type: "weixin", setupCmd: "weixin setup --project default" },
  { name: "飞书", type: "feishu", setupCmd: "feishu setup --project default" },
  { name: "Telegram", type: "telegram", setupCmd: "telegram setup --project default", note: "需先在 @BotFather 创建 bot" },
  { name: "钉钉", type: "dingtalk", setupCmd: "dingtalk setup --project default" },
  { name: "Discord", type: "discord", setupCmd: "discord setup --project default" },
  { name: "Slack", type: "slack", setupCmd: "slack setup --project default" },
  { name: "QQ", type: "qq", setupCmd: "qq setup --project default", note: "需要 NapCat/OneBot" },
  { name: "企业微信", type: "wecom", setupCmd: "wecom setup --project default", note: "需要公网 IP" },
];

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
    const which = execSync("which scream 2>/dev/null", { encoding: "utf-8", timeout: 3000 }).trim();
    if (which) return `${which} stream-json`;
  } catch { /* not found */ }
  return "scream stream-json";
}

function readConfiguredType(): string | undefined {
  if (!existsSync(CONFIG_PATH)) return undefined;
  try {
    // Read the config file directly instead of shelling out to grep —
    // Windows does not have grep, so the old approach always failed there
    // and returned undefined, causing every /cc invocation to regenerate
    // config.toml and overwrite the token that cc-connect <platform> setup
    // had written into [projects.platforms.options].
    const content = readFileSync(CONFIG_PATH, "utf-8");
    for (const line of content.split("\n")) {
      const m = line.match(/^type\s*=\s*"(\S+)"/);
      if (m) return m[1];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function generateConfig(platform: PlatformDef): void {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const content = [
    '# 全局：允许/禁止图片和文件回传到聊天（on = 开启，off = 关闭）',
    'attachment_send = "on"',
    '',
    '[[projects]]',
    'name = "default"',
    '',
    '[projects.agent]',
    'type = "claudecode"',
    '',
    '[projects.agent.options]',
    `cli_path = '${detectScreamPath()}'`,
    `work_dir = '${process.cwd()}'`,
    'mode = "default"',
    '',
    '[[projects.platforms]]',
    `type = "${platform.type}"`,
    '',
  ].join("\n");

  writeFileSync(CONFIG_PATH, content, "utf-8");
}

// ─── Daemon instructions helper ────────────────────────────────────────────

/**
 * Format daemon steps as a numbered continuation from the platform setup step.
 * Returns lines that should be appended after the platform setup command line.
 */
function formatDaemonSteps(configDir: string): string[] {
  const daemon = getDaemonInstructions(configDir);
  const lines: string[] = [];

  if (daemon.warning) {
    lines.push("");
    lines.push(`⚠ ${daemon.warning}`);
  }

  let stepNum = 2; // step 1 is the platform setup
  for (const step of daemon.steps) {
    const onceTag = step.once ? "（一次性）" : "";
    lines.push("");
    lines.push(`第 ${stepNum} 步 — ${step.label}${onceTag}`);
    lines.push(`  ${step.command}`);
    stepNum++;
  }

  lines.push("");
  lines.push("──".repeat(20));
  lines.push("");
  lines.push(`日常管理 (${daemon.method})：`);
  for (const cmd of daemon.helpCommands) {
    lines.push(`  ${cmd}`);
  }

  lines.push("");
  lines.push("💡 激活附件回传（让 Agent 能发图片和文件）：");
  lines.push("");
  lines.push("  在聊天窗口发送 /bind setup");

  return lines;
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleChannelCommand(host: SlashCommandHost, _args: string): Promise<void> {
  const cc = checkCcConnect();
  if (!cc.installed) {
    host.showNotice(
      "cc-connect 未安装",
      "请先在终端运行：\n\n  npm install -g cc-connect\n\n安装完成后重新输入 /cc-connect 配置平台。",
    );
    return;
  }

  const configuredType = readConfiguredType();

  const options: ChoiceOption[] = PLATFORMS.map((p) => {
    const isConfigured = configuredType === p.type;
    return {
      value: p.type,
      label: isConfigured ? `${p.name} ✔ 已配置` : p.name,
      description: p.note,
    };
  });

  const picker = new ChoicePickerComponent({
    title: "cc-connect 快速通道配置",
    hint: "选择要连接的平台，配置将自动写入 ~/.cc-connect/config.toml",
    options,
    currentValue: configuredType,
    colors: host.state.theme.colors,
    onSelect: (value: string) => {
      host.restoreEditor();

      const platform = PLATFORMS.find((p) => p.type === value);
      if (!platform) {
        host.showError("内部错误");
        return;
      }

      if (configuredType === value) {
        const configDir = dirname(CONFIG_PATH);
        host.showNotice(
          `${platform.name} 已配置`,
          [
            `配置文件：${CONFIG_PATH}`,
            "",
            "📋 在终端中按顺序执行：",
            "",
            `第 1 步 — 平台认证（一次性）`,
            `  cc-connect ${platform.setupCmd}`,
            ...formatDaemonSteps(configDir),
          ].join("\n"),
        );
        return;
      }

      generateConfig(platform);

      const configDir = dirname(CONFIG_PATH);
      const lines = [
        `配置文件已写入：${CONFIG_PATH}`,
        "",
        "📋 在终端中按顺序执行：",
        "",
        `第 1 步 — 平台认证（一次性）`,
        `  cc-connect ${platform.setupCmd}`,
        ...formatDaemonSteps(configDir),
      ];
      if (platform.note) {
        lines.push("");
        lines.push(`⚠ ${platform.note}`);
      }

      host.showNotice(`✔ ${platform.name} 通道配置完成`, lines.join("\n"));
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });

  host.mountEditorReplacement(picker);
}
