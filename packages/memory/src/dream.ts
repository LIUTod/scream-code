import { mkdir, readdir, readFile, rmdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'pathe';

export interface DreamState {
  /** ISO timestamp of the last completed dream. */
  lastDreamAt: string;
  /** Number of sessions since the last dream. */
  sessionsSinceLastDream: number;
}

interface DreamLockFile {
  version: 1;
  state: DreamState;
}

const LOCK_FILE = 'dream-lock.json';
const MIN_HOURS_BETWEEN_DREAMS = 24;
const MIN_SESSIONS_BETWEEN_DREAMS = 5;

/**
 * Tracks dream consolidation state and decides when to suggest running
 * another dream. Persisted to `<screamHomeDir>/dream-lock.json`.
 */
export class DreamTracker {
  private state: DreamState;
  private readonly lockPath: string;
  private readonly screamHomeDir: string;
  private initialized = false;

  constructor(screamHomeDir: string) {
    this.screamHomeDir = screamHomeDir;
    this.lockPath = join(screamHomeDir, LOCK_FILE);
    this.state = {
      lastDreamAt: new Date().toISOString(),
      sessionsSinceLastDream: 0,
    };
  }

  /** Load persisted state (call once at startup). */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    try {
      const raw = await readFile(this.lockPath, 'utf8');
      const parsed = JSON.parse(raw) as DreamLockFile;
      if (parsed.version === 1 && parsed.state) {
        this.state = parsed.state;
        return;
      }
    } catch {
      // File doesn't exist or is corrupt — try legacy migration
    }

    await this.migrateLegacyLockFiles();
  }

  /** Record that a dream completed successfully. */
  async recordDream(): Promise<void> {
    this.state = {
      lastDreamAt: new Date().toISOString(),
      sessionsSinceLastDream: 0,
    };
    await this.persist();
  }

  /** Call on each new session to bump the session counter. */
  async recordNewSession(): Promise<void> {
    if (!this.initialized) await this.init();
    this.state.sessionsSinceLastDream += 1;
    await this.persist();
  }

  /** Check whether it's time to suggest another dream. */
  shouldSuggest(): boolean {
    const hoursSince =
      (Date.now() - new Date(this.state.lastDreamAt).getTime()) /
      (1000 * 60 * 60);
    return (
      hoursSince >= MIN_HOURS_BETWEEN_DREAMS &&
      this.state.sessionsSinceLastDream >= MIN_SESSIONS_BETWEEN_DREAMS
    );
  }

  /** Get a human-readable suggestion message when conditions are met. */
  getSuggestionMessage(): string {
    const hoursSince =
      (Date.now() - new Date(this.state.lastDreamAt).getTime()) /
      (1000 * 60 * 60);
    const days = Math.floor(hoursSince / 24);
    const sessions = this.state.sessionsSinceLastDream;
    return (
      `距离上次记忆整理已过去 ${days} 天、${sessions} 个会话。` +
      `建议运行 /dream 来合并重复记忆、清理过期条目、解决矛盾信息。`
    );
  }

  private async persist(): Promise<void> {
    const data: DreamLockFile = { version: 1, state: this.state };
    try {
      await mkdir(dirname(this.lockPath), { recursive: true });
      await writeFile(this.lockPath, JSON.stringify(data, null, 2), 'utf8');
    } catch {
      // Non-critical — will try again next time
    }
  }

  /**
   * One-time migration for legacy dream-lock.json locations:
   * - <screamHomeDir>/.scream-code/dream-lock.json (buggy double directory)
   * - <screamHomeDir>/sessions/<sessionKey>/.scream-code/dream-lock.json (old per-session)
   *
   * Picks the most recent state, writes it to the new global location, and
   * deletes the legacy files/directories.
   */
  private async migrateLegacyLockFiles(): Promise<void> {
    const candidates: string[] = [
      join(this.screamHomeDir, '.scream-code', LOCK_FILE),
    ];

    const sessionsDir = join(this.screamHomeDir, 'sessions');
    try {
      const entries = await readdir(sessionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          candidates.push(join(sessionsDir, entry.name, '.scream-code', LOCK_FILE));
        }
      }
    } catch {
      // sessions directory may not exist
    }

    let bestState: DreamState | undefined;
    for (const candidate of candidates) {
      try {
        await stat(candidate);
        const raw = await readFile(candidate, 'utf8');
        const parsed = JSON.parse(raw) as DreamLockFile;
        if (parsed.version === 1 && parsed.state) {
          if (
            bestState === undefined ||
            new Date(parsed.state.lastDreamAt).getTime() >
              new Date(bestState.lastDreamAt).getTime()
          ) {
            bestState = parsed.state;
          }
        }
      } catch {
        // ignore missing or corrupt legacy files
      }
    }

    if (bestState !== undefined) {
      this.state = bestState;
      await this.persist();
    }

    // Clean up legacy files and empty parent directories regardless of whether
    // we found usable state.
    for (const candidate of candidates) {
      try {
        await rm(candidate);
        await rmdir(dirname(candidate)).catch(() => {});
      } catch {
        // ignore missing files
      }
    }
  }
}
