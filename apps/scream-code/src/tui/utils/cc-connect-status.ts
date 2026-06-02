import { exec } from 'node:child_process';

/**
 * Check whether a cc-connect process is running on the local machine.
 *
 * Matches the full command line so both native daemon launches and
 * PM2-managed Node.js processes are detected.  The check is a lightweight
 * `pgrep` (macOS/Linux) or `wmic` (Windows) call — no filesystem scan.
 */
export function checkCcConnectActive(): Promise<boolean> {
  switch (process.platform) {
    case 'darwin':
    case 'linux':
      return pgrep('cc-connect');
    case 'win32':
      return wmic('cc-connect');
    default:
      return Promise.resolve(false);
  }
}

function pgrep(pattern: string): Promise<boolean> {
  return new Promise((resolve) => {
    exec(`pgrep -f ${escapeShell(pattern)}`, { timeout: 3000 }, (error, stdout) => {
      if (error) { resolve(false); return; }
      resolve(stdout.trim().length > 0);
    });
  });
}

function wmic(pattern: string): Promise<boolean> {
  // wmic queries the full command line of every running process.  The
  // "No Instance(s) Available." string means zero matches; a ProcessId
  // header line means at least one match.
  return new Promise((resolve) => {
    const query = `wmic process where "commandline like '%${pattern}%'" get processid`;
    exec(query, { timeout: 3000, windowsHide: true }, (error, stdout) => {
      if (error) { resolve(false); return; }
      const out = stdout.trim();
      resolve(out.length > 0 && !out.includes('No Instance'));
    });
  });
}

function escapeShell(pattern: string): string {
  // Only called on macOS/Linux; single-quote the pattern and escape
  // embedded single quotes.
  return `'${pattern.replace(/'/g, "'\\''")}'`;
}
