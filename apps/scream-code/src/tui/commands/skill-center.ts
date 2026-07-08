/**
 * /skill — ScreamCode Skill 中心。
 *
 * 上方列出当前会话已安装且可手动激活的 Skill；下方列出可安装的 Skill 包。
 * - Enter：激活已安装 Skill / 安装并注入可安装包
 * - d：卸载已安装 Skill（插件包来源调用 removePlugin，手动安装则删除安装目录及子 Skill）
 * - i：安装并注入可安装包（安装后立即激活首个 Skill，多 Skill 时弹出选择）
 *
 * 系统级 Skill（如 /dream、/make-skill）不会出现在列表中。
 */

import type { PluginSummary, SkillSummary } from '@scream-code/scream-code-sdk';
import { Container, matchesKey, Key, Spacer, type Focusable } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { t } from '@scream-code/config';

import { loadPluginMarketplace, type PluginMarketplaceEntry } from '#/utils/plugin-marketplace';

import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import type { SlashCommandHost } from './dispatch';
import { MoonLoader } from '../components/chrome/moon-loader';
import { getFallbackSkillMarketplace, type FallbackMarketplaceEntry } from './skill-marketplace';
import { isUserActivatableSkill } from './skills';

const SKILL_DESC_MAX = 60;

type MarketplaceEntry = PluginMarketplaceEntry | FallbackMarketplaceEntry;

export async function handleSkillCommand(
  host: SlashCommandHost,
  _args: string,
): Promise<void> {
  const session = host.session;
  if (!session) {
    host.showError(t('skill.no_session'));
    return;
  }
  await openSkillCenter(host);
}

async function openSkillCenter(host: SlashCommandHost): Promise<void> {
  const loading = new SkillCenterLoadingComponent(host, t('skill.loading'));
  host.mountEditorReplacement(loading);

  const [skillsResult, pluginsResult, marketplaceResult] = await Promise.allSettled([
    loadActivatableSkills(host),
    loadInstalledPlugins(host),
    loadMarketplace(host),
  ]);

  loading.stop();

  const skills = skillsResult.status === 'fulfilled' ? skillsResult.value : [];
  const plugins = pluginsResult.status === 'fulfilled' ? pluginsResult.value : [];
  const marketplace = marketplaceResult.status === 'fulfilled' ? marketplaceResult.value : [];

  if (loading.isCancelled()) {
    return;
  }

  const options = buildOptions(host, skills, plugins, marketplace);
  if (options.length === 0) {
    host.restoreEditor();
    host.showNotice(t('skill.center_title'), t('skill.no_skills'));
    return;
  }

  const picker = new ChoicePickerComponent({
    title: t('skill.center_title'),
    hint: t('skill.footer_hint'),
    options,
    colors: host.state.theme.colors,
    searchable: true,
    pageSize: 10,
    onSelect: (value: string) => {
      host.restoreEditor();
      void handleSelect(host, value, skills, plugins, marketplace);
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });

  host.mountEditorReplacement(picker);
}
// ─── Loading overlay ───────────────────────────────────────────────────────

class SkillCenterLoadingComponent extends Container implements Focusable {
  focused = false;
  private readonly loader: MoonLoader;
  private readonly host: SlashCommandHost;
  private cancelled = false;

  constructor(
    host: SlashCommandHost,
    private readonly label: string,
  ) {
    super();
    this.host = host;
    const tint = (s: string): string => chalk.hex(host.state.theme.colors.primary)(s);
    this.loader = new MoonLoader(host.state.ui, 'braille', tint, this.label);
    this.addChild(new Spacer(1));
    this.addChild(this.loader);
  }

  handleInput(data: string): void {
    // Esc cancels the loading overlay and returns to the editor.
    if (matchesKey(data, Key.escape)) {
      this.cancelled = true;
      this.stop();
      this.host.restoreEditor();
    }
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  stop(): void {
    this.loader.stop();
  }
}
async function loadActivatableSkills(host: SlashCommandHost): Promise<readonly SkillSummary[]> {
  const session = host.session;
  if (!session) return [];
  try {
    const all = await session.listSkills();
    return all.filter((skill) => isUserActivatableSkill(skill) && skill.source !== 'builtin');
  } catch {
    return [];
  }
}

async function loadInstalledPlugins(host: SlashCommandHost): Promise<readonly PluginSummary[]> {
  const session = host.session;
  if (!session) return [];
  try {
    // /make-skill writes generated plugins directly to disk, so refresh before showing.
    await session.reloadPlugins().catch(() => {
      /* ignore reload errors */
    });
    return await session.listPlugins();
  } catch {
    return [];
  }
}

async function loadMarketplace(host: SlashCommandHost): Promise<readonly MarketplaceEntry[]> {
  try {
    const { plugins } = await loadPluginMarketplace({
      workDir: host.state.appState.workDir,
    });
    return plugins;
  } catch {
    return [...getFallbackSkillMarketplace()];
  }
}

function buildOptions(
  host: SlashCommandHost,
  skills: readonly SkillSummary[],
  plugins: readonly PluginSummary[],
  marketplace: readonly MarketplaceEntry[],
): ChoiceOption[] {
  const options: ChoiceOption[] = [];

  if (skills.length > 0) {
    options.push({
      value: '__section__installed',
      label: '── ' + t('skill.installed') + ' ──',
    });
    for (const skill of skills) {
      const actionKeys: Record<string, () => void> = {};
      if (skill.pluginId !== undefined) {
        const plugin = plugins.find((p) => p.id === skill.pluginId);
        actionKeys['d'] = () => {
          host.restoreEditor();
          void uninstallByPluginId(host, skill.pluginId!, plugin);
        };
      } else {
        actionKeys['d'] = () => {
          host.restoreEditor();
          void uninstallManualSkill(host, skill);
        };
      }
      options.push({
        value: `activate:${skill.name}`,
        label: skill.name,
        description: formatSkillDescription(skill, plugins),
        actionKeys,
      });
    }
  }

  const installedIds = new Set(plugins.map((p) => p.id));
  const installable = marketplace.filter((entry) => !installedIds.has(entry.id));
  if (installable.length > 0) {
    options.push({
      value: '__section__installable',
      label: '── ' + t('skill.installable') + ' ──',
    });
    for (const entry of installable) {
      options.push({
        value: `install:${entry.source}`,
        label: entry.displayName,
        description: entry.description
          ? `${truncate(entry.description, SKILL_DESC_MAX)}  [${t('skill.not_installed')}]`
          : `[${t('skill.not_installed')}]`,
        actionKeys: {
          i: () => {
            host.restoreEditor();
            void installInjectActivate(host, entry.source);
          },
        },
      });
    }
  }

  return options;
}

async function handleSelect(
  host: SlashCommandHost,
  value: string,
  skills: readonly SkillSummary[],
  _plugins: readonly PluginSummary[],
  _marketplace: readonly MarketplaceEntry[],
): Promise<void> {
  if (value.startsWith('__section')) {
    // Selecting a section header just refreshes the panel.
    await openSkillCenter(host);
    return;
  }
  if (value.startsWith('activate:')) {
    const name = value.slice('activate:'.length);
    await activateSkillByName(host, name, skills);
    return;
  }
  if (value.startsWith('install:')) {
    const source = value.slice('install:'.length);
    await installInjectActivate(host, source);
    return;
  }
  // Unknown value — refresh so the UI doesn't get stuck.
  await openSkillCenter(host);
}

async function activateSkillByName(
  host: SlashCommandHost,
  name: string,
  skills: readonly SkillSummary[],
): Promise<void> {
  const session = host.session;
  if (!session) {
    host.showError(t('skill.no_session_activate'));
    return;
  }
  const skill = skills.find((s) => s.name === name);
  if (!skill) {
    host.showError(t('skill.not_found'));
    return;
  }
  host.sendSkillActivation(session, skill.name, '');
}

async function installInjectActivate(host: SlashCommandHost, source: string): Promise<void> {
  const session = host.session;
  if (!session) {
    host.showError(t('skill.no_session_activate'));
    return;
  }

  const spinner = host.showProgressSpinner(t('skill.installing_package'));
  try {
    const summary = await session.installPlugin(source);
    await session.injectPlugin(summary.id);
    spinner.stop({ ok: true, label: `"${summary.displayName}" ${t('skill.installed_injected')}` });
    const allSkills = await session.listSkills();
    const pluginSkills = allSkills.filter(
      (s) => s.pluginId === summary.id && isUserActivatableSkill(s),
    );
    if (pluginSkills.length === 0) {
      host.showNotice(
        t('skill.plugin_installed'),
        `${summary.displayName} ${t('skill.no_manual_skill')}`,
      );
      return;
    }
    if (pluginSkills.length === 1) {
      const first = pluginSkills[0]!;
      host.sendSkillActivation(session, first.name, '');
      return;
    }
    await pickAndActivateSkill(host, pluginSkills, [summary]);
  } catch (error) {
    spinner.stop({ ok: false, label: t('skill.install_failed') });
    host.showError(t('skill.install_failed_msg', { msg: error instanceof Error ? error.message : String(error) }));
  }
}


async function pickAndActivateSkill(
  host: SlashCommandHost,
  skills: readonly SkillSummary[],
  plugins: readonly PluginSummary[] = [],
): Promise<void> {
  const session = host.session;
  if (!session) return;

  const options: ChoiceOption[] = skills.map((skill) => ({
    value: skill.name,
    label: skill.name,
    description: formatSkillDescription(skill, plugins),
  }));

  const picker = new ChoicePickerComponent({
    title: t('skill.select_activate'),
    hint: t('skill.select_hint'),
    options,
    colors: host.state.theme.colors,
    searchable: true,
    pageSize: 8,
    onSelect: (value: string) => {
      host.restoreEditor();
      host.sendSkillActivation(session, value, '');
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });

  host.mountEditorReplacement(picker);
}

async function uninstallByPluginId(
  host: SlashCommandHost,
  pluginId: string,
  plugin?: PluginSummary,
): Promise<void> {
  const session = host.session;
  if (!session) {
    host.showError(t('skill.no_session_activate'));
    return;
  }

  // 若调用处未带 plugin 信息，从 session 兜底拉一次。
  if (plugin === undefined) {
    try {
      const plugins = await session.listPlugins();
      plugin = plugins.find((p) => p.id === pluginId);
    } catch {
      // 忽略，下方用 pluginId 作 label。
    }
  }

  const label = plugin?.displayName ?? pluginId;
  // plugin Skill 必须整包卸载（SDK 不支持单独删除），明确告知用户影响范围。
  const skillCount = plugin?.skillCount;
  const description =
    skillCount !== undefined && skillCount > 0
      ? t('skill.uninstall_whole_pkg', { count: skillCount })
      : t('skill.uninstall_single');

  const confirmed = await confirmUninstall(host, label, description);
  if (!confirmed) {
    await openSkillCenter(host);
    return;
  }

  const spinner = host.showProgressSpinner(`${t('skill.uninstalling')} "${label}"…`);
  try {
    await session.removePlugin(pluginId);
    spinner.stop({ ok: true, label: `"${label}" ${t('skill.uninstalled')}` });
    host.showNotice(
      t('skill.plugin_uninstalled'),
      t('skill.plugin_removed'),
    );
  } catch (error) {
    spinner.stop({ ok: false, label: t('skill.uninstall_failed') });
    host.showError(t('skill.uninstall_failed_msg', { msg: error instanceof Error ? error.message : String(error) }));
  } finally {
    await openSkillCenter(host);
  }
}

async function uninstallManualSkill(host: SlashCommandHost, skill: SkillSummary): Promise<void> {
  const session = host.session;
  if (!session) {
    host.showError(t('skill.no_session_activate'));
    return;
  }

  const confirmed = await confirmUninstall(
    host,
    skill.name,
    t('skill.deleting_skill'),
  );
  if (!confirmed) {
    await openSkillCenter(host);
    return;
  }

  const spinner = host.showProgressSpinner(`${t('skill.deleting')} "${skill.name}"…`);
  try {
    await session.removeSkill(skill.name);
    spinner.stop({ ok: true, label: `"${skill.name}" ${t('skill.deleted')}` });
    host.showNotice(t('skill.skill_deleted'), t('skill.skill_removed'));
  } catch (error) {
    spinner.stop({ ok: false, label: t('skill.delete_failed') });
    host.showError(t('skill.delete_failed_msg', { msg: error instanceof Error ? error.message : String(error) }));
  } finally {
    await openSkillCenter(host);
  }
}

async function confirmUninstall(
  host: SlashCommandHost,
  label: string,
  description?: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const picker = new ChoicePickerComponent({
      title: t('skill.confirm_uninstall', { label }),
      hint: t('skill.uninstall_reversible'),
      options: [
        { value: 'no', label: t('common.cancel') },
        { value: 'yes', label: t('skill.uninstall_yes'), tone: 'danger', description },
      ],
      colors: host.state.theme.colors,
      onSelect: (value: string) => {
        host.restoreEditor();
        resolve(value === 'yes');
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(false);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

function formatSkillDescription(skill: SkillSummary, plugins: readonly PluginSummary[] = []): string {
  const parts: string[] = [];
  if (skill.source) {
    parts.push(`${t('skill.source_label')} ${skill.source}`);
  }
  if (skill.pluginId !== undefined) {
    const plugin = plugins.find((p) => p.id === skill.pluginId);
    const label = plugin?.displayName ?? skill.pluginId;
    parts.push(`${t('skill.plugin_label')} ${label}`);
  }
  if (skill.description) {
    parts.push(truncate(skill.description, SKILL_DESC_MAX));
  }
  return parts.join('  ·  ');
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
