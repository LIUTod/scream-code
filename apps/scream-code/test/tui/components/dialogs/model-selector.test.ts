import { visibleWidth } from '@liutod-scream/pi-tui';
import { describe, expect, it } from 'vitest';

import {
  formatContextSize,
  ModelSelectorComponent,
  providerDisplayName,
} from '#/tui/components/dialogs/model-selector';
import { getColorPalette } from '#/tui/theme/colors';

const COLORS = getColorPalette('dark');

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function models(): Record<string, never> {
  const entry = (provider: string, model: string, displayName: string, maxContextSize: number, capabilities: string[]) =>
    ({ provider, model, displayName, maxContextSize, capabilities }) as never;
  return {
    'alpha-1': entry('acme', 'alpha-1', 'Alpha 1', 128_000, ['thinking']),
    'alpha-mini': entry('acme', 'alpha-mini', 'Alpha 1 Mini', 128_000, []),
    'bravo-5': entry('nimbus', 'bravo-5', 'Bravo 5', 200_000, ['thinking', 'image_in']),
    'cedar-3': entry('orbit', 'cedar-3', 'Cedar 3', 262_144, ['thinking', 'image_in', 'video_in']),
    'delta-max': entry('delta', 'delta-max', 'Delta Max', 128_000, ['thinking']),
    'echo-5': entry('echo', 'echo-5', 'Echo 5', 400_000, ['thinking', 'image_in']),
    'fjord-pro': entry('fjord', 'fjord-pro', 'Fjord Pro', 200_000, ['thinking', 'image_in']),
    'local-mini': entry('selfhost', 'local-mini', 'Local Mini', 131_072, []),
  } as Record<string, never>;
}

function make(options: Partial<ConstructorParameters<typeof ModelSelectorComponent>[0]> = {}): ModelSelectorComponent {
  return new ModelSelectorComponent({
    models: models(),
    currentValue: 'bravo-5',
    currentThinkingLevel: 'high',
    colors: COLORS,
    searchable: true,
    imageGeneration: { configured: false },
    onSelect: () => {},
    onCancel: () => {},
    ...options,
  });
}

describe('formatContextSize', () => {
  it('reads decimal and binary sizes as the number people say', () => {
    expect(formatContextSize(128_000)).toBe('128K');
    expect(formatContextSize(131_072)).toBe('128K');
    expect(formatContextSize(200_000)).toBe('200K');
    expect(formatContextSize(262_144)).toBe('256K');
    expect(formatContextSize(1_000_000)).toBe('1M');
    expect(formatContextSize(1_048_576)).toBe('1M');
    expect(formatContextSize(0)).toBe('');
  });
});

describe('ModelSelectorComponent — rows', () => {
  it('says what each model is: provider, context and what it can read', () => {
    const text = make().render(100).map(strip);
    const bravo = text.find((line) => line.includes('Bravo 5')) ?? '';
    expect(bravo).toContain('nimbus');
    expect(bravo).toContain('200K');
    expect(bravo).toContain('思考');
    expect(bravo).toContain('识图');
    const cedar = text.find((line) => line.includes('Cedar 3')) ?? '';
    expect(cedar).toContain('256K');
    expect(cedar).toContain('视频');
    const mini = text.find((line) => line.includes('Alpha 1 Mini')) ?? '';
    expect(mini).not.toContain('思考');
  });

  it('lines the descriptions up in one column and keeps the mark of the model in use', () => {
    const text = make().render(100).map(strip);
    const starts = ['Alpha 1 ', 'Bravo 5', 'Fjord Pro'].map((name) => {
      const line = text.find((l) => l.includes(name)) ?? '';
      const provider = /(acme|nimbus|fjord)/.exec(line);
      return provider === null ? -1 : visibleWidth(line.slice(0, provider.index));
    });
    expect(new Set(starts).size).toBe(1);
    expect(text.find((line) => line.includes('Bravo 5')) ?? '').toContain('当前');
  });

  it('draws the thinking level as a scale of glyphs with the active step named', () => {
    const row = make().render(100).map(strip).find((line) => line.includes('思考（全局）')) ?? '';
    expect(row).toContain('○ low');
    expect(row).toContain('[● high]');
    expect(row).toContain('◈ max');
    expect(row).toContain('←→ 调整');
  });

  it('says so when the model has no thinking, instead of a dead scale', () => {
    const selector = make({ currentValue: 'alpha-mini' });
    const row = selector.render(100).map(strip).find((line) => line.includes('思考（全局）')) ?? '';
    expect(row).toContain('此模型不支持');
    expect(row).not.toContain('[');
  });

  it('keeps the scale the same width as the level changes', () => {
    const selector = make();
    const width = (): number => visibleWidth((selector.render(100).map(strip).find((line) => line.includes('思考（全局）')) ?? '').trimEnd());
    const before = width();
    selector.handleInput('\u001B[D');
    expect(width()).toBe(before);
  });

  it('puts what the selected model can read on one row', () => {
    const row = make().render(100).map(strip).find((line) => line.includes('能力')) ?? '';
    expect(row).toMatch(/识图 ✓/);
    expect(row).toMatch(/视频 ✗/);
    expect(row).toMatch(/音频 ✗/);
  });

  it('still cycles the thinking level with the arrow keys', () => {
    const changes: Array<[string, string]> = [];
    const selector = make({ onChangeThinking: (alias, level) => changes.push([alias, level]) });
    selector.handleInput('\u001B[D'); // left
    selector.handleInput('\u001B[C'); // right
    expect(changes).toEqual([
      ['bravo-5', 'medium'],
      ['bravo-5', 'high'],
    ]);
  });

  it('filters by name or provider', () => {
    const selector = make();
    for (const ch of 'nimbus') selector.handleInput(ch);
    const text = selector.render(100).map(strip).join('\n');
    expect(text).toContain('Bravo 5');
    expect(text).not.toContain('Cedar 3');
  });

  it('says there are no matches in the interface language', () => {
    const selector = make();
    for (const ch of 'zzzz') selector.handleInput(ch);
    expect(selector.render(100).map(strip).join('\n')).toContain('没有匹配的模型');
  });
});

describe('ModelSelectorComponent — short terminal', () => {
  it('stays inside the room it has and keeps the key hints and the selected model', () => {
    for (const rows of [14, 18, 24, 40]) {
      const selector = make({ viewportRows: () => rows });
      const lines = selector.render(80).map(strip);
      expect(lines.length, `rows ${String(rows)}`).toBeLessThanOrEqual(Math.max(6, rows - 1 - 2 - 1));
      const text = lines.join('\n');
      expect(text).toContain('Enter 切换模型');
      expect(text).toContain('Bravo 5');
      expect(text).toContain('思考（全局）');
    }
  });

  it('gives up the capability and image rows before models, and pages the rest', () => {
    const roomy = make({ viewportRows: () => 40 }).render(80).map(strip).join('\n');
    const tight = make({ viewportRows: () => 14 }).render(80).map(strip).join('\n');
    expect(roomy).toContain('能力');
    expect(roomy).toContain('生图模型');
    expect(tight).not.toContain('能力');
    expect(tight).not.toContain('生图模型');
    expect(tight).toMatch(/第 \d+\/\d+ 页/);
  });

  it('keeps every line inside the width at any size', () => {
    for (const width of [60, 80, 100]) {
      for (const line of make({ viewportRows: () => 14 }).render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe('ModelSelectorComponent — narrow key hint', () => {
  it('drops the page and thinking hints before it would cut off Enter and Esc', () => {
    const lines = make({ viewportRows: () => 14 }).render(60).map(strip);
    const hint = lines.find((line) => line.includes('Enter')) ?? '';
    expect(hint).toContain('Enter 切换模型');
    expect(hint).toContain('Esc 取消');
    expect(hint).not.toContain('…');
    expect(hint).not.toContain('PgUp');
  });
});

describe('ModelSelectorComponent — models added with /config diy', () => {
  const entry = (provider: string, model: string, displayName: string, capabilities: string[]) =>
    ({ provider, model, displayName, maxContextSize: 1_000_000, capabilities }) as never;
  function diyModels(): Record<string, never> {
    return {
      'my-model-0417': entry('custom-my-model-0417', 'my-model-0417', 'my-model-0417', ['thinking', 'image_in']),
      'my-model:free': entry('custom-my-model-free', 'my-model:free', 'my-model:free', ['thinking']),
      'alpha-1': entry('acme', 'alpha-1', 'Alpha 1', ['thinking']),
    } as Record<string, never>;
  }

  it('shows one short label for the provider instead of the generated id that repeats the model name', () => {
    const text = make({ models: diyModels(), currentValue: 'alpha-1' }).render(100).map(strip);
    const rows = ['my-model-0417', 'my-model:free'].map((name) => text.find((line) => line.includes(name)) ?? '');
    for (const row of rows) {
      expect(row).toContain('diy');
      expect(row).not.toContain('custom-');
    }
    // A provider that is not custom keeps its own name.
    expect(text.find((line) => line.includes('Alpha 1')) ?? '').toContain('acme');
  });

  it('finds the custom models by typing the label', () => {
    const selector = make({ models: diyModels(), currentValue: 'alpha-1' });
    for (const ch of 'diy') selector.handleInput(ch);
    const text = selector.render(100).map(strip).join('\n');
    expect(text).toContain('my-model-0417');
    expect(text).toContain('my-model:free');
    expect(text).not.toContain('Alpha 1');
  });
});

describe('providerDisplayName', () => {
  it('calls every provider made by /config diy the same short name', () => {
    expect(providerDisplayName('custom-my-model-0417')).toBe('diy');
    expect(providerDisplayName('custom-x')).toBe('diy');
  });

  it('leaves other providers as they were', () => {
    expect(providerDisplayName('acme')).toBe('acme');
    expect(providerDisplayName('managed:nimbus')).toBe('nimbus');
  });
});
