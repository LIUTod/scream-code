import type { ChunkSection } from './types.js';

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const CODE_FENCE_RE = /^(\s*)(`{3,}|~{3,})/;

/**
 * Soft cap on chunk token count. BGE-small-zh-v1.5 (the fastembed model used
 * here) has a 512-token sequence limit; chunks longer than that get truncated
 * at the embedding layer, hurting retrieval quality. We split at ~480 to leave
 * headroom for the heading line that gets prepended at embed time.
 */
const MAX_CHUNK_TOKENS = 480;

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
    const level = currentLevel;
    buffer = [];
    // Skip sections with no body content.
    if (raw.length === 0) return;
    const body = stripMarkdown(raw);
    if (body.length === 0 && heading === null) return;
    const base: ChunkSection = {
      heading,
      headingLevel: level,
      content: body,
      rawContent: raw,
      rank,
    };
    const subSections = splitLargeSection(base);
    for (const section of subSections) {
      sections.push({ ...section, rank });
      rank += 1;
    }
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
 * Long paragraphs are split at sentence boundaries to stay under the
 * embedding model's token cap (same MAX_CHUNK_TOKENS as markdown).
 */
export function chunkText(content: string): ChunkSection[] {
  const MAX_PARA_TOKENS = MAX_CHUNK_TOKENS;
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

/**
 * Split a section that exceeds MAX_CHUNK_TOKENS into smaller sub-sections.
 * Strategy (mirrors SAG's `splitLargeSection`):
 *   1. Split into paragraphs by blank lines.
 *   2. Greedily pack paragraphs into chunks under the token cap.
 *   3. A paragraph that alone exceeds the cap is split at sentence boundaries;
 *      a sentence that itself exceeds the cap is split by character limit.
 *
 * Sections under the cap are returned unchanged (single-element array).
 * The heading is preserved across all sub-sections; rank is reassigned by the
 * caller. rawContent is rebuilt from the sub-chunk's content paragraphs.
 */
export function splitLargeSection(section: ChunkSection): ChunkSection[] {
  const totalTokens = estimateTokens(section.content);
  if (totalTokens <= MAX_CHUNK_TOKENS) {
    return [section];
  }

  const paragraphs = section.rawContent.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
  // When the section has no paragraph breaks (one giant block), fall back to
  // sentence-level splitting on the whole content.
  if (paragraphs.length <= 1) {
    return splitBySentences(section, section.rawContent);
  }

  const result: ChunkSection[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;

  const flushBuffer = (): void => {
    if (buffer.length === 0) return;
    const raw = buffer.join('\n\n').trim();
    if (raw.length === 0) {
      buffer = [];
      bufferTokens = 0;
      return;
    }
    result.push({
      heading: section.heading,
      headingLevel: section.headingLevel,
      content: stripMarkdown(raw),
      rawContent: raw,
      rank: 0, // reassigned by caller
    });
    buffer = [];
    bufferTokens = 0;
  };

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);
    if (paraTokens > MAX_CHUNK_TOKENS) {
      // Flush whatever is buffered first, then split the oversized paragraph.
      flushBuffer();
      for (const frag of splitBySentences(section, para)) {
        result.push(frag);
      }
      continue;
    }
    if (buffer.length > 0 && bufferTokens + paraTokens > MAX_CHUNK_TOKENS) {
      flushBuffer();
    }
    buffer.push(para);
    bufferTokens += paraTokens;
  }
  flushBuffer();

  return result.length > 0 ? result : [section];
}

/**
 * Split a long text into sub-sections at sentence boundaries.
 * Falls back to a hard character cut when a single sentence exceeds the cap.
 */
function splitBySentences(section: ChunkSection, text: string): ChunkSection[] {
  const sentences = splitSentences(text);
  const result: ChunkSection[] = [];
  let buffer = '';
  let bufferTokens = 0;

  const flush = (): void => {
    const trimmed = buffer.trim();
    if (trimmed.length === 0) {
      buffer = '';
      bufferTokens = 0;
      return;
    }
    result.push({
      heading: section.heading,
      headingLevel: section.headingLevel,
      content: stripMarkdown(trimmed),
      rawContent: trimmed,
      rank: 0,
    });
    buffer = '';
    bufferTokens = 0;
  };

  for (const sentence of sentences) {
    const sentTokens = estimateTokens(sentence);
    if (sentTokens > MAX_CHUNK_TOKENS) {
      flush();
      for (const frag of splitByCharLimit(sentence)) {
        result.push({
          heading: section.heading,
          headingLevel: section.headingLevel,
          content: stripMarkdown(frag),
          rawContent: frag,
          rank: 0,
        });
      }
      continue;
    }
    if (buffer.length > 0 && bufferTokens + sentTokens > MAX_CHUNK_TOKENS) {
      flush();
    }
    buffer = buffer.length === 0 ? sentence : `${buffer} ${sentence}`;
    bufferTokens += sentTokens;
  }
  flush();

  return result.length > 0 ? result : [
    {
      heading: section.heading,
      headingLevel: section.headingLevel,
      content: section.content,
      rawContent: section.rawContent,
      rank: 0,
    },
  ];
}

/** Split text into sentences using CJK + ASCII punctuation. */
function splitSentences(text: string): string[] {
  const matches = text.match(/[^。！？!?.\n]+[。！？!?.\n]+|[^。！？!?.\n]+$/g);
  return matches ?? [text];
}

/** Hard character cut for pathological single sentences longer than the cap. */
function splitByCharLimit(text: string): string[] {
  const maxChars = MAX_CHUNK_TOKENS * 4;
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxChars) {
    chunks.push(remaining.slice(0, maxChars));
    remaining = remaining.slice(maxChars).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
