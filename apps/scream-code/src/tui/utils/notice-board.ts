/**
 * The footer's notification slot: many sources may have something to say, the
 * row has room for one.
 *
 * Every notice has a key (a newer notice with the same key replaces the older
 * one), a priority (lower number is shown first) and its own lifetime. `top()`
 * is what the footer draws right now; when it expires the next one takes its
 * place, so a burst of notices is read one after another instead of being
 * truncated side by side.
 */

export interface Notice {
  readonly key: string;
  readonly text: string;
  readonly color: string;
  /** Lower is shown first. */
  readonly priority: number;
  readonly ttlMs: number;
}

interface Live extends Notice {
  readonly expiresAt: number;
  readonly seq: number;
}

export class NoticeBoard {
  private readonly live = new Map<string, Live>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;

  /** `onChange` runs after a notice expires, so the row can repaint without it. */
  constructor(private readonly onChange: () => void) {}

  post(notice: Notice): void {
    this.live.set(notice.key, { ...notice, expiresAt: Date.now() + notice.ttlMs, seq: ++this.seq });
    this.schedule();
  }

  remove(key: string): void {
    if (this.live.delete(key)) this.schedule();
  }

  clear(): void {
    this.live.clear();
    this.schedule();
  }

  /** The notice to draw now, or null. Expired notices are dropped on the way. */
  top(): { text: string; color: string } | null {
    this.prune();
    let best: Live | undefined;
    for (const notice of this.live.values()) {
      if (
        best === undefined ||
        notice.priority < best.priority ||
        (notice.priority === best.priority && notice.seq > best.seq)
      ) {
        best = notice;
      }
    }
    return best === undefined ? null : { text: best.text, color: best.color };
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.live.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, notice] of this.live) if (notice.expiresAt <= now) this.live.delete(key);
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.prune();
    if (this.live.size === 0) return;
    const next = Math.min(...[...this.live.values()].map((notice) => notice.expiresAt));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.schedule();
      this.onChange();
    }, Math.max(0, next - Date.now()));
  }
}
