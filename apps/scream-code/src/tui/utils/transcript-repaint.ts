/**
 * Repaints the transcript after a command changes how existing rows look.
 *
 * Transcript components cache the rows they rendered at a given width, so a view
 * toggle (`/blockrows`, `/codebg`) has to invalidate them before the next frame,
 * otherwise the change only shows up on rows created afterwards.
 */

import type { SlashCommandHost } from '../commands/dispatch';

export function repaintTranscript(host: SlashCommandHost): void {
  for (const child of host.state.transcriptContainer.children) {
    const repaintable = child as { invalidate?: () => void };
    if (typeof repaintable.invalidate === 'function') repaintable.invalidate();
  }
  host.state.ui.requestRender();
}
