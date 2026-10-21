import type { MemoryMemo, MemoryMemoStore, MemoryMemoSummary } from '@scream-code/memory';
import { getLocale, setLocale } from '@scream-code/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryPickerComponent } from '#/tui/components/dialogs/memory-picker';
import { getColorPalette } from '#/tui/theme/colors';

const ESC = String.fromCodePoint(0x1b);
const BACKSPACE = String.fromCodePoint(0x7f);

function stripAnsi(text: string): string {
  return text.replaceAll(/\[[0-?]*[ -/]*[@-~]/g, '');
}

function makeSummary(overrides: Partial<MemoryMemoSummary> = {}): MemoryMemoSummary {
  return {
    id: 'memo-test',
    sourceSessionId: 'session-1234567890',
    sourceSessionTitle: 'Session',
    userNeed: '修复令牌刷新',
    approach: '统一走拦截器',
    outcome: '完成',
    whatFailed: 'none',
    whatWorked: '拦截器自动刷新',
    extractionSource: 'exit',
    recordedAt: Date.now(),
    projectDir: '',
    ...overrides,
  };
}

function makeDetail(summary: MemoryMemoSummary): MemoryMemo {
  return {
    ...summary,
    extractionSource: 'exit',
    projectDir: '',
    tags: undefined,
    note: undefined,
  };
}

interface Harness {
  component: MemoryPickerComponent;
  update: ReturnType<typeof vi.fn>;
}

function makeHarness(
  memos: MemoryMemoSummary[],
  opts: { detail?: MemoryMemo } = {},
): Harness {
  const update = vi.fn(async () => true);
  const store = {
    init: async () => {},
    list: async () => ({ memos, total: memos.length }),
    get: async () => opts.detail,
    update,
  } as unknown as MemoryMemoStore;
  const component = new MemoryPickerComponent({
    store,
    memos,
    total: memos.length,
    loading: false,
    colors: getColorPalette('dark'),
    onCancel: vi.fn(),
    onInject: vi.fn(),
  });
  return { component, update };
}

function makeComponent(
  memos: MemoryMemoSummary[],
  opts: { detail?: MemoryMemo } = {},
): MemoryPickerComponent {
  return makeHarness(memos, opts).component;
}

const detailHint = 'e 编辑';

describe('MemoryPickerComponent — latest distillation', () => {
  let originalLocale: ReturnType<typeof getLocale>;

  beforeEach(() => {
    originalLocale = getLocale();
    setLocale('zh');
  });

  afterEach(() => {
    setLocale(originalLocale);
  });

  it('renders the distillation line on the card when present', () => {
    const component = makeComponent([
      makeSummary({ distilled: '刷新令牌统一走拦截器，不要在页面手动重试' }),
    ]);
    const output = stripAnsi(component.render(120).join('\n'));
    expect(output).toContain('修复令牌刷新');
    expect(output).toContain('最新归纳: 刷新令牌统一走拦截器');
  });

  it('omits the distillation line when the memo has none', () => {
    const component = makeComponent([makeSummary()]);
    const output = stripAnsi(component.render(120).join('\n'));
    expect(output).not.toContain('最新归纳');
  });

  it('renders the distillation block in the detail view', async () => {
    const summary = makeSummary({ distilled: '刷新令牌统一走拦截器' });
    const component = makeComponent([summary], { detail: makeDetail(summary) });

    component.handleInput('\r');
    await vi.waitFor(() => {
      expect(stripAnsi(component.render(120).join('\n'))).toContain(
        '最新归纳: 刷新令牌统一走拦截器',
      );
    });
  });
});

describe('MemoryPickerComponent — rule provenance', () => {
  let originalLocale: ReturnType<typeof getLocale>;

  beforeEach(() => {
    originalLocale = getLocale();
    setLocale('zh');
  });

  afterEach(() => {
    setLocale(originalLocale);
  });

  const lineage = [
    { id: 'memo-a', title: '修复登录', at: Date.now() - 2000 },
    { id: 'memo-b', title: '刷新令牌', at: Date.now() - 1000 },
  ];

  it('labels a dream rule with its origin, time and source count on the card', () => {
    const { component } = makeHarness([
      makeSummary({
        origin: 'dream',
        distilled: '统一走拦截器',
        distilledAt: Date.now() - 3600_000,
        distilledFrom: lineage,
      }),
    ]);
    const output = stripAnsi(component.render(160).join('\n'));
    expect(output).toContain('归纳');
    expect(output).toContain('1 小时前');
    expect(output).toContain('来源 2 条');
    expect(output).not.toContain('退出提取');
  });

  it('labels a user rewrite as 人工归纳', () => {
    const { component } = makeHarness([
      makeSummary({
        origin: 'user',
        distilled: '人工改写的规则',
        distilledAt: Date.now() - 60_000,
        distilledFrom: lineage,
      }),
    ]);
    const output = stripAnsi(component.render(160).join('\n'));
    expect(output).toContain('人工归纳');
    expect(output).toContain('来源 2 条');
  });

  it('keeps the extraction source for a session memo', () => {
    const { component } = makeHarness([makeSummary()]);
    const output = stripAnsi(component.render(160).join('\n'));
    expect(output).toContain('退出提取');
    expect(output).not.toContain('人工归纳');
    expect(output).not.toContain('来源 2 条');
  });

  it('lists at most five source entries in the detail view', async () => {
    const sources = Array.from({ length: 7 }, (_, index) => ({
      id: `source-${index}`,
      title: `来源条目${index}`,
      at: Date.now() - (7 - index) * 86_400_000,
    }));
    const summary = makeSummary({
      origin: 'dream',
      distilled: '统一走拦截器',
      distilledAt: Date.now(),
      distilledFrom: sources,
    });
    const { component } = makeHarness([summary], { detail: makeDetail(summary) });

    component.handleInput('\r');
    await vi.waitFor(() => {
      const output = stripAnsi(component.render(200).join('\n'));
      expect(output).toContain('归纳于');
      expect(output).toContain('来源 7 条');
      expect(output).toContain('来源条目0');
      expect(output).toContain('来源条目4');
      expect(output).not.toContain('来源条目5');
      expect(output).toContain('+2 条');
      expect(output).toContain(detailHint);
    });
  });

  it('shows unknown provenance for a legacy rule without lineage', async () => {
    const summary = makeSummary({ origin: 'dream', distilled: '旧规则' });
    const { component } = makeHarness([summary], { detail: makeDetail(summary) });

    component.handleInput('\r');
    await vi.waitFor(() => {
      const output = stripAnsi(component.render(200).join('\n'));
      expect(output).toContain('归纳时间未知');
      expect(output).toContain('来源未知');
      expect(output).toContain('最新归纳: 旧规则');
    });
  });

  it('warns that deleting a rule is irreversible', () => {
    const { component } = makeHarness([
      makeSummary({ origin: 'dream', distilled: '统一走拦截器', distilledAt: Date.now() }),
    ]);
    component.handleInput('d');
    const output = stripAnsi(component.render(160).join('\n'));
    expect(output).toContain('这是归纳结果，原始条目已删除，删除后无法恢复');
  });

  it('warns when a batch selection includes a rule', () => {
    const { component } = makeHarness([
      makeSummary({ id: 'rule-1', origin: 'dream', distilled: '规则', distilledAt: Date.now() }),
      makeSummary({ id: 'raw-1' }),
    ]);
    component.handleInput('a');
    component.handleInput('d');
    const output = stripAnsi(component.render(160).join('\n'));
    expect(output).toContain('这是归纳结果，原始条目已删除，删除后无法恢复');
  });

  it('does not show the irreversible warning for a session memo', () => {
    const { component } = makeHarness([makeSummary()]);
    component.handleInput('d');
    const output = stripAnsi(component.render(160).join('\n'));
    expect(output).toContain('按 Enter 确认删除');
    expect(output).not.toContain('无法恢复');
  });
});

describe('MemoryPickerComponent — editing the latest distillation', () => {
  let originalLocale: ReturnType<typeof getLocale>;

  beforeEach(() => {
    originalLocale = getLocale();
    setLocale('zh');
  });

  afterEach(() => {
    setLocale(originalLocale);
  });

  async function openDetail(component: MemoryPickerComponent): Promise<void> {
    component.handleInput('\r');
    await vi.waitFor(() => {
      expect(stripAnsi(component.render(160).join('\n'))).toContain(detailHint);
    });
  }

  it('saves typed text as a user-authored rule', async () => {
    const summary = makeSummary();
    const { component, update } = makeHarness([summary], { detail: makeDetail(summary) });

    await openDetail(component);
    component.handleInput('e');
    expect(stripAnsi(component.render(160).join('\n'))).toContain('Enter 保存');

    for (const ch of '刷新令牌统一走拦截器') component.handleInput(ch);
    component.handleInput('\r');

    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledTimes(1);
    });
    expect(update).toHaveBeenCalledWith('memo-test', {
      distilled: '刷新令牌统一走拦截器',
      origin: 'user',
      distilledAt: expect.any(Number),
    });
  });

  it('clears the conclusion back to a session memo', async () => {
    const summary = makeSummary({
      origin: 'dream',
      distilled: '旧规则',
      distilledAt: Date.now(),
      distilledFrom: [{ id: 'a', title: '旧经历 A', at: 1 }],
    });
    const { component, update } = makeHarness([summary], { detail: makeDetail(summary) });

    await openDetail(component);
    component.handleInput('e');
    component.handleInput(BACKSPACE);
    component.handleInput(BACKSPACE);
    component.handleInput(BACKSPACE);
    component.handleInput('\r');

    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledTimes(1);
    });
    expect(update).toHaveBeenCalledWith('memo-test', {
      distilled: undefined,
      origin: 'session',
      distilledAt: undefined,
    });
    // toHaveBeenCalledWith ignores undefined-valued properties, so assert the
    // lineage is explicitly cleared rather than merely absent.
    const patch = update.mock.calls[0]![1] as Record<string, unknown>;
    expect('distilledFrom' in patch).toBe(true);
    expect(patch['distilledFrom']).toBeUndefined();
  });

  it('keeps the lineage when rewriting an existing rule', async () => {
    const lineage = [{ id: 'a', title: '旧经历 A', at: 1 }];
    const summary = makeSummary({
      origin: 'dream',
      distilled: '旧规则',
      distilledAt: Date.now(),
      distilledFrom: lineage,
    });
    const { component, update } = makeHarness([summary], { detail: makeDetail(summary) });

    await openDetail(component);
    component.handleInput('e');
    for (let i = 0; i < 3; i += 1) component.handleInput(BACKSPACE);
    for (const ch of '新规则') component.handleInput(ch);
    component.handleInput('\r');

    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledTimes(1);
    });
    const patch = update.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch['distilled']).toBe('新规则');
    expect(patch['origin']).toBe('user');
    expect(patch['distilledFrom']).toEqual(lineage);
  });

  it('does not rewrite provenance when Enter saves an unchanged conclusion', async () => {
    const summary = makeSummary({
      origin: 'dream',
      distilled: '原结论',
      distilledAt: 123,
    });
    const { component, update } = makeHarness([summary], { detail: makeDetail(summary) });

    await openDetail(component);
    component.handleInput('e');
    component.handleInput('\r');

    await vi.waitFor(() => {
      expect(stripAnsi(component.render(160).join('\n'))).toContain('e 编辑');
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('cancels the edit with Esc without writing', async () => {
    const summary = makeSummary({ distilled: '原结论' });
    const { component, update } = makeHarness([summary], { detail: makeDetail(summary) });

    await openDetail(component);
    component.handleInput('e');
    component.handleInput('X');
    component.handleInput(ESC);

    expect(update).not.toHaveBeenCalled();
    const output = stripAnsi(component.render(160).join('\n'));
    expect(output).toContain('最新归纳: 原结论');
    expect(output).not.toContain('Enter 保存');
  });
});
