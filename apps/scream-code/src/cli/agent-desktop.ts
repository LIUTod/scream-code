/**
 * agent-desktop lifecycle management — install, detect.
 *
 * Platform-aware detection of the `agent-desktop` native binary and
 * installation helper. Used by the /mcp panel to set up the Desktop
 * Automation MCP server.
 */

import { exec, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// ── Detection ────────────────────────────────────────────────────────────

export interface AgentDesktopStatus {
  installed: boolean;
  version?: string;
  /**
   * Absolute path to the native binary, or the `agent-desktop` CLI wrapper
   * when resolved via npm.
   */
  binaryPath?: string;
}

/**
 * Check whether the agent-desktop native binary is available (async).
 *
 * Resolution order:
 * 1. `createRequire` lookup — works when agent-desktop is a project dependency.
 * 2. Global `agent-desktop` on PATH — works for global installs.
 */
export async function checkAgentDesktop(): Promise<AgentDesktopStatus> {
  // Try npm dependency (project-level install, like grok-cli)
  let jsPath: string | undefined;
  try {
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve('agent-desktop/package.json');
    const binDir = join(dirname(packagePath), 'bin');
    jsPath = join(binDir, 'agent-desktop.js');
  } catch {
    // Not found as project dependency — fall through to global check
  }

  if (jsPath && existsSync(jsPath)) {
    return tryVersion(jsPath);
  }

  // Fallback: check global install
  return tryVersion();
}

async function tryVersion(jsPath?: string): Promise<AgentDesktopStatus> {
  return new Promise<AgentDesktopStatus>((resolve) => {
    if (jsPath) {
      execFile(
        process.execPath,
        [jsPath, 'version'],
        { timeout: 5_000, windowsHide: true },
        (_error, stdout) => {
          if (_error) { resolve({ installed: false }); return; }
          try {
            const parsed = JSON.parse(stdout.trim()) as { version?: string };
            resolve({ installed: true, version: parsed.version, binaryPath: jsPath });
          } catch {
            resolve({ installed: true, binaryPath: jsPath });
          }
        },
      );
    } else {
      exec(
        'agent-desktop version 2>&1',
        { timeout: 5_000, windowsHide: true },
        (_error, stdout) => {
          if (_error) { resolve({ installed: false }); return; }
          try {
            const parsed = JSON.parse(stdout.trim()) as { version?: string };
            resolve({ installed: true, version: parsed.version });
          } catch {
            resolve({ installed: true });
          }
        },
      );
    }
  });
}

/** Sync version of the check (for initial UI rendering). */
export function checkAgentDesktopSync(): AgentDesktopStatus {
  try {
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve('agent-desktop/package.json');
    const binDir = join(dirname(packagePath), 'bin');
    const jsPath = join(binDir, 'agent-desktop.js');
    if (existsSync(jsPath)) {
      return { installed: true, binaryPath: jsPath };
    }
  } catch {
    // not a project dependency
  }
  return { installed: false };
}

// ── Installation ─────────────────────────────────────────────────────────

export function installAgentDesktop(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(
      'npm install -g agent-desktop',
      { timeout: 60_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, output: stderr.trim() || error.message });
        } else {
          resolve({ ok: true, output: stdout.trim() });
        }
      },
    );
  });
}

export function updateAgentDesktop(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(
      'npm install -g agent-desktop@latest',
      { timeout: 60_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, output: stderr.trim() || error.message });
        } else {
          resolve({ ok: true, output: stdout.trim() });
        }
      },
    );
  });
}
