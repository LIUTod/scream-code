import { execFile } from 'node:child_process';

export interface OpenInvocation {
  command: string;
  args: string[];
  /** Windows: arguments are pre-escaped, so Node must forward them verbatim. */
  windowsVerbatimArguments?: boolean;
}

/**
 * Build the launcher invocation for a URL.
 *
 * Windows deliberately avoids `cmd /c start "" <url>`: cmd.exe splits its
 * command line on metacharacters (`&`, `|`, `^`), and query strings are full of
 * `&`, so a URL from a model or a search result would open the wrong target and
 * could execute a local command. Instead the URL travels inside a
 * Base64-encoded PowerShell command (`Start '<url>'`, single-quoted so `$` is
 * literal), which is the same approach the `open` package and Vite use.
 */
export function buildOpenInvocation(
  url: string,
  platform: NodeJS.Platform = process.platform,
): OpenInvocation {
  if (platform === 'win32') {
    const script = `Start '${url.replaceAll("'", "''")}'`;
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      windowsVerbatimArguments: true,
    };
  }
  if (platform === 'darwin') {
    return { command: 'open', args: [url] };
  }
  return { command: 'xdg-open', args: [url] };
}

/** Open `url` with the platform handler. Best-effort by design. */
export function openUrl(url: string): void {
  const { command, args, windowsVerbatimArguments } = buildOpenInvocation(url);
  execFile(command, args, { windowsVerbatimArguments: windowsVerbatimArguments ?? false }, () => {
    // Best-effort: swallow errors (e.g. missing xdg-open) — an unhandled
    // 'error' event on the child would otherwise crash the process.
  });
}
