import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'pathe';

import type { DistilledSource, MemoryMemo, MemoryMemoListResult, MemoOrigin } from './models.js';
import { toSummary } from './models.js';
import { buildEmbeddingText, EMBEDDING_MODEL_NAME, EMBEDDING_TEXT_VERSION, type EmbeddingEngine } from './embeddings.js';
import { resolveProjectRoot } from './project.js';

/**
 * Two memos at least this similar are the same text twice (see
 * `appendUnlessDuplicate`); dream merges at 0.86, which needs a model.
 */
export const WRITE_DUPLICATE_SIMILARITY = 0.95;

const FILE_NAME = 'entries.jsonl';
const MIGRATION_MARKER = '.migrated';
const SQLITE_MIGRATION_MARKER = '.migrated-to-sqlite';
/** Page size for read() row batches — bounds peak memory on large stores. */
const READ_BATCH_SIZE = 500;

export interface MemoryMemoStoreLogger {
  debug?: (message: string, ...args: unknown[]) => void;
  info?: (message: string, ...args: unknown[]) => void;
  warn?: (message: string, ...args: unknown[]) => void;
  error?: (message: string, ...args: unknown[]) => void;
}

/**
 * Texts embedded per model call during a flush. The model runs on the main
 * thread, so one call blocks the event loop for as long as it takes (~130 ms
 * per memo). Measured on a real 106-memo backlog: sent as one batch it froze
 * the TUI for 14 s in one stretch; two per call gave a 555 ms worst stall; one
 * per call gives 267 ms (p90 131 ms) and finishes no later. A turn of the event
 * loop between calls keeps the UI responsive while a backlog drains.
 */
export const EMBEDDING_FLUSH_CHUNK_SIZE = 1;

/** How memories were used over a window; numbers only. */
export interface MemoryUseStats {
  readonly total: number;
  readonly added: number;
  readonly recalled: number;
  /** Never recalled, although older than the idle threshold. */
  readonly neverRecalledOld: number;
  /** The most-recalled memos of the window, by id. */
  readonly topRecalled: ReadonlyArray<{ readonly id: string; readonly count: number }>;
}

export class MemoryMemoStore {
  private readonly projectDir: string;
  private readonly jsonlPath: string;
  private readonly dbPath: string;
  private db: DatabaseSync | undefined;
  private initialized = false;
  private writeLock: Promise<unknown> = Promise.resolve();
  private embeddingEngine: EmbeddingEngine | undefined;
  private embeddingQueue = new Set<string>();
  private embeddingTimer: ReturnType<typeof setTimeout> | undefined;
  private embeddingFlushing = false;
  private embeddingDegraded = false;
  private embeddingConsecutiveFailures = 0;
  private lastEmbeddingError: Error | undefined;
  private readonly log: MemoryMemoStoreLogger;
  /**
   * Parsed vectors by memo id, tagged with the row's `created_at`: recall
   * scores every vector on every prompt, and parsing thousands of JSON
   * arrays each time would cost more than the comparison. A re-embedded memo
   * gets a new `created_at`, so its stale entry is never used.
   */
  private readonly vectorCache = new Map<string, { createdAt: number; vector: Float32Array }>();

  constructor(projectDir: string, log?: MemoryMemoStoreLogger) {
    this.projectDir = projectDir;
    this.jsonlPath = join(projectDir, 'memory', FILE_NAME);
    this.dbPath = join(projectDir, 'memory', 'memos.sqlite');
    this.log = log ?? {};
  }

  /**
   * Open the SQLite database and run schema migrations. Call this once after
   * construction before relying on reads/writes.
   *
   * Note on async SQLite: Node.js added the asynchronous `Database` class to
   * `node:sqlite` in v23.4.0 (experimental). This package currently supports
   * Node >=22.0.0 and uses `DatabaseSync` because the v22 type definitions do
   * not yet include `Database`. Once the project baseline moves to Node 23+ and
   * the types catch up, the synchronous calls here should be migrated to the
   * async API to avoid blocking the event loop on large operations.
   */
  private initPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    // Reset the cached promise on failure so a transient error (disk hiccup,
    // locked db) doesn't brick the store for the process lifetime.
    this.initPromise = this._doInit().catch((error: unknown) => {
      this.initPromise = null;
      throw error;
    });
    return this.initPromise;
  }

  private async _doInit(): Promise<void> {
    if (this.initialized) return;
    await this.ensureDir();
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.createSchema();
    await this.migrateFromJsonl();
    this.initialized = true;
  }

  /** Close the database handle and checkpoint WAL. */
  close(): void {
    if (this.embeddingTimer !== undefined) {
      clearTimeout(this.embeddingTimer);
      this.embeddingTimer = undefined;
    }
    this.embeddingQueue.clear();
    if (this.db !== undefined) {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      this.db.close();
      this.db = undefined;
    }
    this.initialized = false;
    this.initPromise = null;
  }

  /** Iterate all memos from the database, newest first. Optionally filter by project directory. */
  async *read(options?: { projectDir?: string }): AsyncIterable<MemoryMemo> {
    await this.init();
    if (this.db === undefined) return;
    const projectDir = options?.projectDir;
    // NOTE: `project_dir = ''` includes legacy memos from before per-project
    // filtering was introduced. This is intentional — project queries always
    // include global/legacy entries alongside the requested project.
    //
    // Rows are fetched in bounded batches with a keyset (seek) cursor instead
    // of LIMIT/OFFSET, so peak memory stays flat on large stores *and* the
    // iteration is a stable snapshot under concurrent writes: every page
    // resumes from the exact (recorded_at, rowid) of the previous page's last
    // row, so an append landing above the cursor mid-iteration cannot push an
    // already-yielded row into the next page (duplicate), and a delete cannot
    // pull one past the window (skip). (recorded_at DESC, rowid DESC) is a
    // total order, so on a quiescent store the yielded sequence — and its
    // tie-breaking — is identical to the previous OFFSET paging.
    const firstPage =
      projectDir === undefined
        ? this.db.prepare(
            'SELECT rowid AS row_id, * FROM memos ORDER BY recorded_at DESC, rowid DESC LIMIT ?',
          )
        : this.db.prepare(
            "SELECT rowid AS row_id, * FROM memos WHERE project_dir = ? OR project_dir = '' ORDER BY recorded_at DESC, rowid DESC LIMIT ?",
          );
    // `?1` is the cursor timestamp (bound once per comparison), `?2` its rowid
    // tiebreaker and `?3` the page size.
    const nextPage =
      projectDir === undefined
        ? this.db.prepare(
            'SELECT rowid AS row_id, * FROM memos WHERE recorded_at < ?1 OR (recorded_at = ?1 AND rowid < ?2) ORDER BY recorded_at DESC, rowid DESC LIMIT ?3',
          )
        : this.db.prepare(
            "SELECT rowid AS row_id, * FROM memos WHERE (project_dir = ?1 OR project_dir = '') AND (recorded_at < ?2 OR (recorded_at = ?2 AND rowid < ?3)) ORDER BY recorded_at DESC, rowid DESC LIMIT ?4",
          );
    let cursor: { recordedAt: number; rowId: number } | undefined;
    for (;;) {
      let rows: Array<Record<string, unknown>>;
      if (cursor === undefined) {
        rows = (
          projectDir === undefined
            ? firstPage.all(READ_BATCH_SIZE)
            : firstPage.all(projectDir, READ_BATCH_SIZE)
        ) as Array<Record<string, unknown>>;
      } else {
        rows = (
          projectDir === undefined
            ? nextPage.all(cursor.recordedAt, cursor.rowId, READ_BATCH_SIZE)
            : nextPage.all(projectDir, cursor.recordedAt, cursor.rowId, READ_BATCH_SIZE)
        ) as Array<Record<string, unknown>>;
      }
      for (const row of rows) {
        yield rowToMemo(row);
      }
      if (rows.length < READ_BATCH_SIZE) return;
      const lastRow = rows.at(-1)!;
      cursor = { recordedAt: Number(lastRow['recorded_at']), rowId: Number(lastRow['row_id']) };
    }
  }

  /**
   * Append a memo — the raw insert. Write paths that can plausibly see the same
   * conclusion twice (extraction, the manual tool) go through
   * `appendUnlessDuplicate` instead; restore paths keep this one.
   */
  async append(entry: MemoryMemo): Promise<void> {
    return this.withWriteLock(() => this.appendInternal(entry));
  }

  /**
   * Append a memo unless the library already holds a near-identical one, in
   * which case nothing is written and the existing id comes back.
   *
   * 0.95 is "the same text again", not "the same idea". At that distance the
   * copy adds a diluted candidate to every future recall and nothing else, while
   * the merge that *would* be right — dream's 0.86, where a model rewrites the
   * combined note — cannot run inline. Skipping the insert is the cheap half:
   * history is untouched, so there is nothing to undo.
   *
   * Runs at write time rather than at flush time because the comparison needs the
   * text's vector now; one local `embedBatch` is the cost, and an unavailable
   * engine simply falls back to inserting (a duplicate is cheaper than a lost
   * memo).
   */
  async appendUnlessDuplicate(
    entry: MemoryMemo,
    options: { readonly engine?: EmbeddingEngine | undefined; readonly threshold?: number } = {},
  ): Promise<{ readonly id: string; readonly duplicateOf?: string | undefined }> {
    const engine = options.engine ?? this.embeddingEngine;
    if (engine === undefined || !engine.available) {
      await this.append(entry);
      return { id: entry.id };
    }
    // A duplicate is cheaper than a lost memo: an embedder that errors (a model
    // that is down, a vector store that is locked) must degrade this check, not
    // fail the write that called it.
    const duplicate = await this.findDuplicate(entry, engine, options.threshold).catch(() => undefined);
    if (duplicate !== undefined) return { id: duplicate, duplicateOf: duplicate };
    await this.append(entry);
    return { id: entry.id };
  }

  /** The id of a memo at least `threshold` similar to `entry`, if any. */
  private async findDuplicate(
    entry: MemoryMemo,
    engine: EmbeddingEngine,
    threshold?: number,
  ): Promise<string | undefined> {
    const vector = await engine.embedBatch([buildEmbeddingText(entry)]).then((batch) => batch?.[0]);
    if (vector === undefined) return undefined;
    const scored = await this.scoreByVector(vector, {
      engine,
      project: {
        projectDir: entry.projectDir,
        ...(entry.projectRoot === undefined ? {} : { projectRoot: entry.projectRoot }),
      },
    });
    const best = scored[0];
    return best !== undefined && best.score >= (threshold ?? WRITE_DUPLICATE_SIMILARITY)
      ? best.id
      : undefined;
  }

  /**
   * True when a memo with the same source session + user need + approach
   * already exists. Used by compaction-summary recovery to re-store memos
   * idempotently after a crash between compaction apply and extraction.
   * The approach field keeps two distinct memos that happen to share the
   * same user need from being collapsed into one.
   */
  existsBySourceAndNeed(sourceSessionId: string, userNeed: string, approach: string): boolean {
    if (this.db === undefined) return false;
    const row = this.db
      .prepare(
        'SELECT 1 FROM memos WHERE source_session_id = ? AND user_need = ? AND approach = ? LIMIT 1',
      )
      .get(sourceSessionId, userNeed, approach);
    return row !== undefined;
  }

  /** Delete a memo by id. */
  async delete(id: string): Promise<boolean> {
    return this.withWriteLock(() => this.deleteInternal(id));
  }

  /** Get a single memo by ID. */
  async get(id: string): Promise<MemoryMemo | undefined> {
    await this.init();
    if (this.db === undefined) return undefined;
    const stmt = this.db.prepare('SELECT * FROM memos WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row !== undefined ? rowToMemo(row) : undefined;
  }

  /**
   * Full-text search over memos using the FTS5 index.
   *
   * Returns raw candidates newest first. Callers that need ranking should pass
   * the results to `rankMemos`. An empty or whitespace-only query returns an
   * empty array.
   */
  async search(
    query: string,
    options?: { candidateLimit?: number; projectDir?: string },
  ): Promise<MemoryMemo[]> {
    await this.init();
    if (this.db === undefined) return [];
    const ftsQuery = buildFtsQuery(query);
    if (ftsQuery === undefined) return [];
    const limit = options?.candidateLimit ?? 200;
    const projectDir = options?.projectDir;
    const stmt =
      projectDir === undefined
        ? this.db.prepare(
            `SELECT m.* FROM memos m
         JOIN memos_fts f ON m.rowid = f.rowid
         WHERE f.memos_fts MATCH ?
         ORDER BY m.recorded_at DESC LIMIT ?`,
          )
        : this.db.prepare(
            `SELECT m.* FROM memos m
         JOIN memos_fts f ON m.rowid = f.rowid
         WHERE f.memos_fts MATCH ? AND (m.project_dir = ? OR m.project_dir = '')
         ORDER BY m.recorded_at DESC LIMIT ?`,
          );
    const rows = (
      projectDir === undefined ? stmt.all(ftsQuery, limit) : stmt.all(ftsQuery, projectDir, limit)
    ) as Array<Record<string, unknown>>;
    // `memos_fts` is contentless and only indexes the five original columns, so
    // a term that appears solely in `distilled` or `note` would be invisible.
    // Union the explicit LIKE matches; ranking (not this stage) decides order.
    const like = likePattern(query);
    const remaining = Math.max(0, limit - rows.length);
    const extraRows = remaining === 0
      ? []
      : ((
          projectDir === undefined
            ? this.db
                .prepare(
                  "SELECT * FROM memos WHERE distilled LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\' ORDER BY recorded_at DESC LIMIT ?",
                )
                .all(like, like, remaining)
            : this.db
                .prepare(
                  "SELECT * FROM memos WHERE (distilled LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\') AND (project_dir = ? OR project_dir = '') ORDER BY recorded_at DESC LIMIT ?",
                )
                .all(like, like, projectDir, remaining)
        ) as Array<Record<string, unknown>>);
    const seen = new Set(rows.map((row) => String(row['id'])));
    const merged = rows.map(rowToMemo);
    for (const row of extraRows) {
      const id = String(row['id']);
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(rowToMemo(row));
    }
    return merged;
  }

  /** List memos with optional full-text search and pagination. */
  async list(options?: {
    search?: string;
    limit?: number;
    offset?: number;
    projectDir?: string;
  }): Promise<MemoryMemoListResult> {
    await this.init();
    if (this.db === undefined) return { memos: [], total: 0 };

    const search = options?.search?.toLowerCase().trim();
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const projectDir = options?.projectDir;

    if (search !== undefined && search.length > 0) {
      let candidates = await this.search(search, { projectDir });
      // Preserve the pre-SQLite behavior: keyword search is intersected with a
      // substring filter so the exact query string must appear somewhere in the
      // memo text.
      if (candidates.length === 0) {
        // Fallback: scan the full store so tags and wording not captured by the
        // FTS index are still considered.
        for await (const memo of this.read({ projectDir })) {
          candidates.push(memo);
        }
      }
      const filtered = candidates.filter((memo) => memoMatchesSearch(memo, search));
      const total = filtered.length;
      return { memos: filtered.slice(offset, offset + limit).map(toSummary), total };
    }

    const { rows, total } = this.listAll(limit, offset, projectDir);
    return { memos: rows.map(toSummary), total };
  }

  /**
   * One-time migration from per-workDir memory stores to a global store.
   * Reads `<screamHomeDir>/sessions/<workDirKey>/memory/entries.jsonl`
   * and appends valid entries to the global SQLite store.
   * Deletes the legacy per-session memory files afterwards and writes a marker
   * file so the migration only runs once.
   */
  static async migrateLegacyStores(screamHomeDir: string): Promise<void> {
    const target = new MemoryMemoStore(screamHomeDir);
    try {
      const markerPath = join(screamHomeDir, 'memory', MIGRATION_MARKER);

      try {
        await stat(markerPath);
        return; // already migrated
      } catch {
        // continue with migration
      }

      const sessionsDir = join(screamHomeDir, 'sessions');
      let sessionEntries: string[];
      try {
        sessionEntries = await readdir(sessionsDir, { withFileTypes: true })
          .then((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name));
      } catch {
        await writeFile(markerPath, '', 'utf8').catch(() => {});
        return;
      }

      const migratedIds = new Set<string>();
      for await (const memo of target.read()) {
        migratedIds.add(memo.id);
      }

      let migratedCount = 0;
      const legacyPaths: string[] = [];
      for (const sessionKey of sessionEntries) {
        const legacyPath = join(sessionsDir, sessionKey, 'memory', FILE_NAME);
        let stream: import('node:fs').ReadStream;
        try {
          stream = createReadStream(legacyPath, { encoding: 'utf8' });
        } catch {
          // Sync error (invalid path) — skip this file.
        }

        // Swallow async ENOENT errors when the legacy file does not exist.
        stream!.on('error', () => {});

        let line = '';
        try {
          for await (const chunk of stream!) {
            line += chunk;
            let newlineIndex = line.indexOf('\n');
            while (newlineIndex !== -1) {
              const rawLine = line.slice(0, newlineIndex).replace(/\r$/, '');
              line = line.slice(newlineIndex + 1);
              newlineIndex = line.indexOf('\n');

              const memo = target.parseLine(rawLine, 0);
              if (memo === undefined || migratedIds.has(memo.id)) continue;
              await target.append(memo);
              migratedIds.add(memo.id);
              migratedCount++;
            }
          }
        } catch {
          continue;
        }

        // Track the file for deletion only if we successfully read its stream.
        // We delete regardless of whether any new entries were migrated; the
        // global store is now the source of truth.
        legacyPaths.push(legacyPath);
      }

      // Delete legacy per-session memory files and empty memory directories.
      for (const legacyPath of legacyPaths) {
        await unlink(legacyPath).catch(() => {});
        await rmdir(dirname(legacyPath)).catch(() => {});
      }

      await writeFile(markerPath, `${migratedCount}\n`, 'utf8').catch(() => {});
    } finally {
      // The migration store is a throwaway handle: release it on every path,
      // including the early returns and the catch/swallow branches above.
      target.close();
    }
  }

  /** @internal */
  parseLine(rawLine: string, _lineNumber: number): MemoryMemo | undefined {
    if (rawLine.length === 0) return undefined;
    try {
      const record = JSON.parse(rawLine) as Record<string, unknown>;
      if (record['type'] !== 'memory_memo' || !record['entry']) return undefined;
      const entry = record['entry'] as Record<string, unknown>;

      // Migrate v1 → v2 field names
      if (record['version'] === 1 || (entry['userRequirement'] !== undefined && entry['userNeed'] === undefined)) {
        const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
        return {
          id: str(entry['id']),
          sourceSessionId: str(entry['sourceSessionId']),
          sourceSessionTitle: str(entry['sourceSessionTitle'], undefined as unknown as string),
          userNeed: str(entry['userRequirement']),
          approach: str(entry['solution']),
          outcome: str(entry['completionStatus']),
          whatFailed: str(entry['problemsEncountered'], 'none'),
          whatWorked: 'none',
          extractionSource: entry['extractionSource'] === 'exit' ? 'exit' : 'compaction',
          recordedAt: typeof entry['recordedAt'] === 'number' ? entry['recordedAt'] : 0,
          projectDir: str(entry['projectDir']),
        };
      }

      // Validate v2 fields that have CHECK constraints
      const src = entry['extractionSource'];
      if (typeof src === 'string' && !['compaction', 'exit', 'manual'].includes(src)) {
        return undefined;
      }

      return entry as unknown as MemoryMemo;
    } catch {
      // Skip corrupted lines
      return undefined;
    }
  }

  private createSchema(): void {
    if (this.db === undefined) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memos (
        id TEXT PRIMARY KEY,
        source_session_id TEXT NOT NULL,
        source_session_title TEXT,
        user_need TEXT NOT NULL,
        approach TEXT NOT NULL,
        outcome TEXT NOT NULL,
        what_failed TEXT NOT NULL DEFAULT 'none',
        what_worked TEXT NOT NULL DEFAULT 'none',
        extraction_source TEXT NOT NULL CHECK(extraction_source IN ('compaction', 'exit', 'manual')),
        recorded_at INTEGER NOT NULL,
        project_dir TEXT NOT NULL DEFAULT '',
        project_root TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        note TEXT,
        distilled TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL DEFAULT 'session',
        distilled_from TEXT,
        distilled_at INTEGER,
        recall_count INTEGER NOT NULL DEFAULT 0,
        last_recalled_at INTEGER,
        dreamed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_memos_project_dir ON memos(project_dir);

      CREATE VIRTUAL TABLE IF NOT EXISTS memos_fts USING fts5(
        user_need,
        approach,
        what_failed,
        what_worked,
        source_session_title,
        content=''
      );

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT PRIMARY KEY REFERENCES memos(id) ON DELETE CASCADE,
        embedding_json TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '${EMBEDDING_MODEL_NAME}',
        created_at INTEGER NOT NULL,
        text_version INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_memory_embeddings_created_at ON memory_embeddings(created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_merges (
        id TEXT PRIMARY KEY,
        merged_id TEXT NOT NULL,
        sources_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    this.migrateSchema();
    this.backfillProjectRoots();
  }

  /**
   * Give memos written before project roots existed the root their directory
   * belongs to, so scoping starts working on an existing library instead of only
   * on new memos. Rows whose directory is not inside a checkout (or is the home
   * directory) stay NULL and keep the directory fallback, which is exactly the
   * leniency they had before.
   *
   * Idempotent: it only touches rows that still have no root, so after the first
   * pass it costs one empty query per start.
   */
  private backfillProjectRoots(): void {
    if (this.db === undefined) return;
    const dirs = this.db
      .prepare("SELECT DISTINCT project_dir FROM memos WHERE project_root IS NULL AND project_dir <> ''")
      .all() as Array<{ project_dir: string }>;
    if (dirs.length === 0) return;
    const update = this.db.prepare(
      'UPDATE memos SET project_root = ? WHERE project_root IS NULL AND project_dir = ?',
    );
    for (const row of dirs) {
      const root = resolveProjectRoot(row.project_dir);
      if (root !== undefined) update.run(root, row.project_dir);
    }
  }

  // Migrate schema: uses PRAGMA table_info column-existence checks rather
  // than PRAGMA user_version. Future migrations should adopt user_version
  // with a numbered migration runner for ordered, idempotent upgrades.
  private migrateSchema(): void {
    if (this.db === undefined) return;
    const info = this.db.prepare('PRAGMA table_info(memos)').all() as Array<{
      name: string;
    }>;
    const hasProjectDir = info.some((col) => col.name === 'project_dir');
    if (!hasProjectDir) {
      this.db.exec("ALTER TABLE memos ADD COLUMN project_dir TEXT NOT NULL DEFAULT ''");
    }
    const hasTags = info.some((col) => col.name === 'tags');
    if (!hasTags) {
      this.db.exec("ALTER TABLE memos ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
    }
    const hasNote = info.some((col) => col.name === 'note');
    if (!hasNote) {
      this.db.exec('ALTER TABLE memos ADD COLUMN note TEXT');
    }
    const hasDistilled = info.some((col) => col.name === 'distilled');
    if (!hasDistilled) {
      this.db.exec("ALTER TABLE memos ADD COLUMN distilled TEXT NOT NULL DEFAULT ''");
    }
    const hasOrigin = info.some((col) => col.name === 'origin');
    if (!hasOrigin) {
      this.db.exec("ALTER TABLE memos ADD COLUMN origin TEXT NOT NULL DEFAULT 'session'");
      // Backfill only on the migration that creates the column: memos that
      // already carry a distilled conclusion were /dream output before
      // `origin` existed. Later edits move them to 'user'.
      this.db.exec("UPDATE memos SET origin = 'dream' WHERE distilled <> ''");
    }
    const hasDistilledFrom = info.some((col) => col.name === 'distilled_from');
    if (!hasDistilledFrom) {
      this.db.exec('ALTER TABLE memos ADD COLUMN distilled_from TEXT');
    }
    const hasDistilledAt = info.some((col) => col.name === 'distilled_at');
    if (!hasDistilledAt) {
      this.db.exec('ALTER TABLE memos ADD COLUMN distilled_at INTEGER');
    }
    if (!info.some((col) => col.name === 'recall_count')) {
      this.db.exec('ALTER TABLE memos ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0');
    }
    if (!info.some((col) => col.name === 'last_recalled_at')) {
      this.db.exec('ALTER TABLE memos ADD COLUMN last_recalled_at INTEGER');
    }
    if (!info.some((col) => col.name === 'dreamed_at')) {
      // Last time /dream looked at this memo. NULL means "never considered", so
      // an existing library is processed once and then stays incremental.
      this.db.exec('ALTER TABLE memos ADD COLUMN dreamed_at INTEGER');
    }
    if (!info.some((col) => col.name === 'project_root')) {
      // The git root the memo belongs to. Older rows keep NULL and stay on the
      // directory fallback in `isSameProject`, so nothing becomes unreachable.
      this.db.exec('ALTER TABLE memos ADD COLUMN project_root TEXT');
    }
    const embeddingInfo = this.db.prepare('PRAGMA table_info(memory_embeddings)').all() as Array<{
      name: string;
    }>;
    if (!embeddingInfo.some((col) => col.name === 'text_version')) {
      // Existing rows were built from an older `buildEmbeddingText` shape and
      // default to version 1, which the backfill treats as stale and re-embeds.
      this.db.exec('ALTER TABLE memory_embeddings ADD COLUMN text_version INTEGER NOT NULL DEFAULT 1');
    }
    // Ensure indexes exist even for databases created before these indexes were added.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memos_project_dir ON memos(project_dir);
      CREATE INDEX IF NOT EXISTS idx_memos_project_root ON memos(project_root);
      CREATE INDEX IF NOT EXISTS idx_memory_embeddings_created_at ON memory_embeddings(created_at DESC);
    `);
  }

  private async migrateFromJsonl(): Promise<void> {
    const markerPath = join(this.projectDir, 'memory', SQLITE_MIGRATION_MARKER);
    try {
      await stat(markerPath);
      return;
    } catch {
      // continue with migration
    }

    const memos: MemoryMemo[] = [];
    let stream: import('node:fs').ReadStream;
    try {
      stream = createReadStream(this.jsonlPath, { encoding: 'utf8' });
    } catch {
      // Sync error (invalid path) — nothing to migrate.
      await writeFile(markerPath, '', 'utf8').catch(() => {});
      return;
    }

    // Swallow async ENOENT errors when the legacy file does not exist.
    stream!.on('error', () => {});

    let line = '';
    try {
      for await (const chunk of stream!) {
        line += chunk;
        let newlineIndex = line.indexOf('\n');
        while (newlineIndex !== -1) {
          const rawLine = line.slice(0, newlineIndex).replace(/\r$/, '');
          line = line.slice(newlineIndex + 1);
          newlineIndex = line.indexOf('\n');
          const memo = this.parseLine(rawLine, 0);
          if (memo !== undefined) memos.push(memo);
        }
      }
    } catch {
      // Ignore read errors and migrate whatever we have.
    }

    if (memos.length > 0) {
      this.insertMany(memos);
    }

    await writeFile(markerPath, '', 'utf8').catch(() => {});
    // Keep the legacy file as a backup; remove the old in-memory index.
    await rename(this.jsonlPath, `${this.jsonlPath}.bak`).catch(() => {});
    await unlink(join(this.projectDir, 'memory', 'index.json')).catch(() => {});
  }

  private insertMany(memos: readonly MemoryMemo[]): void {
    if (this.db === undefined || memos.length === 0) return;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO memos (
        id, source_session_id, source_session_title, user_need, approach,
        outcome, what_failed, what_worked, extraction_source, recorded_at, project_dir, tags,
        note, distilled, origin, distilled_from, distilled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING rowid`,
    );
    const insertFts = this.db.prepare(
      `INSERT INTO memos_fts(rowid, user_need, approach, what_failed, what_worked, source_session_title)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN TRANSACTION');
    try {
      for (const memo of memos) {
        const row = insert.get(
          memo.id,
          memo.sourceSessionId,
          memo.sourceSessionTitle ?? null,
          memo.userNeed,
          memo.approach,
          memo.outcome,
          memo.whatFailed,
          memo.whatWorked,
          memo.extractionSource,
          memo.recordedAt,
          memo.projectDir ?? '',
          JSON.stringify(memo.tags ?? []),
          memo.note ?? null,
          memo.distilled ?? '',
          memo.origin ?? 'session',
          stringifyDistilledFrom(memo.distilledFrom),
          memo.distilledAt ?? null,
        ) as { rowid: number } | undefined;
        // INSERT OR IGNORE yields no RETURNING row on duplicates — skip the
        // FTS row instead of crashing the whole migration.
        if (row === undefined) continue;
        insertFts.run(
          row.rowid,
          toFtsText(memo.userNeed),
          toFtsText(memo.approach),
          toFtsText(memo.whatFailed),
          toFtsText(memo.whatWorked),
          toFtsText(memo.sourceSessionTitle ?? ''),
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw new Error(`Failed to migrate memos to SQLite: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  private async appendInternal(entry: MemoryMemo): Promise<void> {
    await this.init();
    if (this.db === undefined) return;
    const insert = this.db.prepare(
      `INSERT INTO memos (
        id, source_session_id, source_session_title, user_need, approach,
        outcome, what_failed, what_worked, extraction_source, recorded_at, project_dir, project_root, tags,
        note, distilled, origin, distilled_from, distilled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING rowid`,
    );
    const insertFts = this.db.prepare(
      `INSERT INTO memos_fts(rowid, user_need, approach, what_failed, what_worked, source_session_title)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN TRANSACTION');
    try {
      const row = insert.get(
        entry.id,
        entry.sourceSessionId,
        entry.sourceSessionTitle ?? null,
        entry.userNeed,
        entry.approach,
        entry.outcome,
        entry.whatFailed,
        entry.whatWorked,
        entry.extractionSource,
        entry.recordedAt,
        entry.projectDir ?? '',
        entry.projectRoot ?? null,
        JSON.stringify(entry.tags ?? []),
        entry.note ?? null,
        entry.distilled ?? '',
        entry.origin ?? 'session',
        stringifyDistilledFrom(entry.distilledFrom),
        entry.distilledAt ?? null,
      ) as { rowid: number };
      insertFts.run(
        row.rowid,
        toFtsText(entry.userNeed),
        toFtsText(entry.approach),
        toFtsText(entry.whatFailed),
        toFtsText(entry.whatWorked),
        toFtsText(entry.sourceSessionTitle ?? ''),
      );
      this.db.exec('COMMIT');
      this.scheduleEmbedding(entry);
    } catch {
      this.db.exec('ROLLBACK');
      throw new Error('Failed to append memo');
    }
  }

  /** Update a memo by id. Returns true if the memo existed and was updated. */
  async update(id: string, patch: Partial<Omit<MemoryMemo, 'id'>>): Promise<boolean> {
    return this.withWriteLock(() => this.updateInternal(id, patch));
  }

  /** @internal */
  private async updateInternal(
    id: string,
    patch: Partial<Omit<MemoryMemo, 'id'>>,
  ): Promise<boolean> {
    await this.init();
    if (this.db === undefined) return false;

    const existing = await this.get(id);
    if (existing === undefined) return false;

    const updated: MemoryMemo = { ...existing, ...patch };
    const selectRow = this.db.prepare('SELECT rowid FROM memos WHERE id = ?');
    const update = this.db.prepare(
      `UPDATE memos SET
        rowid = (SELECT COALESCE(MAX(rowid), 0) + 1 FROM memos),
        source_session_id = ?,
        source_session_title = ?,
        user_need = ?,
        approach = ?,
        outcome = ?,
        what_failed = ?,
        what_worked = ?,
        extraction_source = ?,
        recorded_at = ?,
        project_dir = ?,
        tags = ?,
        note = ?,
        distilled = ?,
        origin = ?,
        distilled_from = ?,
        distilled_at = ?
      WHERE id = ?
      RETURNING rowid`,
    );
    const updateFts = this.db.prepare(
      `INSERT INTO memos_fts(rowid, user_need, approach, what_failed, what_worked, source_session_title)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const deleteFts = this.db.prepare(
      "INSERT INTO memos_fts(memos_fts, rowid) VALUES ('delete', ?)",
    );
    const deleteEmbedding = this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?');
    this.db.exec('BEGIN TRANSACTION');
    try {
      const oldRow = selectRow.get(id) as { rowid: number } | undefined;
      if (oldRow === undefined) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const row = update.get(
        updated.sourceSessionId,
        updated.sourceSessionTitle ?? null,
        updated.userNeed,
        updated.approach,
        updated.outcome,
        updated.whatFailed,
        updated.whatWorked,
        updated.extractionSource,
        updated.recordedAt,
        updated.projectDir ?? '',
        JSON.stringify(updated.tags ?? []),
        updated.note ?? null,
        updated.distilled ?? '',
        updated.origin ?? 'session',
        stringifyDistilledFrom(updated.distilledFrom),
        updated.distilledAt ?? null,
        id,
      ) as { rowid: number } | undefined;
      if (row === undefined) {
        this.db.exec('ROLLBACK');
        return false;
      }
      deleteFts.run(oldRow.rowid);
      updateFts.run(
        row.rowid,
        toFtsText(updated.userNeed),
        toFtsText(updated.approach),
        toFtsText(updated.whatFailed),
        toFtsText(updated.whatWorked),
        toFtsText(updated.sourceSessionTitle ?? ''),
      );
      // Content changed — drop the stale embedding so the re-scheduled one
      // isn't skipped by flushEmbeddings' "already has embedding" check.
      deleteEmbedding.run(id);
      this.db.exec('COMMIT');
      this.scheduleEmbedding(updated);
      return true;
    } catch {
      this.db.exec('ROLLBACK');
      throw new Error('Failed to update memo');
    }
  }

  private async deleteInternal(id: string): Promise<boolean> {
    await this.init();
    if (this.db === undefined) return false;
    const selectRow = this.db.prepare('SELECT rowid FROM memos WHERE id = ?');
    const row = selectRow.get(id) as { rowid: number } | undefined;
    if (row === undefined) return true;
    const deleteFts = this.db.prepare(
      "INSERT INTO memos_fts(memos_fts, rowid) VALUES ('delete', ?)",
    );
    const deleteMemo = this.db.prepare('DELETE FROM memos WHERE id = ?');
    this.db.exec('BEGIN TRANSACTION');
    try {
      deleteFts.run(row.rowid);
      deleteMemo.run(id);
      this.db.exec('COMMIT');
      return true;
    } catch {
      this.db.exec('ROLLBACK');
      throw new Error('Failed to delete memo');
    }
  }

  /** Set the embedding engine. Call once after construction, before any writes. */
  setEmbeddingEngine(engine: EmbeddingEngine): void {
    this.embeddingEngine = engine;
  }

  /** Vectors for every memo that has one, keyed by memo id. Used by the
   * consolidation planner to find near-duplicates with the same similarity
   * measure recall uses, instead of a keyword heuristic. */
  async allVectors(): Promise<Map<string, Float32Array>> {
    await this.init();
    const vectors = new Map<string, Float32Array>();
    if (this.db === undefined) return vectors;
    const rows = this.db
      .prepare(
        `SELECT e.memory_id AS id, e.embedding_json AS json
         FROM memory_embeddings e
         JOIN memos m ON m.id = e.memory_id`,
      )
      .all() as Array<{ id: string; json: string }>;
    for (const row of rows) {
      try {
        const parsed: unknown = JSON.parse(row.json);
        if (Array.isArray(parsed)) vectors.set(row.id, Float32Array.from(parsed as number[]));
      } catch {
        // A malformed row is simply treated as having no vector.
      }
    }
    return vectors;
  }

  /** Stamp memos as looked at by /dream. Called once per run for every memo it
   * considered, whether or not the memo changed — that is what keeps the next
   * run incremental instead of re-proposing the same items forever. */
  async markDreamed(ids: readonly string[], at: number = Date.now()): Promise<void> {
    if (ids.length === 0) return;
    await this.init();
    if (this.db === undefined) return;
    const statement = this.db.prepare('UPDATE memos SET dreamed_at = ? WHERE id = ?');
    this.db.exec('BEGIN TRANSACTION');
    try {
      for (const id of ids) statement.run(at, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Record how a merge was produced so `revertMerge` can undo it later. The
   * snapshot is the full memo, not just ids — a deleted memo cannot be looked up
   * afterwards. */
  async recordMerge(mergedId: string, sources: readonly MemoryMemo[]): Promise<void> {
    await this.init();
    if (this.db === undefined) return;
    this.db
      .prepare('INSERT OR REPLACE INTO memory_merges (id, merged_id, sources_json, created_at) VALUES (?, ?, ?, ?)')
      .run(mergedId, mergedId, JSON.stringify(sources), Date.now());
  }

  /** Undo a merge: restore the source memos from the snapshot and drop the
   * merged result. Returns false when the merge id is unknown. */
  async revertMerge(mergeId: string): Promise<boolean> {
    await this.init();
    if (this.db === undefined) return false;
    const row = this.db
      .prepare('SELECT merged_id AS mergedId, sources_json AS sources FROM memory_merges WHERE id = ?')
      .get(mergeId) as { mergedId: string; sources: string } | undefined;
    if (row === undefined) return false;
    let sources: MemoryMemo[];
    try {
      const parsed: unknown = JSON.parse(row.sources);
      if (!Array.isArray(parsed)) return false;
      sources = parsed as MemoryMemo[];
    } catch {
      return false;
    }
    for (const memo of sources) {
      if ((await this.get(memo.id)) === undefined) await this.append(memo);
    }
    await this.delete(row.mergedId);
    this.db.prepare('DELETE FROM memory_merges WHERE id = ?').run(mergeId);
    return true;
  }

  /** Check whether the store has any vector embeddings. */
  hasEmbeddings(): boolean {
    if (this.db === undefined) return false;
    const row = this.db.prepare('SELECT COUNT(*) as count FROM memory_embeddings').get() as
      | { count: number }
      | undefined;
    return (row?.count ?? 0) > 0;
  }

  /** Access the embedding engine (may be undefined if not configured). */
  getEmbeddingEngine(): EmbeddingEngine | undefined {
    return this.embeddingEngine;
  }

  /**
   * How many memos carry a vector — of one project (legacy memos without a
   * project count for every project, as in search) or of all of them.
   */
  countEmbedded(projectDir?: string): number {
    if (this.db === undefined) return 0;
    const row = (
      projectDir === undefined
        ? this.db.prepare('SELECT COUNT(*) AS count FROM memory_embeddings').get()
        : this.db
            .prepare(
              `SELECT COUNT(*) AS count FROM memory_embeddings e
               JOIN memos m ON m.id = e.memory_id
               WHERE m.project_dir = ? OR m.project_dir = ''`,
            )
            .get(projectDir)
    ) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /**
   * Cosine similarity of the query to the candidate vectors, highest first.
   * Reads no memo rows, so a caller can look at the whole distribution and load
   * only the few memos it keeps.
   *
   * With `project`, candidates are chosen in two tiers: every memo of that
   * project is scored however old it is, while cross-project memos are capped
   * newest-first (`crossProjectLimit`). The single recency window this replaces
   * — newest 2000 overall — silently made older memos unreachable once a library
   * grew past the cap, which is a correctness cliff, not a performance trade.
   */
  async scoreByVector(
    queryEmbedding: Float32Array,
    options: {
      readonly candidateLimit?: number;
      readonly project?:
        | { readonly projectRoot?: string | undefined; readonly projectDir: string }
        | undefined;
      readonly crossProjectLimit?: number;
      /** Overrides the store's engine — a caller that just embedded the query itself. */
      readonly engine?: EmbeddingEngine | undefined;
    } = {},
  ): Promise<Array<{ id: string; score: number }>> {
    await this.init();
    const engine = options.engine ?? this.embeddingEngine;
    if (this.db === undefined || engine === undefined) return [];
    const rows = this.candidateVectors(options);
    const readVector = this.db.prepare('SELECT embedding_json FROM memory_embeddings WHERE memory_id = ?');
    const live = new Set<string>();
    const scored: Array<{ id: string; score: number }> = [];
    for (const row of rows) {
      live.add(row.memory_id);
      let cached = this.vectorCache.get(row.memory_id);
      if (cached === undefined || cached.createdAt !== row.created_at) {
        const stored = readVector.get(row.memory_id) as { embedding_json: string } | undefined;
        if (stored === undefined) continue;
        try {
          cached = { createdAt: row.created_at, vector: new Float32Array(JSON.parse(stored.embedding_json) as number[]) };
        } catch {
          continue; // a corrupted vector
        }
        this.vectorCache.set(row.memory_id, cached);
      }
      if (cached.vector.length !== queryEmbedding.length) continue;
      scored.push({ id: row.memory_id, score: engine.cosineSimilarity(queryEmbedding, cached.vector) });
    }
    // Forget vectors of memos that are gone — but only when the sample covered
    // the library, otherwise the cross-project cap would evict live entries.
    if (options.project === undefined) {
      for (const id of this.vectorCache.keys()) if (!live.has(id)) this.vectorCache.delete(id);
    }
    return scored.toSorted((a, b) => b.score - a.score);
  }

  /**
   * The vectors worth scoring for one query (see `scoreByVector`): the project's
   * memos whole, everything else capped newest-first.
   */
  private candidateVectors(options: {
    readonly candidateLimit?: number;
    readonly project?: { readonly projectRoot?: string | undefined; readonly projectDir: string } | undefined;
    readonly crossProjectLimit?: number;
  }): Array<{ memory_id: string; created_at: number }> {
    if (this.db === undefined) return [];
    const project = options.project;
    if (project === undefined) {
      return this.db
        .prepare('SELECT memory_id, created_at FROM memory_embeddings ORDER BY created_at DESC LIMIT ?')
        .all(options.candidateLimit ?? 2000) as Array<{ memory_id: string; created_at: number }>;
    }
    // Written so no comparison can yield NULL: a NULL in a WHERE triple would
    // make `NOT (...)` NULL as well, and silently drop every row whose root is
    // unset — i.e. exactly the memos the fallback exists for.
    const sameProject = `((m.project_root IS NOT NULL AND m.project_root = ?) OR (m.project_root IS NULL AND (m.project_dir = ? OR m.project_dir = '')))`;
    const root = project.projectRoot ?? null;
    const same = this.db
      .prepare(
        `SELECT e.memory_id AS memory_id, e.created_at AS created_at
           FROM memory_embeddings e JOIN memos m ON m.id = e.memory_id
          WHERE ${sameProject}`,
      )
      .all(root, project.projectDir) as Array<{ memory_id: string; created_at: number }>;
    const cross = this.db
      .prepare(
        `SELECT e.memory_id AS memory_id, e.created_at AS created_at
           FROM memory_embeddings e JOIN memos m ON m.id = e.memory_id
          WHERE NOT ${sameProject}
          ORDER BY e.created_at DESC LIMIT ?`,
      )
      .all(root, project.projectDir, options.crossProjectLimit ?? 2000) as Array<{
      memory_id: string;
      created_at: number;
    }>;
    return [...same, ...cross];
  }

  /** One memo's stored vector, from the cache `scoreByVector` fills. */
  vectorOf(id: string): Float32Array | undefined {
    const cached = this.vectorCache.get(id);
    if (cached !== undefined) return cached.vector;
    if (this.db === undefined) return undefined;
    const row = this.db
      .prepare('SELECT embedding_json, created_at FROM memory_embeddings WHERE memory_id = ?')
      .get(id) as { embedding_json: string; created_at: number } | undefined;
    if (row === undefined) return undefined;
    try {
      const vector = new Float32Array(JSON.parse(row.embedding_json) as number[]);
      this.vectorCache.set(id, { createdAt: row.created_at, vector });
      return vector;
    } catch {
      return undefined;
    }
  }

  /**
   * Record that these memos were brought back into a conversation (recalled
   * automatically, or returned by a lookup). Bookkeeping only: the content,
   * its vector and the full-text index are untouched, and the change history
   * leaves these counters out.
   */
  async markRecalled(ids: readonly string[], at: number = Date.now()): Promise<void> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    await this.withWriteLock(async () => {
      await this.init();
      if (this.db === undefined) return;
      const mark = this.db.prepare(
        'UPDATE memos SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ?',
      );
      this.db.exec('BEGIN TRANSACTION');
      try {
        for (const id of unique) mark.run(at, id);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  /**
   * How memories were used, as numbers only (what the weekly self-review is
   * given): how many exist, how many were added and how many were brought
   * back since `since`, the most-recalled ones of that window by id, and how
   * many were never recalled although older than `idleBefore`.
   */
  async useStats(since: number, idleBefore: number): Promise<MemoryUseStats> {
    await this.init();
    const empty: MemoryUseStats = { total: 0, added: 0, recalled: 0, neverRecalledOld: 0, topRecalled: [] };
    if (this.db === undefined) return empty;
    const count = (sql: string, ...params: number[]): number =>
      ((this.db!.prepare(sql).get(...params) as { count: number } | undefined)?.count ?? 0);
    const topRecalled = (
      this.db
        .prepare(
          'SELECT id, recall_count AS count FROM memos WHERE last_recalled_at >= ? ORDER BY recall_count DESC, last_recalled_at DESC LIMIT 5',
        )
        .all(since) as Array<{ id: string; count: number }>
    ).map((row) => ({ id: row.id, count: row.count }));
    return {
      total: count('SELECT COUNT(*) AS count FROM memos'),
      added: count('SELECT COUNT(*) AS count FROM memos WHERE recorded_at >= ?', since),
      recalled: count('SELECT COUNT(*) AS count FROM memos WHERE last_recalled_at >= ?', since),
      neverRecalledOld: count(
        'SELECT COUNT(*) AS count FROM memos WHERE recall_count = 0 AND recorded_at < ?',
        idleBefore,
      ),
      topRecalled,
    };
  }

  /**
   * Search memos by vector similarity. Returns memos sorted by cosine
   * similarity (highest first). Falls back to empty if no embeddings exist.
   *
   * NOTE: candidates are ordered by created_at DESC, so only the newest
   * N embeddings are considered. Older but highly relevant memos may be
   * omitted when the store has more than candidateLimit embeddings.
   * This is a known limitation — see M-M5 in project review notes.
   * Performance notes:
   * - candidateLimit bounds the SQL query so we never load every embedding.
   * - recencyCutoffDays lets callers ignore very old memos.
   * - projectDir is pushed into the SQL JOIN so unrelated projects are not
   *   considered at all.
   */
  async searchByVector(
    queryEmbedding: Float32Array,
    options?: {
      candidateLimit?: number;
      projectDir?: string;
      recencyCutoffDays?: number;
    },
  ): Promise<Array<{ memo: MemoryMemo; score: number }>> {
    await this.init();
    if (this.db === undefined) return [];

    const limit = options?.candidateLimit ?? 200;
    const projectDir = options?.projectDir;
    const recencyCutoffDays = options?.recencyCutoffDays;
    const cutoffMs =
      recencyCutoffDays !== undefined && recencyCutoffDays > 0
        ? Date.now() - recencyCutoffDays * 24 * 60 * 60 * 1000
        : undefined;

    let rows: Array<{ memory_id: string; embedding_json: string }>;
    if (projectDir !== undefined) {
      const stmt =
        cutoffMs === undefined
          ? this.db.prepare(`
              SELECT e.memory_id, e.embedding_json
              FROM memory_embeddings e
              JOIN memos m ON m.id = e.memory_id
              WHERE (m.project_dir = ? OR m.project_dir = '')
              ORDER BY e.created_at DESC
              LIMIT ?
            `)
          : this.db.prepare(`
              SELECT e.memory_id, e.embedding_json
              FROM memory_embeddings e
              JOIN memos m ON m.id = e.memory_id
              WHERE (m.project_dir = ? OR m.project_dir = '')
                AND e.created_at > ?
              ORDER BY e.created_at DESC
              LIMIT ?
            `);
      rows = (cutoffMs === undefined
        ? stmt.all(projectDir, limit)
        : stmt.all(projectDir, cutoffMs, limit)) as Array<{
        memory_id: string;
        embedding_json: string;
      }>;
    } else {
      const stmt =
        cutoffMs === undefined
          ? this.db.prepare(
              'SELECT memory_id, embedding_json FROM memory_embeddings ORDER BY created_at DESC LIMIT ?',
            )
          : this.db.prepare(
              'SELECT memory_id, embedding_json FROM memory_embeddings WHERE created_at > ? ORDER BY created_at DESC LIMIT ?',
            );
      rows = (cutoffMs === undefined
        ? stmt.all(limit)
        : stmt.all(cutoffMs, limit)) as Array<{
        memory_id: string;
        embedding_json: string;
      }>;
    }

    if (rows.length === 0) return [];

    const scored: Array<{ id: string; score: number }> = [];
    for (const row of rows) {
      try {
        const vec = new Float32Array(JSON.parse(row.embedding_json) as number[]);
        const similarity = this.embeddingEngine?.cosineSimilarity(queryEmbedding, vec) ?? 0;
        if (similarity > 0) {
          scored.push({ id: row.memory_id, score: similarity });
        }
      } catch {
        // Skip corrupted embeddings
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const topScored = scored.slice(0, limit);

    const results: Array<{ memo: MemoryMemo; score: number }> = [];
    for (const { id, score } of topScored) {
      const row = this.db
        .prepare('SELECT * FROM memos WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined;
      if (row !== undefined) {
        results.push({ memo: rowToMemo(row), score });
      }
    }

    return results;
  }

  /**
   * Schedule async embedding generation for a memo. Debounced — the actual
   * batch flush runs after a short quiet period. Never blocks the caller.
   */
  scheduleEmbedding(memo: MemoryMemo): void {
    // Always enqueue — never drop. If the engine isn't ready yet, kick an
    // async model load; a late-ready engine flushes the preserved queue.
    this.embeddingQueue.add(memo.id);
    this.armEmbeddingFlush();
  }

  /**
   * Queue every memo that has no vector yet (newest first, at most `limit`) and
   * arm a flush. Memos written while embeddings could not be stored — or before
   * an engine existed — would otherwise never get one: `scheduleEmbedding` only
   * runs for a write. Safe to call repeatedly; already-embedded memos are
   * skipped by the SQL.
   *
   * Loading the engine can download the model, which must stay the user's
   * decision, so an engine that is not loaded yet is left alone unless the
   * caller passes `loadEngine` (it knows the model is already on disk).
   */
  async backfillMissingEmbeddings(
    options: { readonly limit?: number; readonly loadEngine?: boolean } = {},
  ): Promise<number> {
    const engine = this.embeddingEngine;
    if (engine === undefined) return 0;
    if (!engine.available && options.loadEngine !== true) return 0;
    await this.init();
    if (this.db === undefined) return 0;
    const limit = Math.max(0, Math.floor(options.limit ?? 500));
    const rows = this.db
      .prepare(
        `SELECT m.id AS id FROM memos m
         WHERE NOT EXISTS (SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id)
            OR EXISTS (
              SELECT 1 FROM memory_embeddings e
              WHERE e.memory_id = m.id AND e.text_version < ?
            )
         ORDER BY m.recorded_at DESC
         LIMIT ?`,
      )
      .all(EMBEDDING_TEXT_VERSION, limit) as Array<{ id: string }>;
    for (const row of rows) this.embeddingQueue.add(row.id);
    if (rows.length > 0) this.armEmbeddingFlush();
    return rows.length;
  }

  /** Debounced flush of the queue, loading the engine first when it is not ready yet. */
  private armEmbeddingFlush(): void {
    if (this.embeddingEngine === undefined) return;
    if (!this.embeddingEngine.available) {
      void this.embeddingEngine
        .ensureReady()
        .then((ready) => {
          if (
            ready &&
            this.embeddingQueue.size > 0 &&
            this.embeddingTimer === undefined
          ) {
            this.embeddingTimer = setTimeout(() => {
              void this.flushEmbeddings();
            }, 2000);
          }
        })
        .catch(() => {});
      return;
    }
    if (this.embeddingTimer !== undefined) {
      clearTimeout(this.embeddingTimer);
    }
    // Debounce 2s — wait for a batch of writes to settle before flushing.
    this.embeddingTimer = setTimeout(() => {
      void this.flushEmbeddings();
    }, 2000);
  }

  /**
   * Flush queued embedding generation. Retries once on failure to tolerate
   * transient model-load contention, then marks embeddings as degraded and
   * logs the problem. Callers can still retrieve memos through keyword search.
   */
  private async flushEmbeddings(): Promise<void> {
    if (
      this.embeddingFlushing ||
      this.embeddingEngine === undefined ||
      !this.embeddingEngine.available
    ) {
      return;
    }

    this.embeddingFlushing = true;

    // Snapshot the queue up front (so failures below can restore it). `owed` is
    // what still needs a vector: everything queued at first, then only the memos
    // after the last chunk that was stored — a failure puts back exactly that.
    const ids = [...this.embeddingQueue];
    this.embeddingQueue.clear();
    let owed: readonly string[] = ids;
    let failed = false;
    const requeueOwed = (): void => {
      for (const id of owed) {
        this.embeddingQueue.add(id);
      }
    };

    try {
      await this.init();
      if (this.db === undefined) return;

      // Collect memos that still need embeddings. A row written from an older
      // text shape counts as missing: the backfill queues those ids on purpose,
      // and skipping them here (any row at all was treated as done) is why a
      // distilled rule never reached the vector of an existing memo.
      const pending: Array<{ id: string; text: string }> = [];
      const readVersion = this.db.prepare(
        'SELECT text_version AS version FROM memory_embeddings WHERE memory_id = ?',
      );
      for (const id of ids) {
        const row = readVersion.get(id) as { version: number | null } | undefined;
        if (row !== undefined && (row.version ?? 1) >= EMBEDDING_TEXT_VERSION) continue;

        const memo = await this.get(id);
        if (memo !== undefined) {
          pending.push({ id, text: buildEmbeddingText(memo) });
        }
      }
      owed = pending.map((entry) => entry.id);

      // Embed and store in small chunks (see EMBEDDING_FLUSH_CHUNK_SIZE), each in
      // its own transaction, with a turn of the event loop between them. A chunk
      // that fails leaves the earlier ones stored and the rest owed.
      for (let start = 0; start < pending.length; start += EMBEDDING_FLUSH_CHUNK_SIZE) {
        const db = this.db;
        if (db === undefined) {
          failed = true; // closed mid-flush: put the rest back, do not re-arm
          requeueOwed();
          return;
        }
        const chunk = pending.slice(start, start + EMBEDDING_FLUSH_CHUNK_SIZE);
        const vectors = await this.tryEmbedBatch(chunk.map((entry) => entry.text));
        if (vectors === null || vectors.length !== chunk.length) {
          this.markEmbeddingFailure(
            new Error(vectors === null ? 'embedBatch returned null' : 'embedding count mismatch'),
          );
          // Re-enqueue the failed ids so a later flush (triggered by the next
          // write, or by a late-ready engine) retries them — honoring the
          // "caller retries on the next flush" contract in embeddings.ts.
          failed = true;
          requeueOwed();
          return;
        }

        this.clearEmbeddingFailure();

        const insert = db.prepare(
          'INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding_json, model, created_at, text_version) VALUES (?, ?, ?, ?, ?)',
        );
        const now = Date.now();
        db.exec('BEGIN TRANSACTION');
        try {
          for (const [index, entry] of chunk.entries()) {
            insert.run(
              entry.id,
              JSON.stringify([...vectors[index]!]),
              EMBEDDING_MODEL_NAME,
              now,
              EMBEDDING_TEXT_VERSION,
            );
          }
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          this.markEmbeddingFailure(error instanceof Error ? error : new Error(String(error)));
          failed = true;
          requeueOwed();
          return;
        }
        owed = pending.slice(start + chunk.length).map((entry) => entry.id);

        if (owed.length > 0) {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
      }
    } catch (error) {
      this.markEmbeddingFailure(error instanceof Error ? error : new Error(String(error)));
      failed = true;
      requeueOwed();
    } finally {
      this.embeddingFlushing = false;
      // Clear the timer reference so scheduleEmbedding's ensureReady path
      // (which checks `embeddingTimer === undefined`) can arm a new flush
      // after a late engine load. Without this, the first flush leaves the
      // timer stale and subsequent late-ready writes never trigger a flush.
      this.embeddingTimer = undefined;
      // Memos queued while this flush was running (a backlog takes seconds) would
      // otherwise wait for the next write. Only after a clean run: re-arming after
      // a failure would retry a broken engine every couple of seconds forever.
      if (!failed && this.embeddingQueue.size > 0) this.armEmbeddingFlush();
    }
  }

  private async tryEmbedBatch(texts: string[]): Promise<Float32Array[] | null> {
    if (this.embeddingEngine === undefined) return null;
    // First attempt.
    try {
      const first = await this.embeddingEngine.embedBatch(texts);
      if (first !== null) return first;
    } catch {
      // Fall through to one retry.
    }
    // One immediate retry in case the failure was transient (e.g. model file
    // contention during parallel process startup).
    try {
      return await this.embeddingEngine.embedBatch(texts);
    } catch {
      return null;
    }
  }

  private markEmbeddingFailure(error: Error): void {
    this.embeddingDegraded = true;
    this.embeddingConsecutiveFailures += 1;
    this.lastEmbeddingError = error;
    this.log.warn?.('embedding flush failed', {
      error: error.message,
      consecutiveFailures: this.embeddingConsecutiveFailures,
    });
  }

  private clearEmbeddingFailure(): void {
    this.embeddingDegraded = false;
    this.embeddingConsecutiveFailures = 0;
    this.lastEmbeddingError = undefined;
  }

  /**
   * Runtime health of the embedding subsystem. When `degraded` is true, the
   * store still serves keyword search; only vector similarity is unavailable.
   */
  embeddingStatus(): {
    available: boolean;
    degraded: boolean;
    consecutiveFailures: number;
    lastError?: string;
  } {
    return {
      available: this.embeddingEngine !== undefined && this.embeddingEngine.available,
      degraded: this.embeddingDegraded,
      consecutiveFailures: this.embeddingConsecutiveFailures,
      lastError: this.lastEmbeddingError?.message,
    };
  }

  private listAll(limit: number, offset: number, projectDir?: string): { rows: MemoryMemo[]; total: number } {
    if (this.db === undefined) return { rows: [], total: 0 };
    const countStmt =
      projectDir === undefined
        ? this.db.prepare('SELECT COUNT(*) as total FROM memos')
        : this.db.prepare("SELECT COUNT(*) as total FROM memos WHERE project_dir = ? OR project_dir = ''");
    const countRow = (
      projectDir === undefined ? countStmt.get() : countStmt.get(projectDir)
    ) as { total: number } | undefined;
    const total = countRow?.total ?? 0;
    const stmt =
      projectDir === undefined
        ? this.db.prepare('SELECT * FROM memos ORDER BY recorded_at DESC LIMIT ? OFFSET ?')
        : this.db.prepare(
            "SELECT * FROM memos WHERE project_dir = ? OR project_dir = '' ORDER BY recorded_at DESC LIMIT ? OFFSET ?",
          );
    const rows = (
      projectDir === undefined ? stmt.all(limit, offset) : stmt.all(projectDir, limit, offset)
    ) as Array<Record<string, unknown>>;
    return { rows: rows.map(rowToMemo), total };
  }

  private async ensureDir(): Promise<void> {
    await mkdir(dirname(this.dbPath), { recursive: true });
  }

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.writeLock;
    const next = previous.then(fn, fn);
    this.writeLock = next;
    return next;
  }
}

function rowToMemo(row: Record<string, unknown>): MemoryMemo {
  const sourceSessionTitle = row['source_session_title'];
  const projectDir = row['project_dir'];
  const projectRoot = row['project_root'];
  const distilled = row['distilled'];
  const note = row['note'];
  const distilledAt = row['distilled_at'];
  const recallCount = row['recall_count'];
  const lastRecalledAt = row['last_recalled_at'];
  return {
    id: String(row['id']),
    sourceSessionId: String(row['source_session_id']),
    sourceSessionTitle: typeof sourceSessionTitle === 'string' ? sourceSessionTitle : undefined,
    userNeed: String(row['user_need']),
    approach: String(row['approach']),
    outcome: String(row['outcome']),
    whatFailed: String(row['what_failed']),
    whatWorked: String(row['what_worked']),
    distilled:
      typeof distilled === 'string' && distilled.trim().length > 0 ? distilled : undefined,
    origin: parseOrigin(row['origin']),
    distilledFrom: parseDistilledFrom(row['distilled_from']),
    distilledAt: typeof distilledAt === 'number' && Number.isFinite(distilledAt) ? distilledAt : undefined,
    extractionSource: row['extraction_source'] as 'compaction' | 'exit' | 'manual',
    recordedAt: Number(row['recorded_at']),
    projectDir: typeof projectDir === 'string' ? projectDir : '',
    projectRoot: typeof projectRoot === 'string' && projectRoot.length > 0 ? projectRoot : undefined,
    tags: parseTags(row['tags']),
    note: typeof note === 'string' && note.length > 0 ? note : undefined,
    recallCount: typeof recallCount === 'number' && recallCount > 0 ? recallCount : undefined,
    lastRecalledAt:
      typeof lastRecalledAt === 'number' && Number.isFinite(lastRecalledAt) ? lastRecalledAt : undefined,
    dreamedAt:
      typeof row['dreamed_at'] === 'number' && Number.isFinite(row['dreamed_at'])
        ? row['dreamed_at']
        : undefined,
  };
}

function parseOrigin(value: unknown): MemoOrigin {
  return value === 'dream' || value === 'user' || value === 'session' ? value : 'session';
}

/** Column value for `distilled_from`: undefined when there is nothing to store. */
function stringifyDistilledFrom(sources: readonly DistilledSource[] | undefined): string | null {
  return sources === undefined || sources.length === 0 ? null : JSON.stringify(sources);
}

/** Parse the `distilled_from` JSON column, dropping entries that fail validation. */
function parseDistilledFrom(value: unknown): DistilledSource[] | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const sources = parsed.filter(
      (item): item is DistilledSource =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as DistilledSource).id === 'string' &&
        typeof (item as DistilledSource).title === 'string' &&
        typeof (item as DistilledSource).at === 'number' &&
        Number.isFinite((item as DistilledSource).at),
    );
    return sources.length > 0 ? sources.slice(0, 100) : undefined;
  } catch {
    return undefined;
  }
}

function parseTags(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const tags = parsed.filter((t): t is string => typeof t === 'string');
    return tags.length > 0 ? tags : undefined;
  } catch {
    return undefined;
  }
}

function likePattern(value: string): string {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

function memoMatchesSearch(memo: MemoryMemo, search: string): boolean {
  const haystack = [
    memo.userNeed,
    memo.approach,
    memo.whatFailed,
    memo.whatWorked,
    memo.distilled ?? '',
    memo.note ?? '',
    memo.sourceSessionTitle ?? '',
    ...(memo.tags ?? []),
  ]
    .join(' ')
    .toLowerCase()
    .replaceAll(/\s+/g, '');
  return haystack.includes(search.replaceAll(/\s+/g, ''));
}

/**
 * Tokenize text so FTS5's unicode61 tokenizer can index mixed CJK/ASCII text.
 * CJK characters are split into individual characters separated by spaces, and
 * CJK/ASCII boundaries are also separated so "使用redis缓存" becomes searchable
 * by "redis" as well as by individual CJK characters.
 */
function toFtsText(text: string): string {
  const lower = text.toLowerCase();
  const withBoundaries = lower
    .replaceAll(/([一-鿿㐀-䶿])([a-z0-9])/g, '$1 $2')
    .replaceAll(/([a-z0-9])([一-鿿㐀-䶿])/g, '$1 $2');
  const parts = withBoundaries.split(/[^a-z0-9一-鿿㐀-䶿]+/);
  const tokens: string[] = [];
  for (const part of parts) {
    if (part.length === 0) continue;
    if (/^[a-z0-9]+$/.test(part)) {
      tokens.push(part);
    } else {
      // Split every CJK run into individual characters.
      for (const ch of part) {
        if (ch.length > 0) tokens.push(ch);
      }
    }
  }
  return tokens.join(' ');
}

function buildFtsQuery(search: string): string | undefined {
  const ftsText = toFtsText(search);
  const tokens = ftsText.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(' AND ');
}

// ── Process-level shared store ─────────────────────────────────────────────
// One MemoryMemoStore per home directory instead of one per Agent/TUI caller:
// a long-lived session used to accumulate one open memos.sqlite handle per
// construction, because nothing in production ever called close().

const sharedStores = new Map<string, MemoryMemoStore>();

function entryFor(projectDir: string, log?: MemoryMemoStoreLogger): MemoryMemoStore {
  const existing = sharedStores.get(projectDir);
  if (existing !== undefined) return existing;
  const store = new MemoryMemoStore(projectDir, log);
  sharedStores.set(projectDir, store);
  return store;
}

/**
 * Shared MemoryMemoStore for a home directory. The map key is the raw
 * projectDir string so every caller passing the same path gets the same
 * handle. `init()` is idempotent and stays the caller's job to await.
 */
export function sharedMemoStore(projectDir: string, log?: MemoryMemoStoreLogger): MemoryMemoStore {
  return entryFor(projectDir, log);
}

/**
 * Drop a home directory's shared store and close its handle.
 *
 * Positioning: a test-isolation utility and a future process-exit hook. The
 * production exit paths deliberately do not call it today — process exit
 * relies on the OS reclaiming the sqlite handle — so having no production
 * call site is expected, not an oversight. After this call the next
 * `sharedMemoStore` builds a fresh instance.
 */
export function closeSharedMemoStore(projectDir: string): void {
  const store = sharedStores.get(projectDir);
  if (store === undefined) return;
  sharedStores.delete(projectDir);
  store.close();
}
