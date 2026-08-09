import { execFile } from 'node:child_process';

export function openUrl(url: string): void {
  const command: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  execFile(command[0], command[1], () => {
    // Best-effort: swallow errors (e.g. missing xdg-open) — an unhandled
    // 'error' event on the child would otherwise crash the process.
  });
}
