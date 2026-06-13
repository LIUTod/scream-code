/**
 * /plugin — ScreamCode 插件中心。
 *
 * 打开后展示插件市场和已安装列表，支持浏览、安装、卸载。 */

import type { PluginSummary } from '@scream-cli/scream-code-sdk';

import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import type { SlashCommandHost } from './dispatch';

// ─── Built-in marketplace ────────────────────────────────────────────────────

/**
 * Plugin marketplace shipped with the binary.  Updated with each hard-version
 * release — no remote fetch needed at runtime. */
interface MarketplaceEntry {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly source: string;
}

const BUILTIN_REGISTRY: MarketplaceEntry[] = [
  {
    id: 'gsap-skills',
    displayName: 'GSAP 动画技能包',
    description: 'GreenSock 动画平台全套参考手册，含核心 API、Timeline、ScrollTrigger、插件、React 集成等 8 个技能',
    source: 'https://github.com/greensock/gsap-skills',
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
  {
    id: 'humanizer',
    displayName: 'Humanizer AI 文本去味',
    description: '去除 AI 写作痕迹：30 种 AI 模式检测 × 5 大类 × 语音校准，输出纯正人类文风',
    source: 'https://github.com/blader/humanizer',
  },
  {
    id: 'patent-disclosure-skill',
    displayName: 'Patent Disclosure 专利交底书',
    description: '专利交底书自动生成：专利点挖掘 → 国知局查新 → 脱敏成文 → 自检闭环，Mermaid 附图，输出 .docx',
    source: 'https://github.com/handsomestWei/patent-disclosure-skill',
  },
  {
    id: 'contract-review-pro',
    displayName: 'Contract Review Pro 合同审查',
    description: '专业合同审查：7 步工作流 × 5 强制关 × 15 类风险标签 × 六维评估，输出批注合同+法律意见书+分析备忘录，支持 30 种合同类型',
    source: 'https://github.com/CSlawyer1985/contract-review-pro',
  },
  {
    id: 'academic-research-skills',
    displayName: 'Academic Research 学术研究',
    description: '完整学术研究管线：深度研究（13 Agent 团队 × 7 种模式）+ 学术写作（12 Agent 管线）+ 同行评审（7 Agent 多视角审稿），全流程覆盖',
    source: 'https://github.com/Imbad0202/academic-research-skills',
  },
  {
    id: 'headroom',
    displayName: 'Headroom 压缩优化',
    description: '在内容送达 LLM 前压缩工具输出、日志、文件和 RAG 块，节省 60-95% Token，答案质量不变',
    source: 'https://github.com/chopratejas/headroom',
  },
  {
    id: 'xiaohu-wechat-format',
    displayName: '小壶公众号排版',
    description: 'Markdown → 微信兼容 HTML → 推送草稿箱，30 套主题 + 可视化画廊，一键排版发布',
    source: 'https://github.com/xiaohuailabs/xiaohu-wechat-format',
  },
  {
    id: 'huashu-design',
    displayName: '花束设计',
    description: 'HTML 原生设计技能：高保真原型 / 幻灯片 / 动画 + 20 设计哲学 + 5 维评审 + MP4 导出',
    source: 'https://github.com/alchaincyf/huashu-design',
  },
  {
    id: 'html-video',
    displayName: 'HTML Video 视频生成',
    description: 'HTML 转 MP4：可插拔渲染引擎 + 21 套模板 + AI 配乐，全程本地，零渲染费用',
    source: 'https://github.com/nexu-io/html-video',
  },
  {
    id: 'xiaohu-video-translate',
    displayName: '小壶视频翻译',
    description: '外语视频自动配中文字幕：下载 / 转写 / 翻译 / 润色 / 烧录一条龙，全程本地',
    source: 'https://github.com/xiaohuailabs/xiaohu-video-translate',
  },
  {
    id: 'videocut-skills',
    displayName: '视频剪辑 Agent',
    description: 'Claude Code Skills 驱动的视频剪辑 Agent：口播剪辑 / 字幕导入 / 画质高清化',
    source: 'https://github.com/Ceeon/videocut-skills',
  },
  {
    id: 'taste-skill',
    displayName: 'Taste Skill 设计品味',
    description: '给 AI 好品味：阻止生成无聊通用的设计，输出有质感的方案',
    source: 'https://github.com/Leonxlnx/taste-skill',
  },
  {
    id: 'vtake-skills',
    displayName: 'VTake 视频剪辑',
    description: 'Agent Skills 驱动的视频剪辑工具',
    source: 'https://github.com/notedit/vtake-skills',
  },
  {
    id: 'remotion-skills',
    displayName: 'Remotion 视频技能',
    description: 'Remotion（React 视频框架）官方技能包',
    source: 'https://github.com/remotion-dev/skills',
  },
  {
    id: 'html-anything',
    displayName: 'HTML Anything 全能设计',
    description: '75 个技能 × 9 种场景：杂志 / 幻灯片 / 海报 / 小红书 / 数据报告 / 原型，零 API 密钥',
    source: 'https://github.com/nexu-io/html-anything',
  },
  {
    id: 'guizang-social-card-skill',
    displayName: '归藏社交卡片',
    description: '小红书轮播图 + 公众号封面：28 种布局 × 10 套主题，Editorial × Swiss 视觉体系，单文件 HTML → PNG',
    source: 'https://github.com/op7418/guizang-social-card-skill',
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

  const spinner = host.showProgressSpinner('正在解析插件来源…');
  const stageTimers: ReturnType<typeof setTimeout>[] = [];

  // Approximate progress stages while the underlying RPC call is in-flight.
  // Real timing varies by repo size / network, so these are conservative.
  stageTimers.push(setTimeout(() => spinner.setLabel('正在下载插件包…'), 3_000));
  stageTimers.push(setTimeout(() => spinner.setLabel('正在解压安装…'), 8_000));
  stageTimers.push(setTimeout(() => spinner.setLabel('正在校验并完成…'), 15_000));

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
  } finally {
    for (const timer of stageTimers) clearTimeout(timer);
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
  const marketplace = BUILTIN_REGISTRY;
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
      host.restoreEditor();
      void handlePanelAction(host, value, marketplace, installed).finally(() => {
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

/**
 * Normalize a GitHub URL to `{owner}/{repo}` for fuzzy matching.
 * Returns `null` for non-GitHub URLs (caller falls back to exact match).
 */
function normalizeGithubSource(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null;
    const segments = u.pathname.split('/').filter((s) => s.length > 0);
    if (segments.length < 2) return null;
    const owner = segments[0]!;
    const repo = segments[1]!.replace(/\.git$/, '');
    return `${owner}/${repo}`.toLowerCase();
  } catch {
    return null;
  }
}

function isInstalled(
  marketplaceId: string,
  marketplaceSource: string,
  installed: readonly PluginSummary[],
): boolean {
  // Match by id first (exact).
  if (installed.some((p) => p.id === marketplaceId)) return true;
  // Fallback: match by GitHub owner/repo so a manifest name mismatch doesn't
  // cause the plugin to appear as "not installed" after a successful install.
  const normalizedSource = normalizeGithubSource(marketplaceSource);
  if (normalizedSource === null) return false;
  return installed.some((p) => {
    const src = p.originalSource ?? '';
    const norm = normalizeGithubSource(src);
    return norm !== null && norm === normalizedSource;
  });
}

function buildOptions(
  marketplace: readonly MarketplaceEntry[],
  installed: readonly PluginSummary[],
): ChoiceOption[] {
  const options: ChoiceOption[] = [];

  // ── Section: marketplace (not yet installed) ──
  const newPlugins = marketplace.filter((p) => !isInstalled(p.id, p.source, installed));
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
      options.push({
        value: `uninstall:${p.id}`,
        label: p.displayName,
        description: formatInstalledPluginDescription(p),
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
  _marketplace: readonly MarketplaceEntry[],
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

const SKILL_DESC_MAX = 40;
const SKILLS_PREVIEW_COUNT = 3;

function formatInstalledPluginDescription(p: PluginSummary): string {
  const enabledTag = p.enabled ? '✓ 已启用' : '✗ 已禁用';
  const versionTag = p.version ? `v${p.version}` : '';
  const meta = [versionTag, enabledTag].filter(Boolean).join('  ');
  const skillDescriptions = p.skills
    .slice(0, SKILLS_PREVIEW_COUNT)
    .map((s) => `${s.name}: ${truncate(s.description, SKILL_DESC_MAX)}`);
  const remaining = p.skillCount - SKILLS_PREVIEW_COUNT;
  const descriptionParts = [`${meta}  [${p.skillCount} skills]`, ...skillDescriptions];
  if (remaining > 0) {
    descriptionParts.push(`…等 ${remaining} 个 skill`);
  }
  return descriptionParts.join('  ·  ');
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
