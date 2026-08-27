import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { McpServerConfig } from '../config/schema';
import { log } from '../logging/logger';
import { discoverSkills, type SkillRoot } from '../skill';
import { downloadZip, extractZip } from './archive';
import { resolveGithubSource } from './github-resolver';
import { parseManifest, type ParsedManifestResult } from './manifest';
import { readInstalled, writeInstalled, type InstalledRecord } from './store';
import { compareManifestVersions, resolveInstallSource } from './source';
import {
  acknowledgeQuarantine,
  appendQuarantine,
  matchQuarantine,
  readQuarantine,
  sourceKeyFromFields,
  sourceKeyFromRawSource,
  type QuarantineEntry,
} from './quarantine';
import { flushStats, forgetStats, getUsage, recordUsageInMemory, type UsageStats } from './stats';
import {
  type EnabledPluginSessionStart,
  type PluginCapabilityState,
  type PluginDiagnostic,
  type PluginGithubMetadata,
  type PluginInfo,
  type PluginMcpServerInfo,
  type PluginRecord,
  type PluginSkillSummary,
  type PluginSource,
  type PluginSummary,
  type ReloadSummary,
  normalizePluginId,
} from './types';

/** Result of `PluginManager.upgrade` — the freshly installed record plus provenance. */
export interface PluginUpgradeResult {
  readonly record: PluginRecord;
  readonly from: string | undefined;
  readonly to: string | undefined;
  /** Set when the target version is not a clean upgrade (same/downgrade/unknown). */
  readonly warn?: 'same' | 'downgrade' | 'unknown';
  readonly backupPath: string;
}

// Hidden Scream CLI subcommand that re-enters as a Node interpreter.
// Used as fallback when an MCP server declares `"command": "node"` but the
// user is running a single-binary Scream build that doesn't have `node` on PATH.
const SCREAM_NODE_FALLBACK_SUBCOMMAND = '__plugin_run_node';

export interface PluginManagerOptions {
  readonly screamHomeDir: string;
}

export class PluginManager {
  private readonly screamHomeDir: string;
  private records = new Map<string, PluginRecord>();

  constructor(options: PluginManagerOptions) {
    this.screamHomeDir = options.screamHomeDir;
  }

  async load(): Promise<void> {
    const file = await readInstalled(this.screamHomeDir);
    const next = new Map<string, PluginRecord>();
    for (const entry of file.plugins) {
      next.set(entry.id, await this.materialize(entry));
    }
    this.records = next;
  }

  list(): readonly PluginRecord[] {
    return [...this.records.values()].toSorted((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): PluginRecord | undefined {
    return this.records.get(normalizePluginId(id));
  }

  /**
   * Register a plugin that was generated locally (e.g. via /make-skill).
   * The caller is responsible for preparing `root` with a valid manifest.
   * Throws if a plugin with the same id already exists.
   */
  async registerGenerated(root: string): Promise<PluginRecord> {
    const parsed = await parseManifest(root);
    if (parsed.manifest === undefined) {
      const msg = parsed.diagnostics.find((d) => d.severity === 'error')?.message ?? 'no manifest';
      throw new Error(`Cannot register generated plugin at ${root}: ${msg}`);
    }
    const id = normalizePluginId(parsed.manifest.name);
    const existing = this.records.get(id);
    if (existing !== undefined) {
      throw new Error(`Plugin "${id}" already exists`);
    }
    const now = new Date().toISOString();
    const record = await recordFrom({
      id,
      root,
      enabled: true,
      installedAt: now,
      updatedAt: now,
      source: 'local-path',
      parsed,
    });
    this.records.set(id, record);
    await this.persist();
    return record;
  }

  async install(source: string): Promise<PluginRecord> {
    const resolved = resolveInstallSource(source);

    let normalizedRoot: string;
    let originalSource: string;
    let sourceType: PluginSource;
    let parsed: ParsedManifestResult;
    let id: string;
    let github: PluginGithubMetadata | undefined;

    if (resolved.kind === 'local-path') {
      const sourceRoot = await normalizeInstallRoot(resolved.path);
      originalSource = resolved.path;
      sourceType = 'local-path';
      parsed = await parseManifest(sourceRoot);
      if (parsed.manifest === undefined) {
        const msg = parsed.diagnostics.find((d) => d.severity === 'error')?.message ?? 'no manifest';
        throw new Error(`Cannot install plugin at ${sourceRoot}: ${msg}`);
      }
      id = normalizePluginId(parsed.manifest.name);
      normalizedRoot = await copyPluginToManagedRoot(this.screamHomeDir, id, sourceRoot);
      parsed = await parseManifest(normalizedRoot);
    } else {
      let zipUrl: string;
      if (resolved.kind === 'github') {
        const githubResolution = await resolveGithubSource(resolved);
        zipUrl = githubResolution.tarballUrl;
        originalSource = source.trim();
        sourceType = 'github';
        github = {
          owner: resolved.owner,
          repo: resolved.repo,
          ref: githubResolution.ref,
        };
      } else {
        zipUrl = resolved.path;
        originalSource = resolved.path;
        sourceType = 'zip-url';
      }
      const buffer = await downloadZip(zipUrl);
      const tmpDir = await mkdtemp(path.join(tmpdir(), 'scream-plugin-zip-'));
      try {
        const detectedRoot = await extractZip(buffer, tmpDir);
        parsed = await parseManifest(detectedRoot);
        if (parsed.manifest === undefined) {
          const msg = parsed.diagnostics.find((d) => d.severity === 'error')?.message ?? 'no manifest';
          throw new Error(`Cannot install plugin from ${originalSource}: ${msg}`);
        }
        id = normalizePluginId(parsed.manifest.name);
        normalizedRoot = await copyPluginToManagedRoot(this.screamHomeDir, id, detectedRoot);
        parsed = await parseManifest(normalizedRoot);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    }

    if (parsed.manifest === undefined) {
      const msg = parsed.diagnostics.find((d) => d.severity === 'error')?.message ?? 'no manifest';
      throw new Error(`Cannot install plugin at ${normalizedRoot}: ${msg}`);
    }
    id = normalizePluginId(parsed.manifest.name);
    const existing = this.records.get(id);
    const now = new Date().toISOString();
    const record = await recordFrom({
      id,
      root: normalizedRoot,
      enabled: existing?.enabled ?? true,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
      originalSource,
      source: sourceType,
      capabilities: existing?.capabilities,
      github,
      parsed,
    });
    this.records.set(id, record);
    await this.persist();
    return record;
  }

  /**
   * Replace an already-installed plugin's files from `source`, keeping a
   * single-slot backup of the previous contents under
   * `plugins/backups/<id>/`. Unlike a plain reinstall this records the
   * version transition and refuses to run for unknown ids, so it can always
   * be paired with `rollback`.
   */
  async upgrade(source: string): Promise<PluginUpgradeResult> {
    const resolved = resolveInstallSource(source);
    const isLocal = resolved.kind === 'local-path';
    let stagedRoot: string;
    let originalSource: string;
    let sourceType: PluginSource;
    let parsed: ParsedManifestResult;
    let github: PluginGithubMetadata | undefined;
    let remoteTmpRoot: string | undefined;

    // Phase 1 mirrors install(): resolve/extract into a DETACHED location so
    // nothing under plugins/managed changes until the backup exists.
    if (resolved.kind === 'local-path') {
      stagedRoot = await normalizeInstallRoot(resolved.path);
      originalSource = resolved.path;
      sourceType = 'local-path';
      parsed = await parseManifest(stagedRoot);
      if (parsed.manifest === undefined) {
        const msg =
          parsed.diagnostics.find((d) => d.severity === 'error')?.message ?? 'no manifest';
        throw new Error(`Cannot upgrade plugin at ${stagedRoot}: ${msg}`);
      }
    } else {
      let zipUrl: string;
      const tmpDir = await mkdtemp(path.join(tmpdir(), 'scream-plugin-upgrade-'));
      stagedRoot = tmpDir;
      remoteTmpRoot = tmpDir;
      try {
        if (resolved.kind === 'github') {
          const githubResolution = await resolveGithubSource(resolved);
          zipUrl = githubResolution.tarballUrl;
          originalSource = source.trim();
          sourceType = 'github';
          github = {
            owner: resolved.owner,
            repo: resolved.repo,
            ref: githubResolution.ref,
          };
        } else {
          zipUrl = resolved.path;
          originalSource = resolved.path;
          sourceType = 'zip-url';
        }
        const buffer = await downloadZip(zipUrl);
        stagedRoot = await extractZip(buffer, tmpDir);
        parsed = await parseManifest(stagedRoot);
        if (parsed.manifest === undefined) {
          const msg =
            parsed.diagnostics.find((d) => d.severity === 'error')?.message ?? 'no manifest';
          throw new Error(`Cannot upgrade plugin from ${originalSource}: ${msg}`);
        }
      } catch (error) {
        await rm(tmpDir, { recursive: true, force: true });
        throw error;
      }
    }

    const disposeStaged = async (): Promise<void> => {
      if (!isLocal) {
        await rm(stagedRoot, { recursive: true, force: true });
        if (remoteTmpRoot !== undefined && remoteTmpRoot !== stagedRoot) {
          await rm(remoteTmpRoot, { recursive: true, force: true });
        }
      }
    };

    try {
      const id = normalizePluginId(parsed.manifest.name);
      const existing = this.records.get(id);
      if (existing === undefined) {
        throw new Error(
          `Plugin "${id}" is not installed; upgrade requires an existing installation`,
        );
      }
      const oldVersion = existing.manifest?.version;
      const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
      const backupsForId = path.join(this.screamHomeDir, 'plugins', 'backups', id);
      // The timestamp LEADS the directory name so a lexicographic sort is a
      // chronological sort: `${version}-${stamp}` would sort 0.10.0 before
      // 0.9.0 and prune the wrong backup.
      const backupPath = path.join(
        backupsForId,
        `${stamp}-${(oldVersion ?? 'unknown').replaceAll(/[:.]/g, '-')}`,
      );
      await mkdir(backupPath, { recursive: true });
      await cp(existing.root, backupPath, { recursive: true });
      // Stash the pre-upgrade provenance next to the files: a later rollback
      // must restore SOURCE metadata (originalSource/source/github), not just
      // the files — otherwise files roll back to the old version while the
      // record claims the new source.
      try {
        await writeFile(
          path.join(backupPath, '.scream-rollback.json'),
          JSON.stringify({
            originalSource: existing.originalSource,
            source: existing.source,
            ...(existing.github !== undefined ? { github: existing.github } : {}),
          }),
          'utf8',
        );
      } catch {
        // Provenance restore is best-effort; files remain fully restorable.
      }
      await keepNewestBackupOnly(backupsForId);

      const comparison = compareManifestVersions(oldVersion, parsed.manifest.version);
      const warn =
        comparison === undefined
          ? ('unknown' as const)
          : comparison === 0
            ? ('same' as const)
            : comparison === 1
              ? // compare(old, new) > 0 reads as: the incoming version is OLDER.
                ('downgrade' as const)
              : undefined;

      const promotedRoot = await copyPluginToManagedRoot(this.screamHomeDir, id, stagedRoot);
      const promoted = await parseManifest(promotedRoot);
      const baseRecord = await recordFrom({
        id,
        root: promotedRoot,
        enabled: existing.enabled,
        installedAt: existing.installedAt,
        updatedAt: new Date().toISOString(),
        originalSource,
        source: sourceType,
        capabilities: existing.capabilities,
        github,
        parsed: promoted,
      });
      const note = `upgraded ${oldVersion ?? 'unknown'} -> ${promoted.manifest?.version ?? 'unknown'}`;
      const record: PluginRecord = {
        ...baseRecord,
        diagnostics: [
          ...baseRecord.diagnostics,
          { severity: 'info', message: note },
        ],
      };
      this.records.set(id, record);
      await this.persist();
      return {
        record,
        from: oldVersion,
        to: promoted.manifest?.version,
        ...(warn !== undefined ? { warn } : {}),
        backupPath,
      };
    } finally {
      await disposeStaged();
    }
  }

  /**
   * Restore a plugin's files from its newest backup (created by `upgrade`),
   * then reload the table. The backup manifest is validated BEFORE anything
   * under plugins/managed is touched.
   */
  async rollback(id: string): Promise<{ record: PluginRecord; restoredFrom: string }> {
    const key = normalizePluginId(id);
    const existing = this.records.get(key);
    if (existing === undefined) throw new Error(`Plugin "${id}" is not installed`);
    const backupsForId = path.join(this.screamHomeDir, 'plugins', 'backups', key);
    let newest: string | undefined;
    try {
      newest = (await readdir(backupsForId)).toSorted().at(-1);
    } catch {
      newest = undefined;
    }
    if (newest === undefined) {
      throw new Error(`No backup available for "${key}"`);
    }
    const backupRoot = path.join(backupsForId, newest);
    const backupParsed = await parseManifest(backupRoot);
    if (backupParsed.manifest === undefined) {
      throw new Error(`Backup at ${backupRoot} has no readable manifest`);
    }
    // Restore the provenance captured at upgrade time so files, version, AND
    // source metadata all return to the pre-upgrade state together.
    let preUpgrade: {
      originalSource?: string;
      source?: PluginSource;
      github?: PluginGithubMetadata;
    } = {};
    try {
      const meta = JSON.parse(
        await readFile(path.join(backupRoot, '.scream-rollback.json'), 'utf8'),
      ) as { originalSource?: string; source?: PluginSource; github?: PluginGithubMetadata };
      preUpgrade = meta;
    } catch {
      // Older backups have no meta file: fall back to the record's fields.
    }
    const promotedRoot = await copyPluginToManagedRoot(this.screamHomeDir, key, backupRoot);
    await rm(path.join(promotedRoot, '.scream-rollback.json'), { recursive: true, force: true });
    const promoted = await parseManifest(promotedRoot);
    const baseRecord = await recordFrom({
      id: key,
      root: promotedRoot,
      enabled: existing.enabled,
      installedAt: existing.installedAt,
      updatedAt: new Date().toISOString(),
      originalSource: preUpgrade.originalSource ?? existing.originalSource,
      source: preUpgrade.source ?? existing.source,
      capabilities: existing.capabilities,
      github: preUpgrade.github ?? existing.github,
      parsed: promoted,
    });
    const record: PluginRecord = {
      ...baseRecord,
      diagnostics: [
        ...baseRecord.diagnostics,
        { severity: 'info', message: `rolled back to backup ${newest}` },
      ],
    };
    this.records.set(key, record);
    await this.persist();
    return { record, restoredFrom: backupRoot };
  }

  /**
   * Immune memory: remember the ORIGIN of a circuit-tripped plugin so future
   * sessions can warn before installing from the same repository again.
   * Best-effort bookkeeping; unknown/local-less records are silently skipped.
   */
  async appendQuarantine(pluginId: string, reason: string): Promise<QuarantineEntry | undefined> {
    const key = normalizePluginId(pluginId);
    const record = this.records.get(key);
    if (record === undefined) return undefined;
    const sourceKey = sourceKeyFromFields({
      github: record.github,
      originalSource: record.originalSource,
    });
    if (sourceKey === '') return undefined;
    const entry: QuarantineEntry = {
      at: new Date().toISOString(),
      pluginId: key,
      ...(record.manifest?.name !== undefined ? { name: record.manifest.name } : {}),
      sourceKey,
      reason,
    };
    await appendQuarantine(this.screamHomeDir, entry);
    return entry;
  }

  /** Newest unacknowledged quarantine hit for a raw source string, if any.
   * Both the verbatim and the realpath-resolved forms are tried, because
   * temp-dir fixtures and user paths can differ by symlinks (macOS /var).
   */
  async matchQuarantineForSource(source: string): Promise<QuarantineEntry | undefined> {
    const entries = await readQuarantine(this.screamHomeDir);
    for (const key of await this.quarantineKeysFor(source)) {
      const hit = matchQuarantine(entries, key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  /** Clear the pending warning for a source once an approved install landed. */
  async acknowledgeQuarantineForSource(source: string): Promise<void> {
    for (const key of await this.quarantineKeysFor(source)) {
      await acknowledgeQuarantine(this.screamHomeDir, key);
    }
  }

  /** Advisory usage counters (see plugin/stats.ts); unknown ids are ignored. */
  recordUsage(pluginId: string, ok: boolean): void {
    const key = normalizePluginId(pluginId);
    if (!this.records.has(key)) return;
    recordUsageInMemory(this.screamHomeDir, key, ok);
  }

  async getUsage(pluginId: string): Promise<UsageStats> {
    return getUsage(this.screamHomeDir, normalizePluginId(pluginId));
  }

  private async quarantineKeysFor(source: string): Promise<string[]> {
    const keys = [sourceKeyFromRawSource(source)];
    try {
      keys.push(sourceKeyFromRawSource(await realpath(source)));
    } catch {
      // Non-path sources (URLs) have no alternate real form.
    }
    return [...new Set(keys.filter((key) => key !== ''))];
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const key = normalizePluginId(id);
    const current = this.records.get(key);
    if (current === undefined) throw new Error(`Plugin "${id}" is not installed`);
    if (current.enabled === enabled) return;
    const now = new Date().toISOString();
    this.records.set(key, { ...current, enabled, updatedAt: now });
    await this.persist();
  }

  async setMcpServerEnabled(id: string, server: string, enabled: boolean): Promise<void> {
    const key = normalizePluginId(id);
    const current = this.records.get(key);
    if (current === undefined) throw new Error(`Plugin "${id}" is not installed`);
    if (current.manifest?.mcpServers?.[server] === undefined) {
      throw new Error(`Plugin "${id}" does not declare MCP server "${server}"`);
    }
    const currentMcpServers = current.capabilities?.mcpServers ?? {};
    const nextCapabilities: PluginCapabilityState = {
      ...current.capabilities,
      mcpServers: {
        ...currentMcpServers,
        [server]: { enabled },
      },
    };
    this.records.set(key, {
      ...current,
      capabilities: nextCapabilities,
      updatedAt: new Date().toISOString(),
    });
    await this.persist();
  }

  /**
   * Flag a plugin as failed at runtime (typically its code entry point threw
   * while activating). The record keeps the reason as an error diagnostic so
   * `/plugin info` and listings show why the plugin is not usable.
   */
  async markError(id: string, message: string): Promise<void> {
    const key = normalizePluginId(id);
    const current = this.records.get(key);
    if (current === undefined) {
      log.warn('plugin markError for an unknown plugin', { pluginId: id, message });
      return;
    }
    const diagnostic: PluginDiagnostic = { severity: 'error', message };
    this.records.set(key, {
      ...current,
      state: 'error',
      diagnostics: [...current.diagnostics, diagnostic],
      updatedAt: new Date().toISOString(),
    });
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    const key = normalizePluginId(id);
    if (!this.records.delete(key)) {
      throw new Error(`Plugin "${id}" is not installed`);
    }
    await forgetStats(this.screamHomeDir, key);
    await this.persist();
  }

  async reload(): Promise<ReloadSummary> {
    const prevIds = new Set(this.records.keys());
    const file = await readInstalled(this.screamHomeDir);
    const next = new Map<string, PluginRecord>();
    const errors: Array<{ id: string; message: string }> = [];
    for (const entry of file.plugins) {
      try {
        next.set(entry.id, await this.materialize(entry));
      } catch (error) {
        errors.push({ id: entry.id, message: (error as Error).message });
      }
    }
    const added: string[] = [];
    for (const id of next.keys()) if (!prevIds.has(id)) added.push(id);
    const removed: string[] = [];
    for (const id of prevIds) if (!next.has(id)) removed.push(id);
    this.records = next;
    return { added, removed, errors };
  }

  pluginSkillRoots(): readonly SkillRoot[] {
    const roots: SkillRoot[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled || record.state !== 'ok' || record.manifest === undefined) continue;
      for (const dir of record.manifest.skills ?? []) {
        roots.push({
          path: dir,
          source: 'extra',
          plugin: { id: record.id, instructions: record.skillInstructions },
        });
      }
    }
    return roots;
  }

  enabledSessionStarts(): readonly EnabledPluginSessionStart[] {
    const out: EnabledPluginSessionStart[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled || record.state !== 'ok') continue;
      const skill = record.manifest?.sessionStart?.skill;
      if (skill === undefined) continue;
      out.push({ pluginId: record.id, skillName: skill });
    }
    return out;
  }

  enabledMcpServers(): Record<string, McpServerConfig> {
    const out: Record<string, McpServerConfig> = {};
    for (const record of this.records.values()) {
      if (!record.enabled || record.state !== 'ok' || record.manifest === undefined) continue;
      for (const [name, config] of Object.entries(record.manifest.mcpServers ?? {})) {
        if (!isMcpServerEnabled(record, name, config)) continue;
        out[pluginMcpRuntimeName(record.id, name)] = withPluginMcpRuntime(
          withMcpServerEnabled(config, true),
          record.root,
          this.screamHomeDir,
        );
      }
    }
    return out;
  }

  summaries(): readonly PluginSummary[] {
    return this.list().map((record) => recordToSummary(record));
  }

  info(id: string): PluginInfo | undefined {
    const record = this.get(id);
    return record === undefined ? undefined : recordToInfo(record);
  }

  private async persist(): Promise<void> {
    const installed: InstalledRecord[] = [...this.records.values()].map((record) => ({
      id: record.id,
      root: record.root,
      source: record.source,
      enabled: record.enabled,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
      originalSource: record.originalSource,
      capabilities: record.capabilities,
      github: record.github,
    }));
    await writeInstalled(this.screamHomeDir, { version: 1, plugins: installed });
    // Management writes are the natural flush point for the usage sidecar, so
    // counters never sit un-written longer than the debounce window. Stats are
    // advisory: a sidecar write failure must NOT fail the management action
    // whose table write already succeeded.
    try {
      await flushStats(this.screamHomeDir);
    } catch {
      // Swallow: usage metrics are best-effort, configuration is the truth.
    }
  }

  private async materialize(entry: InstalledRecord): Promise<PluginRecord> {
    const parsed = await parseManifest(entry.root);
    return recordFrom({
      id: entry.id,
      root: entry.root,
      enabled: entry.enabled,
      installedAt: entry.installedAt,
      updatedAt: entry.updatedAt,
      originalSource: entry.originalSource,
      capabilities: entry.capabilities,
      github: entry.github,
      source: entry.source,
      parsed,
    });
  }
}

async function normalizeInstallRoot(rootPath: string): Promise<string> {
  const trimmed = rootPath.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`Plugin root must be an absolute path (got "${rootPath}")`);
  }
  let resolved: string;
  try {
    resolved = await realpath(trimmed);
  } catch (error) {
    throw new Error(`Plugin root does not exist: ${trimmed}`, { cause: error });
  }
  if (!(await stat(resolved)).isDirectory()) {
    throw new Error(`Plugin root is not a directory: ${trimmed}`);
  }
  return resolved;
}

async function copyPluginToManagedRoot(
  screamHomeDir: string,
  id: string,
  sourceRoot: string,
): Promise<string> {
  const managedRoot = path.join(screamHomeDir, 'plugins', 'managed', id);
  const managedDir = path.dirname(managedRoot);
  await mkdir(managedDir, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(managedDir, `${id}-`));
  try {
    await cp(sourceRoot, stagingRoot, { recursive: true });
    await rm(managedRoot, { recursive: true, force: true });
    await rename(stagingRoot, managedRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  return realpath(managedRoot);
}

/**
 * Keep only the newest backup slot per plugin id: upgrade creates a fresh
 * timestamped directory each run, so older siblings are removed here to keep
 * backups bounded. Names sort chronologically because they embed an
 * ISO-derived stamp.
 */
async function keepNewestBackupOnly(backupsForId: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(backupsForId);
  } catch {
    return;
  }
  const ordered = names.toSorted();
  for (const name of ordered.slice(0, Math.max(0, ordered.length - 1))) {
    await rm(path.join(backupsForId, name), { recursive: true, force: true });
  }
}

async function recordFrom(input: {
  id: string;
  root: string;
  enabled: boolean;
  installedAt: string;
  updatedAt?: string;
  originalSource?: string;
  capabilities?: PluginCapabilityState;
  github?: PluginGithubMetadata;
  source?: PluginSource;
  parsed: ParsedManifestResult;
}): Promise<PluginRecord> {
  const { parsed } = input;
  const hasError = parsed.diagnostics.some((d) => d.severity === 'error');
  const skills = hasError || parsed.manifest === undefined ? [] : await discoverPluginSkills(input.id, parsed.manifest);
  return {
    id: input.id,
    root: input.root,
    source: input.source ?? 'local-path',
    enabled: input.enabled,
    state: hasError || parsed.manifest === undefined ? 'error' : 'ok',
    installedAt: input.installedAt,
    updatedAt: input.updatedAt,
    originalSource: input.originalSource,
    capabilities: input.capabilities,
    github: input.github,
    skills,
    skillCount: skills.length,
    manifest: parsed.manifest,
    manifestKind: parsed.manifestKind,
    manifestPath: parsed.manifestPath,
    shadowedManifestPath: parsed.shadowedManifestPath,
    diagnostics: parsed.diagnostics,
    skillInstructions: parsed.manifest?.skillInstructions,
  };
}

function recordToSummary(record: PluginRecord): PluginSummary {
  return {
    id: record.id,
    displayName: record.manifest?.interface?.displayName ?? record.id,
    version: record.manifest?.version,
    enabled: record.enabled,
    state: record.state,
    skillCount: record.skillCount,
    skills: record.skills,
    mcpServerCount: Object.keys(record.manifest?.mcpServers ?? {}).length,
    enabledMcpServerCount: pluginMcpServersInfo(record).filter((server) => server.enabled).length,
    hasErrors: record.diagnostics.some((d) => d.severity === 'error'),
    source: record.source,
    originalSource: record.originalSource,
    github: record.github,
  };
}

async function discoverPluginSkills(
  pluginId: string,
  manifest: PluginRecord['manifest'],
): Promise<readonly PluginSkillSummary[]> {
  const roots = (manifest?.skills ?? []).map((dir) => ({
    path: dir,
    source: 'extra',
    plugin: { id: pluginId, instructions: manifest?.skillInstructions },
  }) satisfies SkillRoot);
  if (roots.length === 0) return [];
  const skills = await discoverSkills({ roots });
  return skills.map((skill) => ({ name: skill.name, description: skill.description }));
}

function recordToInfo(record: PluginRecord): PluginInfo {
  return {
    ...recordToSummary(record),
    root: record.root,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    manifestKind: record.manifestKind,
    manifestPath: record.manifestPath,
    manifest: record.manifest,
    mcpServers: pluginMcpServersInfo(record),
    shadowedManifestPath: record.shadowedManifestPath,
    diagnostics: record.diagnostics,
  };
}

function isMcpServerEnabled(
  record: PluginRecord,
  name: string,
  config: McpServerConfig,
): boolean {
  return record.capabilities?.mcpServers?.[name]?.enabled ?? config.enabled !== false;
}

function pluginMcpServersInfo(record: PluginRecord): readonly PluginMcpServerInfo[] {
  return Object.entries(record.manifest?.mcpServers ?? {})
    .map(([name, config]) => pluginMcpServerInfo(record, name, config))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

function pluginMcpServerInfo(
  record: PluginRecord,
  name: string,
  config: McpServerConfig,
): PluginMcpServerInfo {
  if (config.transport === 'http') {
    return {
      name,
      runtimeName: pluginMcpRuntimeName(record.id, name),
      enabled: isMcpServerEnabled(record, name, config),
      transport: 'http',
      url: config.url,
      headerKeys: config.headers === undefined ? undefined : Object.keys(config.headers).toSorted(),
    };
  }
  return {
    name,
    runtimeName: pluginMcpRuntimeName(record.id, name),
    enabled: isMcpServerEnabled(record, name, config),
    transport: 'stdio',
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    envKeys: config.env === undefined ? undefined : Object.keys(config.env).toSorted(),
  };
}

function withMcpServerEnabled(config: McpServerConfig, enabled: boolean): McpServerConfig {
  return { ...config, enabled };
}

function pluginMcpRuntimeName(pluginId: string, serverName: string): string {
  // Plugin ids cannot contain ":", so this keeps plugin/server pairs unambiguous
  // even when either side contains "-".
  return `${PLUGIN_MCP_RUNTIME_PREFIX}${pluginId}:${serverName}`;
}

/** Runtime-name prefix that marks an MCP server as contributed by a plugin. */
export const PLUGIN_MCP_RUNTIME_PREFIX = 'plugin-';

/**
 * True when an MCP runtime name belongs to a plugin. Anything else is
 * user-configured and must never be touched by the plugin hot-apply pass.
 */
export function isPluginMcpRuntimeName(name: string): boolean {
  return name.startsWith(PLUGIN_MCP_RUNTIME_PREFIX);
}

/**
 * The plugin id embedded in a plugin MCP runtime name, or `undefined` for a
 * user-configured server or a name that is not well-formed.
 */
export function pluginIdFromMcpRuntimeName(name: string): string | undefined {
  if (!isPluginMcpRuntimeName(name)) return undefined;
  const separator = name.indexOf(':');
  if (separator <= PLUGIN_MCP_RUNTIME_PREFIX.length) return undefined;
  return name.slice(PLUGIN_MCP_RUNTIME_PREFIX.length, separator);
}

function withPluginMcpRuntime(
  config: McpServerConfig,
  pluginRoot: string,
  screamHomeDir: string,
): McpServerConfig {
  if (config.transport === 'http') return config;

  const env = {
    ...config.env,
    SCREAM_CODE_HOME: screamHomeDir,
    SCREAM_PLUGIN_ROOT: pluginRoot,
  };

  if (config.command === 'node' && isScreamNativeBinary()) {
    return {
      ...config,
      command: process.execPath,
      args: [SCREAM_NODE_FALLBACK_SUBCOMMAND, ...(config.args ?? [])],
      cwd: config.cwd ?? pluginRoot,
      env,
    };
  }

  return { ...config, cwd: config.cwd ?? pluginRoot, env };
}

function isScreamNativeBinary(): boolean {
  return !path.basename(process.execPath).toLowerCase().startsWith('node');
}
