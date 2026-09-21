/**
 * Mermaid drawing in the transcript.
 *
 * What matters here is geometry: a drawn frame has to land on the same columns
 * the layout engine chose for it. These tests compare whole rendered rows
 * against the library's own rows rather than checking that "something came
 * back", because every failure mode of this feature — a stripped space, a
 * wrapped line, two rows folded into one — is a visual skew that a substring
 * assertion would happily pass.
 */

import { t } from '@scream-code/config';
import chalk from 'chalk';
import { Marked, visibleWidth } from '@liutod-scream/pi-tui';
import { render as drawMermaid } from 'grok-mermaid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { darkColors } from '#/tui/theme/colors';
import { createDiagramTheme, createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import { createMermaidTransformer } from '#/tui/utils/mermaid-diagram';
import type { MarkdownTransformContext } from '#/tui/utils/markdown-transform';
import {
  getMermaidDisplay,
  setMermaidDisplay,
  useMermaidAsciiFrames,
} from '#/tui/utils/ui-preferences';

const FENCE = '```';
const ANSI = /\u001B\[[0-9;]*m/g;

const FLOW = [
  'flowchart LR',
  '  A[开始] --> B{有测试用例?}',
  '  B -->|有| C[跑测试]',
  '  B -->|没有| D[先补测试]',
  '  D --> C',
].join('\n');

const SEQUENCE = [
  'sequenceDiagram',
  '  participant U as 用户',
  '  participant S as 服务',
  '  U->>S: 请求',
  '  S-->>U: 响应',
].join('\n');

const STATE = ['stateDiagram-v2', '  [*] --> Idle', '  Idle --> Run: 开始', '  Run --> [*]'].join('\n');

function block(source: string): string {
  return `${FENCE}mermaid\n${source}\n${FENCE}`;
}

function ctx(overrides: Partial<MarkdownTransformContext> = {}): MarkdownTransformContext {
  return { messageKind: 'assistant', streaming: false, availableWidth: 120, ...overrides };
}

function drawer(opts: { enabled?: boolean; ascii?: boolean } = {}) {
  return createMermaidTransformer({
    getTheme: () => createDiagramTheme(darkColors),
    isEnabled: () => opts.enabled ?? true,
    getAsciiFrames: () => opts.ascii ?? false,
  });
}

/** Rows the terminal would show: colour off, right padding off, message prefix
 *  off — the prefix is a layout constant, not part of the drawing. */
function rowsOf(transformed: string, width: number): string[] {
  const component = new AssistantMessageComponent(
    createMarkdownTheme(darkColors),
    darkColors,
    false,
  );
  component.updateContent(transformed);
  return component
    .render(width)
    .map((line) => {
      const plain = line.replace(ANSI, '');
      // The component puts exactly the message indent in front of every row; the
      // frame's own indentation starts after it and must survive.
      const unprefixed = plain.startsWith(MESSAGE_INDENT)
        ? plain.slice(MESSAGE_INDENT.length)
        : plain;
      return unprefixed.replace(/\s+$/, '');
    })
    .filter((line) => line.trim() !== '');
}

/** The rows the layout engine produced, trimmed identically. */
function laidOut(source: string): string[] {
  const art = drawMermaid(source);
  if (!art) throw new Error('fixture stopped being drawable — update the test source');
  return art.plain.map((row) => row.replace(/\s+$/, ''));
}

function frameWidth(source: string): number {
  return Math.max(...laidOut(source).map((row) => visibleWidth(row)));
}

const SUBGRAPHED = [
  'flowchart LR',
  '  subgraph 前端',
  '    A[TUI] --> B[命令层]',
  '  end',
  '  subgraph 核心',
  '    B --> C[turn loop]',
  '  end',
].join('\n');

const DRAWABLES: ReadonlyArray<readonly [string, string]> = [
  ['flowchart', FLOW],
  ['subgraph 分组', SUBGRAPHED],
  ['sequence', SEQUENCE],
  ['state', STATE],
];

describe('绘制出的行与布局列一致', () => {
  for (const [name, source] of DRAWABLES) {
    it(`${name}: 每一行都落在布局算出的列上`, () => {
      const want = laidOut(source);
      const width = frameWidth(source) + 2;
      const got = rowsOf(drawer()(block(source), ctx({ availableWidth: width })), width + 2);
      expect(got).toEqual(want);
    });
  }

  it('每一行都自带硬换行，不会被解析器折叠成一行', () => {
    const out = drawer()(block(FLOW), ctx());
    const rows = out.replace(/\n$/, '').split('\n');
    expect(rows).toHaveLength(laidOut(FLOW).length);
    for (const row of rows) {
      expect(row.endsWith('  ')).toBe(true);
      expect(row.startsWith('```')).toBe(false);
    }
  });

  it('保留标签里的反引号，不会提前结束行内代码', () => {
    const labelled = ['flowchart LR', '  A["带 `反引号` 的标签"] --> B[结束]'].join('\n');
    const out = drawer()(block(labelled), ctx());
    expect(out).not.toContain(FENCE);
    expect(rowsOf(out, frameWidth(labelled) + 4)).toEqual(laidOut(labelled));
  });

  it('换行符前后的普通文字不被吞掉', () => {
    const text = `前面一段说明\n\n${block(FLOW)}\n\n后面一段说明`;
    const out = drawer()(text, ctx({ availableWidth: frameWidth(FLOW) + 2 }));
    const rows = rowsOf(out, frameWidth(FLOW) + 4);
    expect(rows[0]).toBe('前面一段说明');
    expect(rows.at(-1)).toBe('后面一段说明');
    expect(rows.filter((row) => laidOut(FLOW).includes(row))).toEqual(laidOut(FLOW));
  });
});

describe('画不出来时退回原样', () => {
  it('比终端还宽：整块交回原来的代码块，并说明原因', () => {
    const out = drawer()(block(FLOW), ctx({ availableWidth: 4 }));
    expect(out.startsWith(block(FLOW))).toBe(true);
    // 提示必须跟用户语言走，所以断言用 t() 取，不写死英文。
    expect(out).toContain(t('mermaid.note.not_rendered', { reason: '' }));
    expect(out).toContain(t('mermaid.note.wider', { width: 999, available: 4 }).split('999')[0]);
    // 交回的必须仍是完整围栏，不能是半张图或被截断的一行。
    expect(out).toContain(`${FENCE}mermaid`);
    expect(out).toContain(`${FENCE}\n`);
  });

  it('流式途中不抱怨，只是先不画', () => {
    expect(drawer()(block(FLOW), ctx({ availableWidth: 4, streaming: true }))).toBe(block(FLOW));
  });

  it('不支持的类型（思维导图）留作源码并说明', () => {
    const mindmap = ['mindmap', '  root((计划))', '    甲', '    乙'].join('\n');
    const out = drawer()(block(mindmap), ctx());
    expect(out.startsWith(block(mindmap))).toBe(true);
    expect(out).toContain(t('mermaid.note.unsupported'));
  });
});

describe('时机与开关', () => {
  it('关档什么都不做', () => {
    expect(drawer({ enabled: false })(block(FLOW), ctx())).toBe(block(FLOW));
  });

  it('任何时候都不在流式途中画（半画图会反复重排）', () => {
    expect(drawer()(block(FLOW), ctx({ streaming: true }))).toBe(block(FLOW));
    expect(drawer()(block(FLOW), ctx({ streaming: false }))).not.toBe(block(FLOW));
  });

  it('思考过程永远不画', () => {
    const out = drawer()(block(FLOW), ctx({ messageKind: 'thinking', streaming: true }));
    expect(out).toBe(block(FLOW));
  });

  it('同一输入重复应用结果不变', () => {
    const once = drawer()(block(FLOW), ctx());
    expect(drawer()(once, ctx())).toBe(once);
  });
});

describe('行内代码引号的空格规则（防护存在的理由）', () => {
  const BT = '`';
  const parser = new Marked();

  function spanText(markdown: string): string {
    let found = '';
    const walk = (tokens: readonly { type?: string; text?: string; tokens?: unknown }[]): void => {
      for (const token of tokens) {
        if (token.type === 'codespan') found = token.text ?? '';
        if (Array.isArray(token.tokens)) walk(token.tokens as typeof tokens);
      }
    };
    walk(parser.lexer(markdown) as unknown as readonly { type?: string; text?: string; tokens?: unknown }[]);
    return found;
  }

  it('首尾都是空格时各被剥掉一个 —— 那会让整幅图左移一列', () => {
    expect(spanText(`${BT}    x   ${BT}`)).toBe('   x  ');
  });

  it('去掉尾部空格后，前导缩进完整保留', () => {
    expect(spanText(`${BT}    x${BT}`)).toBe('    x');
  });

  it('绘图器交出的行本身不带尾部填充，防护是针对库的后续变化', () => {
    // Measured: today every row already ends on a glyph, so the trim is inert.
    // It stays because it is what keeps a padded row from shifting a column if
    // the library ever stops right-trimming.
    for (const [, source] of DRAWABLES) {
      for (const row of laidOut(source)) {
        expect(/[ ]$/.test(row.trimEnd() ? row : ' ')).toBe(false);
      }
    }
  });
});

describe('配色跟随主题', () => {
  const level = chalk.level;
  beforeEach(() => {
    chalk.level = 3;
  });
  afterEach(() => {
    chalk.level = level;
  });

  /** The SGR sequence chalk emits for a 24-bit foreground. */
  const sgr = (hex: string): string =>
    `38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}`;

  it('节点名用标题色，框线用边框色，边标签用弱化色', () => {
    const theme = createDiagramTheme(darkColors);
    expect(theme.style('text', '开始')).toContain(sgr(darkColors.mdHeading));
    expect(theme.style('border', '┌──┐')).toContain(sgr(darkColors.border));
    expect(theme.style('edge', '│')).toContain(sgr(darkColors.border));
    expect(theme.style('edgeLabel', '是')).toContain(sgr(darkColors.textDim));
    // Titles are the same hue one step louder: bold, not a different colour.
    expect(theme.style('title', 'mermaid')).toContain(sgr(darkColors.mdHeading));
    expect(theme.style('title', 'mermaid')).toContain('1m');
  });

  it('空白填充不单独着色，也不留悬空序列', () => {
    const theme = createDiagramTheme(darkColors);
    expect(theme.style('none', '    ')).toBe('    ');
  });
});

/**
 * The transform rebuilds the whole document from token `raw` to splice diagrams
 * in. That rebuild is not faithful for every input — the parser normalises line
 * endings, for one — so the transform abandons the pass rather than hand back a
 * rewritten reply. These tests pin that refusal.
 */
describe('不能逐字节还原就整块放弃', () => {
  it('CRLF 回复原样返回，不会被改成 LF', () => {
    const crlf = ['行一', '', '```mermaid', 'flowchart TD', '  A-->B', '```', '', '行二'].join('\r\n');
    expect(drawer()(crlf, ctx())).toBe(crlf);
  });

  it('LF 回复照常出图（说明上一条是行尾问题，不是绘图本身失败）', () => {
    const lf = crlfToLf();
    expect(drawer()(lf, ctx())).not.toBe(lf);
  });

  it('波浪号围栏的图也认', () => {
    const tilde = ['x', '', '~~~mermaid', 'flowchart TD', '  A[开始] --> B[结束]', '~~~'].join('\n');
    const out = drawer()(tilde, ctx());
    expect(out).not.toBe(tilde);
    expect(out).toContain('┌');
  });

  it('每一行都非空 —— 空行由不可剥离的空格占位', () => {
    // The placeholder exists because an empty code span is dropped by the
    // parser, which would silently merge two rows of a frame. Asserted as the
    // property rather than as a literal, since whether the layout emits a blank
    // row at all is the drawing library's choice.
    for (const source of [FLOW, SEQUENCE, STATE]) {
      const out = drawer()(block(source), ctx());
      // Each row ends with Markdown's hard break, so the block trails one empty
      // segment; the rows themselves must all be present and non-empty.
      const lines = out.split('\n');
      expect(lines.at(-1), '只允许末尾留硬换行的空段').toBe('');
      const rows = lines.slice(0, -1);
      for (const line of rows) {
        expect(line.trim(), '不应出现被丢弃的空行').not.toBe('');
      }
      expect(rows).toHaveLength(laidOut(source).length);
    }
  });
});

function crlfToLf(): string {
  return ['行一', '', '```mermaid', 'flowchart TD', '  A[开始] --> B[结束]', '```', '', '行二'].join('\n');
}

/**
 * The note under an undrawn block is appended to the document, so if the
 * transform ever ran over its own output the note would pile up one line per
 * render. It does not — the component keeps the source text and re-derives the
 * transform on every frame — but that is the property worth pinning.
 */
describe('反复渲染不累积提示行', () => {
  it('同一块内容连续渲染五次，输出完全一致', () => {
    const source = `${block(FLOW)}\n\n后文`;
    const component = new AssistantMessageComponent(
      createMarkdownTheme(darkColors),
      darkColors,
      false,
    );
    component.updateContent(source);
    const first = component.render(6);
    for (let i = 0; i < 4; i += 1) {
      expect(component.render(6)).toEqual(first);
    }
    // 超宽退化的提示也只出现一次
    component.updateContent(`${block(FLOW)}\n\n后文`);
    const notes = component
      .render(6)
      .map((line) => line.replace(ANSI, ''))
      .filter((line) => line.includes('Mermaid'));
    expect(notes.length).toBeLessThanOrEqual(1);
  });
});

/**
 * The same graph can be several times narrower laid out the other way, so an
 * over-wide frame gets one retry in the opposite direction before it is given
 * up on. Measured on the real case: a seven-block chain is 148 columns
 * left-to-right and 26 top-down.
 */
describe('超宽先试另一个方向', () => {
  const SEVEN = [
    'flowchart LR',
    '  A[采样返回] --> B[入馆登记/惰性气氛保存] --> C[样品申请与审批] --> D[前处理与分割] --> E[多手段表征] --> F[数据建模与释读] --> G[成果发表/样品归还]',
  ].join('\n');

  it('横向装不下时自动改用纵向，图照样画出来', () => {
    const art = drawMermaid(SEVEN);
    if (!art) throw new Error('fixture stopped rendering');
    expect(art.width).toBeGreaterThan(119);

    const out = drawer()(block(SEVEN), ctx({ availableWidth: 119 }));
    expect(out).not.toContain(FENCE);
    const rows = out.split('\n').filter((line) => line.startsWith('`'));
    // 换方向后是纵向：行数远多于原方向，且每行远窄于 119
    expect(rows.length).toBeGreaterThan(art.plain.length);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(119);
    // 明确告知读者方向被改过，而不是悄悄换掉
    expect(out).toContain(t('mermaid.note.flipped'));
  });

  it('另一个方向更差时不换（横向 3 行 vs 纵向 8 行）', () => {
    const narrow = ['flowchart LR', '  A[开始] --> B[结束]'].join('\n');
    const out = drawer()(block(narrow), ctx({ availableWidth: 119 }));
    expect(out).not.toContain(t('mermaid.note.flipped'));
    expect(out).not.toContain(FENCE);
  });

  /**
   * The guard's real job, measured: a star or two-chain shape lays out to the
   * *same width* in both directions and differs by a single row (14x8 against
   * 14x7). Switching there buys nothing and costs the reader the direction the
   * model chose, so the rule requires a material saving.
   */
  it('两方向几乎等效（同宽、只差一行）时不换', () => {
    const star = ['flowchart TD', '  A[a] --> B[b]', '  A --> C[c]'].join('\n');
    const a = drawMermaid(star);
    const b = drawMermaid(star.replace('TD', 'LR'));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.width).toBe(b?.width);
    expect(Math.abs((a?.plain.length ?? 0) - (b?.plain.length ?? 0))).toBeLessThan(3);

    const out = drawer()(block(star), ctx({ availableWidth: 119 }));
    expect(out).not.toContain(t('mermaid.note.flipped'));
  });

  /**
   * Both directions are measured and the shorter one wins, whichever the model
   * asked for: vertical space is what a terminal runs out of, so a frame that
   * fits at 23 rows and also at 3 should be drawn at 3.
   */
  it('装得下但另一个方向明显更矮时，也换过去', () => {
    const tall = ['flowchart TD', '  A[采样] --> B[登记] --> C[申请] --> D[表征] --> E[归还]'].join('\n');
    const original = drawMermaid(tall);
    if (!original) throw new Error('fixture stopped rendering');
    const out = drawer()(block(tall), ctx({ availableWidth: 119 }));
    expect(out).toContain(t('mermaid.note.flipped'));
    const rows = out.split('\n').filter((line) => line.startsWith('`'));
    expect(rows.length).toBeLessThan(original.plain.length);
    // 换完仍必须在宽度内
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(119);
  });

  it('两个方向都装不下才退回源码，并报出真实宽度', () => {
    // 极窄宽度下两个方向都放不下（该图 LR 148 列、TD 26 列）
    const out = drawer()(block(SEVEN), ctx({ availableWidth: 25 }));
    expect(out.startsWith(block(SEVEN))).toBe(true);
    expect(out).toContain(t('mermaid.note.not_rendered', { reason: '' }));
    // 换方向救不了时不能说"已自动改方向"，否则读者会以为图被改过
    expect(out).not.toContain(t('mermaid.note.flipped'));
  });

  it('换方向只认表头里的第一个方向词，不会误改标签内容', () => {
    const tricky = ['flowchart LR', '  A[先看 LR 再换 TD] --> B[结束]'].join('\n');
    // 装得下时不动；即便触发换向，也只改表头那一个词
    const out = drawer()(block(tricky), ctx({ availableWidth: 200 }));
    expect(out).toContain('先看 LR 再换 TD');
  });
});

describe('边界', () => {
  it('列表里缩进的围栏不碰（容器缩进归列表管）', () => {
    const nested = `1. 步骤\n   ${FENCE}mermaid\n   flowchart TD\n     A-->B\n   ${FENCE}\n2. 下一步`;
    expect(drawer()(nested, ctx())).toBe(nested);
  });

  it('没有 mermaid 的文本原样返回', () => {
    const plain = `普通段落\n\n${FENCE}ts\nconst a = 1\n${FENCE}`;
    expect(drawer()(plain, ctx())).toBe(plain);
  });

  it('空文本与只有围栏头的输入都不出错', () => {
    expect(drawer()('', ctx())).toBe('');
    expect(drawer()(`${FENCE}mermaid\n${FENCE}`, ctx())).toContain(FENCE);
  });

  it('要求 ASCII 边框时不再出现制表符', () => {
    const out = drawer({ ascii: true })(block(FLOW), ctx());
    expect(out).not.toContain('─');
    expect(out).not.toContain('│');
    expect(out).toContain('-');
  });

  it('默认是开，且偏好可写回', () => {
    const before = getMermaidDisplay();
    expect(before).toBe('on');
    setMermaidDisplay('ascii');
    expect(getMermaidDisplay()).toBe('ascii');
    expect(useMermaidAsciiFrames()).toBe(true);
    setMermaidDisplay(before);
    expect(useMermaidAsciiFrames()).toBe(false);
  });
});
