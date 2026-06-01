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
          "cc-connect daemon stop       停止服务",
          "cc-connect daemon status     查看状态",
          "cc-connect daemon logs -f    查看日志",
        ],
      };
    }

    // daemon unavailable — lead with upgrade, pm2 as fallback
    const entry = detectCcConnectEntry();

    const pm2StartCmd = entry
      ? `pm2 start "${entry}" --name cc-connect`
      : "pm2 start cc-connect --name cc-connect";

    return {
      method: "schtasks（升级后），备选 pm2",
      warning:
        "当前 cc-connect 版本不支持 Windows 原生守护进程。\n" +
        "  推荐先升级到最新版，升级后会自动使用原生 Task Scheduler。",
      steps: [
        {
          label: "升级 cc-connect（推荐）",
          command: "npm install -g cc-connect@latest",
          once: true,
        },
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
        "cc-connect daemon stop       停止服务",
        "cc-connect daemon status     查看状态",
        "cc-connect daemon logs -f    查看日志",
        "",
        `备选 pm2 命令（不升级时使用）：`,
        `  npm install -g pm2`,
        `  ${pm2StartCmd}`,
        "  pm2 save",
        "  pm2 startup",
        "  pm2 status               查看状态",
        "  pm2 logs cc-connect      查看日志",
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
      "cc-connect daemon stop       停止服务",
      "cc-connect daemon status     查看状态",
      "cc-connect daemon logs -f    查看日志",
    ],
  };
}
