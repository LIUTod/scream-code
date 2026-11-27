import type { SlashCommandHost } from './dispatch';

export type ParsedSidebarCommand =
  | { readonly kind: 'toggle' }
  | { readonly kind: 'width'; readonly cols: number }
  | { readonly kind: 'resetWidth' }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Parse the `/sidebar` command.
 *
 * - `/sidebar`                      → open the session status if closed, close it if open
 * - `/sidebar width <n>`            → fix the width to n columns (24 to 60)
 * - `/sidebar width auto|reset`     → let the width follow the terminal again
 */
export function parseSidebarCommand(rawArgs: string): ParsedSidebarCommand {
  const args = rawArgs.trim();
  if (args.length === 0) return { kind: 'toggle' };

  const tokens = args.split(/\s+/);
  const cmd = tokens[0];
  switch (cmd) {
    case 'toggle':
      return { kind: 'toggle' };
    case 'width': {
      const raw = tokens[1];
      if (raw === 'reset' || raw === 'auto') return { kind: 'resetWidth' };
      const cols = Number(raw);
      if (raw === undefined || !Number.isFinite(cols)) {
        return { kind: 'error', message: 'usage: /sidebar width <n|auto>' };
      }
      return { kind: 'width', cols };
    }
    default:
      return { kind: 'error', message: `unknown sidebar subcommand: ${cmd}` };
  }
}

export async function handleSidebarCommand(host: SlashCommandHost, args: string): Promise<void> {
  const parsed = parseSidebarCommand(args);
  const manager = host.state.sidebarManager;

  if (parsed.kind === 'error') {
    host.showStatus(parsed.message);
    return;
  }

  switch (parsed.kind) {
    case 'toggle':
      manager.toggle();
      break;
    case 'width':
      manager.setWidth(parsed.cols);
      break;
    case 'resetWidth':
      manager.resetWidth();
      break;
  }

  const width = manager.chosenWidth;
  host.showStatus(`sidebar: ${manager.isOpen ? 'open' : 'closed'}${width === undefined ? '' : ` (${String(width)} cols)`}`);
}
