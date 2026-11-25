/**
 * Session-scoped snapshot store behind stale-anchor recovery for line-range
 * edits.
 *
 * When a `replace_range` Edit arrives with an anchor that no longer matches
 * the file on disk, recovery needs to know what the model actually saw when
 * it picked its line numbers. This store keeps exactly that: the model-view
 * text (LF-normalized, the same shape `computeAnchor` hashed) captured either
 * by a successful Read (`recordedAt: 'read'` — the model's last view) or by a
 * successful Edit (`recordedAt: 'edit'` — what our own last apply produced).
 *
 * Each path keeps a short history, newest last: the model's Read plus the
 * views its own later Edits / Writes produced. A call that still carries the
 * anchor of that Read after editing the file is then recognised — its line
 * numbers can be remapped across the model's own changes, and a string edit
 * is not mistaken for one made against a file someone else changed.
 *
 * One instance per Agent, handed to the file tools like repetitionGuard:
 * subagents own their own store, so snapshots never leak across agent
 * boundaries. Paths are bounded with LRU eviction — evicting a path merely
 * downgrades that file's next stale-anchor attempt to the plain hard reject,
 * which is the pre-recovery behaviour.
 *
 * Micro-compaction elision deliberately does NOT forget snapshots here (no
 * forget wiring from the compaction layer): eliding a Read result removes the
 * model's visible copy of the content, but compaction never touches the file
 * on disk, so the snapshot keeps mirroring disk state and remains valid for
 * recovery. The store stays bounded through the path LRU and the per-snapshot
 * content cap instead.
 */
export interface EditSnapshot {
  /** Model-view text (LF) of the file at capture time, matching `computeAnchor`. */
  content: string;
  /** The anchor `computeAnchor(content)` produced at capture time. */
  anchor: string;
  /** Whether a Read (the model's view) or an Edit / Write (our own apply) captured it. */
  recordedAt: 'read' | 'edit';
}

/** Cap on tracked paths; insertion-order Map gives cheap LRU semantics. */
export const EDIT_SNAPSHOT_MAX_PATHS = 64;

/** Snapshots kept per path: the latest plus the few views before it. */
export const EDIT_SNAPSHOT_HISTORY = 4;

/**
 * Per-snapshot content budget. Snapshots of larger files are skipped: they
 * would dominate session memory, and the O(n·m) line diff recovery relies on
 * is only practical for files of this scale anyway — recovery for bigger
 * files falls back to the plain hard reject. Read consults the same cap
 * (against `stat.stSize`) before paying for its snapshot re-read.
 */
export const EDIT_SNAPSHOT_MAX_CONTENT_BYTES = 2 * 1024 * 1024;

/** Budget across every kept snapshot; past it, the oldest history goes first. */
export const EDIT_SNAPSHOT_TOTAL_BYTES = 48 * 1024 * 1024;

interface Kept {
  readonly snapshot: EditSnapshot;
  readonly bytes: number;
}

export class EditSnapshotStore {
  /** Path → history (newest last); Map order doubles as the LRU list. */
  private readonly entries = new Map<string, Kept[]>();
  private totalBytes = 0;

  /**
   * Record the latest snapshot for a path. Content over the budget is not
   * remembered (the path is dropped, so `recall` reports the file as
   * snapshot-less and recovery degrades to the hard reject). The path moves
   * to most-recent, and inserting past the path cap evicts the
   * least-recently-used path.
   */
  remember(path: string, snapshot: EditSnapshot): void {
    const bytes = Buffer.byteLength(snapshot.content, 'utf8');
    if (bytes > EDIT_SNAPSHOT_MAX_CONTENT_BYTES) {
      this.drop(path);
      return;
    }
    // The same view recorded again (a re-read) moves to the end instead of
    // filling the history twice.
    const history = (this.entries.get(path) ?? []).filter((kept) => {
      if (kept.snapshot.anchor !== snapshot.anchor) return true;
      this.totalBytes -= kept.bytes;
      return false;
    });
    history.push({ snapshot, bytes });
    this.totalBytes += bytes;
    while (history.length > EDIT_SNAPSHOT_HISTORY) {
      const oldest = history.shift();
      if (oldest !== undefined) this.totalBytes -= oldest.bytes;
    }
    this.entries.delete(path);
    this.entries.set(path, history);
    if (this.entries.size > EDIT_SNAPSHOT_MAX_PATHS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.drop(oldest);
    }
    this.trimToBudget(path);
  }

  /**
   * Return the latest snapshot for a path, or undefined. A hit moves the path
   * to most-recent so the path actively used for recovery survives eviction.
   */
  recall(path: string): EditSnapshot | undefined {
    return this.touch(path)?.at(-1)?.snapshot;
  }

  /** The kept view of a path whose anchor is `anchor` (the model's Read, or an earlier apply). */
  recallAnchor(path: string, anchor: string): EditSnapshot | undefined {
    return this.touch(path)?.findLast((kept) => kept.snapshot.anchor === anchor)?.snapshot;
  }

  /**
   * True when every view after the one behind `anchor` was produced by this
   * agent's own Edit / Write, and the newest of them is `content`: the file
   * only changed because the model changed it.
   */
  changedOnlyByOwnEdits(path: string, anchor: string, content: string): boolean {
    const history = this.entries.get(path);
    if (history === undefined) return false;
    const at = history.findLastIndex((kept) => kept.snapshot.anchor === anchor);
    if (at < 0) return false;
    const later = history.slice(at + 1);
    return (
      later.length > 0 &&
      later.every((kept) => kept.snapshot.recordedAt === 'edit') &&
      later.at(-1)?.snapshot.content === content
    );
  }

  private touch(path: string): Kept[] | undefined {
    const history = this.entries.get(path);
    if (history === undefined) return undefined;
    // Delete-then-set re-inserts at the Map tail so the path counts as touched.
    this.entries.delete(path);
    this.entries.set(path, history);
    return history;
  }

  private drop(path: string): void {
    const history = this.entries.get(path);
    if (history === undefined) return;
    for (const kept of history) this.totalBytes -= kept.bytes;
    this.entries.delete(path);
  }

  /** Over the total budget: older views go first, then whole least-recent paths. */
  private trimToBudget(keep: string): void {
    for (const history of this.entries.values()) {
      while (this.totalBytes > EDIT_SNAPSHOT_TOTAL_BYTES && history.length > 1) {
        const oldest = history.shift();
        if (oldest !== undefined) this.totalBytes -= oldest.bytes;
      }
      if (this.totalBytes <= EDIT_SNAPSHOT_TOTAL_BYTES) return;
    }
    for (const path of this.entries.keys()) {
      if (this.totalBytes <= EDIT_SNAPSHOT_TOTAL_BYTES) return;
      if (path !== keep) this.drop(path);
    }
  }
}
