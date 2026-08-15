import type { SlashCommandHost } from './dispatch';

/**
 * Open the full-screen conversation search overlay (same as Ctrl+Shift+F).
 * The overlay is owned by pi-tui; `openSearch` is a TS-private method but a
 * plain instance method at runtime, so we reach it through a cast instead of
 * adding an upstream API for a single caller.
 */
export function handleSearchCommand(host: SlashCommandHost): void {
  const ui = host.state.ui as unknown as { openSearch(): void } | undefined;
  ui?.openSearch?.();
}
