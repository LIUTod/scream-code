import type { ClientContext } from './state';
import { generateId } from './state';

/** G5.4: prompts queued while offline; flushed after a successful hello. */
const OFFLINE_KEY = 'scream-offline-prompt-queue';

/** G5.5: keep the last few user prompts for the empty-state shortcut chips. */
const RECENT_KEY = 'scream-recent-prompts';

export interface QueueModule {
  enqueueOfflinePrompt(text: string): void;
  removeOfflineQueueItem(text: string): void;
  recordRecentPrompt(text: string): void;
  flushQueue(): void;
  flushQueueNext(): void;
}

export function createQueueModule(ctx: ClientContext): QueueModule {
  const { s } = ctx;

  let offlineQueue: string[] = [];
  try {
    const raw = localStorage.getItem(OFFLINE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) offlineQueue = parsed.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    offlineQueue = [];
  }
  function persistQueue(): void {
    try {
      localStorage.setItem(OFFLINE_KEY, JSON.stringify(offlineQueue.slice(0, 20)));
    } catch {
      // best effort
    }
  }
  /** Serialized offline flush (G5.4): sends the head item and waits for the
   *  server echo (user_message with our clientMessageId) before sending the
   *  next. The server marks the session busy on the first prompt, so sending
   *  back-to-back would reject every item after the first. */
  function flushQueue(): void {
    if (offlineQueue.length === 0) return;
    const text = offlineQueue[0]!;
    const clientMessageId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const localMessageId = generateId();
    // queueText marks this send as "the current head of the offline queue",
    // so echo/error handling can advance (or evict) exactly that item.
    s.sentMessageIds.set(clientMessageId, { messageId: localMessageId, connectionGeneration: s.connectionGeneration, queueText: text });
    s.promptGeneration++;
    s.pendingPromptAccepted = false;
    s.promptPending.value = true;
    s.messages.value.push({
      id: localMessageId,
      role: 'user',
      content: text,
      clientMessageId,
      tools: [],
      ts: Date.now(),
    });
    recordRecentPrompt(text);
    ctx.send({ type: 'prompt', text, clientMessageId });
  }
  /** Drop the head item (server echoed it back) and try the next one. */
  function flushQueueNext(): void {
    if (offlineQueue.length > 0) offlineQueue.shift();
    persistQueue();
    flushQueue();
  }
  function enqueueOfflinePrompt(text: string): void {
    offlineQueue.push(text);
    persistQueue();
  }
  /** G5.4: drop the queued item only when a rejection arrived for the send
   *  that came from the offline flush. A plain connected send must never
   *  evict an unrelated queue head that was never sent. */
  function removeOfflineQueueItem(text: string): void {
    const idx = offlineQueue.indexOf(text);
    if (idx >= 0) {
      offlineQueue.splice(idx, 1);
      persistQueue();
    }
  }

  let recentPrompts: string[] = [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) recentPrompts = parsed.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    recentPrompts = [];
  }
  function recordRecentPrompt(text: string): void {
    const t = text.trim();
    if (!t) return;
    recentPrompts = [t, ...recentPrompts.filter((x) => x !== t)].slice(0, 8);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recentPrompts));
    } catch {
      // best effort
    }
  }

  ctx.flushQueue = flushQueue;
  ctx.flushQueueNext = flushQueueNext;
  ctx.enqueueOfflinePrompt = enqueueOfflinePrompt;
  ctx.removeOfflineQueueItem = removeOfflineQueueItem;
  ctx.recordRecentPrompt = recordRecentPrompt;

  return { enqueueOfflinePrompt, removeOfflineQueueItem, recordRecentPrompt, flushQueue, flushQueueNext };
}
