import { t } from '@scream-code/config';

import { writeTextClipboard } from '#/utils/clipboard/clipboard-text';
import type { SlashCommandHost } from './dispatch';

/**
 * `/copy` — put the most recent assistant reply on the system clipboard.
 *
 * Only `assistant` transcript entries are considered: tool output and notices
 * are not "the reply", and an empty/whitespace entry (a cancelled turn) would
 * otherwise count as copyable. Clipboard failures are reported, never swallowed:
 * the user asked for a side effect and must know whether it landed.
 */
export async function handleCopyCommand(host: SlashCommandHost): Promise<void> {
  const entries = host.state.transcriptEntries;
  let latest: string | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== 'assistant') continue;
    if (entry.content.trim().length === 0) continue;
    latest = entry.content;
    break;
  }

  if (latest === undefined) {
    host.showStatus(t('tui.copy_empty'));
    return;
  }

  try {
    await writeTextClipboard(latest);
    host.showStatus(t('tui.copy_done'));
  } catch (error: unknown) {
    host.showError(
      t('tui.copy_failed', { msg: error instanceof Error ? error.message : String(error) }),
    );
  }
}
