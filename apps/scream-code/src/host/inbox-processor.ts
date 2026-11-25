/**
 * The host's side of the "waiting for you" inbox (see the SDK's `listInbox`).
 *
 * Every sweep it
 *
 * - pushes each new item to the person's chat once (the chat it came from, or
 *   the chat the person last wrote from), with the commands that answer it;
 * - expires items nobody answered within 24 hours;
 * - delivers each answered item to its session: opens the session (when no
 *   other process holds it), lets the approved action through once, tells the
 *   run what the person decided, and lets it continue. A chat session is
 *   answered through its channel so the result reaches the chat.
 */

import {
  listInbox,
  log,
  readInboxItem,
  saveInboxMemories,
  sessionLockHolder,
  patchInboxItem,
  type InboxItem,
  type ScreamHarness,
  type Session,
} from '@scream-code/scream-code-sdk';

import { runPromptToEnd } from './run-to-end';
import { readUsage, usageTokens } from './usage';

const CHANNEL_SESSION_PREFIX = 'line-';

export interface InboxProcessorOptions {
  readonly harness: ScreamHarness;
  readonly screamHomeDir: string;
  /** Push text to a chat; undefined while no channel runs. */
  readonly notify?: ((sessionKey: string, text: string) => Promise<void>) | undefined;
  /** The chat to tell about items from sessions that are not a chat's. */
  readonly ownerChat?: (() => string | undefined) | undefined;
  /** Deliver a decision to a chat session through its channel (grant, turn, reply). */
  readonly deliverToChat?: ((sessionKey: string, text: string, actionKey?: string) => Promise<void>) | undefined;
  readonly formatNotice: (item: InboxItem, title?: string) => string;
  /** The title of the session an item comes from (a job's title for a job run), for its notice. */
  readonly titleFor?: ((item: InboxItem) => Promise<string | undefined>) | undefined;
  readonly recordUsage?: ((tokens: number) => void) | undefined;
  /** Told once about each new item, chat or no chat (activity log, system notification). */
  readonly onNewItem?: ((item: InboxItem) => void) | undefined;
  /** Nothing of `sessionId` waits in the inbox any more (delivered or expired). */
  readonly onSessionSettled?: ((sessionId: string) => Promise<void>) | undefined;
  readonly now?: () => number;
}

/** What the run is told about the person's decision. Model-facing, so English. */
export function decisionPrompt(item: InboxItem): string | undefined {
  const action = item.approval?.action ?? '';
  switch (item.decision) {
    case 'approve':
    case 'session':
    case 'always':
      return `The person approved this action from the inbox (${item.id}): ${action}\nDo exactly that now, then report the result.`;
    case 'reject':
      return `The person rejected this action (${item.id}): ${action}\nDo not do it. Finish what you can without it and report.`;
    case 'did-it':
      return `The person did this themselves (${item.id}): ${action}\nTreat it as done and continue the work.`;
    case 'answer':
      return `The person answered your question (${item.id}): ${item.answer ?? ''}\nContinue the work with that answer.`;
    case undefined:
      return undefined;
  }
}

export class InboxProcessor {
  private readonly delivering = new Set<string>();
  private sweeping: Promise<void> | undefined;

  constructor(private readonly options: InboxProcessorOptions) {}

  /** A decision is being delivered right now (an approved action running in its session). */
  busy(): boolean {
    return this.delivering.size > 0;
  }

  sweep(): Promise<void> {
    if (this.sweeping !== undefined) return this.sweeping;
    this.sweeping = this.sweepOnce().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  private async sweepOnce(): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    for (const listed of listInbox(this.options.screamHomeDir)) {
      // The list was read before the awaits below; read each item fresh so a
      // decision made meanwhile is seen, never overwritten.
      const item = readInboxItem(this.options.screamHomeDir, listed.id);
      if (item === undefined) continue;
      if (item.status === 'pending' && now > item.expiresAt) {
        if (patchInboxItem(this.options.screamHomeDir, item.id, 'pending', { status: 'expired' }) !== undefined) {
          await this.settleIfDone(item.sessionId);
        }
        continue;
      }
      if (item.status === 'pending' && item.announced !== true) {
        if (patchInboxItem(this.options.screamHomeDir, item.id, 'pending', { announced: true }) !== undefined) {
          this.options.onNewItem?.(item);
        }
      }
      // Memories to save are not pushed: they wait in /jobs and the terminal's
      // "while you were away" note, for a week (see the inbox).
      if (item.status === 'pending' && item.notified !== true && item.kind !== 'memory') {
        await this.notify(item);
        continue;
      }
      if (item.status === 'decided' && !this.delivering.has(item.id)) {
        this.delivering.add(item.id);
        void this.deliver(item)
          .catch((error: unknown) => {
            log.warn('host: delivering an inbox decision failed', { id: item.id, error: String(error) });
          })
          .finally(() => {
            this.delivering.delete(item.id);
            if (readInboxItem(this.options.screamHomeDir, item.id)?.status === 'delivered') {
              void this.settleIfDone(item.sessionId);
            }
          });
      }
    }
  }

  private async settleIfDone(sessionId: string): Promise<void> {
    const waiting = listInbox(this.options.screamHomeDir).some(
      (item) => item.sessionId === sessionId && (item.status === 'pending' || item.status === 'decided'),
    );
    if (waiting || this.options.onSessionSettled === undefined) return;
    await this.options.onSessionSettled(sessionId).catch((error: unknown) => {
      log.warn('host: settling an inbox session failed', { sessionId, error: String(error) });
    });
  }

  private async notify(item: InboxItem): Promise<void> {
    const target = item.sessionId.startsWith(CHANNEL_SESSION_PREFIX) ? item.sessionId : this.options.ownerChat?.();
    if (target === undefined || this.options.notify === undefined) return;
    try {
      const title = await this.options.titleFor?.(item).catch(() => undefined);
      await this.options.notify(target, this.options.formatNotice(item, title));
      patchInboxItem(this.options.screamHomeDir, item.id, 'pending', { notified: true, notifiedTo: target });
    } catch (error) {
      log.warn('host: could not push an inbox item', { id: item.id, error: String(error) });
    }
  }

  private async deliver(item: InboxItem): Promise<void> {
    // Memories an unattended run wanted to keep: saved, or dropped. No session needed.
    if (item.kind === 'memory') {
      if (patchInboxItem(this.options.screamHomeDir, item.id, 'decided', { status: 'delivered' }) === undefined) return;
      if (item.decision === 'approve') await saveInboxMemories(this.options.screamHomeDir, item);
      return;
    }
    const prompt = decisionPrompt(item);
    if (prompt === undefined) return;
    const grant =
      item.decision === 'approve' || item.decision === 'session' || item.decision === 'always'
        ? item.approval?.key
        : undefined;
    if (item.sessionId.startsWith(CHANNEL_SESSION_PREFIX)) {
      if (this.options.deliverToChat === undefined) return;
      if (patchInboxItem(this.options.screamHomeDir, item.id, 'decided', { status: 'delivered' }) === undefined) return;
      await this.options.deliverToChat(item.sessionId, prompt, grant);
      return;
    }
    // Held by another process (a terminal has it open, the resumer is running
    // it): try again on a later sweep, once it is free.
    if ((await sessionLockHolder(this.options.screamHomeDir, item.sessionId)) !== undefined) return;
    let session: Session;
    try {
      session = await this.options.harness.resumeSession({ id: item.sessionId });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'session.not_found') patchInboxItem(this.options.screamHomeDir, item.id, 'decided', { status: 'delivered' });
      if (code === 'session.in_use' || code === 'session.not_found') return;
      throw error;
    }
    if (patchInboxItem(this.options.screamHomeDir, item.id, 'decided', { status: 'delivered' }) === undefined) {
      await session.close({ extractMemories: false }).catch(() => {});
      return;
    }
    // Lifetime usage on resume: count only what this follow-up spends.
    const usedBefore = usageTokens(await readUsage(session));
    try {
      if (grant !== undefined) await session.grantOneShotApproval(grant);
      await runPromptToEnd(session, prompt);
    } finally {
      this.options.recordUsage?.(Math.max(0, usageTokens(await readUsage(session)) - usedBefore));
      // Its memories were extracted when the run first ended.
      await session.close({ extractMemories: false }).catch(() => {});
    }
  }
}

