import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { BotStore, SCHEMA_V1 } from '../../../src/bot/server/store';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
function path() {
  const cache = join(process.cwd(),'node_modules','.cache');
  mkdirSync(cache,{recursive:true});
  const root = mkdtempSync(join(cache,'bot-migration-')); roots.push(root);
  return {root,path:join(root,'bot.db')};
}
function legacy(db: DatabaseSync) {
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(SCHEMA_V1);
  db.exec('PRAGMA user_version=1');
  db.prepare('INSERT INTO bots(id,name,workspace,created_at) VALUES(?,?,?,1)').run('bot_old','Keep',process.cwd());
  db.exec("INSERT INTO threads(id,bot_id,last_active_at,created_at) VALUES('th_old','bot_old',1,1)");
  db.exec("INSERT INTO runs(id,bot_id,thread_id,status,created_at) VALUES('run_old','bot_old','th_old','running',1)");
  db.exec(`INSERT INTO handoffs(id,from_bot_id,from_thread_id,to_bot_id,task,status,idempotency_key,answer,created_at)
    VALUES('ho_old','bot_old','th_old','bot_other','old task','queued','legacy','preserved answer',1)`);
}

describe('explicit transactional database migrations', () => {
  it('backs up committed WAL consistently, preserves legacy data and never reexecutes legacy work', () => {
    const location = path();
    const writer = new DatabaseSync(location.path);
    legacy(writer);
    const store = new BotStore(location.path); store.open();
    const files = readdirSync(location.root).filter((name) => name.endsWith('.bak'));
    expect(files).toHaveLength(1);
    const snapshot = new DatabaseSync(join(location.root,files[0]!),{readOnly:true});
    expect(snapshot.prepare("SELECT name FROM bots WHERE id='bot_old'").get()?.['name']).toBe('Keep');
    expect(snapshot.prepare('PRAGMA user_version').get()?.['user_version']).toBe(1);
    snapshot.close();
    writer.close();
    expect(store.getBot('bot_old')?.name).toBe('Keep');
    expect(store.getThread('th_old')?.workspace).toBe(process.cwd());
    expect(store.getHandoff('ho_old')).toMatchObject({status:'failed',answer:'preserved answer',error:expect.stringContaining('legacy interrupted')});
    expect(store.markOrphanRuns()).toBe(1);
    expect(store.getRun('run_old')).toMatchObject({status:'interrupted',input:null});
    expect(store.listQueuedRuns()).toEqual([]);
    store.close();
    const check = new DatabaseSync(location.path,{readOnly:true});
    expect(check.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{version:1},{version:2},{version:3},{version:4},{version:5},{version:6}]);
    check.close();
    const reopened = new BotStore(location.path); reopened.open(); reopened.close();
    expect(readdirSync(location.root).filter((name) => name.endsWith('.bak'))).toHaveLength(1);
  });

  it('rolls back required migration failures and refuses a partially writable startup', () => {
    const location = path();
    const db = new DatabaseSync(location.path);
    legacy(db);
    db.exec('ALTER TABLE bots ADD COLUMN config_revision INTEGER');
    db.close();
    const store = new BotStore(location.path);
    expect(() => { store.open(); }).toThrow(/writes disabled.*Restore/);
    expect(() => store.listBots()).toThrow(/not open/);
    const check = new DatabaseSync(location.path,{readOnly:true});
    expect(check.prepare('PRAGMA user_version').get()?.['user_version']).toBe(1);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name='thread_messages'").get()).toBeUndefined();
    expect(check.prepare("SELECT name FROM bots WHERE id='bot_old'").get()?.['name']).toBe('Keep');
    check.close();
  });
});
