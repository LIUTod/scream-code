import { describe, expect, it } from 'vitest';

import { chunkMarkdown, estimateTokens, splitLargeSection, stripMarkdown } from '../src/chunking.js';

describe('chunkMarkdown', () => {
  it('returns empty array for empty input', () => {
    expect(chunkMarkdown('')).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(chunkMarkdown('   \n  \n')).toEqual([]);
  });

  it('groups pre-heading content as Introduction', () => {
    const md = [
      'This is the intro.',
      '',
      '## Section A',
      'Body of A.',
    ].join('\n');
    const sections = chunkMarkdown(md);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.heading).toBeNull();
    expect(sections[0]!.content).toContain('This is the intro.');
    expect(sections[1]!.heading).toBe('Section A');
    expect(sections[1]!.content).toContain('Body of A.');
  });

  it('splits each heading into its own section', () => {
    const md = [
      '## A',
      'Body A.',
      '## B',
      'Body B.',
      '### C',
      'Body C.',
    ].join('\n');
    const sections = chunkMarkdown(md);
    expect(sections).toHaveLength(3);
    expect(sections[0]!.heading).toBe('A');
    expect(sections[1]!.heading).toBe('B');
    expect(sections[2]!.heading).toBe('C');
  });

  it('preserves code fence content', () => {
    const md = [
      '## Code',
      '',
      '```ts',
      'const x = 1;',
      '## not a heading inside fence',
      '```',
      '',
      'After fence.',
    ].join('\n');
    const sections = chunkMarkdown(md);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.heading).toBe('Code');
    // The line inside the fence should be in raw content, but stripped from the clean body.
    expect(sections[0]!.rawContent).toContain('## not a heading inside fence');
  });

  it('assigns incremental ranks', () => {
    const md = ['## A', 'a', '## B', 'b', '## C', 'c'].join('\n');
    const sections = chunkMarkdown(md);
    expect(sections.map((s) => s.rank)).toEqual([0, 1, 2]);
  });
});

describe('stripMarkdown', () => {
  it('removes inline code backticks', () => {
    expect(stripMarkdown('Use `npm install` to install.')).toBe('Use npm install to install.');
  });

  it('removes image syntax but keeps alt', () => {
    expect(stripMarkdown('![logo](https://x.com/y.png)')).toBe('logo');
  });

  it('removes link syntax but keeps text', () => {
    expect(stripMarkdown('[click here](https://x.com)')).toBe('click here');
  });

  it('removes bold/italic markers', () => {
    expect(stripMarkdown('**bold** and *italic*')).toBe('bold and italic');
  });

  it('removes heading markers from inline lines', () => {
    expect(stripMarkdown('## Title\nbody')).toBe('Title\nbody');
  });
});

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns ceil(chars/4) for non-empty', () => {
    expect(estimateTokens('hello world!')).toBe(3); // 12 chars / 4 = 3
  });
});

describe('splitLargeSection', () => {
  function makeSection(content: string, heading: string | null = 'H'): {
    heading: string | null;
    headingLevel: number | null;
    content: string;
    rawContent: string;
    rank: number;
  } {
    return { heading, headingLevel: 2, content, rawContent: content, rank: 0 };
  }

  it('returns single section when under the cap', () => {
    const short = makeSection('Short content.');
    const result = splitLargeSection(short);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe('Short content.');
  });

  it('splits a multi-paragraph section at paragraph boundaries', () => {
    // 3 paragraphs of ~300 tokens each — total ~900 tokens, exceeds 480 cap.
    const para = 'word '.repeat(300).trim();
    const section = makeSection(`${para}\n\n${para}\n\n${para}`, 'Big');
    const result = splitLargeSection(section);
    expect(result.length).toBeGreaterThan(1);
    for (const sub of result) {
      expect(estimateTokens(sub.content)).toBeLessThanOrEqual(480);
      expect(sub.heading).toBe('Big');
    }
  });

  it('splits a single long paragraph at sentence boundaries', () => {
    // One paragraph with many sentences, total ~1000 tokens (480+ triggers split).
    const sentence = 'This is a test sentence with enough words to matter. ';
    const section = makeSection(sentence.repeat(40).trim(), 'Long');
    const result = splitLargeSection(section);
    expect(result.length).toBeGreaterThan(1);
    for (const sub of result) {
      expect(estimateTokens(sub.content)).toBeLessThanOrEqual(480);
      expect(sub.heading).toBe('Long');
    }
  });

  it('falls back to character cut for a single giant sentence', () => {
    const giant = 'a'.repeat(4000);
    const section = makeSection(giant, 'Giant');
    const result = splitLargeSection(section);
    expect(result.length).toBeGreaterThan(1);
    for (const sub of result) {
      expect(sub.content.length).toBeLessThanOrEqual(480 * 4);
    }
  });

  it('preserves heading across all sub-sections', () => {
    const para = 'word '.repeat(300).trim();
    const section = makeSection(`${para}\n\n${para}`, 'My Heading');
    const result = splitLargeSection(section);
    expect(result.length).toBeGreaterThan(1);
    for (const sub of result) {
      expect(sub.heading).toBe('My Heading');
      expect(sub.headingLevel).toBe(2);
    }
  });
});

describe('chunkMarkdown integration with splitLargeSection', () => {
  it('splits oversized sections during markdown chunking', () => {
    const longBody = 'word '.repeat(600).trim();
    const md = `## Big Section\n\n${longBody}\n\n## Small\nshort body`;
    const sections = chunkMarkdown(md);
    expect(sections.length).toBeGreaterThanOrEqual(3);
    const bigSubs = sections.filter((s) => s.heading === 'Big Section');
    expect(bigSubs.length).toBeGreaterThan(1);
    for (const sub of bigSubs) {
      expect(estimateTokens(sub.content)).toBeLessThanOrEqual(480);
    }
    const small = sections.find((s) => s.heading === 'Small');
    expect(small).toBeDefined();
    expect(small!.content).toContain('short body');
  });

  it('preserves incremental ranks across split sub-sections', () => {
    const longBody = 'word '.repeat(600).trim();
    const md = `## A\n\n${longBody}\n\n## B\nshort`;
    const sections = chunkMarkdown(md);
    const ranks = sections.map((s) => s.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});
