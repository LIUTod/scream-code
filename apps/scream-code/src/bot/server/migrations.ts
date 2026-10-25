import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const BOT_SCHEMA_VERSION = 6;

function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row['name'])));
}

/** All upgrades either commit together or leave the old database untouched. */
export function migrateBotDatabase(db: DatabaseSync, path: string, baseline: string): void {
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bots'").get();
  const version = Number(db.prepare('PRAGMA user_version').get()?.['user_version'] ?? 0);
  if (version > BOT_SCHEMA_VERSION) throw new Error(`Bot database schema ${version} is newer than this server`);
  let backup: string | undefined;
  if (existing !== undefined && version < BOT_SCHEMA_VERSION && path !== ':memory:') {
    backup = `${path}.pre-v${BOT_SCHEMA_VERSION}-${randomUUID()}.bak`;
    // SQLite reads a consistent snapshot including committed WAL pages.
    db.prepare('VACUUM INTO ?').run(backup);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    if (version < 1) {
      db.exec(baseline);
      db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES(1, ?)').run(Date.now());
    }
    if (version < 2) {
      const hc = columns(db, 'handoffs');
      if (!hc.has('answer')) db.exec('ALTER TABLE handoffs ADD COLUMN answer TEXT');
      if (!hc.has('completed_at')) db.exec('ALTER TABLE handoffs ADD COLUMN completed_at INTEGER');
      if (columns(db, 'bots').has('type')) db.exec('ALTER TABLE bots DROP COLUMN type');
      db.exec(`
        ALTER TABLE bots ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE threads ADD COLUMN workspace TEXT;
        ALTER TABLE threads ADD COLUMN applied_config_revision INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE threads ADD COLUMN blocked_by_run_id TEXT;
        ALTER TABLE threads ADD COLUMN projection_version INTEGER NOT NULL DEFAULT 0;
        UPDATE threads SET workspace=(SELECT workspace FROM bots WHERE bots.id=threads.bot_id);
        ALTER TABLE runs ADD COLUMN input_json TEXT;
        ALTER TABLE runs ADD COLUMN request_key TEXT;
        ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'prompt';
        ALTER TABLE runs ADD COLUMN origin_json TEXT;
        ALTER TABLE runs ADD COLUMN core_session_id TEXT;
        ALTER TABLE runs ADD COLUMN session_generation TEXT;
        ALTER TABLE runs ADD COLUMN turn_id INTEGER;
        ALTER TABLE runs ADD COLUMN dispatch_started_at INTEGER;
        ALTER TABLE runs ADD COLUMN retry_of_run_id TEXT;
        ALTER TABLE runs ADD COLUMN recovery_decision TEXT;
        ALTER TABLE runs ADD COLUMN recovery_at INTEGER;
        ALTER TABLE runs ADD COLUMN recovery_run_id TEXT;
        ALTER TABLE runs ADD COLUMN config_revision INTEGER;
        ALTER TABLE handoffs ADD COLUMN target_run_id TEXT;
        CREATE UNIQUE INDEX idx_runs_request_key ON runs(request_key) WHERE request_key IS NOT NULL;
        CREATE TABLE thread_messages (
          id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          core_session_id TEXT, core_message_id TEXT, run_id TEXT, position INTEGER NOT NULL,
          message_json TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_thread_messages_core ON thread_messages(thread_id,core_session_id,core_message_id)
          WHERE core_message_id IS NOT NULL;
        CREATE TABLE run_inputs (
          request_key TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          thread_id TEXT NOT NULL, input_json TEXT NOT NULL, message_id TEXT NOT NULL, kind TEXT NOT NULL
        );
        DROP INDEX IF EXISTS idx_room_messages_source;
        UPDATE room_messages SET source_message_id=source_message_id || ':legacy:' || id
          WHERE source_message_id IS NOT NULL AND rowid NOT IN (
            SELECT MIN(rowid) FROM room_messages WHERE source_message_id IS NOT NULL
            GROUP BY room_id,speaker_id,source_message_id
          );
        CREATE UNIQUE INDEX idx_room_messages_source ON room_messages(room_id,speaker_id,source_message_id);
        UPDATE handoffs SET status='failed', error='legacy interrupted: no target run association; confirmation required',
          completed_at=COALESCE(completed_at,${Date.now()}) WHERE target_run_id IS NULL AND status IN ('queued','running');
      `);
      db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES(1, ?)').run(Date.now());
      db.prepare('INSERT INTO schema_migrations VALUES(2, ?)').run(Date.now());
    }
    if (version < 3) {
      // Sessions created before runtime identity existed carry a pinned profile role.
      const tc = columns(db, 'threads');
      if (!tc.has('pinned_role')) db.exec('ALTER TABLE threads ADD COLUMN pinned_role INTEGER NOT NULL DEFAULT 1');
      db.prepare('INSERT INTO schema_migrations VALUES(3, ?)').run(Date.now());
    }
    if (version < 4) {
      const hc4 = columns(db, 'handoffs');
      if (!hc4.has('relay_run_id')) db.exec('ALTER TABLE handoffs ADD COLUMN relay_run_id TEXT');
      if (!hc4.has('relay_status')) db.exec('ALTER TABLE handoffs ADD COLUMN relay_status TEXT');
      db.prepare('INSERT INTO schema_migrations VALUES(4, ?)').run(Date.now());
    }
    if (version < 5) {
      const rc5 = columns(db, 'room_messages');
      if (!rc5.has('room_request_id')) db.exec('ALTER TABLE room_messages ADD COLUMN room_request_id TEXT');
      if (!rc5.has('run_id')) db.exec('ALTER TABLE room_messages ADD COLUMN run_id TEXT');
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_room_messages_request
         ON room_messages(room_id, room_request_id) WHERE room_request_id IS NOT NULL`,
      );
      // Legacy hand-offs have no run association, so their completion cannot be
      // proven; surface them as interrupted instead of guessing success.
      db.prepare(
        `UPDATE handoffs SET status = 'failed', error = ?, completed_at = ?
         WHERE target_run_id IS NULL AND status IN ('queued', 'running')`,
      ).run('legacy hand-off interrupted during upgrade; confirm before retrying', Date.now());
      db.prepare('INSERT INTO schema_migrations VALUES(5, ?)').run(Date.now());
    }
    if (version < 6) {
      const rc6 = columns(db, 'room_messages');
      if (!rc6.has('attachments_json')) db.exec('ALTER TABLE room_messages ADD COLUMN attachments_json TEXT');
      db.prepare('INSERT INTO schema_migrations VALUES(6, ?)').run(Date.now());
    }
    db.exec("UPDATE bots SET permission='auto' WHERE permission='yolo'; UPDATE bots SET permission='bot' WHERE permission NOT IN ('auto','bot')");
    db.exec(`PRAGMA user_version=${BOT_SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`Bot migration failed; writes disabled. Restore ${backup ?? 'the pre-upgrade backup'} with the matching server version.`, { cause: error });
  }
}
