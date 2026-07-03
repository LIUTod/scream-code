import type { ChunkSection } from './types.js';

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const CODE_FENCE_RE = /^(\s*)(`{3,}|~{3,})/;

/**
 * Split a markdown document into sections using heading_strict strategy:
 * each section begins at a heading and contains all body content until the
 * next heading. Consecutive headings collapse to the lowest-level one as the
 * main heading. Content before the first heading is grouped as "Introduction".
 *
 * Mirrors SAG's `buildHeadingStrictSections`.
 */
export function chunkMarkdown(content: string): ChunkSection[] {
  const lines = content.split('\n');
  const sections: ChunkSection[] = [];

  let buffer: string[] = [];
  let currentHeading: string | null = null;
  let currentLevel: number | null = null;
  let rank = 0;
  let inFence = false;

  const flush = (): void => {
    const raw = buffer.join('\n').trim();
    const heading = currentHeading;
    buffer = [];
    // Skip sections with no body content.
    if (raw.length === 0) return;
    const body = stripMarkdown(raw);
    if (body.length === 0 && heading === null) return;
    sections.push({
      heading,
      headingLevel: currentLevel,
      content: body,
      rawContent: raw,
      rank,
    });
    rank += 1;
  };

  for (const line of lines) {
    const fenceMatch = CODE_FENCE_RE.exec(line);
    if (fenceMatch) {
      inFence = !inFence;
      buffer.push(line);
      continue;
    }
    if (inFence) {
      buffer.push(line);
      continue;
    }

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      // Flush whatever is buffered under the previous heading (if any).
      flush();
      currentHeading = headingMatch[2]!.trim();
      currentLevel = headingMatch[1]!.length;
    } else {
      buffer.push(line);
    }
  }
  flush();

  return sections;
}

/**
 * Strip markdown decorations that hurt embedding quality:
 * code fences, inline code, images, links, emphasis markers.
 *
 * Mirrors SAG's `stripMarkdown`.
 */
export function stripMarkdown(text: string): string {
  return text
    // Remove code fences but keep their content
    .replaceAll(/^(\s*)```[^\n]*$\n?/gm, '$1')
    .replaceAll(/^(\s*)```[^\n]*$/gm, '')
    // Remove inline code backticks
    .replaceAll(/`([^`]+)`/g, '$1')
    // Remove images: ![alt](url)
    .replaceAll(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // Remove links: [text](url) → text
    .replaceAll(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove emphasis: **bold**, __bold__, *italic*, _italic_
    .replaceAll(/\*\*([^*]+)\*\*/g, '$1')
    .replaceAll(/__([^_]+)__/g, '$1')
    .replaceAll(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1')
    .replaceAll(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1')
    // Remove heading markers from inline text
    .replaceAll(/^#{1,6}\s+/gm, '')
    // Collapse 3+ blank lines to 2
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split a plain text file into chunks by blank-line paragraphs.
 * Each non-empty paragraph becomes one chunk with no heading.
 * Long paragraphs are split at sentence boundaries to avoid huge chunks.
 */
export function chunkText(content: string): ChunkSection[] {
  const MAX_PARA_TOKENS = 800;
  const MAX_PARA_CHARS = MAX_PARA_TOKENS * 4;

  const paragraphs = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const sections: ChunkSection[] = [];
  let rank = 0;

  for (const para of paragraphs) {
    if (estimateTokens(para) <= MAX_PARA_TOKENS) {
      sections.push({
        heading: null,
        headingLevel: null,
        content: para,
        rawContent: para,
        rank: rank++,
      });
      continue;
    }

    // Long paragraph: try sentence boundaries, then fixed-size fallback.
    const sentences = para.match(/[^.!?。！？\n]+[.!?。！？\n]+|[^.!?。！？\n]+$/g) ?? [para];
    let buffer = '';
    const flushBuffer = (): void => {
      const text = buffer.trim();
      if (text.length === 0) return;
      sections.push({
        heading: null,
        headingLevel: null,
        content: text,
        rawContent: text,
        rank: rank++,
      });
      buffer = '';
    };

    for (const sentence of sentences) {
      const candidate = (buffer + ' ' + sentence).trim();
      if (buffer.length > 0 && candidate.length > MAX_PARA_CHARS) {
        flushBuffer();
      }
      buffer = buffer.length === 0 ? sentence : `${buffer} ${sentence}`;
    }
    flushBuffer();
  }

  return sections;
}

/** Rough token estimate — chars / 4 (English-leaning; CJK underestimates). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
