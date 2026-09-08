import type { SlashCommandHost } from './dispatch';

export type ParsedSidebarCommand =
  | { readonly kind: 'toggle' }
  | { readonly kind: 'next' }
  | { readonly kind: 'prev' }
  | { readonly kind: 'panel'; readonly id: string }
  | { readonly kind: 'width'; readonly cols: number }
  | { readonly kind: 'resetWidth' }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Parse the `/sidebar` command.
 *
 * - `/sidebar`              → toggle the sidebar (open if closed, close if open)
 * - `/sidebar next|prev`    → cycle the active panel
 * - `/sidebar panel <id>`   → activate a specific panel
 * - `/sidebar width <n>`    → clamp the sidebar width to [24..60] columns
 * - `/sidebar width reset`  → restore the default width
 */
export function parseSidebarCommand(rawArgs: string): ParsedSidebarCommand {
  const args = rawArgs.trim();
  if (args.length === 0) return { kind: 'toggle' };

  const tokens = args.split(/\s+/);
  const cmd = tokens[0];
  switch (cmd) {
    case 'toggle':
      return { kind: 'toggle' };
    case 'next':
      return { kind: 'next' };
    case 'prev':
      return { kind: 'prev' };
    case 'panel': {
      const id = tokens[1];
      if (id === undefined) {
        return { kind: 'error', message: 'usage: /sidebar panel <id>' };
      }
      return { kind: 'panel', id };
    }
    case 'width': {
      const raw = tokens[1];
      if (raw === 'reset') return { kind: 'resetWidth' };
      const cols = Number(raw);
      if (!Number.isFinite(cols)) {
        return { kind: 'error', message: 'usage: /sidebar width <n|reset>' };
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
    case 'next':
      if (manager.isOpen) manager.next();
      else manager.toggle();
      break;
    case 'prev':
      if (manager.isOpen) manager.prev();
      else manager.toggle();
      break;
    case 'panel': {
      if (!manager.activate(parsed.id)) {
        host.showStatus(`sidebar: no panel '${parsed.id}'`);
        return;
      }
      break;
    }
    case 'width':
      manager.setWidth(parsed.cols);
      break;
    case 'resetWidth':
      manager.resetWidth();
      break;
  }

  const panel = manager.activePanel;
  host.showStatus(`sidebar: ${manager.isOpen ? (panel?.title ?? 'open') : 'closed'}`);
}
