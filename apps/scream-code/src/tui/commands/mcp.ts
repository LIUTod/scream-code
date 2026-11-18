/**
 * /mcp — MCP 服务器管理面板。
 *
 * 查看已安装的 MCP 服务器状态，一键安装推荐服务器。 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  Container,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { t } from '@scream-code/config';
import {
  pluginIdFromMcpRuntimeName,
  resolveMcpJsonPaths,
} from '@scream-code/scream-code-sdk';

import { getDataDir } from '#/utils/paths';
import { openUrl } from '#/tui/utils/open-url';
import {
  buildBrowserArgs,
  cycleChannel,
  cycleViewport,
  DEFAULT_BROWSER_OPTIONS,
  installedPackageSpec,
  launchOptionBlocker,
  parseBrowserOptions,
  unmanagedArgs,
  type BrowserRuntimeOptions,
} from './chrome-devtools-options';
import {
  findPackageSkillsLocation,
  installUpstreamSkills,
  readSkillsManifest,
  removeUpstreamSkills,
} from './mcp-skills';
import type { ColorPalette } from '#/tui/theme/colors';
import { SELECT_POINTER } from '../constant/symbols';
import type { SlashCommandHost } from './dispatch';
import { printableChar } from '../utils/printable-key';

// ─── 内置推荐列表 ──────────────────────────────────────────────────────

export interface McpRecommendation {
  name: string;
  displayName: string;
  description: string;
  command: string;
  args: string[];
  /** If true, only available on macOS */
  macOnly?: boolean;
  /** Environment variables for the MCP server. {INSTALL_DIR} is replaced with the clone path. */
  env?: Record<string, string>;
  /** If set, the repo is cloned to ~/.scream-code/mcp/<name>/ before configuring. */
  gitUrl?: string;
  /**
   * Startup timeout written into mcp.json. When omitted the entry gets no
   * field and falls back to the connection-manager default (60s) — the old
   * blanket 300s was a Playwright-era leftover.
   */
  startupTimeoutMs?: number;
  /**
   * Capability labels persisted with the entry (e.g. `['browser']`) so the
   * config layer — and with it guide injection and the panel — understands
   * what the server is for without name hard-coding.
   */
  capabilities?: string[];
}

/**
 * The one recommendation with adjustable launch options (see
 * `chrome-devtools-options.ts`). Kept as a named constant instead of a
 * `rec.options` field on every entry: options are a property of *this* server's
 * CLI, not of the recommendation concept.
 */
const BROWSER_RECOMMENDATION = 'chrome-devtools';

// Built per call — t() must be evaluated after any runtime /language switch,
// not once at module load.
function getRecommended(): McpRecommendation[] {
  return [
    {
      name: 'chrome-devtools',
      displayName: 'Chrome DevTools',
      description: t('mcp.browser_desc'),
      command: 'npx',
      // Base flags + the default runtime options. The flags themselves (and
      // their rationale) live in `chrome-devtools-options.ts`, which also
      // parses them back for the `/mcp` options submenu.
      args: buildBrowserArgs(DEFAULT_BROWSER_OPTIONS),
      env: { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' },
      // Plain npm package; Chrome itself only launches lazily on the first
      // tool call. 180s covers a cold `npx` download on a slow link without
      // the old "first launch downloads Chromium" (Playwright) rationale.
      startupTimeoutMs: 180_000,
      capabilities: ['browser'],
    },
    {
      name: 'scream-life',
      displayName: 'ScreamLife',
      description: 'Decision memory system - captures and analyzes your decisions during conversations',
      command: 'bun',
      args: ['{INSTALL_DIR}/Core/mcp-server.ts'],
      env: {
        SCREAM_LIFE_DB_PATH: '{INSTALL_DIR}/Data/scream-life.db',
      },
      gitUrl: 'https://github.com/LIUTod/scream-life.git',
      capabilities: ['memory'],
    },
  ];
}

/**
 * Args/env as they must be written for a recommendation.
 *
 * `gitUrl` recommendations carry `{INSTALL_DIR}` placeholders that only mean
 * something once the clone exists. Every managed write has to resolve them —
 * writing the placeholder verbatim would persist an entry that cannot launch,
 * which is exactly the kind of "saved but broken" state nobody debugs later.
 */
export function resolveRecommendationArgs(
  rec: McpRecommendation,
  installDir: string,
): { args: string[]; env?: Record<string, string> } {
  if (rec.gitUrl === undefined) {
    return { args: [...rec.args], ...(rec.env === undefined ? {} : { env: rec.env }) };
  }
  const replace = (value: string): string => value.replaceAll('{INSTALL_DIR}', installDir);
  return {
    args: rec.args.map(replace),
    ...(rec.env === undefined
      ? {}
      : { env: Object.fromEntries(Object.entries(rec.env).map(([k, v]) => [k, replace(v)])) }),
  };
}

// ─── 推荐参数漂移检测 ─────────────────────────────────────────────────

/**
 * Recommended flags the installed entry does not carry.
 *
 * Only tokens that look like flags (`-…`) are compared: the package specifier
 * is deliberately excluded so a user who pinned `chrome-devtools-mcp@1.13.0`
 * instead of `@latest` is not nagged, and npx's own `-y` is compared like any
 * other flag. Values are part of the token (`--screenshot-quality=85`), so a
 * user who tuned a value sees it offered for reset — that is what the
 * confirmation text promises.
 */
export function missingRecommendedArgs(
  installed: readonly string[],
  recommended: readonly string[],
): readonly string[] {
  const have = new Set(installed);
  return recommended.filter((token) => token.startsWith('-') && !have.has(token));
}

// ─── 状态映射 ─────────────────────────────────────────────────────────

function getStatusLabels(): Record<string, string> {
  return {
    pending: t('mcp.connecting'),
    connected: t('mcp.connected'),
    failed: t('mcp.failed'),
    disabled: t('mcp.disabled'),
    'needs-auth': t('mcp.auth_required'),
  };
}

// Built per call for the same reason as getRecommended(): t() must track a
// runtime /language switch. Unknown capabilities fall back to their raw id.
function getCapabilityLabels(): Record<string, string> {
  return {
    browser: t('mcp.capability_browser'),
    memory: t('mcp.capability_memory'),
  };
}

// ─── Handler ──────────────────────────────────────────────────────────

export async function handleMcpCommand(
  host: SlashCommandHost,
  _args: string,
): Promise<void> {
  if (!host.session) {
    host.showError(t('mcp.no_session'));
    return;
  }
  await openMcpPanel(host);
}

// ─── 主面板 ───────────────────────────────────────────────────────────

interface McpRow {
  kind: 'installed' | 'recommended' | 'option';
  name: string;
  label: string;
  status?: string;
  toolCount?: number;
  error?: string;
  description?: string;
  alreadyInstalled?: boolean;
  /** Recommended flags the installed entry is missing; >0 offers an update. */
  updateAvailable?: number;
}

async function openMcpPanel(host: SlashCommandHost): Promise<void> {
  const servers = await loadServers(host);
  const rows = buildRows(servers, readInstalledRecommendedArgs());
  const connectedCount = servers.filter((s) => s.status === 'connected').length;

  let picker: McpPickerComponent;

  const refreshPanel = async () => {
    const s = await loadServers(host);
    const r = buildRows(s, readInstalledRecommendedArgs());
    const cc = s.filter((x) => x.status === 'connected').length;
    picker.refresh(r, t('mcp.manage_title', { count: `${cc}/${s.length}` }));
    host.mountEditorReplacement(picker);
  };

  picker = new McpPickerComponent({
    title: t('mcp.manage_title', { count: `${connectedCount}/${servers.length}` }),
    rows,
    colors: host.state.theme.colors,
    onEnter: (row) => {
      void (async () => {
        host.restoreEditor();
        await handleEnter(host, row);
        await refreshPanel();
      })();
    },
    onDelete: (row) => {
      void (async () => {
        host.restoreEditor();
        await handleDelete(host, row);
        await refreshPanel();
      })();
    },
    onAuthenticate: (row) => {
      void (async () => {
        await handleAuthenticate(host, row);
        await refreshPanel();
      })();
    },
    onOptions: (row) => {
      void (async () => {
        host.restoreEditor();
        await handleOptions(host, row);
        await refreshPanel();
      })();
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });

  host.mountEditorReplacement(picker);
}

// ─── 数据加载 ─────────────────────────────────────────────────────────

async function loadServers(
  host: SlashCommandHost,
): Promise<readonly { name: string; status: string; toolCount: number; error?: string; capabilities?: readonly string[]; serverVersion?: string }[]> {
  if (!host.session) return [];
  try {
    return await host.session.listMcpServers();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    host.showError(t('mcp.load_failed', { msg }));
    return [];
  }
}

/** Replace newlines so error messages don't break single-line terminal rendering. */
function sanitizeDesc(s: string): string {
  return s.replaceAll(/\r?\n/g, ' ').replaceAll(/\s+/g, ' ').trim();
}

export function buildRows(
  servers: readonly { name: string; status: string; toolCount: number; error?: string; capabilities?: readonly string[]; serverVersion?: string }[],
  /**
   * Launch args of installed entries, keyed by server name. Only entries read
   * from the *user-level* mcp.json are passed in: a project-declared or
   * plugin-owned entry is not ours to rewrite, so it never gets an update hint.
   */
  installedArgs: Readonly<Record<string, readonly string[]>> = {},
): McpRow[] {
  const rows: McpRow[] = [];
  // A server that's installed but in a failed state should still be
  // retryable — don't mark it "already installed" in recommendations.
  const installedNames = new Set(
    servers.filter((s) => s.status !== 'failed').map((s) => s.name),
  );

  if (servers.length > 0) {
    rows.push({ kind: 'installed', name: '', label: '── ' + t('mcp.installed') + ' ──', status: '__section' });
    for (const s of servers) {
      // A needs-auth row is a dead end unless the key that fixes it is visible
      // right where the problem is shown.
      const authHint =
        s.status === 'needs-auth' ? `[a ${t('mcp.auth_action')}]` : '';
      const statusLabel = getStatusLabels()[s.status] ?? s.status;
      // `@latest` in args says nothing about the version that actually
      // resolved, so the row reports what the handshake said.
      const versionInfo = s.status === 'connected' && s.serverVersion !== undefined
        ? `v${s.serverVersion}`
        : '';
      const toolInfo = s.status === 'connected' ? `${s.toolCount} tools` : '';
      const capLabels = getCapabilityLabels();
      const capInfo = (s.capabilities ?? []).map((c) => capLabels[c] ?? c).join('  ');
      const errorInfo = s.error ? ` — ${sanitizeDesc(s.error)}` : '';
      // Plugin-contributed servers are managed by the plugin registry, not by
      // mcp.json: /mcp must say so instead of offering a silent no-op uninstall.
      const pluginInfo = pluginIdFromMcpRuntimeName(s.name) !== undefined ? t('mcp.plugin_owned') : '';
      rows.push({
        kind: 'installed',
        name: s.name,
        label: s.name,
        status: s.status,
        toolCount: s.toolCount,
        error: s.error,
        description: [statusLabel, authHint, versionInfo, toolInfo, capInfo, pluginInfo, errorInfo]
          .filter(Boolean)
          .join('  '),
      });
    }
  } else {
    rows.push({
      kind: 'installed', name: '', label: t('mcp.no_installed'), status: '__empty',
    });
  }

  rows.push({ kind: 'recommended', name: '', label: '── ' + t('mcp.recommended') + ' ──', status: '__section' });
  for (const rec of getRecommended()) {
    const alreadyInstalled = installedNames.has(rec.name);
    const platformUnavailable = rec.macOnly && process.platform !== 'darwin';
    const installedForRec = installedArgs[rec.name];
    const drift = alreadyInstalled && installedForRec !== undefined
      ? missingRecommendedArgs(installedForRec, rec.args)
      : [];
    rows.push({
      kind: 'recommended',
      name: rec.name,
      label: rec.displayName,
      description: platformUnavailable
        ? `${rec.description}  [${t('mcp.macos_only')}]`
        : drift.length > 0
          ? `${rec.description}  [${t('mcp.update_available', { count: drift.length })}]`
          : alreadyInstalled
            ? `${rec.description}  [${t('mcp.installed')}]`
            : `${rec.description}  [${t('mcp.install_enter')}]`,
      alreadyInstalled: alreadyInstalled || platformUnavailable,
      updateAvailable: drift.length > 0 ? drift.length : undefined,
    });
  }

  return rows;
}

// ─── 动作处理 ────────────────────────────────────────────────────────

export async function handleEnter(
  host: SlashCommandHost,
  row: McpRow,
): Promise<void> {
  if (row.kind === 'recommended') {
    const rec = getRecommended().find((r) => r.name === row.name);
    if (!rec) return;
    if (row.alreadyInstalled) {
      // An installed built-in whose launch args drifted from the current
      // recommendation: Enter resets them instead of reporting "already
      // installed" — otherwise existing installs never receive a new flag.
      if (row.updateAvailable !== undefined && row.updateAvailable > 0) {
        await updateRecommendedMcp(host, rec);
      } else {
        host.showStatus(t('mcp.already_installed', { name: row.label }));
      }
      return;
    }
    await installMcp(host, rec);
  } else if (row.kind === 'installed' && row.status === 'needs-auth') {
    // Reconnecting without tokens just fails again; point at the action.
    host.showStatus(t('mcp.auth_needed_hint', { name: row.label }));
  } else if (row.kind === 'installed' && row.status && row.status !== '__section' && row.status !== '__empty') {
    if (row.status === 'connected') {
      await disableMcp(host, row.name);
    } else {
      await enableMcp(host, row.name);
    }
  }
}

export async function handleDelete(
  host: SlashCommandHost,
  row: McpRow,
): Promise<void> {
  if (row.kind !== 'installed' || !row.status || row.status === '__section' || row.status === '__empty') {
    return;
  }
  // Plugin-owned servers are refused outright — before the confirmation
  // dialog, so the user gets the explanation instead of a dead-end prompt
  // for an action that the plugin sync would undo on the next startup.
  const pluginId = pluginIdFromMcpRuntimeName(row.name);
  if (pluginId !== undefined) {
    host.showError(t('mcp.uninstall_plugin_blocked', { name: row.label, plugin: pluginId }));
    return;
  }
  const confirmed = await confirmAction(host, t('mcp.uninstall_confirm', { name: row.label }));
  if (!confirmed) return;
  await uninstallMcp(host, row.name);
}

/**
 * The single write+reconnect path for a recommended entry.
 *
 * Install, drift-reset and the options submenu all end here, so mcp.json and
 * the runtime config can never disagree about what the server was launched
 * with. `addMcpServer` replaces the config of an existing entry and reconnects,
 * which is what makes a new flag live in the running session.
 */
async function applyRecommendedArgs(
  host: SlashCommandHost,
  rec: McpRecommendation,
  args: readonly string[],
  env: Record<string, string> | undefined = rec.env,
): Promise<
  | { status: 'applied' }
  | { status: 'saved-disabled' }
  | { status: 'saved-only'; message: string }
  | { status: 'not-written'; message: string }
> {
  const session = host.session;
  if (!session) return { status: 'not-written', message: 'session closed' };
  const existing = readUserConfigEntry(rec.name);
  await writeMcpConfig(host, {
    name: rec.name,
    // A hand-set launcher (absolute npx path, wrapper script) survives; we only
    // manage what the recommendation actually describes.
    command: typeof existing?.['command'] === 'string' ? existing['command'] : rec.command,
    args: [...args],
    env,
    startupTimeoutMs: rec.startupTimeoutMs,
    capabilities: rec.capabilities,
  });
  if (existing?.['enabled'] === false) {
    // mcp.json parks this server. Writing to it must not start it behind the
    // user's back — say "saved, still parked" instead of claiming a restart.
    return { status: 'saved-disabled' };
  }
  try {
    await session.addMcpServer(rec.name, toServerConfig(rec, args, env));
    return { status: 'applied' };
  } catch (error) {
    // The file on disk is already the new config. Reporting a bare failure
    // would invite a blind retry of something that already happened, so the
    // caller says "saved, will take effect on restart" instead.
    return {
      status: 'saved-only',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── 上游技能（chrome-devtools-mcp 官方 skill 包） ────────────────────

interface UpstreamSkillsState {
  /** A package copy was found in the npx cache. */
  available: boolean;
  packageVersion?: string;
  /** Version recorded by our manifest; undefined = not installed by us. */
  installedVersion?: string;
}

/**
 * Where npm keeps its cache. Asked from npm itself so Windows/macOS/Linux all
 * resolve the same layout the server is actually launched from; the fallback
 * keeps the menu usable when npm is not on PATH.
 */
let cachedNpmCacheRoot: string | undefined;

function npmCacheRoot(): string {
  // `npm config get cache` spawns npm (~150 ms). The menu is synchronous on the
  // TUI thread, so ask once per process instead of on every open.
  if (cachedNpmCacheRoot !== undefined) return cachedNpmCacheRoot;
  try {
    const configured = execSync('npm config get cache', {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    cachedNpmCacheRoot = configured.length > 0 ? configured : join(homedir(), '.npm');
  } catch {
    cachedNpmCacheRoot = join(homedir(), '.npm');
  }
  return cachedNpmCacheRoot;
}

/**
 * Where skill discovery actually looks: the user skill directory in the
 * Scream home (`userSkillsDir` in agent-core's `skill/scanner.ts`), which
 * follows SCREAM_CODE_HOME like every other piece of user data.
 */
function skillsRoot(): string {
  return join(getDataDir(), 'skills');
}

async function loadUpstreamSkillsState(): Promise<UpstreamSkillsState> {
  const manifest = readSkillsManifest(skillsRoot());
  const location = findPackageSkillsLocation(npmCacheRoot());
  return {
    available: location !== undefined,
    ...(location === undefined ? {} : { packageVersion: location.version }),
    ...(manifest === undefined ? {} : { installedVersion: manifest.version }),
  };
}

async function runUpstreamSkillsInstall(
  host: SlashCommandHost,
): Promise<UpstreamSkillsState | undefined> {
  const location = findPackageSkillsLocation(npmCacheRoot());
  if (location === undefined) {
    host.showStatus(t('mcp.skills_package_missing'));
    return undefined;
  }
  const root = skillsRoot();
  try {
    const result = await installUpstreamSkills(
      location.dir,
      location.version,
      root,
      readSkillsManifest(root),
    );
    // 四种结果要分开说：真装了 / 全被同名技能挡住 / 已是最新 / 包里什么都没有。
    // 混成一句「已安装 0 个」会让人以为功能坏了。
    const restart = ` ${t('mcp.skills_restart')}`;
    const conflictNote =
      result.conflicts.length > 0
        ? ` ${t('mcp.skills_conflicts', { names: result.conflicts.join(', ') })}`
        : '';
    if (result.installed.length > 0) {
      host.showStatus(
        t('mcp.skills_installed', { count: result.installed.length, version: location.version }) +
          conflictNote +
          restart,
      );
    } else if (result.conflicts.length > 0) {
      // 全部命中冲突：说「跳过」而不是「没有可安装的技能」。
      host.showStatus(t('mcp.skills_conflicts', { names: result.conflicts.join(', ') }));
    } else if (result.upToDate.length > 0) {
      host.showStatus(t('mcp.skills_up_to_date', { version: location.version }) + restart);
    } else {
      host.showStatus(t('mcp.skills_none'));
    }
    return { available: true, packageVersion: location.version, installedVersion: result.manifest.version };
  } catch (error) {
    host.showError(
      t('mcp.skills_install_failed', {
        msg: error instanceof Error ? error.message : String(error),
      }),
    );
    return undefined;
  }
}

async function runUpstreamSkillsRemove(
  host: SlashCommandHost,
): Promise<UpstreamSkillsState | undefined> {
  const root = skillsRoot();
  try {
    const result = await removeUpstreamSkills(root, readSkillsManifest(root));
    const blocked =
      result.blocked.length > 0
        ? ` ${t('mcp.skills_remove_blocked', { names: result.blocked.join(', ') })}`
        : '';
    host.showStatus(
      t('mcp.skills_removed', { count: result.removed.length }) + blocked + ` ${t('mcp.skills_restart')}`,
    );
    const state = await loadUpstreamSkillsState();
    // Anything left on disk is still ours: keep reporting the installed version
    // so the row does not flip to "install" for skills that never went away.
    return result.blocked.length > 0 ? state : { ...state, installedVersion: undefined };
  } catch (error) {
    host.showError(
      t('mcp.skills_remove_failed', {
        msg: error instanceof Error ? error.message : String(error),
      }),
    );
    return undefined;
  }
}

/**
 * Report a managed write with wording that matches what actually happened.
 *
 * Four outcomes, not two: applied / saved-but-parked (`enabled:false` in
 * mcp.json) / saved-but-reconnect-failed / nothing written (session gone).
 * Collapsing them into "done" or "failed" is how a settings dialog starts
 * lying.
 */
function reportApplyOutcome(
  host: SlashCommandHost,
  spinner: ReturnType<SlashCommandHost['showProgressSpinner']>,
  result: Awaited<ReturnType<typeof applyRecommendedArgs>>,
  rec: McpRecommendation,
  appliedLabel: string,
): void {
  switch (result.status) {
    case 'applied':
      spinner.stop({ ok: true, label: appliedLabel });
      return;
    case 'saved-disabled':
      spinner.stop({ ok: true, label: t('mcp.args_saved_parked', { name: rec.displayName }) });
      return;
    case 'saved-only':
      spinner.stop({ ok: false, label: t('mcp.args_saved_label', { name: rec.displayName }) });
      host.showError(t('mcp.args_saved_restart_failed', { msg: result.message }));
      return;
    case 'not-written':
      spinner.stop({ ok: false, label: t('mcp.update_failed_label', { name: rec.displayName }) });
      host.showError(t('mcp.args_not_written', { msg: result.message }));
      return;
  }
}

// ─── 运行形态子菜单（chrome-devtools） ────────────────────────────────

/**
 * Rows for the launch-option menu. Pure so the menu can re-render after every
 * toggle without re-reading config.
 */
export function buildBrowserOptionRows(
  options: BrowserRuntimeOptions,
  skills?: { installedVersion?: string; packageVersion?: string; available: boolean },
): McpRow[] {
  const onOff = (value: boolean): string => (value ? t('mcp.opt_on') : t('mcp.opt_off'));
  const inert = launchOptionBlocker(options) !== undefined;
  const launchNote = inert ? `  ${t('mcp.opt_inert_with_autoconnect')}` : '';
  const rows: McpRow[] = [
    { kind: 'option', name: '', label: `── ${t('mcp.opt_section_runtime')} ──`, status: '__section' },
    {
      kind: 'option',
      name: 'headless',
      label: t('mcp.opt_headless'),
      status: '__option',
      description: onOff(options.headless) + launchNote,
    },
    {
      kind: 'option',
      name: 'isolated',
      label: t('mcp.opt_isolated'),
      status: '__option',
      description: onOff(options.isolated) + launchNote,
    },
    {
      kind: 'option',
      name: 'viewport',
      label: t('mcp.opt_viewport'),
      status: '__option',
      description: options.viewport ?? t('mcp.opt_default'),
    },
    {
      kind: 'option',
      name: 'channel',
      label: t('mcp.opt_channel'),
      status: '__option',
      description: options.channel,
    },
    {
      kind: 'option',
      name: 'autoconnect',
      label: t('mcp.opt_autoconnect'),
      status: '__option',
      description: `${onOff(options.autoConnect)}  ${t('mcp.opt_autoconnect_note')}`,
    },
  ];

  if (skills !== undefined) {
    rows.push({ kind: 'option', name: '', label: `── ${t('mcp.opt_section_skills')} ──`, status: '__section' });
    if (!skills.available) {
      rows.push({
        kind: 'option',
        name: 'skills-missing',
        label: t('mcp.skills_install'),
        status: '__info',
        description: t('mcp.skills_package_missing'),
      });
    } else {
      rows.push({
        kind: 'option',
        name: 'skills-install',
        label: skills.installedVersion === undefined ? t('mcp.skills_install') : t('mcp.skills_update'),
        status: '__option',
        description: skills.installedVersion === undefined
          ? `v${skills.packageVersion ?? '?'}`
          : t('mcp.skills_version_note', {
              installed: skills.installedVersion,
              available: skills.packageVersion ?? '?',
            }),
      });
      if (skills.installedVersion !== undefined) {
        rows.push({
          kind: 'option',
          name: 'skills-remove',
          label: t('mcp.skills_remove'),
          status: '__option',
        });
      }
    }
  }

  rows.push({ kind: 'option', name: '', label: `── ${t('mcp.opt_section_actions')} ──`, status: '__section' });
  rows.push({ kind: 'option', name: 'apply', label: t('mcp.opt_apply'), status: '__option' });
  return rows;
}

/**
 * `a` on an installed row: run the OAuth flow for an HTTP MCP server.
 *
 * The model could already authenticate through the synthetic
 * `…__authenticate` tool; this is the same flow without needing a conversation.
 * The browser step is asynchronous, so success arrives later as a status event
 * (the server reconnects on its own) — the panel only reports where to look.
 */
export async function handleAuthenticate(host: SlashCommandHost, row: McpRow): Promise<void> {
  const session = host.session;
  if (!session) return;
  const spinner = host.showProgressSpinner(
    t('mcp.auth_discovering', { name: row.label }),
  );
  try {
    const result = await session.authenticateMcpServer(row.name);
    if (result.alreadyAuthorized) {
      spinner.stop({ ok: true, label: t('mcp.auth_reconnected', { name: row.label }) });
      return;
    }
    const url = result.authorizationUrl ?? '';
    spinner.stop({ ok: true, label: t('mcp.auth_opened', { name: row.label }) });
    if (url.length > 0) openUrl(url);
    host.showStatus(t('mcp.auth_url_hint', { url }));
  } catch (error) {
    spinner.stop({ ok: false, label: t('mcp.auth_failed_label', { name: row.label }) });
    host.showError(
      t('mcp.auth_failed', { msg: error instanceof Error ? error.message : String(error) }),
    );
  }
}

/**
 * `o` on an installed row: open the launch-option menu for a built-in that has
 * one. Exported next to `handleEnter`/`handleDelete` so the key, the panel and
 * the tests share the same single entry point.
 */
export async function handleOptions(host: SlashCommandHost, row: McpRow): Promise<void> {
  const rec = getRecommended().find((r) => r.name === row.name);
  if (rec === undefined || rec.name !== BROWSER_RECOMMENDATION) {
    host.showStatus(t('mcp.opt_not_available', { name: row.label }));
    return;
  }
  await openBrowserOptionsMenu(host, rec);
}

/**
 * `/mcp` → an installed built-in → `o`.
 *
 * Toggles only mutate local state: each saved change relaunches Chrome, so the
 * menu batches them behind one explicit "save and restart". Esc discards —
 * nothing is written until apply runs.
 */
async function openBrowserOptionsMenu(
  host: SlashCommandHost,
  rec: McpRecommendation,
): Promise<void> {
  if (!host.session) return;
  if (pluginIdFromMcpRuntimeName(rec.name) !== undefined) {
    host.showError(t('mcp.update_plugin_blocked', { name: rec.displayName }));
    return;
  }
  const projectFiles = projectConfigFilesDeclaring(rec.name);
  if (projectFiles.length > 0) {
    host.showError(t('mcp.uninstall_project_owned', { name: rec.name, files: projectFiles.join(', ') }));
    return;
  }

  const installedArgs = readInstalledRecommendedArgs()[rec.name] ?? rec.args;
  let options: BrowserRuntimeOptions = parseBrowserOptions(installedArgs);
  const skillsState = await loadUpstreamSkillsState();

  return new Promise<void>((resolve) => {
    let picker: McpPickerComponent;
    // 安装/移除技能是文件操作，没有串行化：连按两下会并发复制同一批目录。
    let busy = false;

    const rows = (): McpRow[] => buildBrowserOptionRows(options, skillsState);
    const refresh = (): void => {
      picker.refresh(rows(), t('mcp.options_title'));
    };

    const close = (): void => {
      host.restoreEditor();
      resolve();
    };

    const toggleLaunchOption = (key: 'headless' | 'isolated'): void => {
      const blocker = launchOptionBlocker(options);
      // Only enabling is inert; removing a flag always takes effect, so refusing
      // the off-switch would strand a hand-edited combination.
      if (blocker !== undefined && !options[key]) {
        // Refusing is honest: the flag would be written but ignored by the
        // server, leaving the menu's "on" state describing nothing.
        host.showStatus(t('mcp.opt_inert_with_autoconnect'));
        return;
      }
      options = { ...options, [key]: !options[key] };
      refresh();
    };

    picker = new McpPickerComponent({
      title: t('mcp.options_title'),
      rows: rows(),
      colors: host.state.theme.colors,
      hint: t('mcp.options_hint'),
      onEnter: (row) => {
        void (async () => {
          switch (row.name) {
            case 'headless':
            case 'isolated':
              toggleLaunchOption(row.name);
              return;
            case 'viewport':
              options = { ...options, viewport: cycleViewport(options.viewport) };
              refresh();
              return;
            case 'channel':
              options = { ...options, channel: cycleChannel(options.channel) };
              refresh();
              return;
            case 'autoconnect': {
              // auto-connect does not launch Chrome, so headless/isolated would
              // be saved switches that do nothing. Clear them instead of
              // leaving an "on" that the server ignores.
              options = options.autoConnect
                ? { ...options, autoConnect: false }
                : { ...options, autoConnect: true, headless: false, isolated: false };
              refresh();
              return;
            }
            case 'skills-missing':
              host.showStatus(t('mcp.skills_package_missing'));
              return;
            case 'skills-install': {
              if (busy) return;
              busy = true;
              try {
                const result = await runUpstreamSkillsInstall(host);
                if (result !== undefined) Object.assign(skillsState, result);
              } finally {
                busy = false;
              }
              refresh();
              return;
            }
            case 'skills-remove': {
              if (busy) return;
              busy = true;
              try {
                const result = await runUpstreamSkillsRemove(host);
                if (result !== undefined) Object.assign(skillsState, result);
              } finally {
                busy = false;
              }
              refresh();
              return;
            }
            case 'apply': {
              const nextArgs = buildBrowserArgs(options, {
                packageSpec: installedPackageSpec(installedArgs),
                keep: unmanagedArgs(installedArgs),
              });
              const nextEnv = mergeManagedEnv(readInstalledEnv(rec.name), rec.env);
              host.restoreEditor();
              const spinner = host.showProgressSpinner(`${t('mcp.configuring')} ${rec.displayName}...`);
              try {
                const result = await applyRecommendedArgs(host, rec, nextArgs, nextEnv);
                reportApplyOutcome(
                  host,
                  spinner,
                  result,
                  rec,
                  t('mcp.opt_applied', { name: rec.displayName }),
                );
              } catch (error) {
                spinner.stop({ ok: false, label: t('mcp.update_failed_label', { name: rec.displayName }) });
                host.showError(
                  t('mcp.update_failed', {
                    msg: error instanceof Error ? error.message : String(error),
                  }),
                );
              }
              resolve();
              return;
            }
            default:
              return;
          }
        })();
      },
      onDelete: () => {
        // `d` has no meaning in this menu; swallowing it keeps the delete
        // handler from being reachable by an accidental keystroke.
      },
      onCancel: close,
    });

    host.mountEditorReplacement(picker);
  });
}

async function confirmAction(host: SlashCommandHost, title: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const picker = new McpPickerComponent({
      title,
      rows: [
        { kind: 'installed', name: 'no', label: t('common.cancel') },
        { kind: 'installed', name: 'yes', label: t('mcp.uninstall_yes') },
      ],
      colors: host.state.theme.colors,
      hint: t('mcp.confirm_hint'),
      onEnter: (r) => {
        host.restoreEditor();
        resolve(r.name === 'yes');
      },
      onDelete: () => {
        host.restoreEditor();
        resolve(false);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(false);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

// ─── MCP 操作 ────────────────────────────────────────────────────────

/**
 * Runtime config for a recommended server, built once so what we persist to
 * mcp.json and what we register with the session can never drift apart.
 */
function toServerConfig(
  rec: McpRecommendation,
  args: readonly string[],
  env: Record<string, string> | undefined,
): {
  transport: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
  startupTimeoutMs?: number;
  capabilities?: string[];
} {
  const config: {
    transport: 'stdio';
    command: string;
    args: string[];
    env?: Record<string, string>;
    startupTimeoutMs?: number;
    capabilities?: string[];
  } = { transport: 'stdio', command: rec.command, args: [...args] };
  if (rec.startupTimeoutMs !== undefined) config.startupTimeoutMs = rec.startupTimeoutMs;
  if (rec.capabilities !== undefined) config.capabilities = rec.capabilities;
  if (env !== undefined && Object.keys(env).length > 0) config.env = env;
  return config;
}

async function installMcp(host: SlashCommandHost, rec: McpRecommendation): Promise<void> {
  const session = host.session;
  if (!session) return;

  const spinner = host.showProgressSpinner(`${t('mcp.installing')} ${rec.displayName}...`);

  spinner.setLabel(`${t('mcp.configuring')} ${rec.displayName}...`);
  try {
    // For MCPs that require a local clone (gitUrl), clone or update the repo
    // and resolve {INSTALL_DIR} placeholders in args and env.
    let resolvedArgs = rec.args;
    let resolvedEnv = rec.env;
    if (rec.gitUrl !== undefined) {
      const installDir = join(getDataDir(), 'mcp', rec.name);
      if (existsSync(join(installDir, '.git'))) {
        spinner.setLabel(`Updating ${rec.displayName}...`);
        execSync(`git pull --ff-only`, { cwd: installDir, stdio: 'pipe', timeout: 30_000 });
      } else {
        spinner.setLabel(`Cloning ${rec.displayName}...`);
        await mkdir(installDir, { recursive: true });
        execSync(`git clone --depth 1 ${rec.gitUrl} "${installDir}"`, { stdio: 'pipe', timeout: 60_000 });
      }
      // Ensure Data/ directory exists for DB_PATH env var
      await mkdir(join(installDir, 'Data'), { recursive: true });
      const resolved = resolveRecommendationArgs(rec, installDir);
      resolvedArgs = resolved.args;
      resolvedEnv = resolved.env;
    }

    await writeMcpConfig(host, {
      name: rec.name,
      command: rec.command,
      args: resolvedArgs,
      env: resolvedEnv,
      startupTimeoutMs: rec.startupTimeoutMs,
      capabilities: rec.capabilities,
    });
    await session.addMcpServer(rec.name, toServerConfig(rec, resolvedArgs, resolvedEnv));
    spinner.stop({ ok: true, label: t('mcp.install_success', { name: rec.displayName }) });
  } catch (error) {
    spinner.stop({ ok: false, label: t('mcp.install_fail', { name: rec.displayName }) });
    const msg = error instanceof Error ? error.message : String(error);
    const hint = msg.includes('Timed out') || msg.includes('ETIMEDOUT') || msg.includes('ENOTFOUND')
      ? t('mcp.network_timeout')
      : '';
    host.showError(hint ? t('mcp.install_failed', { msg: `${msg}\n${hint}` }) : t('mcp.install_failed', { msg }));
  }
}

/**
 * Reset an installed built-in to the current recommended launch args.
 *
 * Existing installs keep whatever args they were created with, so a flag added
 * to the recommendation later (a privacy default, a new tool category) never
 * reaches them on its own. Enter on the recommendation row offers this reset;
 * the confirmation says custom args and env are replaced.
 */
async function updateRecommendedMcp(
  host: SlashCommandHost,
  rec: McpRecommendation,
): Promise<void> {
  const session = host.session;
  if (!session) return;
  if (pluginIdFromMcpRuntimeName(rec.name) !== undefined) {
    host.showError(t('mcp.update_plugin_blocked', { name: rec.displayName }));
    return;
  }
  const projectFiles = projectConfigFilesDeclaring(rec.name);
  if (projectFiles.length > 0) {
    host.showError(
      t('mcp.uninstall_project_owned', { name: rec.name, files: projectFiles.join(', ') }),
    );
    return;
  }
  const installedArgs = readInstalledRecommendedArgs()[rec.name] ?? [];
  const drift = missingRecommendedArgs(installedArgs, rec.args);
  const confirmed = await confirmAction(
    host,
    t('mcp.update_confirm', { name: rec.displayName, count: drift.length }),
  );
  if (!confirmed) return;

  // Reset means "current product flags", not "factory settings": the runtime
  // options chosen in the `o` submenu (headless/isolated/viewport/channel) are
  // the user's, so they are read back off the entry and re-applied. Anything
  // else in args is product-owned and gets replaced.
  let nextArgs: string[];
  let nextEnv: Record<string, string> | undefined;
  if (rec.name === BROWSER_RECOMMENDATION) {
    // "Reset" refreshes the flags this product owns. A pinned package spec and
    // flags the menu does not model (`--browserUrl`, `--proxyServer`, …) are the
    // user's, so they are carried over instead of being deleted.
    const resolved = resolveRecommendationArgs(rec, join(getDataDir(), 'mcp', rec.name));
    nextArgs = buildBrowserArgs(parseBrowserOptions(installedArgs), {
      packageSpec: installedPackageSpec(installedArgs),
      keep: unmanagedArgs(installedArgs),
    });
    nextEnv = mergeManagedEnv(readInstalledEnv(rec.name), resolved.env);
  } else {
    const installDir = join(getDataDir(), 'mcp', rec.name);
    if (rec.gitUrl !== undefined && !existsSync(installDir)) {
      // Cloning belongs to install; a reset that pointed at a missing checkout
      // would produce an entry that fails at launch with a confusing ENOENT.
      host.showError(t('mcp.update_requires_reinstall', { name: rec.displayName }));
      return;
    }
    const resolved = resolveRecommendationArgs(rec, installDir);
    nextArgs = resolved.args;
    nextEnv = mergeManagedEnv(readInstalledEnv(rec.name), resolved.env);
  }

  const spinner = host.showProgressSpinner(`${t('mcp.configuring')} ${rec.displayName}...`);
  try {
    const result = await applyRecommendedArgs(host, rec, nextArgs, nextEnv);
    reportApplyOutcome(host, spinner, result, rec, t('mcp.update_done', { name: rec.displayName }));
  } catch (error) {
    spinner.stop({ ok: false, label: t('mcp.update_failed_label', { name: rec.displayName }) });
    const msg = error instanceof Error ? error.message : String(error);
    host.showError(t('mcp.update_failed', { msg }));
  }
}

async function disableMcp(host: SlashCommandHost, name: string): Promise<void> {
  const session = host.session;
  if (!session) return;
  try {
    await session.stopMcpServer(name);
    // Stopping really does take effect for this session, but a plugin-owned
    // server is re-registered by the plugin sync on the next startup — say so
    // instead of implying a persistent disable.
    const note = pluginIdFromMcpRuntimeName(name) !== undefined
      ? ` ${t('mcp.plugin_owned_stop_note')}`
      : '';
    host.showStatus(t('mcp.disabled_done', { name }) + note);
  } catch (error) {
    host.showError(
      t('mcp.disable_failed', { msg: error instanceof Error ? error.message : String(error) }),
    );
  }
}

async function enableMcp(host: SlashCommandHost, name: string): Promise<void> {
  const session = host.session;
  if (!session) return;
  try {
    await session.reconnectMcpServer(name);
    host.showStatus(`${name} ${t('mcp.detected_starting')}`);
  } catch (error) {
    host.showError(
      t('mcp.start_failed', { msg: error instanceof Error ? error.message : String(error) }),
    );
  }
}

/**
 * Project-level mcp.json files (cwd + parent chain) that declare `name`.
 *
 * The runtime list cannot tell where a server came from, but a server declared
 * by a project config is re-loaded on every start no matter what we delete from
 * the user-level file — removing it there is the same silent lie as removing a
 * plugin-owned server. Paths come from the core's own resolver so the rule that
 * decides "which files count" cannot drift.
 */
function projectConfigFilesDeclaring(name: string): string[] {
  let parents: readonly string[];
  let project: string;
  try {
    const resolved = resolveMcpJsonPaths({ cwd: process.cwd(), homeDir: getDataDir() });
    parents = resolved.parents;
    project = resolved.project;
  } catch {
    return [];
  }

  return [...parents, project].filter((file) => {
    if (!existsSync(file)) return false;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as {
        mcpServers?: Record<string, unknown>;
      };
      return parsed !== null
        && typeof parsed === 'object'
        && parsed.mcpServers !== undefined
        && Object.hasOwn(parsed.mcpServers, name);
    } catch {
      // An unreadable project config cannot be edited from here; ignore it and
      // let the runtime verification below catch any surprise.
      return false;
    }
  });
}

export async function uninstallMcp(host: SlashCommandHost, name: string): Promise<void> {
  const session = host.session;
  if (!session) return;
  // Defence in depth: the panel refuses plugin rows before the confirmation
  // dialog, but a programmatic caller must hit the same wall — plugin-owned
  // servers are runtime entries derived from the plugin registry, so removing
  // them here is undone on the next startup by the plugin hot-apply pass.
  const pluginId = pluginIdFromMcpRuntimeName(name);
  if (pluginId !== undefined) {
    host.showError(t('mcp.uninstall_plugin_blocked', { name, plugin: pluginId }));
    return;
  }
  const projectFiles = projectConfigFilesDeclaring(name);
  if (projectFiles.length > 0) {
    host.showError(t('mcp.uninstall_project_owned', { name, files: projectFiles.join(', ') }));
    return;
  }
  try {
    await session.removeMcpServer(name);
    await removeMcpConfig(host, name);
    // Config files are re-read at startup and the runtime only knows what it
    // was handed; if the entry is still listed here the removal did not stick.
    // The listing itself is best-effort: a failing re-list must not turn a
    // completed removal into a misleading "uninstall failed".
    let stillListed = false;
    try {
      const remaining = await session.listMcpServers();
      stillListed = remaining.some((server) => server.name === name);
    } catch { /* listing is best-effort */ }
    if (stillListed) {
      host.showError(t('mcp.uninstall_verify_failed', { name }));
      return;
    }
    host.showStatus(t('mcp.uninstalled', { name }));
  } catch (error) {
    host.showError(
      t('mcp.uninstall_failed', { msg: error instanceof Error ? error.message : String(error) }),
    );
  }
}

// ─── mcp.json 读写 ───────────────────────────────────────────────────

interface McpConfigEntry {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  startupTimeoutMs?: number;
  capabilities?: string[];
}

/** Parsed `mcpServers` of the user-level mcp.json; `{}` when absent/unreadable. */
function readUserConfigServers(): Record<string, unknown> {
  const configPath = join(getDataDir(), 'mcp.json');
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      mcpServers?: unknown;
    };
    const servers = parsed?.mcpServers;
    return servers !== null && typeof servers === 'object'
      ? (servers as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Launch args of installed built-ins, read from the user-level mcp.json only.
 *
 * Project-declared entries are not included on purpose: the panel refuses to
 * rewrite them (they are reloaded from the project file on every start), so
 * showing an update hint for them would promise an action that cannot stick.
 */
function readInstalledRecommendedArgs(): Record<string, readonly string[]> {
  const servers = readUserConfigServers();
  const out: Record<string, readonly string[]> = {};
  for (const rec of getRecommended()) {
    const entry = servers[rec.name];
    const args = (entry as { args?: unknown } | undefined)?.args;
    if (Array.isArray(args) && args.every((arg) => typeof arg === 'string')) {
      out[rec.name] = args;
    }
  }
  return out;
}

/** The persisted entry as-is, for callers that must not lose unknown fields. */
function readUserConfigEntry(name: string): Record<string, unknown> | undefined {
  const entry = readUserConfigServers()[name];
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    ? (entry as Record<string, unknown>)
    : undefined;
}

/** String-valued `env` of the persisted entry, if it has one. */
function readInstalledEnv(name: string): Record<string, string> | undefined {
  const entry = readUserConfigServers()[name] as { env?: unknown } | undefined;
  const env = entry?.env;
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Env for a managed write: the user's own keys survive, product-owned keys win.
 *
 * A reset or an options save replaces *launch flags*, which is what the
 * confirmation says — silently dropping an `HTTPS_PROXY` someone added to the
 * same entry would be a surprising second effect.
 */
function mergeManagedEnv(
  installed: Record<string, string> | undefined,
  managed: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (installed === undefined && managed === undefined) return undefined;
  const merged = { ...installed, ...managed };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

async function writeMcpConfig(
  host: SlashCommandHost,
  entry: McpConfigEntry,
): Promise<void> {
  const homeDir = getDataDir();
  const configPath = join(homeDir, 'mcp.json');

  let data: Record<string, unknown> = {};
  try {
    const text = await readFile(configPath, 'utf-8');
    data = JSON.parse(text);
  } catch { /* file doesn't exist yet */ }

  const servers: Record<string, unknown> =
    (data['mcpServers'] as Record<string, unknown>) ?? {};
  const existing = servers[entry.name];
  // Merge, never replace: `enabled`, `exposure`, `toolTimeoutMs`,
  // `enabledTools`/`disabledTools` and `cwd` are the schema's, not ours — a
  // settings save that silently un-parked a server would be data loss.
  const config: Record<string, unknown> =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  config['transport'] = 'stdio';
  config['command'] = entry.command;
  config['args'] = entry.args;
  if (entry.startupTimeoutMs !== undefined) {
    config['startupTimeoutMs'] = entry.startupTimeoutMs;
  }
  if (entry.capabilities !== undefined) {
    config['capabilities'] = entry.capabilities;
  }
  // Explicit `undefined` (not a delete) so a stale env is dropped on write while
  // JSON.stringify still omits the key.
  config['env'] = entry.env !== undefined && Object.keys(entry.env).length > 0
    ? entry.env
    : undefined;
  servers[entry.name] = config;
  data['mcpServers'] = servers;

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(data, null, 2), 'utf-8');
}

async function removeMcpConfig(host: SlashCommandHost, name: string): Promise<void> {
  const homeDir = getDataDir();
  const configPath = join(homeDir, 'mcp.json');

  let data: Record<string, unknown> = {};
  try {
    const text = await readFile(configPath, 'utf-8');
    data = JSON.parse(text);
  } catch { return; }

  const servers = (data['mcpServers'] as Record<string, unknown>) ?? {};
  delete servers[name];
  data['mcpServers'] = servers;

  await writeFile(configPath, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── 自定义选择组件 ──────────────────────────────────────────────────

const ELLIPSIS = '…';

interface McpPickerOptions {
  title: string;
  rows: McpRow[];
  colors: ColorPalette;
  /** Footer hint override; the main panel uses the shared default. */
  hint?: string;
  /** `o` on an installed row; absent = the key is inert (menus, confirms). */
  onOptions?: (row: McpRow) => void;
  /** `a` on an installed row: start the OAuth flow. */
  onAuthenticate?: (row: McpRow) => void;
  onEnter: (row: McpRow) => void;
  onDelete: (row: McpRow) => void;
  onCancel: () => void;
}

class McpPickerComponent extends Container implements Focusable {
  focused = false;
  private selectedIndex = 0;
  private colors: ColorPalette;
  private title: string;
  private rows: McpRow[];
  private onEnter: (row: McpRow) => void;
  private onDelete: (row: McpRow) => void;
  private onCancel: () => void;
  private maxVisible = 12;
  private hint: string | undefined;
  private onOptions: ((row: McpRow) => void) | undefined;
  private onAuthenticate: ((row: McpRow) => void) | undefined;

  constructor(opts: McpPickerOptions) {
    super();
    this.title = opts.title;
    this.rows = opts.rows;
    this.colors = opts.colors;
    this.hint = opts.hint;
    this.onOptions = opts.onOptions;
    this.onAuthenticate = opts.onAuthenticate;
    this.onEnter = opts.onEnter;
    this.onDelete = opts.onDelete;
    this.onCancel = opts.onCancel;
    // Skip section headers for initial selection
    while (
      this.selectedIndex < this.rows.length &&
      this.rows[this.selectedIndex]?.status === '__section'
    ) {
      this.selectedIndex++;
    }
  }

  refresh(rows: McpRow[], title: string): void {
    this.rows = rows;
    this.title = title;
    if (
      this.selectedIndex >= rows.length ||
      rows[this.selectedIndex]?.status === '__section' ||
      rows[this.selectedIndex]?.status === '__empty'
    ) {
      this.selectedIndex = 0;
      while (
        this.selectedIndex < rows.length &&
        (rows[this.selectedIndex]?.status === '__section' ||
          rows[this.selectedIndex]?.status === '__empty')
      ) {
        this.selectedIndex++;
      }
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onCancel();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const row = this.rows[this.selectedIndex];
      if (row && row.status !== '__section' && row.status !== '__empty') {
        this.onEnter(row);
      }
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = this.prevSelectable(this.selectedIndex);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = this.nextSelectable(this.selectedIndex);
      return;
    }
    const key = printableChar(data);
    if ((key === 'a' || key === 'A') && this.onAuthenticate !== undefined) {
      const row = this.rows[this.selectedIndex];
      if (row && row.kind === 'installed' && row.status !== '__section' && row.status !== '__empty') {
        this.onAuthenticate(row);
      }
      return;
    }
    if ((key === 'o' || key === 'O') && this.onOptions !== undefined) {
      const row = this.rows[this.selectedIndex];
      if (row && row.kind === 'installed' && row.status !== '__section' && row.status !== '__empty') {
        this.onOptions(row);
      }
      return;
    }
    if (key === 'd' || key === 'D') {
      const row = this.rows[this.selectedIndex];
      if (row && row.kind === 'installed' && row.status && row.status !== '__section' && row.status !== '__empty') {
        this.onDelete(row);
      }
      return;
    }
  }

  private prevSelectable(from: number): number {
    let i = from - 1;
    while (i >= 0) {
      const row = this.rows[i];
      if (row && row.status !== '__section' && row.status !== '__empty') return i;
      i--;
    }
    return from;
  }

  private nextSelectable(from: number): number {
    let i = from + 1;
    while (i < this.rows.length) {
      const row = this.rows[i];
      if (row && row.status !== '__section' && row.status !== '__empty') return i;
      i++;
    }
    return from;
  }

  override render(width: number): string[] {
    const colors = this.colors;
    const lines: string[] = [];

    // Header
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    lines.push(chalk.hex(colors.primary).bold(truncateToWidth(this.title, width, ELLIPSIS)));

    // Hint
    const hint = this.hint ?? t('mcp.footer_hint');
    lines.push(chalk.hex(colors.textMuted)(truncateToWidth(hint, width, ELLIPSIS)));
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));

    // Visible window
    const visibleStart = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        Math.max(0, this.rows.length - this.maxVisible),
      ),
    );
    const visibleRows = this.rows.slice(visibleStart, visibleStart + this.maxVisible);

    for (const [vi, row] of visibleRows.entries()) {
      const index = visibleStart + vi;
      const isSelected = index === this.selectedIndex;
      const isSection = row.status === '__section';

      if (isSection) {
        lines.push(chalk.hex(colors.textMuted)(truncateToWidth(row.label, width, ELLIPSIS)));
        continue;
      }

      if (row.status === '__empty') {
        lines.push(chalk.hex(colors.textMuted)(truncateToWidth('  ' + row.label, width, ELLIPSIS)));
        continue;
      }

      const pointer = isSelected ? SELECT_POINTER : ' ';
      const pointerColor = isSelected ? colors.primary : colors.textDim;
      const labelColor = isSelected ? colors.primary : colors.text;
      const labelStyle = isSelected ? chalk.hex(labelColor).bold : chalk.hex(labelColor);

      let line = chalk.hex(pointerColor)(pointer + ' ') + labelStyle(row.label);

      if (row.description) {
        const descColor = isSelected ? colors.textDim : colors.textMuted;
        const budget = Math.max(8, width - visibleWidth(line) - 2);
        const desc = truncateToWidth(row.description, budget, ELLIPSIS);
        if (desc.length > 0) {
          line += '  ' + chalk.hex(descColor)(desc);
        }
      }

      line = truncateToWidth(line, width, ELLIPSIS);
      lines.push(line);
    }

    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }
}
