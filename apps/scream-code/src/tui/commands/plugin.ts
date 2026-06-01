/**
 * /plugin — ScreamCode 插件中心。
 *
 * 打开后展示插件市场和已安装列表，支持一键安装/卸载。
 * 也支持快捷命令：/plugin install <url>、/plugin uninstall <id>
 */

import type { PluginSummary } from '@scream-cli/scream-code-sdk';

import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import {
  loadPluginMarketplace,
  type PluginMarketplaceEntry,
} from '../../utils/plugin-marketplace';
import type { SlashCommandHost } from './dispatch';

// ─── Built-in fallback ──────────────────────────────────────────────────────

/**
 * Minimal built-in registry shipped with the binary.  Used as a fallback when
 * the remote CDN marketplace is unreachable (offline mode).
 */
const BUILTIN_REGISTRY: PluginMarketplaceEntry[] = [
  {
    id: 'gsap-skills',
    displayName: 'GSAP 动画技能包',
    description: 'GreenSock 动画平台全套参考手册，含核心 API、Timeline、ScrollTrigger、插件、React 集成等 8 个技能',
    source: 'https://github.com/greensock/gsap-skills',
  },
];

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handlePluginCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const trimmed = args.trim();

  // ── Quick install from URL ────────────────────────────────────────────
  if (trimmed.startsWith('install ')) {
    const source = trimmed.slice('install '.length).trim();
    if (source.length === 0) {
      host.showError('用法: /plugin install <github-url>');
      return;
    }
    await installAndReport(host, source);
    return;
  }

  // ── Quick uninstall ───────────────────────────────────────────────────
  if (trimmed.startsWith('uninstall ') || trimmed.startsWith('remove ')) {
    const id = trimmed.slice(trimmed.indexOf(' ') + 1).trim();
    if (id.length === 0) {
      host.showError('用法: /plugin uninstall <插件id>');
      return;
    }
    await uninstallAndReport(host, id);
    return;
  }

  // ── Open plugin panel ─────────────────────────────────────────────────
  await openPluginPanel(host);
}

// ─── Quick actions ──────────────────────────────────────────────────────────

async function installAndReport(host: SlashCommandHost, source: string): Promise<void> {
  const session = host.session;
  if (!session) {
    host.showError('未连接到会话。请先创建或恢复一个会话。');
    return;
  }

  const spinner = host.showProgressSpinner('正在安装插件...');
  try {
    const summary = await session.installPlugin(source);
    spinner.stop({ ok: true, label: `插件 "${summary.displayName}" 安装成功。` });
    host.showNotice(
      '插件已安装',
      [
        `${summary.displayName} (${summary.id}) v${summary.version ?? '—'}`,
        `Skills: ${summary.skillCount} 个`,
        '',
        '⚠ 新插件在下次创建或恢复会话时生效。',
      ].join('\n'),
    );
  } catch (error) {
    spinner.stop({ ok: false, label: '插件安装失败。' });
    host.showError(
      `安装失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function uninstallAndReport(host: SlashCommandHost, id: string): Promise<void> {
  const session = host.session;
  if (!session) {
    host.showError('未连接到会话。请先创建或恢复一个会话。');
    return;
  }

  const spinner = host.showProgressSpinner(`正在卸载插件 "${id}"...`);
  try {
    await session.removePlugin(id);
    spinner.stop({ ok: true, label: `插件 "${id}" 已卸载。` });
    host.showNotice(
      '插件已卸载',
      '⚠ 变更在新会话中生效，当前会话不受影响。',
    );
  } catch (error) {
    spinner.stop({ ok: false, label: '插件卸载失败。' });
    host.showError(
      `卸载失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ─── Plugin panel ───────────────────────────────────────────────────────────

async function openPluginPanel(host: SlashCommandHost): Promise<void> {
  const marketplace = await loadSafe(host);
  const installed = await loadInstalled(host);

  const options = buildOptions(marketplace, installed);
  if (options.length === 0) {
    host.showNotice(
      'ScreamCode 插件中心',
      '暂无可用插件。请检查网络或稍后重试。',
    );
    return;
  }

  const picker = new ChoicePickerComponent({
    title: 'ScreamCode 插件中心',
    hint: 'Enter 安装 / 先按 d 再 Enter 卸载 / Esc 返回',
    options,
    colors: host.state.theme.colors,
    searchable: false,
    pageSize: 10,
    onSelect: async (value: string) => {
      host.restoreEditor();
      await handlePanelAction(host, value, marketplace, installed);
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });

  host.mountEditorReplacement(picker);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Load marketplace (remote CDN), falling back to built-in registry. */
async function loadSafe(
  host: SlashCommandHost,
): Promise<readonly PluginMarketplaceEntry[]> {
  try {
    const result = await loadPluginMarketplace({
      workDir: host.state.appState.workDir ?? process.cwd(),
    });
    return result.plugins;
  } catch {
    return BUILTIN_REGISTRY;
  }
}

async function loadInstalled(
  host: SlashCommandHost,
): Promise<readonly PluginSummary[]> {
  try {
    const session = host.session;
    if (!session) return [];
    return await session.listPlugins();
  } catch {
    return [];
  }
}

function buildOptions(
  marketplace: readonly PluginMarketplaceEntry[],
  installed: readonly PluginSummary[],
): ChoiceOption[] {
  const options: ChoiceOption[] = [];
  const installedIds = new Set(installed.map((p) => p.id));

  // ── Section: marketplace (not yet installed) ──
  const newPlugins = marketplace.filter((p) => !installedIds.has(p.id));
  if (newPlugins.length > 0) {
    options.push({
      value: '__section__marketplace',
      label: '── 插件市场（可安装）──',
      description: undefined,
    });
    for (const p of newPlugins) {
      options.push({
        value: `install:${p.source}`,
        label: p.displayName,
        description: p.description ? `${p.description}  [未安装]` : '[未安装]',
      });
    }
  }

  // ── Section: installed ──
  if (installed.length > 0) {
    options.push({
      value: '__section__installed',
      label: '── 已安装 ──',
      description: undefined,
    });
    for (const p of installed) {
      const enabledTag = p.enabled ? '✓ 已启用' : '✗ 已禁用';
      const versionTag = p.version ? `v${p.version}` : '';
      const meta = [versionTag, enabledTag].filter(Boolean).join('  ');
      options.push({
        value: `uninstall:${p.id}`,
        label: p.displayName,
        description: `${meta}  [${p.skillCount} skills]`,
      });
    }
  }

  if (options.length === 0) {
    options.push({
      value: '__empty__',
      label: '暂无可用插件',
      description: '请检查网络连接或稍后重试',
    });
  }

  return options;
}

async function handlePanelAction(
  host: SlashCommandHost,
  value: string,
  marketplace: readonly PluginMarketplaceEntry[],
  installed: readonly PluginSummary[],
): Promise<void> {
  if (value.startsWith('install:')) {
    const source = value.slice('install:'.length);
    await installAndReport(host, source);
    await openPluginPanel(host);
  } else if (value.startsWith('uninstall:')) {
    const id = value.slice('uninstall:'.length);
    const confirmed = await confirmUninstall(host, id, installed);
    if (confirmed) {
      await uninstallAndReport(host, id);
    }
    await openPluginPanel(host);
  }
}

async function confirmUninstall(
  host: SlashCommandHost,
  id: string,
  installed: readonly PluginSummary[],
): Promise<boolean> {
  const plugin = installed.find((p) => p.id === id);
  const label = plugin?.displayName ?? id;

  return new Promise<boolean>((resolve) => {
    const picker = new ChoicePickerComponent({
      title: `确认卸载 "${label}"？`,
      hint: '卸载后插件技能在下次会话中不再可用。',
      options: [
        { value: 'yes', label: '是，卸载', tone: 'danger' },
        { value: 'no', label: '取消' },
      ],
      colors: host.state.theme.colors,
      onSelect: (v: string) => {
        host.restoreEditor();
        resolve(v === 'yes');
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(false);
      },
    });

    host.mountEditorReplacement(picker);
  });
}
