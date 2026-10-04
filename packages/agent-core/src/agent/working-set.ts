const DECAY_TURNS = 10;
const VERIFICATION_DEDUP_MS = 60_000;

type ProjectKind = 'node' | 'rust' | 'python' | 'go' | 'unknown';

interface WorkingSetEntry {
  readonly path: string;
  lastTurn: number;
  lastReadTurn?: number;
  verified: boolean;
}

export interface VerificationRecord {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number;
  readonly output: string;
  readonly outputDigest: string;
  readonly timestamp: number;
  readonly turnId: number;
  readonly passed: boolean;
}

interface ProjectFingerprint {
  readonly kind: ProjectKind;
  readonly packageFile?: string;
}

const VERIFICATION_COMMANDS: Record<ProjectKind, readonly string[]> = {
  node: ['pnpm test', 'pnpm lint', 'pnpm typecheck'],
  rust: ['cargo test', 'cargo clippy'],
  python: ['pytest', 'python -m pytest'],
  go: ['go test ./...', 'go vet ./...'],
  unknown: [],
};

/**
 * Tracks file paths the agent has recently read, edited, or searched.
 *
 * The set is injected into each turn as a system reminder so the model can
 * prioritize files it is already working with instead of re-reading unchanged
 * files. Entries decay after they have not been touched for 10 turns.
 *
 * A `verified` flag tracks whether a touched file still has unverified changes.
 * Writing or editing a path resets it to unverified; running a verification
 * command (build/test/lint) marks paths verified. This feeds the convergence
 * gate in TurnFlow so the agent cannot stop while changes are unverified.
 *
 * A separate `lastReadTurn` tracks when a path was last read. Edit tools can
 * warn when the model attempts to edit a file that has not been read recently,
 * reducing anchor mismatches caused by stale reads.
 *
 * Verification deduplication: records of recent verification commands are kept
 * so that the same successful command is not run repeatedly within
 * VERIFICATION_DEDUP_MS. This prevents the convergence gate from causing
 * redundant test/lint/typecheck invocations.
 */
export class WorkingSet {
  private entries = new Map<string, WorkingSetEntry>();
  private verifications: VerificationRecord[] = [];

  /**
   * Normalize a shell command for deduplication by stripping leading whitespace,
   * trailing semicolons, and collapsing redundant spaces.
   */
  private normalizeCommand(command: string): string {
    const strippedLeading = command.replace(/^\s+/, '');
    const strippedTrailing = strippedLeading.replace(/[\s;]+$/, '');
    return strippedTrailing
      .replaceAll('\\\\', '/')
      .replaceAll(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * Computes a short digest of command output for change detection.
   */
  private digestOutput(output: string): string {
    let hash = 0;
    const text = output.slice(0, 2000);
    // NOTE: increments by 1, not 2, for surrogate pairs. Non-BMP characters
    // (emoji) are processed as two code units with different hash contributions.
    // Only affects change detection for verification output with emoji.
    for (let i = 0; i < text.length; i++) {
      const char = text.codePointAt(i) ?? 0;
      hash = Math.trunc((hash << 5) - hash + char);
    }
    return String(hash);
  }

  /**
   * Returns a matching recent successful verification record, or null if none
   * exists for the same command/cwd/output within the dedup window.
   */
  findRecentVerification(
    command: string,
    cwd: string,
    output: string,
  ): VerificationRecord | null {
    const normalized = this.normalizeCommand(command);
    const normalizedCwd = cwd.replaceAll('\\\\', '/');
    const outputDigest = this.digestOutput(output);
    const now = Date.now();
    for (const record of this.verifications) {
      if (
        record.passed &&
        this.normalizeCommand(record.command) === normalized &&
        record.cwd.replaceAll('\\\\', '/') === normalizedCwd &&
        record.outputDigest === outputDigest &&
        now - record.timestamp < VERIFICATION_DEDUP_MS
      ) {
        return record;
      }
    }
    return null;
  }

  /**
   * Returns a recent successful verification record for the same command and
   * cwd, but only if no unverified file has been touched since that record was
   * made. This is used by TurnFlow to hard-skip redundant verification commands
   * before they are executed.
   */
  findSkipCandidate(
    command: string,
    cwd: string,
    currentTurnId: number,
  ): VerificationRecord | null {
    const normalized = this.normalizeCommand(command);
    const normalizedCwd = cwd.replaceAll('\\\\', '/');
    const now = Date.now();
    for (const record of this.verifications) {
      if (
        record.passed &&
        this.normalizeCommand(record.command) === normalized &&
        record.cwd.replaceAll('\\\\', '/') === normalizedCwd &&
        now - record.timestamp < VERIFICATION_DEDUP_MS &&
        record.turnId <= currentTurnId
      ) {
        // Do not skip if an unverified file was touched after this record.
        let stale = false;
        for (const entry of this.entries.values()) {
          if (!entry.verified && entry.lastTurn >= record.turnId) {
            stale = true;
            break;
          }
        }
        if (!stale) {
          return record;
        }
      }
    }
    return null;
  }

  /**
   * Records a verification command result and prunes stale entries.
   */
  recordVerification(
    command: string,
    cwd: string,
    exitCode: number,
    output: string,
    turnId: number,
  ): VerificationRecord {
    const now = Date.now();
    const record: VerificationRecord = {
      command: this.normalizeCommand(command),
      cwd: cwd.replaceAll('\\\\', '/'),
      exitCode,
      output,
      outputDigest: this.digestOutput(output),
      timestamp: now,
      turnId,
      passed: exitCode === 0,
    };
    this.verifications = [
      ...this.verifications.filter((r) => now - r.timestamp < VERIFICATION_DEDUP_MS),
      record,
    ];
    return record;
  }

  clearVerifications(): void {
    this.verifications = [];
  }

  getVerificationCount(): number {
    return this.verifications.length;
  }
  hasVerificationForTurn(turnId: number): boolean {
    return this.verifications.some((record) => record.turnId === turnId);
  }
  /**
   * Returns the most recent verification record for the given turn, or
   * undefined if no verification was recorded for that turn.
   */
  getLatestVerificationForTurn(turnId: number): VerificationRecord | undefined {
    let latest: VerificationRecord | undefined;
    for (const record of this.verifications) {
      if (record.turnId === turnId) {
        if (
          latest === undefined ||
          record.timestamp > latest.timestamp ||
          (record.timestamp === latest.timestamp &&
            record.command.length > latest.command.length)
        ) {
          latest = record;
        }
      }
    }
    return latest;
  }


  /**
   * Key normalization for working-set entries: `\` → `/` for cross-platform
   * keys, and leading `./` segments stripped so `./src/a.ts` and `src/a.ts`
   * refer to the same entry (Read and Edit may spell the same path
   * differently).
   */
  private normalizePath(path: string): string {
    return path.replaceAll('\\', '/').replace(/^(\.\/)+/, '');
  }

  touch(path: string, turn: number): void {
    if (path.length === 0) return;
    const normalized = this.normalizePath(path);
    const existing = this.entries.get(normalized);
    this.entries.set(normalized, {
      path: normalized,
      lastTurn: turn,
      lastReadTurn: existing?.lastReadTurn,
      verified: false,
    });
  }

  markRead(path: string, turn: number): void {
    if (path.length === 0) return;
    const normalized = this.normalizePath(path);
    const existing = this.entries.get(normalized);
    if (existing !== undefined) {
      this.entries.set(normalized, { ...existing, lastTurn: turn, lastReadTurn: turn });
    } else {
      this.entries.set(normalized, {
        path: normalized,
        lastTurn: turn,
        lastReadTurn: turn,
        verified: true,
      });
    }
  }

  markVerified(path: string): void {
    const normalized = path.replaceAll('\\', '/');
    const entry = this.entries.get(normalized);
    if (entry !== undefined) {
      this.entries.set(normalized, { ...entry, verified: true });
    }
  }

  markAllVerified(): void {
    for (const [key, entry] of this.entries) {
      this.entries.set(key, { ...entry, verified: true });
    }
  }

  getUnverifiedPaths(): string[] {
    return [...this.entries.values()]
      .filter((entry) => !entry.verified)
      .map((entry) => entry.path)
      .toSorted();
  }

  /**
   * Returns the turn number of the most recent Read for a path, or undefined
   * if the path has never been read. Used by EditTool to warn about stale edits.
   */
  lastReadTurn(path: string): number | undefined {
    const normalized = this.normalizePath(path);
    return this.entries.get(normalized)?.lastReadTurn;
  }

  decay(currentTurn: number): void {
    const cutoff = currentTurn - DECAY_TURNS;
    for (const [key, entry] of this.entries) {
      if (entry.lastTurn < cutoff) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * Heuristically determines the project type from the working set and
   * suggests a list of verification commands. The suggestions are ordered
   * from most specific (tests) to broadest (typecheck). Empty if there are
   * no unverified paths.
   */
  suggestVerificationCommands(_workspaceRoot = '.'): string[] {
    const unverified = this.getUnverifiedPaths();
    if (unverified.length === 0) return [];

    const fingerprint = this.detectProjectKind();
    const commands = [...VERIFICATION_COMMANDS[fingerprint.kind]];
    return commands.length > 0 ? commands : ['Run the appropriate build/test command for this project'];
  }

  private detectProjectKind(): ProjectFingerprint {
    // Fast path: infer from the paths in the working set.
    for (const entry of this.entries.values()) {
      const path = entry.path.toLowerCase();
      if (path.endsWith('package.json') || path.includes('/package.json')) {
        return { kind: 'node', packageFile: entry.path };
      }
      if (path.endsWith('cargo.toml') || path.includes('/cargo.toml')) {
        return { kind: 'rust', packageFile: entry.path };
      }
      if (path.endsWith('pyproject.toml') || path.includes('/pyproject.toml')) {
        return { kind: 'python', packageFile: entry.path };
      }
      if (path.endsWith('go.mod') || path.includes('/go.mod')) {
        return { kind: 'go', packageFile: entry.path };
      }
    }
    return { kind: 'unknown' };
  }

  getPaths(): string[] {
    return [...this.entries.keys()].toSorted();
  }

  clear(): void {
    this.entries.clear();
  }
}

// Recognized verification commands. These are checked for deduplication via
// the WorkingSet so the convergence gate does not cause redundant runs.
const VERIFICATION_PATTERNS = [
  // TypeScript / JavaScript
  /\b(tsc|typecheck)\b/i,
  // Test runners (including language-specific ones)
  /\b(test|jest|vitest|mocha|pytest|unittest|go test|go vet|cargo test|cargo check)\b/i,
  // Linters / type checkers
  /\b(lint|eslint|oxlint|clippy|ruff|mypy|pylint|flake8|black\s+--check|isort\s+--check)\b/i,
  // Builds
  /\b(build|make|cargo build|go build)\b/i,
  // Python module compilation
  /\bpy_compile\b/i,
  // Python script/module execution
  /\bpython3?\s+(\S+\.(py|pyw)\b|-m\s+\w+)/i,
];

export function looksLikeVerificationCommand(command: string): boolean {
  return VERIFICATION_PATTERNS.some((pattern) => pattern.test(command));
}

export { DECAY_TURNS, VERIFICATION_COMMANDS };
