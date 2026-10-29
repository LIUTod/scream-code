import { describe, expect, it } from 'vitest';

import {
  MAX_REPLY_CHARS,
  buildReplyContent,
  buildTextJSON,
  containsMarkdown,
  preprocessFeishuMarkdown,
  sanitizeMarkdownURLs,
  truncateForLine,
} from '#/line/feishu/format';

describe('containsMarkdown (markdown markers)', () => {
  it('detects fences, bold, lists, headings and rules', () => {
    expect(containsMarkdown('plain text')).toBe(false);
    expect(containsMarkdown('code:\n```ts\nx\n```')).toBe(true);
    expect(containsMarkdown('**bold**')).toBe(true);
    expect(containsMarkdown('~~strike~~')).toBe(true);
    expect(containsMarkdown('inline `code`')).toBe(true);
    expect(containsMarkdown('list:\n- a')).toBe(true);
    expect(containsMarkdown('list:\n* a')).toBe(true);
    expect(containsMarkdown('list:\n1. a')).toBe(true);
    // The heading indicator is "\n# " — a heading at the
    // very start of the string is NOT detected (no leading newline).
    expect(containsMarkdown('# heading')).toBe(false);
    expect(containsMarkdown('x\n# heading')).toBe(true);
    expect(containsMarkdown('---')).toBe(true);
  });
});

describe('preprocessFeishuMarkdown (code fence newline guard)', () => {
  it('inserts a newline before an inline-starting fence', () => {
    expect(preprocessFeishuMarkdown('text```ts')).toBe('text\n```ts');
    expect(preprocessFeishuMarkdown('text\n```ts')).toBe('text\n```ts');
    expect(preprocessFeishuMarkdown('```ts')).toBe('```ts');
  });
});

describe('sanitizeMarkdownURLs (Feishu 230001 guard)', () => {
  it('keeps http(s) links and rewrites other schemes to plain text', () => {
    expect(sanitizeMarkdownURLs('[a](https://x.com)')).toBe('[a](https://x.com)');
    expect(sanitizeMarkdownURLs('[a](http://x.com)')).toBe('[a](http://x.com)');
    expect(sanitizeMarkdownURLs('[a](ftp://x.com)')).toBe('a (ftp://x.com)');
    expect(sanitizeMarkdownURLs('[a](javascript:alert(1))')).toBe('a (javascript:alert(1))');
  });

  it('leaves native card-image syntax alone', () => {
    expect(sanitizeMarkdownURLs('![alt](img_v3_xxx)')).toBe('![alt](img_v3_xxx)');
  });

  it('returns the input untouched when nothing matches', () => {
    expect(sanitizeMarkdownURLs('no links here')).toBe('no links here');
  });
});

describe('buildReplyContent (P1: post-md for markdown)', () => {
  it('sends plain content as a text message', () => {
    const out = buildReplyContent('hello');
    expect(out.msgType).toBe('text');
    expect(JSON.parse(out.body)).toEqual({ text: 'hello' });
  });

  it('sends markdown content as a post message with the md tag', () => {
    const out = buildReplyContent('# Title\n\n- item');
    expect(out.msgType).toBe('post');
    const body = JSON.parse(out.body) as { zh_cn: { content: Array<Array<{ tag: string; text: string }>> } };
    expect(body.zh_cn.content[0]?.[0]?.tag).toBe('md');
    expect(body.zh_cn.content[0]?.[0]?.text).toContain('# Title');
  });

  it('forces plain text when a resolved mention is present', () => {
    const out = buildReplyContent('**bold** <at user_id=u1></at>');
    expect(out.msgType).toBe('text');
  });

  it('sanitizes URLs inside markdown before sending', () => {
    const out = buildReplyContent('**bold** [link](ftp://x)');
    expect(out.msgType).toBe('post');
    // The link syntax is stripped (Feishu would reject a non-http scheme);
    // the target stays visible as plain text, keeping legacy behavior.
    expect(out.body).not.toContain('](ftp://x)');
    expect(out.body).toContain('link (ftp://x)');
  });
});

describe('truncateForLine', () => {
  it('passes short content through unchanged', () => {
    expect(truncateForLine('short')).toBe('short');
  });

  it('cuts long content and appends a notice', () => {
    const long = 'x'.repeat(MAX_REPLY_CHARS + 10);
    const out = truncateForLine(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain('已截断');
  });
});

describe('buildTextJSON', () => {
  it('wraps plain notices', () => {
    expect(JSON.parse(buildTextJSON('hi'))).toEqual({ text: 'hi' });
  });
});
