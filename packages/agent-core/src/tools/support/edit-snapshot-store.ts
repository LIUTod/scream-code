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
  /** Whether a Read (model's last view) or an Edit (our last apply) captured it. */
  recordedAt: 'read' | 'edit';
}

/** Cap on tracked paths; insertion-order Map gives cheap LRU semantics. */
export const EDIT_SNAPSHOT_MAX_PATHS = 64;

/**
 * Per-snapshot content budget. Snapshots of larger files are skipped: they
 * would dominate session memory, and the O(n·m) line diff recovery relies on
 * is only practical for files of this scale anyway — recovery for bigger
 * files falls back to the plain hard reject. Read consults the same cap
 * (against `stat.stSize`) before paying for its snapshot re-read.
 */
export const EDIT_SNAPSHOT_MAX_CONTENT_BYTES = 2 * 1024 * 1024;

export class EditSnapshotStore {
  /** Path → latest snapshot; Map order doubles as the LRU list. */
  private readonly entries = new Map<string, EditSnapshot>();

  /**
   * Record the latest snapshot for a path. Content over the budget is not
   * remembered (the path is dropped, so `recall` reports the file as
   * snapshot-less and recovery degrades to the hard reject). The path moves
   * to most-recent, and inserting past the path cap evicts the
   * least-recently-used path.
   */
  remember(path: string, snapshot: EditSnapshot): void {
    this.entries.delete(path);
    if (Buffer.byteLength(snapshot.content, 'utf8') > EDIT_SNAPSHOT_MAX_CONTENT_BYTES) {
      return;
    }
    this.entries.set(path, snapshot);
    if (this.entries.size > EDIT_SNAPSHOT_MAX_PATHS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /**
   * Return the latest snapshot for a path, or undefined. A hit moves the path
   * to most-recent so the path actively used for recovery survives eviction.
   */
  recall(path: string): EditSnapshot | undefined {
    const snapshot = this.entries.get(path);
    if (snapshot === undefined) return undefined;
    // Delete-then-set re-inserts at the Map tail so the path counts as touched.
    this.entries.delete(path);
    this.entries.set(path, snapshot);
    return snapshot;
  }
}
