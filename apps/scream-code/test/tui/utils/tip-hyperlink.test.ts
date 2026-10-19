import { describe, expect, it, vi } from 'vitest';

// chalk 在非 TTY 环境会静默丢弃全部 SGR 码；在模块导入前强制开色，
// 使断言稳定于"链接色+下划线"的真实形态（与 TTY 下行为一致）。
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '3';
});

import { composeTipLabel, OFFER_TIP_PROBABILITY, pickTipIndex } from '#/tui/utils/tip-hyperlink';
import { SESSION_TIPS } from '#/tui/constant/scream-tui';

/** Strips OSC 8 wrappers and SGR codes down to the visible text. */
const OSC8_WRAPPERS = /\u001B\]8;;[^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
const SGR_CODES = /\u001B\[[0-9;]*m/g;

function visibleText(line: string): string {
  return line.replaceAll(OSC8_WRAPPERS, '').replaceAll(SGR_CODES, '');
}

describe('composeTipLabel', () => {
  it('首位 offer tip 的域名被包装成 OSC 8 可点击链接（链接色+下划线），可见文本不变', () => {
    // 首位 tip 即投放位：isAd + url 指向自家服务入口
    expect(SESSION_TIPS[0]).toMatchObject({ isAd: true, url: 'https://todapi.work' });
    const raw = '💡 Tips：部分模型低至1折起，一个API搞定！todapi.work 【Ctrl+B 关闭 Tips】';
    const out = composeTipLabel(raw, SESSION_TIPS[0]!, '#6a9ffc');

    expect(out).toContain('\u001B]8;;https://todapi.work\u0007'); // open（BEL 结尾）
    expect(out).toContain('\u001B]8;;\u0007'); // close
    expect(out).toContain('\u001B[4m'); // underline → 亮色链接语义
    expect(visibleText(out)).toBe(raw); // 可见宽度/字符与原文完全一致
  });

  it('无 url 的 tip 原样返回（功能 tips 不受影响）', () => {
    const plainTip = { i18nKey: 'editor.tip_1', isAd: false };
    expect(composeTipLabel('plain text', plainTip, '#ffffff')).toBe('plain text');
  });

  it('有 url 但文中不提域名 → 原样返回（GitHub tip 不做内联链接）', () => {
    const gitHubTip = { i18nKey: 'editor.tip_ad', isAd: true, url: 'https://github.com/LIUTod/scream-code' };
    const raw = '欢迎在 GitHub 上反馈或点个星标';
    expect(composeTipLabel(raw, gitHubTip, '#ffffff')).toBe(raw);
  });

  it('轮播池契约：全部 tip 唯一；两条广告（offer + 反馈）都响应 Ctrl+F', () => {
    expect(new Set(SESSION_TIPS.map((tip) => tip.i18nKey)).size).toBe(SESSION_TIPS.length);
    const ads = SESSION_TIPS.filter((tip) => tip.isAd);
    expect(ads.map((tip) => tip.url)).toEqual(['https://todapi.work', 'https://github.com/LIUTod/scream-code']);
    expect(SESSION_TIPS.every((tip) => tip.i18nKey.length > 0)).toBe(true);
  });
});

describe('pickTipIndex（广告加权轮播）', () => {
  const tips = SESSION_TIPS; // 16 条；offer = index 0
  const OFFER = 0;

  it('roll 在 0.8 内 → 恒选 offer（无论当前条是什么，允许重复保持广告位）', () => {
    for (const value of [0.0, 0.5, 0.79, 0.7999]) {
      for (const current of [3, OFFER, tips.length - 1]) {
        vi.spyOn(Math, 'random').mockReturnValueOnce(value).mockReturnValue(0.5);
        expect(pickTipIndex(tips, current)).toBe(OFFER);
        vi.restoreAllMocks();
      }
    }
  });

  it('roll ≥ 0.8 → 均匀池（可含另一条 ad，但永不等于当前条）', () => {
    for (const current of [5, OFFER, tips.length - 1]) {
      const uniformIndex = (current + 1) % tips.length;
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.8)
        .mockReturnValueOnce((uniformIndex + 0.5) / tips.length);
      expect(pickTipIndex(tips, current)).toBe(uniformIndex);
      vi.restoreAllMocks();
    }
  });

  it('统计面：大量轮换中 offer 占比 ≈ 80%', () => {
    // 用固定种子的 LCG 代替真随机：断言仍然检验权重行为，但结果完全可复现，
    // 不会像 ±3σ 的随机采样那样在多次全量运行中偶发越界（flake）。
    let seed = 123456789;
    const lcg = (): number => {
      seed = (1664525 * seed + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const spy = vi.spyOn(Math, 'random').mockImplementation(lcg);
    try {
      const rounds = 4000;
      let offerHits = 0;
      let current: number | undefined = undefined;
      for (let i = 0; i < rounds; i++) {
        const next = pickTipIndex(tips, current);
        if (next === OFFER) offerHits += 1;
        current = next;
      }
      const rate = offerHits / rounds;
      expect(rate).toBeGreaterThan(0.78);
      expect(rate).toBeLessThan(0.82);
    } finally {
      spy.mockRestore();
    }
  });

  it('单条池防死循环：返回唯一索引', () => {
    expect(pickTipIndex([{ i18nKey: 'x', isAd: false }], 0)).toBe(0);
    expect(pickTipIndex([{ i18nKey: 'x', isAd: false }], undefined)).toBe(0);
  });
});
