import { describe, expect, it } from 'vitest';

import {
  MESSAGE_ITEM_TEXT,
  MAX_WEIXIN_CHUNK,
  bodyFromItemList,
  splitMessageCodeFenceAware,
  type IlinkMessageItem,
} from '#/line/weixin/format';

describe('bodyFromItemList (text/ref/voice extraction)', () => {
  it('extracts the first non-empty text item', () => {
    const items: IlinkMessageItem[] = [
      { type: MESSAGE_ITEM_TEXT, text_item: { text: '' } },
      { type: MESSAGE_ITEM_TEXT, text_item: { text: '  hello  ' } },
    ];
    expect(bodyFromItemList(items)).toBe('hello');
  });

  it('renders quoted references as [引用: title | body]', () => {
    const items: IlinkMessageItem[] = [
      {
        type: MESSAGE_ITEM_TEXT,
        text_item: { text: 'my answer' },
        ref_msg: {
          title: 'quoted title',
          message_item: { type: MESSAGE_ITEM_TEXT, text_item: { text: 'quoted body' } },
        },
      },
    ];
    expect(bodyFromItemList(items)).toBe('[引用: quoted title | quoted body]\nmy answer');
  });

  it('uses the caption alone when quoting a media message', () => {
    const items: IlinkMessageItem[] = [
      {
        type: MESSAGE_ITEM_TEXT,
        text_item: { text: 'caption' },
        ref_msg: { title: 'photo.png', message_item: { type: 2 } }, // image
      },
    ];
    expect(bodyFromItemList(items)).toBe('caption');
  });

  it('falls back to voice ASR text', () => {
    const items: IlinkMessageItem[] = [
      { type: 3, voice_item: { text: '语音转写内容' } },
    ];
    expect(bodyFromItemList(items)).toBe('语音转写内容');
  });

  it('returns empty for items without text or ASR', () => {
    expect(bodyFromItemList([{ type: MESSAGE_ITEM_TEXT }])).toBe('');
    expect(bodyFromItemList([])).toBe('');
    expect(bodyFromItemList(undefined)).toBe('');
  });
});

describe('splitMessageCodeFenceAware', () => {
  it('passes short content through as a single chunk', () => {
    expect(splitMessageCodeFenceAware('hello')).toEqual(['hello']);
    expect(splitMessageCodeFenceAware('')).toEqual([]);
  });

  it('splits long content at line boundaries', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(20)}`);
    const content = lines.join('\n');
    const chunks = splitMessageCodeFenceAware(content);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_WEIXIN_CHUNK);
    }
    // Reassembling (minus fence padding) preserves every line.
    const rejoined = chunks.join('\n').replaceAll('\n```', '').replaceAll('```\n', '');
    for (const line of lines) {
      expect(rejoined).toContain(line);
    }
  });

  it('keeps code fences balanced across chunks', () => {
    const codeLines = Array.from({ length: 600 }, (_, i) => `code ${i}`);
    const content = `look:\n\`\`\`ts\n${codeLines.join('\n')}\n\`\`\`\ndone`;
    const chunks = splitMessageCodeFenceAware(content);
    expect(chunks.length).toBeGreaterThan(1);
    let open = 0;
    for (const chunk of chunks) {
      for (const line of chunk.split('\n')) {
        if (line.startsWith('```')) open++;
      }
      // Every chunk must be fence-balanced on its own.
      expect(open % 2).toBe(0);
    }
  });

  it('hard-splits a single oversized line', () => {
    const content = 'y'.repeat(MAX_WEIXIN_CHUNK + 500);
    const chunks = splitMessageCodeFenceAware(content);
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.length).toBe(MAX_WEIXIN_CHUNK);
  });
});
