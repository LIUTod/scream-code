import type { ChatMessage } from '../types';

/** Max entries kept in the composer input history (newest first). */
export const INPUT_HISTORY_LIMIT = 50;

/**
 * Derive input history from the session journal: user message texts, newest
 * first, deduped, capped. Mirrors the reference behavior — history recall
 * works from real sent prompts regardless of which browser sent them.
 * Local-only messages (command results, system notices) are excluded.
 */
export function deriveHistoryFromMessages(messages: ChatMessage[], limit = INPUT_HISTORY_LIMIT): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'user' || m.local) continue;
    const text = (m.content ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * Merge stored history (old→new, from localStorage — includes slash commands
 * and queued sends that never reached the journal) with derived history
 * (newest first, from messages). Result: chronological oldest→newest (shell
 * history order; the menu opens scrolled to the newest entry at the bottom),
 * deduped by exact text, capped at the newest `limit`. Derived entries win
 * dedup ties (journal is ground truth); stored-only entries (commands,
 * offline records) sit before them.
 */
export function mergeInputHistory(storedOldToNew: readonly string[], derivedNewToOld: readonly string[], limit = INPUT_HISTORY_LIMIT): string[] {
  const seen = new Set<string>();
  const newestFirst: string[] = [];
  const push = (raw: string) => {
    const text = raw.trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    newestFirst.push(text);
  };
  for (const t of derivedNewToOld) push(t);
  for (let i = storedOldToNew.length - 1; i >= 0; i -= 1) {
    const raw = storedOldToNew[i];
    if (raw !== undefined) push(raw);
  }
  // newestFirst is newest→oldest; flip to chronological, keeping the newest.
  return newestFirst.slice(0, limit).toReversed();
}
