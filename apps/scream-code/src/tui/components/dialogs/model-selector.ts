import type { ModelAlias, ThinkingEffort } from '@scream-code/scream-code-sdk';
import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { DEFAULT_OAUTH_PROVIDER_NAME, PRODUCT_NAME } from '#/constant/app';
import type { ColorPalette } from '#/tui/theme/colors';
import { SearchableList } from '#/tui/utils/searchable-list';
import { SELECT_POINTER } from '../../constant/symbols';

import type { ChoiceOption } from './choice-picker';

type ThinkingAvailability = 'toggle' | 'always-on' | 'unsupported';

interface ModelChoice {
  readonly alias: string;
  readonly model: ModelAlias;
  readonly label: string;
}

export interface ModelSelection {
  readonly alias: string;
  readonly thinkingLevel: ThinkingEffort;
  readonly imageEnabled: boolean;
}

const DEFAULT_THINKING_LEVELS: readonly ThinkingEffort[] = ['off', 'low', 'medium', 'high'];

export function modelDisplayName(alias: string, model: ModelAlias | undefined): string {
  return model?.displayName ?? model?.model ?? alias;
}

export function providerDisplayName(provider: string): string {
  if (provider === DEFAULT_OAUTH_PROVIDER_NAME) return PRODUCT_NAME;
  if (provider.startsWith('managed:')) return provider.slice('managed:'.length);
  return provider;
}

export function createModelChoiceOptions(
  models: Record<string, ModelAlias>,
): readonly ChoiceOption[] {
  return Object.entries(models).map(([alias, cfg]) => ({
    value: alias,
    label: `${modelDisplayName(alias, cfg)} (${providerDisplayName(cfg.provider)})`,
  }));
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
  readonly onSelect: (selection: ModelSelection) => void;
  readonly onCancel: () => void;
}

function createModelChoices(models: Record<string, ModelAlias>): readonly ModelChoice[] {
  return Object.entries(models).map(([alias, cfg]) => ({
    alias,
    model: cfg,
    label: `${modelDisplayName(alias, cfg)} (${providerDisplayName(cfg.provider)})`,
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

function getThinkingLevels(model: ModelAlias): readonly ThinkingEffort[] {
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

export class ModelSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: ModelSelectorOptions;
  private readonly list: SearchableList<ModelChoice>;
  private thinkingDraft: ThinkingEffort;
  private imageDraft: boolean;
  private lastSelectedAlias: string | undefined;

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
    this.imageDraft =
      initialChoice !== undefined ? modelHasImageIn(initialChoice.model) : false;
    this.lastSelectedAlias = initialChoice?.alias;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.opts.onCancel();
      return;
    }
    const selected = this.list.selected();
    // When the user navigates to a different model, reset imageDraft to that
    // model's actual declared state so the display stays honest. thinkingDraft
    // is intentionally sticky (a preference); image capability is model-specific.
    if (selected !== undefined && selected.alias !== this.lastSelectedAlias) {
      this.imageDraft = modelHasImageIn(selected.model);
      this.lastSelectedAlias = selected.alias;
    }
    // Left/Right cycle thinking level for the selected model. Paging stays on
    // PgUp/PgDn so horizontal arrows are free for the thinking control.
    if (selected !== undefined && thinkingAvailability(selected.model) !== 'unsupported') {
      const levels = getThinkingLevels(selected.model);
      const idx = levels.indexOf(this.thinkingDraft);
      if (matchesKey(data, Key.left)) {
        const nextIdx = idx <= 0 ? levels.length - 1 : idx - 1;
        this.thinkingDraft = levels[nextIdx]!;
        return;
      }
      if (matchesKey(data, Key.right)) {
        const nextIdx = idx === -1 || idx >= levels.length - 1 ? 0 : idx + 1;
        this.thinkingDraft = levels[nextIdx]!;
        return;
      }
    }
    // Space toggles image capability for the selected model. Catalog-declared
    // image_in is locked on (shown as "默认开启") and cannot be turned off —
    // only DIY/catalog-off models can be toggled to force-enable vision.
    if (
      selected !== undefined &&
      !modelHasImageIn(selected.model) &&
      matchesKey(data, Key.space)
    ) {
      this.imageDraft = !this.imageDraft;
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (selected === undefined) return;
      this.opts.onSelect({
        alias: selected.alias,
        thinkingLevel: effectiveThinkingLevel(selected.model, this.thinkingDraft),
        imageEnabled: this.imageDraft,
      });
      return;
    }
    this.list.handleKey(data);
  }

  override render(width: number): string[] {
    const { colors } = this.opts;
    const searchable = this.opts.searchable === true;
    const view = this.list.view();
    const choices = view.items;

    const navParts = ['↑↓ 模型', '←→ 思考等级', 'Space(空格) vision识图'];
    if (view.page.pageCount > 1) navParts.push('PgUp/PgDn 翻页');
    navParts.push('Enter 应用', 'Esc 取消');

    const titleSuffix =
      searchable && view.query.length === 0 ? chalk.hex(colors.textMuted)('  (输入搜索)') : '';
    const lines: string[] = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(' 选择模型') + titleSuffix,
    ];
    if (searchable && view.query.length > 0) {
      lines.push(chalk.hex(colors.primary)(' 搜索：') + chalk.hex(colors.text)(view.query));
    }
    lines.push(chalk.hex(colors.textMuted)(` ${navParts.join(' · ')}`));
    lines.push('');

    if (choices.length === 0) {
      lines.push(chalk.hex(colors.textMuted)('   No matches'));
    }
    for (let i = view.page.start; i < view.page.end; i++) {
      const choice = choices[i]!;
      const isSelected = i === view.selectedIndex;
      const isCurrent = choice.alias === this.opts.currentValue;
      const pointer = isSelected ? SELECT_POINTER : ' ';
      const labelStyle = isSelected ? chalk.hex(colors.primary).bold : chalk.hex(colors.text);
      let line = chalk.hex(isSelected ? colors.primary : colors.textDim)(`  ${pointer} `);
      line += labelStyle(choice.label);
      if (isCurrent) {
        line += ' ' + chalk.hex(colors.success)('← current');
      }
      lines.push(line);
    }

    lines.push('');
    lines.push(chalk.hex(colors.textMuted)(' Thinking'));
    const selected = choices[view.selectedIndex];
    if (selected !== undefined) {
      lines.push(this.renderThinkingControl(selected.model));
    }
    lines.push('');
    lines.push(chalk.hex(colors.textMuted)(' Vision 识图'));
    if (selected !== undefined) {
      lines.push(this.renderImageControl(selected.model));
    }
    lines.push('');
    if (view.page.pageCount > 1) {
      lines.push(
        chalk.hex(colors.textMuted)(
          ` Page ${String(view.page.page + 1)}/${String(view.page.pageCount)}`,
        ),
      );
    }
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderThinkingControl(model: ModelAlias): string {
    const { colors } = this.opts;
    const availability = thinkingAvailability(model);
    const levels = getThinkingLevels(model);
    const effectiveLevel = effectiveThinkingLevel(model, this.thinkingDraft);

    const segments = levels.map((level) => {
      const active = level === effectiveLevel;
      return active
        ? chalk.hex(colors.primary).bold(`[ ${level} ]`)
        : chalk.hex(colors.text)(level);
    });

    const line = `  ${segments.join('  ')}`;
    if (availability === 'unsupported') {
      return `${line} ${chalk.hex(colors.textMuted)('unsupported')}`;
    }
    return line;
  }

  private renderImageControl(model: ModelAlias): string {
    const { colors } = this.opts;
    // Catalog-declared image_in is always on and cannot be turned off.
    if (modelHasImageIn(model)) {
      return `  ${chalk.hex(colors.success).bold('✓ 默认开启')}${chalk.hex(colors.textMuted)(' (catalog)')}`;
    }
    const stateLabel = this.imageDraft
      ? chalk.hex(colors.success).bold('✓ 开启')
      : chalk.hex(colors.textDim)('✗ 关闭');
    const note = this.imageDraft
      ? chalk.hex(colors.textMuted)(' (手动开启)')
      : '';
    return `  ${stateLabel}${note}`;
  }
}
