import { exec } from 'node:child_process';

/**
 * Check whether a cc-connect process is running on the local machine.
 *
 * Detection strategy per platform:
 *   - macOS / Linux: pgrep -f cc-connect
 *   - Windows:        pm2 jlist (preferred) → Get-CimInstance (PowerShell) → wmic (deprecated fallback)
 */

export function checkCcConnectActive(): Promise<boolean> {
  switch (process.platform) {
    case 'darwin':
    case 'linux':
      return pgrep('cc-connect');
    case 'win32':
      return checkWindows();
    default:
      return Promise.resolve(false);
  }
}

// ── macOS / Linux ──────────────────────────────────────────────────────────

function pgrep(pattern: string): Promise<boolean> {
  return new Promise((resolve) => {
    exec(`pgrep -f ${escapeShell(pattern)}`, { timeout: 3000 }, (error, stdout) => {
      if (error) { resolve(false); return; }
      resolve(stdout.trim().length > 0);
    });
  });
}

function escapeShell(pattern: string): string {
  return `'${pattern.replace(/'/g, "'\\''")}'`;
}

// ── Windows ────────────────────────────────────────────────────────────────

async function checkWindows(): Promise<boolean> {
  // 1. pm2 jlist — most reliable when cc-connect is managed by pm2
  const pm2Active = await checkPm2();
  if (pm2Active !== undefined) return pm2Active;

  // 2. PowerShell Get-CimInstance — modern replacement for wmic
  const psActive = await checkPowerShell();
  if (psActive !== undefined) return psActive;

  // 3. wmic — deprecated since Windows 10 21H2, removed in Win11 24H2
  return wmic('cc-connect');
}

/** Query pm2's internal process list. Returns undefined if pm2 is not available. */
function checkPm2(): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    exec('pm2 jlist 2>nul', { timeout: 3000, windowsHide: true }, (error, stdout) => {
      if (error) { resolve(undefined); return; }
      try {
        const list = JSON.parse(stdout.trim());
        if (!Array.isArray(list)) { resolve(undefined); return; }
        const cc = list.find(
          (p: { name?: string; pm2_env?: { status?: string } }) =>
            p.name === 'cc-connect',
        );
        resolve(cc !== undefined ? cc.pm2_env?.status === 'online' : false);
      } catch {
        resolve(undefined);
      }
    });
  });
}

/** Query process command lines via PowerShell Get-CimInstance. Returns undefined if unavailable. */
function checkPowerShell(): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*cc-connect*' } | Measure-Object | Select-Object -ExpandProperty Count"`;
    exec(cmd, { timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error) { resolve(undefined); return; }
      const count = parseInt(stdout.trim(), 10);
      if (isNaN(count)) { resolve(undefined); return; }
      resolve(count > 0);
    });
  });
}

function wmic(pattern: string): Promise<boolean> {
  return new Promise((resolve) => {
    const query = `wmic process where "commandline like '%${pattern}%'" get processid`;
    exec(query, { timeout: 3000, windowsHide: true }, (error, stdout) => {
      if (error) { resolve(false); return; }
      const out = stdout.trim();
      resolve(out.length > 0 && !out.includes('No Instance'));
    });
  });
}
