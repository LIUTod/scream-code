/**
 * Local adaptation: plain text, per-Bot/thread request ownership, tab-scoped recovery;
 * accepted work belongs exclusively to the server queue, never a browser drain.
 */
export type DraftMode = "queue" | "steer";
export interface DraftRequest {
  readonly id: string;
  readonly key: string;
  readonly botId: string;
  readonly threadId: string;
  readonly text: string;
  readonly restore: string;
  readonly mode: DraftMode;
}
export interface DraftRetry {
  readonly id: string;
  readonly text: string;
  readonly restore: string;
  readonly mode: DraftMode;
}
export interface DraftState {
  readonly retry: DraftRetry | null;
  readonly value: string;
  readonly pending: DraftRequest | null;
  readonly error: string | null;
  readonly recovered: boolean;
}
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const EMPTY: DraftState = { value: "", pending: null, error: null, recovered: false, retry: null };
const PREFIX = "scream.bot.draft.v2:";
export const draftKey = (botId: string, threadId: string) => JSON.stringify([botId, threadId]);

export function canSubmitDraft(text: string, paused: boolean, pending: boolean): boolean {
  return text.trim().length > 0 && !paused && !pending;
}
function tabStorage(): DraftStorage | undefined {
  try { return typeof sessionStorage === "undefined" ? undefined : sessionStorage; }
  catch { return undefined; }
}

export class DraftStore {
  private readonly states = new Map<string, DraftState>();
  private readonly listeners = new Set<() => void>();
  constructor(private readonly storage: () => DraftStorage | undefined = tabStorage) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  get(key: string): DraftState {
    const existing = this.states.get(key);
    if (existing) return existing;
    let state = EMPTY;
    try {
      const raw = this.storage()?.getItem(PREFIX + key);
      const saved: unknown = raw ? JSON.parse(raw) : null;
      if (saved && typeof saved === "object" && "value" in saved && typeof saved.value === "string") {
        const recovered = "unconfirmed" in saved && saved.unconfirmed === true;
        let retry: DraftRetry | null = null;
        if ("retry" in saved && saved.retry && typeof saved.retry === "object") {
          const candidate = saved.retry;
          if ("id" in candidate && typeof candidate.id === "string" &&
            "text" in candidate && typeof candidate.text === "string" &&
            "restore" in candidate && typeof candidate.restore === "string" &&
            "mode" in candidate && (candidate.mode === "queue" || candidate.mode === "steer")) {
            retry = { id: candidate.id, text: candidate.text, restore: candidate.restore, mode: candidate.mode };
          }
        }
        state = { ...EMPTY, value: saved.value, recovered, retry };
      }
    } catch { /* A blocked/full storage must not disable the live editor. */ }
    this.states.set(key, state);
    return state;
  }
  private put(key: string, state: DraftState) {
    this.states.set(key, state);
    try {
      // Keep the unconfirmed intent separate: changing its body/key could duplicate accepted work.
      const value = state.value;
      const retry = state.pending ?? state.retry;
      if (value || retry) this.storage()?.setItem(PREFIX + key, JSON.stringify({ value, unconfirmed: !!retry || state.recovered, retry }));
      else this.storage()?.removeItem(PREFIX + key);
    } catch { /* In-memory ownership still protects pending edits. */ }
    for (const listener of this.listeners) listener();
  }
  edit(key: string, value: string) { this.put(key, { ...this.get(key), value }); }
  begin(botId: string, threadId: string, text: string, paused: boolean, mode: DraftMode = "queue", consume = true): DraftRequest | null {
    const key = draftKey(botId, threadId);
    const state = this.get(key);
    if (!canSubmitDraft(text, paused, state.pending !== null || state.retry !== null)) return null;
    const consuming = consume && state.value === text;
    const request: DraftRequest = {
      id: crypto.randomUUID(),
      key, botId, threadId, text: text.trim(), mode,
      restore: text,
    };
    // Lock synchronously: a second Enter before React commits cannot start another POST.
    this.put(key, { value: consuming ? "" : state.value, pending: request, error: null, recovered: false, retry: null });
    return request;
  }
  retry(botId: string, threadId: string, paused: boolean): DraftRequest | null {
    const key = draftKey(botId, threadId);
    const state = this.get(key);
    if (!state.retry || !canSubmitDraft(state.retry.text, paused, state.pending !== null)) return null;
    // A fresh object owns this attempt; only the immutable id/body are reused for server dedupe.
    const request: DraftRequest = { ...state.retry, key, botId, threadId };
    this.put(key, { ...state, pending: request, error: null });
    return request;
  }
  finish(request: DraftRequest, error?: string) {
    const state = this.get(request.key);
    if (state.pending !== request) return;
    this.put(request.key, {
      // A failed response does NOT prove rejection: retain exactly this intent, not a new merged POST.
      value: state.value,
      pending: null, error: error ?? null, recovered: false, retry: error ? request : null,
    });
  }
}
export const composerDrafts = new DraftStore();
