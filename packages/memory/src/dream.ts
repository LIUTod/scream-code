import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
 * another dream. Persisted to `<project>/.scream-code/dream-lock.json`.
 */
export class DreamTracker {
  private state: DreamState;
  private readonly lockPath: string;
  private initialized = false;

  constructor(projectDir: string) {
    this.lockPath = join(projectDir, '.scream-code', LOCK_FILE);
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
      }
    } catch {
      // File doesn't exist or is corrupt — use defaults
    }
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
}
