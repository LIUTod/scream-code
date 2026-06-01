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
            label: "安装守护进程（一次性）",
            command: `cc-connect daemon install --work-dir ${dir}`,
            once: true,
          },
          {
            label: "启动服务",
            command: "cc-connect daemon start",
          },
        ],
        helpCommands: [
          "cc-connect daemon stop       停止服务",
          "cc-connect daemon status     查看状态",
          "cc-connect daemon logs -f    查看日志",
        ],
      };
    }

    return {
      method: "pm2 (Node.js process manager)",
      warning:
        "当前 cc-connect 版本不支持 Windows 原生守护进程，以下使用 pm2 代替。\n" +
        "  升级到最新版后可获得原生支持：npm install -g cc-connect@latest",
      steps: [
        {
          label: "安装 pm2（一次性）",
          command: "npm install -g pm2",
          once: true,
        },
        {
          label: "启动 cc-connect",
          command: `pm2 start cc-connect --name cc-connect -- --work-dir ${dir}`,
        },
        {
          label: "保存进程列表（一次性）",
          command: "pm2 save",
          once: true,
        },
        {
          label: "设置开机自启（一次性）",
          command: "pm2 startup",
          once: true,
        },
      ],
      helpCommands: [
        "pm2 status               查看状态",
        "pm2 logs cc-connect      查看日志",
        "pm2 stop cc-connect      停止服务",
        "pm2 restart cc-connect   重启服务",
      ],
    };
  }

  // ── macOS / Linux ──────────────────────────────────────────────────────
  return {
    method: process.platform === "darwin" ? "launchd" : "systemd",
    steps: [
      {
        label: "安装守护进程（一次性）",
        command: `cc-connect daemon install --work-dir ${dir}`,
        once: true,
      },
      {
        label: "启动服务",
        command: "cc-connect daemon start",
      },
    ],
    helpCommands: [
      "cc-connect daemon stop       停止服务",
      "cc-connect daemon status     查看状态",
      "cc-connect daemon logs -f    查看日志",
    ],
  };
}
