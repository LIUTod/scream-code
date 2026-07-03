import { describe, expect, it } from 'vitest';

import { chunkMarkdown, estimateTokens, stripMarkdown } from '../src/chunking.js';

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
