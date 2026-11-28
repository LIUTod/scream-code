import * as path from 'node:path';

import type { Component } from '@liutod-scream/pi-tui';

import { t } from '@scream-code/config';
import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import { CompactionComponent } from '../components/dialogs/compaction';
import { WelcomeComponent } from '../components/chrome/welcome';
import { ActivityGroupComponent } from '../components/messages/activity-group';
import { AssistantMessageComponent } from '../components/messages/assistant-message';
import { BackgroundAgentStatusComponent } from '../components/messages/background-agent-status';
import { SkillActivationComponent } from '../components/messages/skill-activation';
import { StatusMessageComponent } from '../components/messages/status-message';
import { ThinkingComponent } from '../components/messages/thinking';
import { isBusy } from '../utils/app-state';
import { ToolCallComponent } from '../components/messages/tool-call';
import { UserMessageComponent } from '../components/messages/user-message';
import { getNoActiveSessionMessage } from '../constant/scream-tui';
import type { TranscriptEntry } from '../types';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

// ── Revoke command ────────────────────────────────────────────────────────

export async function handleRevokeCommand(
  host: SlashCommandHost,
  args: string = '',
): Promise<void> {
  if (isBusy(host.state.appState)) {
    host.showError(t('revoke.streaming'));
    return;
  }

  const count = parseRevokeCount(args);
  if (count === undefined) {
    host.showError(t('revoke.usage'));
    return;
  }

  const session = host.session;
  if (session === undefined) {
    host.showError(getNoActiveSessionMessage());
    return;
  }

  if (findRevokeAnchorEntryIndex(host.state.transcriptEntries, count) === undefined) {
    host.showError(t('revoke.nothing'));
    return;
  }

  // Files the write tools changed in those turns: offer to put them back too.
  // An engine that cannot tell (or a failed look-up) undoes the conversation alone.
  let files: readonly string[] = [];
  try {
    files = await session.previewUndoFiles(count);
  } catch {
    files = [];
  }
  if (files.length === 0) {
    await performRevoke(host, session, count, 'keep');
    return;
  }
  const workDir = host.state.appState.workDir;
  const shown = files.slice(0, REVOKE_FILES_SHOWN).map((file) => `  ${displayPath(file, workDir)}`);
  if (files.length > REVOKE_FILES_SHOWN) shown.push(`  ${t('revoke.files_more', { count: files.length - REVOKE_FILES_SHOWN })}`);
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: t('revoke.files_title', { count: files.length }),
      hint: t('revoke.files_hint'),
      colors: host.state.theme.colors,
      details: [...shown, '', t('revoke.files_shell_note')],
      options: [
        { value: 'restore', label: t('revoke.files_restore'), description: t('revoke.files_restore_desc', { count: files.length }) },
        { value: 'keep', label: t('revoke.files_keep'), description: t('revoke.files_keep_desc') },
      ],
      onSelect: (value) => {
        host.restoreEditor();
        void performRevoke(host, session, count, value === 'restore' ? 'restore' : 'keep');
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

/** Files listed in the choice before `/revoke` asks whether to put them back. */
const REVOKE_FILES_SHOWN = 6;

/** A path under the working directory reads relative to it; anything else stays absolute. */
function displayPath(file: string, workDir: string): string {
  const relative = path.relative(workDir, file);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
}

async function performRevoke(
  host: SlashCommandHost,
  session: NonNullable<SlashCommandHost['session']>,
  count: number,
  files: 'restore' | 'keep',
): Promise<void> {
  // The choice may have stayed open while something else started.
  if (isBusy(host.state.appState)) {
    host.showError(t('revoke.streaming'));
    return;
  }
  const entries = host.state.transcriptEntries;
  const lastUserIndex = findRevokeAnchorEntryIndex(entries, count);
  if (lastUserIndex === undefined) {
    host.showError(t('revoke.nothing'));
    return;
  }

  let result: Awaited<ReturnType<typeof session.undoHistory>>;
  try {
    result = await session.undoHistory(count, { files });
  } catch (error) {
    const message = formatErrorMessage(error);
    host.showError(t('revoke.failed', { msg: message }));
    return;
  }
  // An older engine answers nothing about files.
  if (result !== undefined && result !== null) reportRestoredFiles(host, result);

  const children = host.state.transcriptContainer.children;
  const lastUserComponentIndex = findRevokeAnchorComponentIndex(children, count);
  if (lastUserComponentIndex !== undefined) {
    removeRevokeContextComponents(children, lastUserComponentIndex);
    host.state.transcriptContainer.invalidate();
  }

  const preservedEntries = entries.slice(lastUserIndex).filter(
    (entry) => !isRevokeContextEntry(entry),
  );
  entries.splice(lastUserIndex, entries.length - lastUserIndex, ...preservedEntries);

  if (entries.length === 0) {
    renderWelcome(host);
  }

  // Rows left the transcript, so everything below them moved up: a live
  // selection still carries the dropped rows' coordinates and its highlight
  // would repaint over whatever slid into that region.
  host.state.ui.resetTextSelection();
  host.state.ui.requestRender();
}

/** Say which files came back and which were left alone (changed since, too large, a failed write). */
function reportRestoredFiles(
  host: SlashCommandHost,
  result: { readonly restored: readonly string[]; readonly skipped: ReadonlyArray<{ path: string; reason: string }> },
): void {
  const colors = host.state.theme.colors;
  if (result.restored.length > 0) {
    host.showStatus(t('revoke.files_restored', { count: result.restored.length }), colors.success);
  }
  if (result.skipped.length > 0) {
    const workDir = host.state.appState.workDir;
    const names = result.skipped.map((entry) => displayPath(entry.path, workDir)).join(', ');
    const changed = result.skipped.every((entry) => entry.reason === 'changed');
    host.showStatus(
      changed
        ? t('revoke.files_skipped_changed', { count: result.skipped.length, files: names })
        : t('revoke.files_skipped', { count: result.skipped.length, files: names }),
      colors.warning,
    );
  }
}

// ── Parsing ─────────────────────────────────────────────────────────────

function parseRevokeCount(args: string): number | undefined {
  const value = args.trim();
  if (value.length === 0) return 1;
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : undefined;
}

// ── Transcript entry helpers ─────────────────────────────────────────────

function isRevokeAnchorEntry(entry: TranscriptEntry): boolean {
  // User messages and user-triggered skill activations are turn boundaries.
  // ScreamCode doesn't distinguish trigger types on TranscriptEntry, but all
  // skill_activation transcript entries originate from user slash commands.
  return entry.kind === 'user' || entry.kind === 'skill_activation';
}

function findRevokeAnchorEntryIndex(
  entries: readonly TranscriptEntry[],
  count: number,
): number | undefined {
  let found = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry !== undefined && isRevokeAnchorEntry(entry)) {
      found++;
      if (found === count) return i;
    }
  }
  return undefined;
}

function isRevokeContextEntry(entry: TranscriptEntry): boolean {
  switch (entry.kind) {
    case 'user':
    case 'assistant':
    case 'tool_call':
    case 'tool_result':
    case 'thinking':
    case 'skill_activation':
      return true;
    case 'status':
      return entry.turnId !== undefined;
    case 'welcome':
    case 'cron':
      return false;
  }
}

// ── UI component helpers ─────────────────────────────────────────────────

function findRevokeAnchorComponentIndex(
  children: readonly Component[],
  count: number,
): number | undefined {
  let found = 0;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child !== undefined && isRevokeAnchorComponent(child)) {
      found++;
      if (found === count) return i;
    }
  }
  return undefined;
}

function removeRevokeContextComponents(
  children: Component[],
  startIndex: number,
): void {
  for (let i = children.length - 1; i >= startIndex; i--) {
    const child = children[i];
    if (child !== undefined && isRevokeContextComponent(child)) {
      // Live ThinkingComponent instances own a spinner tick chain; skipping
      // dispose here would leave the chain running against a detached child.
      // Component does not declare dispose, so narrow through a structural
      // view instead of widening the shared interface.
      const disposable = child as Partial<Record<"dispose", () => void>>;
      if (typeof disposable.dispose === "function") {
        disposable.dispose();
      }
      children.splice(i, 1);
    }
  }
}

function isRevokeAnchorComponent(child: Component): boolean {
  // Turn boundaries: user messages and user-triggered skill activations (the
  // latter originate from user slash commands).
  return child instanceof UserMessageComponent || child instanceof SkillActivationComponent;
}

function isRevokeContextComponent(child: Component): boolean {
  // Component types whose transcript entries are dropped by isRevokeContextEntry.
  // Cron notices are intentionally absent: their entries are preserved.
  return (
    child instanceof UserMessageComponent ||
    child instanceof AssistantMessageComponent ||
    child instanceof ThinkingComponent ||
    child instanceof ToolCallComponent ||
    child instanceof ActivityGroupComponent ||
    child instanceof SkillActivationComponent ||
    child instanceof BackgroundAgentStatusComponent ||
    child instanceof StatusMessageComponent ||
    child instanceof CompactionComponent
  );
}

function renderWelcome(host: SlashCommandHost): void {
  if (
    host.state.transcriptContainer.children.some(
      (child) => child instanceof WelcomeComponent,
    )
  ) {
    return;
  }
  host.state.transcriptContainer.addChild(
    new WelcomeComponent(host.state.appState, host.state.theme.colors, host.state.ui),
  );
}
