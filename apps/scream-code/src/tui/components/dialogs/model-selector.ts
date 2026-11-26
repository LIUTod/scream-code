import { breadcrumbPrefix } from './choice-picker';
import type { ModelAlias, ThinkingEffort } from '@scream-code/scream-code-sdk';
import { t } from '@scream-code/config';
import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@liutod-scream/pi-tui';
import chalk from 'chalk';

import { DEFAULT_OAUTH_PROVIDER_NAME, PRODUCT_NAME } from '#/constant/app';
import type { ColorPalette } from '#/tui/theme/colors';
import { panelRowBudget } from '#/tui/utils/panel-rows';
import { SearchableList } from '#/tui/utils/searchable-list';
import { currentMark, pointerCell, rowLabel, selectableRow } from '../../utils/select-row';


type ThinkingAvailability = 'toggle' | 'always-on' | 'unsupported';

interface ModelChoice {
  readonly alias: string;
  readonly model: ModelAlias;
  /** What the filter matches: the name and the provider. */
  readonly label: string;
  readonly name: string;
}

export interface ModelSelection {
  readonly alias: string;
  readonly thinkingLevel: ThinkingEffort;
}

const DEFAULT_THINKING_LEVELS: readonly ThinkingEffort[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

export function modelDisplayName(alias: string, model: ModelAlias | undefined): string {
  return model?.displayName ?? model?.model ?? alias;
}

export function providerDisplayName(provider: string): string {
  if (provider === DEFAULT_OAUTH_PROVIDER_NAME) return PRODUCT_NAME;
  if (provider.startsWith('managed:')) return provider.slice('managed:'.length);
  return provider;
}

/** Status of the independently configured image-generation API (/config image). */
export interface ImageGenerationSummary {
  readonly configured: boolean;
  /** The configured image model — present only when `configured` is true. */
  readonly model?: string;
}

export interface ModelSelectorOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue: string;
  readonly selectedValue?: string;
  readonly currentThinkingLevel: ThinkingEffort;
  readonly colors: ColorPalette;
  /** When true, typed characters filter the list (fuzzy) and a search line is shown. */
  readonly searchable?: boolean;
  /** Items per page. Lists longer than this paginate (PgUp/PgDn). */
  readonly pageSize?: number;
  /**
   * Image-generation status to surface under the multimodal block. Only the
   * /model picker supplies it; callers that omit it render no status line.
   * Image generation is configured independently via /config image — it is
   * not a property of the selected chat model.
   */
  readonly imageGeneration?: ImageGenerationSummary;
  readonly onSelect: (selection: ModelSelection) => void;
  readonly onCancel: () => void;
  /** The menu this one was opened from (see ChoicePickerOptions.breadcrumb). */
  readonly breadcrumb?: string | undefined;
  /**
   * Fired immediately when the user cycles the thinking level with ←/→ for
   * the selected model. Persistence is the host's responsibility; Enter is
   * not required to save the change.
   */
  readonly onChangeThinking?: (alias: string, level: ThinkingEffort) => void;
  /**
   * Terminal height, read on every render. The selector replaces the editor,
   * so on a short terminal it gives rows back (fewer models per page, no
   * capability or image rows) and keeps the key hints visible. Unknown means
   * no limit.
   */
  readonly viewportRows?: () => number;
}

function createModelChoices(models: Record<string, ModelAlias>): readonly ModelChoice[] {
  return Object.entries(models).map(([alias, cfg]) => ({
    alias,
    model: cfg,
    name: modelDisplayName(alias, cfg),
    label: `${modelDisplayName(alias, cfg)} ${providerDisplayName(cfg.provider)}`,
  }));
}

function thinkingAvailability(model: ModelAlias): ThinkingAvailability {
  const caps = model.capabilities ?? [];
  if (caps.includes('always_thinking')) return 'always-on';
  // Forcing adaptive thinking implies the model supports thinking, even when the
  // alias declares no capabilities — e.g. a custom-named endpoint configured with
  // only `adaptive_thinking = true`. Without this it would render as "unsupported"
  // and switching to it would force thinking off.
  if (caps.includes('thinking') || model.adaptiveThinking === true) return 'toggle';
  return 'unsupported';
}

export function getThinkingLevels(model: ModelAlias): readonly ThinkingEffort[] {
  const availability = thinkingAvailability(model);
  if (availability === 'unsupported') return ['off'];
  const base = model.thinkingLevels ?? DEFAULT_THINKING_LEVELS;
  if (availability === 'always-on') {
    return base.filter((level) => level !== 'off');
  }
  return base;
}

function effectiveThinkingLevel(
  model: ModelAlias,
  thinkingDraft: ThinkingEffort,
): ThinkingEffort {
  const levels = getThinkingLevels(model);
  if (levels.includes(thinkingDraft)) return thinkingDraft;
  // If the draft is unsupported, fall back to the first available level.
  return levels[0] ?? 'off';
}

function modelHasImageIn(model: ModelAlias): boolean {
  return model.capabilities?.includes('image_in') === true;
}

function modelHasVideoIn(model: ModelAlias): boolean {
  return model.capabilities?.includes('video_in') === true;
}

function modelHasAudioIn(model: ModelAlias): boolean {
  return model.capabilities?.includes('audio_in') === true;
}

export class ModelSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: ModelSelectorOptions;
  private readonly list: SearchableList<ModelChoice>;
  private thinkingDraft: ThinkingEffort;

  constructor(opts: ModelSelectorOptions) {
    super();
    this.opts = opts;
    const choices = createModelChoices(opts.models);
    const selectedValue = opts.selectedValue ?? opts.currentValue;
    const selectedIdx = choices.findIndex((choice) => choice.alias === selectedValue);
    this.list = new SearchableList({
      items: choices,
      toSearchText: (c) => c.label,
      pageSize: opts.pageSize,
      initialIndex: Math.max(selectedIdx, 0),
      searchable: opts.searchable === true,
    });
    const initialChoice = choices[selectedIdx];
    this.thinkingDraft =
      initialChoice !== undefined
        ? effectiveThinkingLevel(initialChoice.model, opts.currentThinkingLevel)
        : opts.currentThinkingLevel;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.opts.onCancel();
      return;
    }
    const selected = this.list.selected();
    // Left/Right cycle thinking level for the selected model. Paging stays on
    // PgUp/PgDn so horizontal arrows are free for the thinking control. The
    // change is persisted immediately via onChangeThinking so the user does
    // not need to press Enter to save it.
    if (selected !== undefined && thinkingAvailability(selected.model) !== 'unsupported') {
      const levels = getThinkingLevels(selected.model);
      const idx = levels.indexOf(this.thinkingDraft);
      if (matchesKey(data, Key.left)) {
        const nextIdx = idx <= 0 ? levels.length - 1 : idx - 1;
        this.thinkingDraft = levels[nextIdx]!;
        this.opts.onChangeThinking?.(selected.alias, this.thinkingDraft);
        return;
      }
      if (matchesKey(data, Key.right)) {
        const nextIdx = idx === -1 || idx >= levels.length - 1 ? 0 : idx + 1;
        this.thinkingDraft = levels[nextIdx]!;
        this.opts.onChangeThinking?.(selected.alias, this.thinkingDraft);
        return;
      }
    }
    if (matchesKey(data, Key.enter)) {
      if (selected === undefined) return;
      this.opts.onSelect({
        alias: selected.alias,
        thinkingLevel: effectiveThinkingLevel(selected.model, this.thinkingDraft),
      });
      return;
    }
    this.list.handleKey(data);
  }

  override render(width: number): string[] {
    const budget = panelRowBudget(this.opts.viewportRows?.());
    const roomy = this.opts.pageSize ?? MODELS_PER_PAGE;
    this.list.setPageSize(roomy);
    let lines = this.compose(width, 0);
    if (lines.length <= budget) return lines;
    // Short terminal: no blank rows, no capability or image rows (the row of
    // each model already says what it can read), then fewer models per page.
    for (let size = roomy; size >= MIN_MODELS_PER_PAGE; size -= 1) {
      this.list.setPageSize(size);
      lines = this.compose(width, 1);
      if (lines.length <= budget) return lines;
    }
    return lines;
  }

  private compose(width: number, level: 0 | 1): string[] {
    const { colors } = this.opts;
    const dim = chalk.hex(colors.textDim);
    const searchable = this.opts.searchable === true;
    const view = this.list.view();
    const choices = view.items;

    // Highest rank goes first when the row is too narrow for all of it.
    const navParts: Array<{ text: string; rank: number }> = [
      { text: t('model.nav_model'), rank: 0 },
      { text: t('model.nav_thinking'), rank: 2 },
    ];
    if (view.page.pageCount > 1) navParts.push({ text: t('model.nav_page'), rank: 3 });
    navParts.push(
      { text: t('model.nav_select'), rank: 0 },
      { text: this.opts.breadcrumb === undefined ? t('model.nav_cancel') : t('dialog.back'), rank: 0 },
    );

    const titleSuffix = searchable && view.query.length === 0 ? dim(`  ${t('model.search_placeholder')}`) : '';
    const lines: string[] = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      ' ' + breadcrumbPrefix(this.opts.breadcrumb, colors) + chalk.hex(colors.primary).bold(t('model.select_title').trim()) + titleSuffix,
    ];
    if (searchable && view.query.length > 0) {
      lines.push(chalk.hex(colors.primary)(t('model.search_label')) + chalk.hex(colors.text)(view.query));
    }
    if (level === 0) lines.push('');

    if (choices.length === 0) {
      lines.push(dim(`   ${t('model.no_matches')}`));
    }
    // One row per model: its name (and the mark when it is the one in use),
    // then a quiet column that says what it is — provider, context, what it
    // can read — so models can be compared before one is picked.
    const names: string[] = [];
    for (let i = view.page.start; i < view.page.end; i++) {
      const choice = choices[i]!;
      const isSelected = i === view.selectedIndex;
      const isCurrent = choice.alias === this.opts.currentValue;
      let head = `  ${pointerCell(colors, isSelected)}` + rowLabel(colors, isSelected)(choice.name);
      if (isCurrent) head += currentMark(colors);
      names.push(head);
    }
    const column = Math.min(
      Math.max(0, ...names.map((head) => visibleWidth(head))) + 2,
      Math.max(Math.floor(width * 0.5), 12),
    );
    for (let i = view.page.start; i < view.page.end; i++) {
      const choice = choices[i]!;
      const isSelected = i === view.selectedIndex;
      const head = truncateToWidth(names[i - view.page.start]!, column - 1);
      const room = width - column - 1;
      const note = room > 6 ? dim(truncateToWidth(describeModel(choice), room, '…')) : '';
      lines.push(selectableRow(colors, head + ' '.repeat(Math.max(1, column - visibleWidth(head))) + note, width, isSelected));
    }

    if (level === 0) lines.push('');
    const selected = choices[view.selectedIndex];
    if (selected !== undefined) {
      lines.push(this.renderThinkingRow(selected.model, width));
      if (level === 0) lines.push(this.renderCapabilityRow(selected.model));
    }
    if (level === 0 && this.opts.imageGeneration !== undefined) {
      const imageGeneration = this.opts.imageGeneration;
      lines.push(
        dim(
          imageGeneration.configured && imageGeneration.model !== undefined
            ? t('model.image_gen_configured', { model: imageGeneration.model })
            : t('model.image_gen_missing'),
        ),
      );
    }
    if (level === 0) lines.push('');
    if (view.page.pageCount > 1) {
      lines.push(dim(` ${t('model.page', { page: String(view.page.page + 1), count: String(view.page.pageCount) })}`));
    }
    // The key hint sits under the list in every dialog.
    lines.push(dim(` ${fitNav(navParts, width - 2)}`));
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }

  /**
   * The thinking level as a scale of glyphs, the active step bracketed and bold. Only what
   * this model offers is listed; narrow rows keep the name of the active step
   * alone.
   */
  private renderThinkingRow(model: ModelAlias, width: number): string {
    const { colors } = this.opts;
    const dim = chalk.hex(colors.textDim);
    const label = dim(`  ${t('model.thinking_label')}  `);
    if (thinkingAvailability(model) === 'unsupported') {
      return `${label}${dim(t('model.thinking_unsupported'))}`;
    }
    const levels = getThinkingLevels(model);
    const active = effectiveThinkingLevel(model, this.thinkingDraft);
    // The active step is bracketed as well as bold, so it still shows where
    // there is no colour; every step is the same width, so the row does not
    // shift as the level changes.
    const scale = (names: boolean): string =>
      levels
        .map((level) => {
          const glyph = THINKING_GLYPH[level] ?? '•';
          if (level === active) return chalk.hex(colors.primary).bold(`[${glyph} ${level}]`);
          return dim(names ? ` ${glyph} ${level} ` : ` ${glyph} `);
        })
        .join(' ');
    const adjust = dim(`   ${t('model.thinking_adjust')}`);
    for (const row of [`${label}${scale(true)}${adjust}`, `${label}${scale(true)}`, `${label}${scale(false)}`]) {
      if (visibleWidth(row) <= width) return row;
    }
    return `${label}${scale(false)}`;
  }

  /** What the model can read, on one row. */
  private renderCapabilityRow(model: ModelAlias): string {
    const { colors } = this.opts;
    const dim = chalk.hex(colors.textDim);
    const item = (name: string, yes: boolean): string =>
      `${dim(name)} ${yes ? chalk.hex(colors.success).bold('✓') : dim('✗')}`;
    return (
      dim(`  ${t('model.capabilities_label')}  `) +
      [
        item(t('model.image'), modelHasImageIn(model)),
        item(t('model.video'), modelHasVideoIn(model)),
        item(t('model.audio'), modelHasAudioIn(model)),
      ].join('  ')
    );
  }
}

/** The key hint, the least important parts dropped until it fits `width`. */
function fitNav(parts: ReadonlyArray<{ text: string; rank: number }>, width: number): string {
  const kept = [...parts];
  const joined = (): string => kept.map((part) => part.text).join(' · ');
  while (visibleWidth(joined()) > width) {
    const worst = Math.max(...kept.map((part) => part.rank));
    if (worst === 0) break;
    kept.splice(kept.map((part) => part.rank).lastIndexOf(worst), 1);
  }
  return joined();
}

/** Models per page when there is room, and the fewest a short terminal gets. */
const MODELS_PER_PAGE = 8;
const MIN_MODELS_PER_PAGE = 3;

/** One glyph per level: a scale that fills up. */
const THINKING_GLYPH: Readonly<Record<string, string>> = {
  off: '-',
  low: '○',
  medium: '◐',
  high: '●',
  xhigh: '⦿',
  max: '◉',
};

/** `128000` and `131072` are both "128K": the nearer of the decimal and binary reading. */
export function formatContextSize(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  const decimal = Math.round(tokens / 1000) * 1000;
  const binary = Math.round(tokens / 1024) * 1024;
  const unit = Math.abs(tokens - binary) < Math.abs(tokens - decimal) ? 1024 : 1000;
  const k = Math.round(tokens / unit);
  return k >= 1000 ? `${String(Math.round((k / 1000) * 10) / 10)}M` : `${String(k)}K`;
}

/** `provider · context · what it reads`, the quiet column of a model's row. */
function describeModel(choice: ModelChoice): string {
  const { model } = choice;
  const parts = [providerDisplayName(model.provider)];
  const context = formatContextSize(model.maxContextSize);
  if (context.length > 0) parts.push(context);
  if (thinkingAvailability(model) !== 'unsupported') parts.push(t('model.cap_thinking'));
  if (modelHasImageIn(model)) parts.push(t('model.image'));
  if (modelHasVideoIn(model)) parts.push(t('model.video'));
  if (modelHasAudioIn(model)) parts.push(t('model.audio'));
  return parts.join(' · ');
}
