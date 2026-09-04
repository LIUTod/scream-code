import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { Dirent } from 'node:fs';

import type { Jian } from '@scream-code/jian';

import { LspClient } from './client';
import type { LspProcessSupervisor } from './process-supervisor';

export interface LspCommand {
  readonly command: string[];
  readonly languageId: string;
  /** Optional factory for initializationOptions passed to the server. */
  readonly initOptions?: (workspaceRoot: string) => Record<string, unknown> | undefined;
}

const TYPESCRIPT_SERVER_COMMAND = ['typescript-language-server', '--stdio'];

const LANGUAGE_SERVERS: Readonly<Record<string, LspCommand>> = {
  '.ts': { command: TYPESCRIPT_SERVER_COMMAND, languageId: 'typescript', initOptions: typescriptInitOptions },
  '.tsx': { command: TYPESCRIPT_SERVER_COMMAND, languageId: 'typescriptreact', initOptions: typescriptInitOptions },
  '.js': { command: TYPESCRIPT_SERVER_COMMAND, languageId: 'javascript', initOptions: typescriptInitOptions },
  '.jsx': { command: TYPESCRIPT_SERVER_COMMAND, languageId: 'javascriptreact', initOptions: typescriptInitOptions },
  '.py': { command: ['pyright-langserver', '--stdio'], languageId: 'python' },
  '.rs': { command: ['rust-analyzer'], languageId: 'rust' },
  '.go': { command: ['gopls'], languageId: 'go' },
};

/**
 * Resolve a `tsserver` lib directory for `typescript-language-server`.
 *
 * `typescript-language-server` is only the LSP protocol layer; it shells out to
 * TypeScript's own `tsserver.js` to compute diagnostics. It searches the
 * workspace's `node_modules/typescript` by default, so editing a standalone
 * `.ts` file outside any JS project makes it exit with "Could not find a valid
 * TypeScript installation." Passing `initializationOptions.tsserver.path`
 * points it at a known-good install so diagnostics work regardless of where
 * the edited file lives.
 *
 * Resolution order: workspace `node_modules/typescript`, then the
 * `typescript` dependency bundled with scream-code itself (resolved via
 * `require.resolve`). Returns undefined when neither is available, in which
 * case the server will fall back to its own search (and likely fail for
 * project-less files).
 */
function resolveTsserverPath(workspaceRoot: string): string | undefined {
  const workspaceCandidate = join(workspaceRoot, 'node_modules', 'typescript', 'lib');
  if (existsSync(join(workspaceCandidate, 'tsserver.js'))) return workspaceCandidate;
  try {
    const bundled = createRequire(import.meta.url).resolve('typescript/lib/tsserver.js');
    return bundled.slice(0, -'/tsserver.js'.length);
  } catch {
    return undefined;
  }
}

function typescriptInitOptions(workspaceRoot: string): Record<string, unknown> | undefined {
  const tsserverPath = resolveTsserverPath(workspaceRoot);
  if (tsserverPath === undefined) return undefined;
  return { tsserver: { path: tsserverPath } };
}

export class LspRegistry {
  private readonly clients = new Map<string, Promise<LspClient>>();
  /** Set by stopAll(); getClient/getWorkspaceClient short-circuit afterwards. */
  private stopping = false;

  constructor(
    private readonly jian: Jian,
    private readonly supervisor?: LspProcessSupervisor,
  ) {}

  /**
   * Get or create an LSP client for the given file path and workspace root.
   * Returns undefined if the file type is not supported.
   *
   * Caches the in-flight `Promise<LspClient>` rather than the client instance
   * so concurrent callers share the same startup and never receive a client
   * whose `initialize` has not completed.
   */
  async getClient(path: string, workspaceRoot: string): Promise<LspClient | undefined> {
    if (this.stopping) return undefined;
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    const config = LANGUAGE_SERVERS[ext];
    if (config === undefined) return undefined;

    const key = `${workspaceRoot}\0${config.command.join(' ')}`;
    let clientPromise = this.clients.get(key);
    if (clientPromise === undefined) {
      clientPromise = this.createAndStartClient(config, workspaceRoot, key);
      this.clients.set(key, clientPromise);
    }
    return clientPromise;
  }

  /**
   * Get a client suitable for workspace-wide operations (e.g. `workspace/symbol`)
   * that do not target a specific file. Reuses an already-started client when
   * one exists; otherwise starts the first configured server. Returns undefined
   * when no language server is configured at all.
   *
   * Workspace-scoped requests need the server to have loaded a project: many
   * servers (tsserver's navto among them) answer `workspace/symbol` with
   * "No Project" until at least one file has been opened. To make the first
   * workspace call work, a seed file is opened on the freshly started client
   * before it is returned.
   */
  async getWorkspaceClient(workspaceRoot: string): Promise<LspClient | undefined> {
    if (this.stopping) return undefined;
    const existing = this.findStartedClient(workspaceRoot);
    if (existing !== undefined) return existing;
    const first = Object.values(LANGUAGE_SERVERS)[0];
    if (first === undefined) return undefined;
    const key = `${workspaceRoot}\0${first.command.join(' ')}`;
    let clientPromise = this.clients.get(key);
    if (clientPromise === undefined) {
      clientPromise = this.createAndStartClient(first, workspaceRoot, key);
      this.clients.set(key, clientPromise);
    }
    let client: LspClient;
    try {
      client = await clientPromise;
    } catch (error) {
      this.clients.delete(key);
      throw error;
    }
    await this.openSeedFile(client, first, workspaceRoot);
    return client;
  }

  private findStartedClient(workspaceRoot: string): Promise<LspClient> | undefined {
    for (const config of Object.values(LANGUAGE_SERVERS)) {
      const key = `${workspaceRoot}\0${config.command.join(' ')}`;
      const existing = this.clients.get(key);
      if (existing !== undefined) return existing;
    }
    return undefined;
  }

  /**
   * Stop and forget all clients for the workspace so the next
   * `getWorkspaceClient` starts a fresh server and re-seeds it. Used by the
   * LSP tool's self-healing retry when a server answers "No Project" despite
   * seeding (tsserver project-reload races).
   *
   * Concurrent callers share one reseed: the in-flight promise is removed
   * immediately and a short lock window collapses duplicate calls, so two
   * parallel tool invocations don't kill each other's freshly started server.
   */
  async reseedWorkspaceClient(workspaceRoot: string): Promise<void> {
    if (this.reseedLockUntil > Date.now()) return; // Another caller is already reseeding.
    this.reseedLockUntil = Date.now() + 3_000;
    for (const config of Object.values(LANGUAGE_SERVERS)) {
      const key = `${workspaceRoot}\0${config.command.join(' ')}`;
      const pending = this.clients.get(key);
      if (pending === undefined) continue;
      this.clients.delete(key);
      try {
        const client = await pending;
        await client.stop();
      } catch {
        // A half-started client has nothing to stop.
      }
    }
  }

  private reseedLockUntil = 0;

  /**
   * Open workspace files so the server loads a project, then WAIT until the
   * PROJECT-WIDE symbol index is queryable before returning. Best-effort:
   * when no seed candidate exists the server may still answer "No Project" —
   * callers surface that as a normal error.
   *
   * Why stage 2 exists and what it must not do: tsserver builds its navto
   * index (what `workspace/symbol` queries) asynchronously after the project
   * loads, and it indexes didOpen'd files IMMEDIATELY while the bulk project
   * scan lags (measured: probes of open files answered at ~250ms while
   * project-wide queries stayed empty until ~2.3s). So the readiness probe
   * MUST be a symbol from a candidate we deliberately do NOT open. We open
   * the first few entry-point candidates (project load), keep the next
   * candidate closed and probe one of its declared names (bulk index live);
   * each probe carries a short timeout so a stalled mid-index request cannot
   * eat the budget.
   */
  private async openSeedFile(client: LspClient, config: LspCommand, workspaceRoot: string): Promise<void> {
    try {
      const candidates = this.findSeedCandidates(workspaceRoot, config.languageId);
      if (candidates.length < 2) return;
      const openCount = Math.min(candidates.length - 1, 4);
      let probe: string | undefined;
      for (const [i, seed] of candidates.entries()) {
        let content: string;
        try {
          content = await this.jian.readText(seed);
        } catch {
          continue;
        }
        if (i < openCount) {
          client.didOpen(seed, content, config.languageId);
        } else {
          probe = extractProbeIdentifier(content);
          if (probe !== undefined) break;
        }
      }
      if (probe === undefined) return; // Nothing closed+probeable to assert against.
      // Stage 1: the server must stop answering "No Project" (deadline 15s).
      const loadDeadline = Date.now() + 15_000;
      let delay = 200;
      let loaded = false;
      while (Date.now() < loadDeadline) {
        if (await client.hasLoadedProject()) {
          loaded = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 1_000);
      }
      if (!loaded) return;
      // Stage 2: wait until the CLOSED probe file's symbol is queryable —
      // that is the moment the bulk project index goes live. A candidate
      // outside the tsconfig project never resolves; the 10s deadline caps
      // the damage (cold start happens once per workspace per session).
      const warmDeadline = Date.now() + 10_000;
      while (Date.now() < warmDeadline) {
        try {
          const warm = await client.workspaceSymbols(probe, 4_000);
          if (warm.length > 0) return;
        } catch {
          // Stalled mid-index; keep probing until the deadline.
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    } catch {
      // Seeding is opportunistic; never block the client on it.
    }
  }

  /**
   * Find existing source files in the workspace matching the language,
   * ordered entry-point-first. Monorepo roots rarely keep sources at the top
   * level, so scan shallowly (depth ≤ 3) under src/ and the root. Multiple
   * candidates matter because the first file may declare no probeable name.
   */
  private findSeedCandidates(workspaceRoot: string, languageId: string): string[] {
    const extensions = Object.entries(LANGUAGE_SERVERS)
      .filter(([, config]) => config.languageId === languageId)
      .map(([ext]) => ext);
    const roots = [join(workspaceRoot, 'src'), workspaceRoot, join(workspaceRoot, 'packages')];
    const out: string[] = [];
    for (const dir of roots) {
      this.scanForSeed(dir, extensions, 0, out);
      if (out.length >= 8) return out;
    }
    return out;
  }

  private scanForSeed(dir: string, extensions: readonly string[], depth: number, out: string[]): void {
    if (depth > 3 || out.length >= 8 || !existsSync(dir)) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Prefer entry-point-looking files in this directory first.
    for (const ext of extensions) {
      for (const base of ['index', 'main']) {
        const candidate = entries.find((e) => e.isFile() && e.name === `${base}${ext}`);
        if (candidate !== undefined) out.push(join(dir, candidate.name));
      }
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
      if (
        entry.isFile() &&
        extensions.some((ext) => entry.name.endsWith(ext)) &&
        !entry.name.endsWith('.d.ts') &&
        !out.some((seed) => seed.endsWith(`/${entry.name}`))
      ) {
        out.push(join(dir, entry.name));
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
      this.scanForSeed(join(dir, entry.name), extensions, depth + 1, out);
    }
  }

  private async createAndStartClient(
    config: LspCommand,
    workspaceRoot: string,
    key: string,
  ): Promise<LspClient> {
    const client = new LspClient(
      config.command,
      workspaceRoot,
      this.jian,
      config.initOptions?.(workspaceRoot),
      this.supervisor,
    );
    try {
      await client.start();
      return client;
    } catch (error) {
      // Uncache the failed promise so subsequent calls don't reuse a
      // half-started client (process undefined, started flag stuck) and
      // block for the diagnostics poll timeout on every Edit/Write.
      this.clients.delete(key);
      throw error;
    }
  }

  languageIdForPath(path: string): string | undefined {
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    return LANGUAGE_SERVERS[ext]?.languageId;
  }

  /** Returns the server command for the path's extension, or undefined when unsupported. */
  commandForPath(path: string): string[] | undefined {
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    return LANGUAGE_SERVERS[ext]?.command;
  }

  async stopAll(): Promise<void> {
    // Final: mark stopping first so any in-flight getClient/getWorkspaceClient
    // short-circuits instead of starting a server mid-teardown.
    this.stopping = true;
    const promises = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(
      promises.map((promise) => promise.then((client) => client.stop())),
    );
  }
}

/**
 * Extract a candidate probe identifier from seed source: the first declared
 * name (class/interface/function/const/…) long enough to be distinctive.
 * "Long enough" matters: tsserver's navto answers generic short queries from
 * its lib .d.ts long before PROJECT files land in the index, so the probe
 * must be a name that can only come from the seed's own project file.
 */
function extractProbeIdentifier(content: string): string | undefined {
  const declaration =
    /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|interface|enum|function|const|let|type)\s+([A-Za-z_$][A-Za-z0-9_$]{5,})\b/.exec(
      content,
    );
  return declaration?.[1];
}
