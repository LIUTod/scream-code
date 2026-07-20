/**
 * Covers: SogouSearchProvider, So360SearchProvider, BaiduSearchProvider
 * (domestic-search.ts).
 *
 * Tests the providers with mocked fetch — no real network calls.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  BaiduSearchProvider,
  So360SearchProvider,
  SogouSearchProvider,
} from '../../src/tools/providers/domestic-search';

function providerReturning<T extends new (o: { fetchImpl: typeof fetch }) => InstanceType<T>>(
  Ctor: T,
  html: string,
  status = 200,
): InstanceType<T> {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(html, { status }));
  return new Ctor({ fetchImpl });
}

// ── Sogou ────────────────────────────────────────────────────────────────

describe('SogouSearchProvider', () => {
  const SOGOU_HTML = `<html><body>
    <div class="vrwrap">
      <h3 class="vr-title"><a href="/link?url=abc123">特朗普官宣重大消息</a></h3>
      <p class="str-text">美国总统特朗普今日宣布…</p>
    </div>
    <div class="vrwrap">
      <h3 class="vr-title"><a href="https://news.example.com/direct">直接链接新闻</a></h3>
      <p class="str-text">第二条摘要</p>
    </div>
    <div class="vrwrap">
      <h3 class="vr-title"><a href="https://www.sogou.com/sogou?ie=utf8&amp;query=x">相关搜索</a></h3>
    </div>
  </body></html>`;

  it('has name "sogou"', () => {
    expect(new SogouSearchProvider().name).toBe('sogou');
  });

  it('parses results, prefixes relative redirect links, skips internal links', async () => {
    const p = providerReturning(SogouSearchProvider, SOGOU_HTML);
    const results = await p.search('特朗普');

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: '特朗普官宣重大消息',
      url: 'https://www.sogou.com/link?url=abc123',
      snippet: '美国总统特朗普今日宣布…',
    });
    expect(results[1]?.url).toBe('https://news.example.com/direct');
  });

  it('sends a browser User-Agent and a hard-timeout signal', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html></html>', { status: 200 }));
    const p = new SogouSearchProvider({ fetchImpl });
    await p.search('test');

    const init = fetchImpl.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)['User-Agent']).toContain('Mozilla/5.0');
    expect(init?.signal).toBeDefined();
  });

  it('throws on anti-bot pages', async () => {
    const p = providerReturning(SogouSearchProvider, '<html>antispider 请输入验证码</html>');
    await expect(p.search('test')).rejects.toThrow(/anti-bot/);
  });

  it('throws on HTTP errors', async () => {
    const p = providerReturning(SogouSearchProvider, 'err', 503);
    await expect(p.search('test')).rejects.toThrow(/HTTP 503/);
  });

  it('returns [] for a valid page with no results', async () => {
    const p = providerReturning(SogouSearchProvider, '<html><body>没有找到</body></html>');
    expect(await p.search('test')).toEqual([]);
  });
});

// ── 360 ──────────────────────────────────────────────────────────────────

describe('So360SearchProvider', () => {
  const SO360_HTML = `<html><body>
    <li class="res-list">
      <h3 class="res-title"><a href="https://www.so.com/link?m=xyz">特朗普彻底败诉</a></h3>
      <p class="res-desc">终审落幕，赔付560万美元</p>
    </li>
    <li class="res-list">
      <h3 class="res-title"><a href="https://www.so.com/link?m=xyz">重复 URL</a></h3>
    </li>
  </body></html>`;

  it('has name "360"', () => {
    expect(new So360SearchProvider().name).toBe('360');
  });

  it('parses results and deduplicates URLs', async () => {
    const p = providerReturning(So360SearchProvider, SO360_HTML);
    const results = await p.search('特朗普');

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      title: '特朗普彻底败诉',
      url: 'https://www.so.com/link?m=xyz',
      snippet: '终审落幕，赔付560万美元',
    });
  });

  it('falls back to the title when the block has no snippet', async () => {
    const p = providerReturning(So360SearchProvider, SO360_HTML);
    const results = await p.search('特朗普');
    expect(results[0]?.snippet).not.toBe('');
  });

  it('throws on verification pages', async () => {
    const p = providerReturning(So360SearchProvider, '<html>请完成验证 安全验证</html>');
    await expect(p.search('test')).rejects.toThrow(/anti-bot/);
  });
});

// ── Baidu ────────────────────────────────────────────────────────────────

describe('BaiduSearchProvider', () => {
  const BAIDU_HTML = `<html><body>
    <div class="result c-container">
      <h3 class="t"><a href="http://www.baidu.com/link?url=aaa">唐纳德·特朗普 - 百度百科</a></h3>
      <span class="c-abstract">唐纳德·特朗普，美国第45任总统…</span>
    </div>
    <div class="result c-container">
      <h3 class="t"><a href="http://www.baidu.com/link?url=bbb">特朗普最新发声</a></h3>
    </div>
  </body></html>`;

  it('has name "baidu"', () => {
    expect(new BaiduSearchProvider().name).toBe('baidu');
  });

  it('parses results with baidu redirect URLs kept as-is', async () => {
    const p = providerReturning(BaiduSearchProvider, BAIDU_HTML);
    const results = await p.search('特朗普');

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: '唐纳德·特朗普 - 百度百科',
      url: 'http://www.baidu.com/link?url=aaa',
      snippet: '唐纳德·特朗普，美国第45任总统…',
    });
    // Snippet falls back to the title when absent.
    expect(results[1]?.snippet).toBe('特朗普最新发声');
  });

  it('respects the limit option', async () => {
    const p = providerReturning(BaiduSearchProvider, BAIDU_HTML);
    const results = await p.search('特朗普', { limit: 1 });
    expect(results).toHaveLength(1);
  });

  it('throws on security verification pages', async () => {
    const p = providerReturning(BaiduSearchProvider, '<html>百度安全验证</html>');
    await expect(p.search('test')).rejects.toThrow(/anti-bot/);
  });

  it('propagates network errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNRESET'));
    const p = new BaiduSearchProvider({ fetchImpl });
    await expect(p.search('test')).rejects.toThrow('ECONNRESET');
  });
});
