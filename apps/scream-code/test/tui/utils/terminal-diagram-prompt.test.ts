/**
 * terminal-diagram-prompt.test.ts — 对模型的能力声明是否属实、是否放权。
 *
 * 两类断言：
 * 一是**属实** —— 提示点名的能力拿真绘图器逐类验证，声明的方向规则也要实测，
 * 否则提示会慢慢变成谎话。
 * 二是**放权** —— 提示只该管"有没有这个能力、怎么画好、什么样式适配终端"，
 * "何时画"交回模型判断。
 *
 * 第二组是被真实使用教出来的两课：只写规格说明，模型读成"一堆会失败的地方"，于是一张
 * 都不画；写了七条枚举，模型读成"只有这些才许画"，于是开始删减讲解并回头问要不要重画
 * 一张合规的。所以这里锁的是"不许再退回那两种写法"。
 */

import { render } from 'grok-mermaid';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  describesDiagramRendering,
  diagramCapabilityPrompt,
  syncDiagramCapabilityPrompt,
} from '#/tui/utils/terminal-diagram-prompt';
import { setMermaidDisplay } from '#/tui/utils/ui-preferences';

const NL = '\n';

/** Smallest source of each shape that should be drawable. */
const SHAPE_SOURCES: Record<string, string> = {
  flowchart: ['flowchart TD', '  A[a] --> B[b]'].join(NL),
  graph: ['graph LR', '  A[a] --> B[b]'].join(NL),
  subgraph: ['flowchart LR', '  subgraph 前端', '    A[a] --> B[b]', '  end', '  B --> C[c]'].join(NL),
  sequenceDiagram: ['sequenceDiagram', '  A->>B: 消息'].join(NL),
  stateDiagram: ['stateDiagram-v2', '  [*] --> Idle', '  Idle --> [*]'].join(NL),
  classDiagram: ['classDiagram', '  Animal <|-- Dog'].join(NL),
  erDiagram: ['erDiagram', '  A ||--o{ B : has'].join(NL),
};

/** Shapes the prompt promises are *not* drawn; each must genuinely be refused. */
const UNDRAWN_SHAPES: Record<string, string> = {
  mindmap: ['mindmap', '  root((计划))', '    甲'].join(NL),
  gantt: ['gantt', '  title 排期', '  section 一期', '  设计 :a1, 2026-01-01, 7d'].join(NL),
  pie: ['pie', '  "甲" : 40', '  "乙" : 60'].join(NL),
};

/** The note as the model receives it, wrapping collapsed for one-line reads. */
const flat = (): string => diagramCapabilityPrompt().replaceAll(/\s+/g, ' ');

function graph(dir: string, nodes: number): string {
  const lines = [`flowchart ${dir}`, '  A[开始] --> B{判断?}'];
  lines.push('  B -->|是| C[做]', '  B -->|否| D[不做]', '  D --> C');
  if (nodes >= 6) lines.push('  C --> E{全绿?}', '  E -->|是| F[提交]', '  E -->|否| G[修]', '  G --> C');
  return lines.join('\n');
}

function rowCount(dir: string, nodes: number): number {
  const art = render(graph(dir, nodes));
  if (!art) throw new Error(`fixture ${dir}/${nodes} stopped rendering`);
  return art.plain.length;
}

describe('能力声明属实', () => {
  it('提示点名的每一类图形确实画得出来', () => {
    for (const [shape, source] of Object.entries(SHAPE_SOURCES)) {
      expect(render(source), `${shape} 应可绘制`).not.toBeNull();
      expect(diagramCapabilityPrompt()).toContain(shape);
    }
  });

  it('提示声明画不出来的类型确实画不出来', () => {
    for (const [shape, source] of Object.entries(UNDRAWN_SHAPES)) {
      expect(render(source), `${shape} 应被拒绝`).toBeNull();
      expect(diagramCapabilityPrompt()).toContain(shape);
    }
  });

  it('说了超宽会退回源码', () => {
    expect(flat()).toMatch(/cannot be scaled or wrapped/i);
    expect(flat()).toMatch(/falls back to showing its own source/i);
  });

  /**
   * The note makes a quantitative claim — horizontal comes out several times
   * shorter than top-down for the same graph. Checked against the renderer so it
   * cannot rot into a lie if the layout engine changes.
   */
  it('提示里"横向矮得多"这个说法是真的', () => {
    for (const nodes of [4, 6]) {
      const tall = rowCount('TD', nodes);
      const wide = rowCount('LR', nodes);
      expect(wide).toBeLessThan(tall);
      expect(tall / wide).toBeGreaterThanOrEqual(3);
    }
    expect(flat()).toMatch(/three to four times shorter/);
  });

  it('把渲染范围限定在给用户的回复，不诱导子代理白画', () => {
    expect(flat()).toMatch(/What gets drawn is the answer shown to the user/);
    expect(flat()).toMatch(/subagent's report|tool result/);
    expect(flat()).toMatch(/is not rendered anywhere/);
  });
});

describe('只定用法与样式，把"何时画"交回模型', () => {
  it('给出一个判断总则，而不是一串准入条件', () => {
    expect(flat()).toMatch(/## When to draw — this part is your judgement/);
    expect(flat()).toMatch(/would the reader understand this faster from a picture/);
  });

  it('明说下面的场景只是例证，不是许可清单', () => {
    expect(flat()).toMatch(/Nothing below narrows that test/);
    expect(flat()).toMatch(/not a set of permitted cases/);
    expect(flat()).toMatch(/Illustrations, not a checklist/);
  });

  it('场景例子覆盖到非结构类的解释（竞态、机制形状、走查）', () => {
    expect(flat()).toMatch(/A race or an interleaving/);
    expect(flat()).toMatch(/The shape of a mechanism/);
    expect(flat()).toMatch(/before\/after or two-option comparison/);
    expect(flat()).toMatch(/A walkthrough/);
  });

  it('管住了该管的：怎么画好', () => {
    expect(flat()).toMatch(/One diagram, one idea/);
    expect(flat()).toMatch(/picture carries structure/);
    expect(flat()).toMatch(/prose carries judgement/);
    expect(flat()).toMatch(/Do not narrate a diagram line by line/);
    expect(flat()).toMatch(/Draw when it earns its place/);
  });

  it('统一规则是"并排不超过五块"，且划清了与内容配额的界限', () => {
    expect(flat()).toMatch(/never\s+put more than five blocks side by side/i);
    // 实测代价必须点明"六块已经越界"，否则 74 列那个例子会被读成允许六块
    expect(flat()).toMatch(/five is the limit and six is\s+already over it/);
    expect(flat()).toMatch(/a `TD` chain may carry ten nodes happily/);
    // 形状规则不得被写成节点总数上限
    expect(flat()).not.toMatch(/no more than \d+ nodes|at most \d+ nodes|six nodes or fewer/);
  });

  /**
   * The rule is stated with measured column counts, and the whole point of the
   * number five is that both directions cap out near 60 columns. If the layout
   * engine ever changes, these assertions fail rather than the advice silently
   * becoming wrong.
   */
  it('提示里引用的列数都是真的', () => {
    const chain = (dir: string, blocks: number) => {
      const ids = Array.from({ length: blocks }, (_, i) => String.fromCodePoint(65 + i));
      const lines = [`flowchart ${dir}`];
      for (let i = 0; i < blocks - 1; i += 1) {
        lines.push(`  ${ids[i]}[步骤${i + 1}] --> ${ids[i + 1]}[步骤${i + 2}]`);
      }
      return lines.join('\n');
    };
    const widthOf = (src: string): number => {
      const art = render(src);
      if (!art) throw new Error('fixture stopped rendering');
      return art.width;
    };

    // LR：整条链并排 → 35 / 48 / 61 / 74
    for (const [blocks, expected] of [[3, 35], [4, 48], [5, 61], [6, 74]] as const) {
      expect(widthOf(chain('LR', blocks)), `LR ${blocks} 块宽度`).toBe(expected);
    }
    // TD：直线链恒为 10 列，多长都一样
    for (const blocks of [3, 8]) {
      expect(widthOf(chain('TD', blocks)), `TD ${blocks} 块宽度`).toBe(10);
    }
    // TD：宽度由最宽层决定 → 五分支 58 列
    const fan = (width: number) =>
      ['flowchart TD', `  root[开始] --> ${Array.from({ length: width }, (_, i) => `n${i}[分支${i + 1}]`).join(' & ')}`].join('\n');
    expect(widthOf(fan(5))).toBe(58);

    // 封顶效果：两个方向的五块都在 60 列上下
    expect(Math.abs(widthOf(chain('LR', 5)) - widthOf(fan(5)))).toBeLessThan(5);
    expect(flat()).toMatch(/61 for five/);
    expect(flat()).toMatch(/already 58/);
  });

  it('不再向模型声称能读到窗口的实时宽度', () => {
    expect(flat()).not.toMatch(/not known to you right now/);
    expect(flat()).not.toMatch(/You have about \d+ columns/);
  });

  /**
   * The note once said two contradictory things about width: "window is the real
   * limit" and "go wider when the content asks". A model cannot act on both, so
   * the fallback path is an explicit ladder with a stated last resort.
   */
  it('装不下时给出明确阶梯，最后一级是照画而不是删内容', () => {
    expect(flat()).toMatch(/### When a frame would not fit/);
    expect(flat()).toMatch(/Work down this ladder and stop at the first rung that fits/);
    expect(flat()).toMatch(/1\. Shorten the labels\./);
    expect(flat()).toMatch(/2\. Switch direction or flatten the fan/);
    expect(flat()).toMatch(/3\. Split it into two or three frames/);
    expect(flat()).toMatch(/4\. Still not enough\? \*\*Draw it too wide\.\*\*/);
    expect(flat()).toMatch(/never on the ladder: cutting content/);
    expect(flat()).toMatch(/Undrawn source is still information/);
  });

  it('超宽的唯一出路是拆分，并明说讲多少由模型定', () => {
    expect(flat()).toMatch(/3\. Split it into two or three frames/);
    expect(flat()).toMatch(/how many diagrams a reply deserves are\s+yours to decide/);
  });

  it('不要求先征求许可，也不要求汇报合规', () => {
    expect(flat()).toMatch(/Do not wait to be asked, do not ask permission/);
    expect(flat()).toMatch(/do not offer to draw something instead of drawing it/);
    expect(flat()).toMatch(/do not report compliance with these rules/);
  });

  it('把漏画定义成失误，而不是把画了定义成冒进', () => {
    expect(flat()).toMatch(/wants it used/i);
    expect(flat()).toMatch(/is the miss to avoid/i);
  });

  it('判断总则排在样式与限制之前', () => {
    const note = diagramCapabilityPrompt();
    const test = note.search(/## When to draw/);
    const style = note.search(/## Style/);
    const limits = note.search(/## Shapes that render/);
    expect(test).toBeGreaterThan(-1);
    expect(style).toBeGreaterThan(-1);
    expect(test).toBeLessThan(style);
    expect(style).toBeLessThan(limits);
  });
});

describe('syncDiagramCapabilityPrompt', () => {
  afterEach(() => {
    setMermaidDisplay('on');
  });

  it('会绘图时声明能力，关掉时撤回', async () => {
    const calls: string[] = [];
    const session = {
      setRuntimeSystemPrompt: vi.fn(async (prompt: { append?: string }) => {
        calls.push(prompt.append ?? '');
      }),
    };

    setMermaidDisplay('on');
    expect(describesDiagramRendering()).toBe(true);
    await syncDiagramCapabilityPrompt(session);
    expect(calls.at(-1)).toBe(diagramCapabilityPrompt());

    setMermaidDisplay('ascii');
    await syncDiagramCapabilityPrompt(session);
    expect(calls.at(-1)).toBe(diagramCapabilityPrompt());

    setMermaidDisplay('off');
    expect(describesDiagramRendering()).toBe(false);
    await syncDiagramCapabilityPrompt(session);
    expect(calls.at(-1)).toBe('');
  });

  it('没有会话时什么都不做', async () => {
    await expect(syncDiagramCapabilityPrompt(null)).resolves.toBeUndefined();
    await expect(syncDiagramCapabilityPrompt(undefined)).resolves.toBeUndefined();
  });

  it('会话拒绝设置也不能把调用方带崩', async () => {
    const failing = {
      setRuntimeSystemPrompt: vi.fn(async () => {
        throw new Error('session closed');
      }),
    };
    await expect(syncDiagramCapabilityPrompt(failing as never)).resolves.toBeUndefined();
    expect(failing.setRuntimeSystemPrompt).toHaveBeenCalled();
  });
});