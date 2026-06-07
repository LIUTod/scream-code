/**
 * `scream channel setup` — interactive cc-connect platform configuration.
 *
 * Guides the user through:
 *   1. Check cc-connect is installed
 *   2. Select a platform (weixin, feishu, telegram, ...)
 *   3. Auto-generate ~/.cc-connect/config.toml
 *   4. Print the next command (cc-connect <platform> setup --project default)
 */

import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

import { getDaemonInstructions } from "./cc-connect-daemon";

// ─── Platform registry ────────────────────────────────────────────────────

interface PlatformDef {
  /** cc-connect platform type string */
  type: string;
  /** Human-readable name */
  name: string;
  /** Short description */
  desc: string;
  /** cc-connect setup command (e.g. "weixin setup", "feishu setup") */
  setupCmd: string;
  /** Extra note shown after setup */
  note?: string;
}

const PLATFORMS: PlatformDef[] = [
  {
    type: "weixin",
    name: "微信",
    desc: "个人微信，ilink bot 协议，扫码登录",
    setupCmd: "weixin setup",
  },
  {
    type: "feishu",
    name: "飞书",
    desc: "飞书/Lark 企业通讯，无需公网 IP",
    setupCmd: "feishu setup",
  },
  {
    type: "telegram",
    name: "Telegram",
    desc: "Telegram bot，需提前在 @BotFather 创建",
    setupCmd: "telegram setup",
  },
  {
    type: "dingtalk",
    name: "钉钉",
    desc: "钉钉企业通讯",
    setupCmd: "dingtalk setup",
  },
  {
    type: "discord",
    name: "Discord",
    desc: "Discord 社区平台",
    setupCmd: "discord setup",
  },
  {
    type: "slack",
    name: "Slack",
    desc: "Slack 企业通讯",
    setupCmd: "slack setup",
  },
  {
    type: "qq",
    name: "QQ",
    desc: "QQ via NapCat/OneBot",
    setupCmd: "qq setup",
    note: "需要先安装 NapCat 或 OneBot 桥接",
  },
  {
    type: "qqbot",
    name: "QQ Bot (官方)",
    desc: "QQ 官方 Bot API",
    setupCmd: "qqbot setup",
  },
  {
    type: "wecom",
    name: "企业微信",
    desc: "WeChat Work，需公网 IP",
    setupCmd: "wecom setup",
    note: "需要公网 URL 或 ngrok",
  },
  {
    type: "line",
    name: "LINE",
    desc: "LINE 通讯平台，需公网 URL",
    setupCmd: "line setup",
    note: "需要公网 URL",
  },
  {
    type: "weibo",
    name: "微博",
    desc: "微博消息通道",
    setupCmd: "weibo setup",
  },
  {
    type: "wps-xiezuo",
    name: "WPS 协作",
    desc: "WPS 协同办公",
    setupCmd: "wps-xiezuo setup",
  },
];

// ─── Helpers ───────────────────────────────────────────────────────────────

async function question(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

function checkCcConnect(): { installed: boolean; version?: string } {
  try {
    const out = execSync("cc-connect --version 2>&1", {
      encoding: "utf-8",
      timeout: 5000,
    });
    const match = out.match(/v(\d+\.\d+\.\d+)/);
    return { installed: true, version: match?.[1] ?? out.trim().split("\n")[0] };
  } catch {
    return { installed: false };
  }
}

/** Auto-detect the path to the scream binary, including the stream-json subcommand. */
function detectScreamPath(): string {
  // 1. Check if running as a bundled binary (process.execPath)
  const execBase = process.execPath.toLowerCase();
  if (execBase.endsWith("/scream") || execBase.endsWith("\\scream")) {
    return `${process.execPath} stream-json`;
  }

  // 2. Check if we're running from the monorepo dist
  if (execBase.includes("node") && process.argv[1]) {
    const arg1 = process.argv[1];
    // If the first arg looks like a scream entry point
    if (arg1.includes("scream-code") || arg1.includes("scream")) {
      return `node ${arg1} stream-json`;
    }
  }

  // 3. Check for scream in PATH
  try {
    const which = execSync("which scream 2>/dev/null", {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    // Guard against multi-line output (rare but possible).
    const first = which.split(/[\r\n]+/)[0]?.trim() ?? "";
    if (first) return `${first} stream-json`;
  } catch {
    // not found
  }

  // 4. Fallback
  return "scream stream-json";
}

function resolveConfigPath(): string {
  return join(homedir(), ".cc-connect", "config.toml");
}

function resolveWorkDir(): string {
  return process.cwd();
}

function generateConfig(cliPath: string, platformType: string): string {
  const workDir = resolveWorkDir();
  return [
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
    `cli_path = '${cliPath}'`,
    `work_dir = '${workDir}'`,
    'mode = "default"',
    '',
    '[[projects.platforms]]',
    `type = "${platformType}"`,
    '',
  ].join("\n");
}

// ─── Main ──────────────────────────────────────────────────────────────────

export async function runChannelSetup(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("");
  console.log("🧩  cc-connect 快速通道配置");
  console.log("━".repeat(50));
  console.log("");

  // ── Step 1: Check cc-connect ─────────────────────────────────────────
  const cc = checkCcConnect();
  if (cc.installed) {
    console.log(`  ✔ cc-connect 已安装 (${cc.version})`);
  } else {
    console.log("  ✖ cc-connect 未安装");
    console.log("");
    console.log("  请先安装 cc-connect：");
    console.log("    npm install -g cc-connect");
    console.log("");
    console.log("  安装完成后重新运行：");
    console.log("    scream channel setup");
    console.log("");
    rl.close();
    process.exit(1);
  }
  console.log("");

  // ── Step 2: Select platform ──────────────────────────────────────────
  console.log("  选择你要连接的平台：");
  console.log("");
  PLATFORMS.forEach((p, i) => {
    const num = String(i + 1).padStart(2, " ");
    console.log(`  ${num}. ${p.name.padEnd(12)} — ${p.desc}`);
  });
  console.log("");

  const answer = await question(rl, "  输入编号 (1-12): ");
  const index = parseInt(answer, 10) - 1;
  const platform = PLATFORMS[index];
  if (!platform) {
    console.log("");
    console.log(`  ✖ 无效选择: "${answer}"，请输入 1-${PLATFORMS.length}`);
    console.log("");
    rl.close();
    process.exit(1);
  }
  console.log("");
  console.log(`  ✔ 已选择: ${platform.name}`);
  console.log("");

  // ── Step 3: Detect scream path ───────────────────────────────────────
  const cliPath = detectScreamPath();
  console.log(`  ScreamCode 路径: ${cliPath}`);
  console.log("");

  // ── Step 4: Generate config ──────────────────────────────────────────
  const configPath = resolveConfigPath();
  const configDir = dirname(configPath);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const configContent = generateConfig(cliPath, platform.type);

  // Check if config already exists
  if (existsSync(configPath)) {
    const existing = readFileSync(configPath, "utf-8");
    if (existing.includes(`type = "${platform.type}"`)) {
      console.log(`  ⚠ ${platform.name} 已配置过，跳过写入`);
      console.log("");
    } else {
      // Append platform to existing config
      const append = `\n[[projects.platforms]]\ntype = "${platform.type}"\n`;
      writeFileSync(configPath, existing + append, "utf-8");
      console.log(`  ✔ 已追加 ${platform.name} 到现有配置`);
      console.log("");
    }
  } else {
    writeFileSync(configPath, configContent, "utf-8");
    console.log(`  ✔ 配置已写入 ${configPath}`);
    console.log("");
  }

  // ── Step 5: Full setup guide ──────────────────────────────────────────
  const daemon = getDaemonInstructions(dirname(configPath));

  console.log("━".repeat(50));
  console.log("");
  console.log("  📋 完整安装步骤（在终端中按顺序执行）：");
  console.log("");

  // Step 1: platform login
  console.log(`  第 1 步 — 扫码认证（一次性）`);
  console.log("");
  console.log(`    cc-connect ${platform.setupCmd} --project default`);
  console.log("");

  if (platform.note) {
    console.log(`    ⚠ ${platform.note}`);
    console.log("");
  }

  // Steps 2+: daemon install & start
  if (daemon.warning) {
    console.log(`  ⚠ ${daemon.warning}`);
    console.log("");
  }

  let stepNum = 2;
  for (const step of daemon.steps) {
    const onceTag = step.once ? "（一次性）" : "";
    console.log(`  第 ${stepNum} 步 — ${step.label}${onceTag}`);
    console.log("");
    console.log(`    ${step.command}`);
    console.log("");
    stepNum++;
  }

  // Maintenance commands
  console.log("  ──".repeat(25));
  console.log("");
  console.log(`  日常管理 (${daemon.method})：`);
  console.log("");
  for (const cmd of daemon.helpCommands) {
    console.log(`    ${cmd}`);
  }
  console.log("");

  console.log("  💡 激活附件回传（让 Agent 能发图片和文件）：");
  console.log("");
  console.log("    在聊天窗口发送 /bind setup");
  console.log("");

  rl.close();
}
