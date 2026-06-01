/**
 * /plugin — ScreamCode 插件中心。
 *
 * 打开后展示插件市场和已安装列表，支持浏览、安装、卸载。 */

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
  {
    id: 'gorden-ppt-skill',
    displayName: 'Gorden PPT 助手',
    description: '17 套精修中文 PPT 模板，支持 python-pptx 编辑生成，适配国企/互联网大厂风格',
    source: 'https://github.com/GordenSun/GordenPPTSkill',
  },
  {
    id: 'claude-design-card',
    displayName: 'Claude Design Card',
    description: '14 种设计卡片生成（封面/图文/社交分享/长篇排版），Parchment × Swiss 双风格体系',
    source: 'https://github.com/geekjourneyx/claude-design-card',
  },
  {
    id: 'superpowers',
    displayName: 'Superpowers 开发技能包',
    description: '14 个开发方法论技能：TDD、系统调试、代码审查、子代理驱动开发、并行代理、头脑风暴等',
    source: 'https://github.com/obra/superpowers',
  },
  {
    id: 'audio-skill',
    displayName: 'Audio Skill 录音分析',
    description: '本地录音分析自动化，含 RAG 知识库。适用于销售录音复盘、会议纪要、质量评分等',
    source: 'https://github.com/LIUTod/audio-skill',
  },
  {
    id: 'scrapling-skill',
    displayName: 'Scrapling 网页爬取',
    description: '基于 Scrapling 的智能爬虫技能，支持 Cloudflare/WAF 绕过、登录会话、自动抓取解析',
    source: 'https://github.com/Cedriccmh/claude-code-skill-scrapling',
  },
  {
    id: 'a-stock-data',
    displayName: 'A 股数据分析',
    description: 'A 股市场数据查询分析，27 个接口覆盖行情/研报/资金流/新闻/基本面，含 4 套内置研究流程',
    source: 'https://github.com/simonlin1212/a-stock-data',
  },
];

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handlePluginCommand(
  host: SlashCommandHost,
  _args: string,
): Promise<void> {
  if (!host.session) {
    host.showError('请先创建或恢复一个会话，再使用插件中心。');
    return;
  }
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
    hint: 'Enter 安装 / d+Enter 卸载 / Esc 返回',
    options,
    colors: host.state.theme.colors,
    searchable: false,
    pageSize: 10,
    onSelect: (value: string) => {
      if (value.startsWith('__section')) return;
      // Dismiss the picker immediately so transcript updates are visible
      host.restoreEditor();
      // Run async work; re-open panel with fresh data when done
      handlePanelAction(host, value, marketplace, installed).finally(() => {
        openPluginPanel(host).catch(() => { /* panel refresh failure is non-fatal */ });
      });
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
  _marketplace: readonly PluginMarketplaceEntry[],
  installed: readonly PluginSummary[],
): Promise<void> {
  if (value.startsWith('install:')) {
    const source = value.slice('install:'.length);
    await installAndReport(host, source);
  } else if (value.startsWith('uninstall:')) {
    const id = value.slice('uninstall:'.length);
    const plugin = installed.find((p) => p.id === id);
    const label = plugin?.displayName ?? id;
    const confirmed = await confirmUninstall(host, label);
    if (confirmed) {
      await uninstallAndReport(host, id);
    }
  }
}

async function confirmUninstall(host: SlashCommandHost, label: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const picker = new ChoicePickerComponent({
      title: `确认卸载 "${label}"？`,
      hint: '卸载后可在插件市场中重新安装',
      options: [
        { value: 'no', label: '取消' },
        { value: 'yes', label: '是，卸载', tone: 'danger' },
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
