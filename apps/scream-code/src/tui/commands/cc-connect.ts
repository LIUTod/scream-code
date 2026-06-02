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
    parts.push(`${platform.name} 已配置（配置不会丢失）`);
    parts.push("");
    parts.push(`配置文件：${CONFIG_PATH}`);
  } else {
    parts.push(`✔ ${platform.name} 通道配置完成`);
    parts.push("");
    parts.push(`配置文件已写入：${CONFIG_PATH}`);
  }

  // ── Quick Reference (front & center) ──
  parts.push("");
  parts.push("📋 常用管理指令（建议复制保存）：");
  parts.push("");
  parts.push(`  pm2 status                         查看运行状态（online = 正常）`);
  parts.push(`  pm2 restart cc-connect             重启服务`);
  parts.push(`  pm2 stop cc-connect                停止服务`);
  parts.push(`  pm2 logs cc-connect                查看日志`);
  parts.push(`  pm2 delete cc-connect              完全删除`);
  if (isReconfigure) {
    parts.push("");
    parts.push("  ⚠ 不要再次运行 /cc-connect 并选择相同平台，否则会覆盖已有配置！");
    parts.push("    如需更换平台，请先删除 C:\\Users\\<用户名>\\.cc-connect\\config.toml");
  }

  // ── Detailed setup steps ──
  parts.push("");
  parts.push(SEP);
  parts.push("");
  parts.push("📋 初始化步骤（仅首次配置时需要，按顺序执行）：");
  parts.push("");

  // Step 1: Platform auth
  const noteTag = platform.note ? `（${platform.note}）` : "";
  parts.push(`  第 1 步：平台认证${noteTag}`);
  parts.push(`    cc-connect ${platform.setupCmd}`);
  parts.push("");

  // Step 2+: Daemon steps
  if (daemon.warning) {
    parts.push(`  ⚠ ${daemon.warning}`);
    parts.push("");
  }
  let stepNum = 2;
  for (const step of daemon.steps) {
    const onceTag = step.once ? "（一次性）" : "";
    parts.push(`  第 ${stepNum} 步：${step.label}${onceTag}`);
    parts.push(`    ${step.command}`);
    stepNum++;
  }

  // ── Help ──
  parts.push("");
  parts.push(SEP);
  parts.push("");
  parts.push(`更多指令 (${daemon.method})：`);
  for (const cmd of daemon.helpCommands) {
    parts.push(`  ${cmd}`);
  }

  parts.push("");
  parts.push("💡 激活附件回传（让 Agent 能发图片和文件）：");
  parts.push("  在聊天窗口发送 /bind setup");
  parts.push("");
  parts.push("💡 开机自启已通过 Startup 文件夹中的 cc-connect-startup.bat 实现。");
  parts.push("  如需手动重启服务：pm2 resurrect");

  return parts.join("\n");
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
        host.showNotice(`${platform.name} 已配置`, buildNoticeText(platform, true));
        return;
      }

      generateConfig(platform);
      host.showNotice(`✔ ${platform.name} 通道配置完成`, buildNoticeText(platform, false));
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });

  host.mountEditorReplacement(picker);
}
