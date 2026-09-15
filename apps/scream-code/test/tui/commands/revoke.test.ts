import { Text } from '@liutod-scream/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { handleRevokeCommand } from '#/tui/commands/revoke';
import { CompactionComponent } from '#/tui/components/dialogs/compaction';
import { ActivityGroupComponent } from '#/tui/components/messages/activity-group';
import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { CronMessageComponent } from '#/tui/components/messages/cron-message';
import { StatusMessageComponent } from '#/tui/components/messages/status-message';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import { createScreamTUIThemeBundle } from '#/tui/theme/bundle';
import type { TranscriptEntry } from '#/tui/types';

import { makeMockSession, makeMockSlashCommandHost } from '../fixtures/mock-host';

const bundle = createScreamTUIThemeBundle('dark', 'dark');

function makeEntry(kind: TranscriptEntry['kind'], turnId?: string): TranscriptEntry {
  return { id: `e-${kind}-${String(Math.random())}`, kind, renderMode: 'plain', content: kind, turnId };
}

describe('handleRevokeCommand', () => {
  it('removes every turn-owned card and keeps notices and panels', async () => {
    const session = makeMockSession({ overrides: { undoHistory: vi.fn(async (): Promise<void> => {}) } });
    const host = makeMockSlashCommandHost({ session });
    const { transcriptContainer, transcriptEntries } = host.state;

    const user = new UserMessageComponent('do the thing', bundle.colors);
    const assistant = new AssistantMessageComponent(bundle.markdownTheme, bundle.colors);
    assistant.updateContent('done');
    const block = new ActivityGroupComponent(bundle.colors, undefined);
    const status = new StatusMessageComponent('notice', bundle.colors);
    const compaction = new CompactionComponent(bundle.colors);
    const cron = new CronMessageComponent('reminder', { cron: '0 9 * * *', recurring: true }, bundle.colors);
    const panel = new Text('panel row', 0, 0);

    transcriptContainer.addChild(user);
    transcriptContainer.addChild(assistant);
    transcriptContainer.addChild(block);
    transcriptContainer.addChild(status);
    transcriptContainer.addChild(compaction);
    transcriptContainer.addChild(cron);
    transcriptContainer.addChild(panel);

    transcriptEntries.push(makeEntry('user', 'turn-1'));
    transcriptEntries.push(makeEntry('assistant', 'turn-1'));
    transcriptEntries.push(makeEntry('tool_call', 'turn-1'));
    transcriptEntries.push(makeEntry('status', 'turn-1'));
    transcriptEntries.push(makeEntry('cron'));

    await handleRevokeCommand(host, '');

    const children = transcriptContainer.children;
    expect(children).not.toContain(user);
    expect(children).not.toContain(assistant);
    expect(children).not.toContain(block);
    expect(children).not.toContain(status);
    expect(children).not.toContain(compaction);
    // Cron notices and non-transcript panels are outside the turn's context.
    expect(children).toContain(cron);
    expect(children).toContain(panel);
    expect(transcriptEntries.map((entry) => entry.kind)).toEqual(['cron']);
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('reports when there is nothing to revoke', async () => {
    const session = makeMockSession({ overrides: { undoHistory: vi.fn(async (): Promise<void> => {}) } });
    const host = makeMockSlashCommandHost({ session });

    await handleRevokeCommand(host, '');

    expect(host.showError).toHaveBeenCalled();
  });
});
