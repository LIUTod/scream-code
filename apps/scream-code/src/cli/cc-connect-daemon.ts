/**
 * Platform-aware cc-connect daemon instruction generator.
 *
 * cc-connect supports native daemon management (systemd/launchd/schtasks) on
 * Linux, macOS, and Windows. However older versions or mis-built binaries may
 * lack Windows support, producing:
 *   "daemon management is not supported on windows; use a process manager
 *    (e.g. nssm, pm2) instead"
 *
 * This module detects the platform and whether the installed cc-connect binary
 * actually supports the `daemon` subcommand, then returns explicit step-by-step
 * instructions that users can copy-paste in order.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────

export interface DaemonStep {
  /** Short description of what this step does */
  label: string;
  /** The exact command to run */
  command: string;
  /** Whether this is a one-time setup step */
  once?: boolean;
}

export interface DaemonInstructions {
  /** Human-readable label for the daemon method (e.g. "systemd", "pm2") */
  method: string;
  /** Ordered steps the user should follow */
  steps: DaemonStep[];
  /** Additional maintenance/management commands */
  helpCommands: string[];
  /** Warning or note to show */
  warning?: string;
}

// ─── Detection ─────────────────────────────────────────────────────────────

/**
 * Check whether the installed cc-connect binary supports the `daemon`
 * subcommand.
 */
export function ccConnectSupportsDaemon(): boolean {
  try {
    const out = execSync("cc-connect daemon --help 2>&1", {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    return out.includes("install") && !out.includes("not supported");
  } catch {
    return false;
  }
}

/**
 * Detect the installed cc-connect version string (e.g. "1.2.3"), or undefined.
 */
export function ccConnectVersion(): string | undefined {
  try {
    const out = execSync("cc-connect --version 2>&1", {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    const match = out.match(/v?(\d+\.\d+\.\d+)/);
    return match?.[1] ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the real JavaScript entry point of the globally-installed cc-connect
 * package, bypassing platform wrapper scripts (.cmd / shell launchers).
 *
 * On Windows, `npm install -g cc-connect` creates a `.CMD` batch file that pm2
 * cannot execute (it treats it as JS and crashes on `@ECHO off`).  This returns
 * the absolute path to `run.js` inside the package so pm2 can invoke it
 * directly.
 */
export function detectCcConnectEntry(): string | null {
  try {
    // Resolve global node_modules — dynamic across OS / user / node version
    const npmRoot = execSync("npm root -g", {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    }).trim();

    // npm publish may produce either layout:
    //   1. repo-root publish  → node_modules/cc-connect/npm/package.json
    //   2. npm/ dir publish  → node_modules/cc-connect/package.json
    const candidates = [
      join(npmRoot, "cc-connect", "npm", "package.json"),
      join(npmRoot, "cc-connect", "package.json"),
    ];

    for (const pkgPath of candidates) {
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        bin?: Record<string, string>;
      };
      const binScript = pkg?.bin?.["cc-connect"]; // "run.js"
      if (!binScript) continue;

      // Resolve relative to the package.json directory
      const entryPath = join(dirname(pkgPath), binScript);
      if (existsSync(entryPath)) return entryPath;
    }

    return null;
  } catch {
    return null;
  }
}

// ─── Instruction generator ─────────────────────────────────────────────────

const CONFIG_DIR_DEFAULT = "~/.cc-connect";

export function getDaemonInstructions(
  configDir?: string,
): DaemonInstructions {
  const dir = configDir ?? CONFIG_DIR_DEFAULT;
  const isWindows = process.platform === "win32";

  // ── Windows ────────────────────────────────────────────────────────────
  if (isWindows) {
    const daemonOk = ccConnectSupportsDaemon();

    if (daemonOk) {
      return {
        method: "schtasks (Windows Task Scheduler)",
        steps: [
          {
            label: "安装守护进程",
            command: `cc-connect daemon install --work-dir ${dir}`,
            once: true,
          },
          {
            label: "启动服务",
            command: "cc-connect daemon start",
          },
        ],
        helpCommands: [
          "cc-connect daemon status             查看运行状态",
          "cc-connect daemon logs -f            实时查看日志（Ctrl+C 退出）",
          "cc-connect daemon stop               停止服务",
          "cc-connect daemon start              启动服务",
          "cc-connect daemon restart            重启服务",
          "cc-connect daemon uninstall          卸载守护进程",
        ],
      };
    }

    // daemon genuinely unavailable on this machine — pm2 is the only path
    const entry = detectCcConnectEntry();

    const pm2StartCmd = entry
      ? `pm2 start "${entry}" --name cc-connect`
      : "pm2 start cc-connect --name cc-connect";

    // Use the Windows Startup folder for reliable auto-start after reboot.
    // schtasks + "pm2 resurrect" fails because the PM2 daemon isn't alive
    // when the scheduled task fires at logon.  A .bat file in the Startup
    // folder runs in the full user desktop environment where pm2 is on PATH
    // and auto-spawns a daemon when needed.
    const appData = process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
    const startupDir = join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
    const batPath = join(startupDir, "cc-connect-startup.bat");

    return {
      method: "pm2 (Node.js process manager)",
      warning:
        "cc-connect 暂不支持在当前 Windows 系统上使用原生守护进程，以下使用 pm2 代替。",
      steps: [
        {
          label: "安装 pm2",
          command: "npm install -g pm2",
          once: true,
        },
        {
          label: "启动 cc-connect",
          command: pm2StartCmd,
        },
        {
          label: "保存进程列表",
          command: "pm2 save",
          once: true,
        },
        {
          label: "写入开机自启脚本（重启后自动运行）",
          // Wrap in cmd /c so the command works in PowerShell too —
          // PowerShell treats && as reserved and rejects ^& escaping.
          command: `cmd /c "echo @echo off && pm2 resurrect > \\"${batPath}\\""`,
          once: true,
        },
      ],
      helpCommands: [
        "⚠ 启动后会弹出一个小窗口，不要关闭！拖到任务栏或最小化即可。",
        "   窗口关闭 = 服务停止，重启需执行下面的启动命令。",
        "",
        "pm2 status                         查看运行状态（online = 正常）",
        "pm2 logs cc-connect                实时查看日志（Ctrl+C 退出）",
        "pm2 stop cc-connect                停止服务",
        "pm2 restart cc-connect             重启服务（日常开机后/改配置后）",
        "pm2 delete cc-connect              完全删除",
        "pm2 list                           列出所有 pm2 进程",
        "",
        "取消开机自启：",
        `  del "${batPath}"`,
        "",
        "如果开机后 pm2 status 显示为空：",
        "  （1）运行 pm2 resurrect 手动恢复进程列表",
        "  （2）运行 pm2 save 重新保存",
        "",
        "常见问题：",
        '  "Script already launched" → pm2 已经注册过了，用 pm2 restart cc-connect 即可。',
        '  "stopped / errored"      → 用 pm2 logs cc-connect 查看错误原因。',
        '  重新安装 cc-connect 后   → pm2 delete cc-connect 再重新走启动步骤。',
      ],
    };
  }

  // ── macOS / Linux ──────────────────────────────────────────────────────
  return {
    method: process.platform === "darwin" ? "launchd" : "systemd",
    steps: [
      {
        label: "安装守护进程",
        command: `cc-connect daemon install --work-dir ${dir}`,
        once: true,
      },
      {
        label: "启动服务",
        command: "cc-connect daemon start",
      },
    ],
    helpCommands: [
      "cc-connect daemon status             查看运行状态",
      "cc-connect daemon logs -f            实时查看日志（Ctrl+C 退出）",
      "cc-connect daemon stop               停止服务",
      "cc-connect daemon start              启动服务",
      "cc-connect daemon restart            重启服务",
      "cc-connect daemon uninstall          卸载守护进程",
    ],
  };
}
