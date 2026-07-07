import type { Component } from '@earendil-works/pi-tui';

import { t } from '@scream-code/config';
import { WelcomeComponent } from '../components/chrome/welcome';
import { AgentGroupComponent } from '../components/messages/agent-group';
import { AssistantMessageComponent } from '../components/messages/assistant-message';
import { BackgroundAgentStatusComponent } from '../components/messages/background-agent-status';
import { ReadGroupComponent } from '../components/messages/read-group';
import { SkillActivationComponent } from '../components/messages/skill-activation';
import { ThinkingComponent } from '../components/messages/thinking';
import { isBusy } from '../utils/app-state';
import { ToolCallComponent } from '../components/messages/tool-call';
import { UserMessageComponent } from '../components/messages/user-message';
import { getNoActiveSessionMessage } from '../constant/scream-tui';
import type { TranscriptEntry } from '../types';
import { formatErrorMessage } from '../utils/event-payload';
import { getTranscriptComponentEntry } from '../utils/transcript-component-metadata';
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

  const entries = host.state.transcriptEntries;
  const lastUserIndex = findRevokeAnchorEntryIndex(entries, count);
  if (lastUserIndex === undefined) {
    host.showError(t('revoke.nothing'));
    return;
  }

  try {
    await session.undoHistory(count);
  } catch (error) {
    const message = formatErrorMessage(error);
    host.showError(t('revoke.failed', { msg: message }));
    return;
  }

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

  host.state.ui.requestRender();
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
      children.splice(i, 1);
    }
  }
}

function isRevokeAnchorComponent(child: Component): boolean {
  // Use the transcript entry metadata path first — it covers both
  // UserMessageComponent and SkillActivationComponent reliably.
  const entry = getTranscriptComponentEntry(child);
  if (entry !== undefined) {
    return isRevokeAnchorEntry(entry);
  }
  // Fallback: SkillActivationComponent without entry metadata is still
  // an anchor (it was triggered by the user typing /skillname).
  return child instanceof UserMessageComponent || child instanceof SkillActivationComponent;
}

function isRevokeContextComponent(child: Component): boolean {
  const entry = getTranscriptComponentEntry(child);
  if (entry !== undefined) {
    return isRevokeContextEntry(entry);
  }

  return (
    child instanceof UserMessageComponent ||
    child instanceof AssistantMessageComponent ||
    child instanceof ThinkingComponent ||
    child instanceof ToolCallComponent ||
    child instanceof AgentGroupComponent ||
    child instanceof ReadGroupComponent ||
    child instanceof SkillActivationComponent ||
    child instanceof BackgroundAgentStatusComponent
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
