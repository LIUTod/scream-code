import type { MemoryMemoSummary } from './models.js';

export interface RelevanceFactors {
  /** Jaccard similarity of keyword sets (memo vs current query). */
  keywordOverlap: number;      // 0-1
  /** Recency score: 1.0 for today, decays to 0 for >90 days. */
  recency: number;             // 0-1
  /** Usage boost: +0.1 per previous injection, capped at 0.3. */
  usageBoost: number;          // 0-0.3
}

export interface ScoredMemo {
  memo: MemoryMemoSummary;
  score: number;
}

/**
 * Multi-factor relevance score for a memory memo against a query.
 * Pure deterministic scoring — no LLM call, no network.
 */
export function computeRelevanceScore(
  memo: MemoryMemoSummary,
  query: string,
  usageCount: number = 0,
): number {
  const factors = {
    keywordOverlap: computeKeywordSimilarity(memo, query),
    recency: computeRecency(memo.recordedAt),
    usageBoost: Math.min(0.3, usageCount * 0.1),
  };

  return (
    factors.keywordOverlap * 0.50 +
    factors.recency * 0.25 +
    factors.usageBoost * 0.25
  );
}

/**
 * Score multiple memos against a query, returning sorted results.
 */
export function rankMemos(
  memos: MemoryMemoSummary[],
  query: string,
  minScore: number = 0.3,
  maxResults: number = 3,
): ScoredMemo[] {
  return memos
    .map((memo) => ({ memo, score: computeRelevanceScore(memo, query) }))
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

// Chinese + English stopwords
const STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
  '没有', '看', '好', '自己', '这', '他', '她', '它', '们', '那', '些',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
  'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each', 'every',
  'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'only', 'own', 'same', 'than', 'too', 'very', 'just', 'because',
  'about', 'what', 'which', 'who', 'whom', 'this', 'that', 'these',
  'those', 'it', 'its', 'he', 'she', 'they', 'we', 'you', 'how',
]);

function extractKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  // Split on non-alphanumeric (keep CJK chars as individual tokens)
  const tokens: string[] = [];
  // Split into alphanumeric runs and individual CJK chars
  const parts = lower.split(/[^a-z0-9一-鿿㐀-䶿]+/);
  for (const part of parts) {
    if (part.length === 0) continue;
    // For CJK text, split into individual characters
    if (/[一-鿿㐀-䶿]/.test(part)) {
      for (const ch of part) {
        if (ch.length >= 1 && !STOP_WORDS.has(ch)) {
          tokens.push(ch);
        }
      }
    }
    // For ASCII text, keep as word if long enough and not a stopword
    if (/[a-z0-9]/.test(part) && part.length >= 2 && !STOP_WORDS.has(part)) {
      tokens.push(part);
    }
  }
  return [...new Set(tokens)]; // deduplicate
}

function computeKeywordSimilarity(
  memo: MemoryMemoSummary,
  query: string,
): number {
  const memoText = `${memo.userNeed} ${memo.approach} ${memo.whatFailed} ${memo.whatWorked}`;
  const memoWords = extractKeywords(memoText);
  const queryWords = extractKeywords(query);

  if (memoWords.length === 0 || queryWords.length === 0) return 0;

  // Jaccard similarity: |intersection| / |union|
  const intersection = memoWords.filter((w) => queryWords.includes(w)).length;
  const union = new Set([...memoWords, ...queryWords]).size;

  return union === 0 ? 0 : intersection / union;
}

function computeRecency(recordedAt: number): number {
  const daysSince = (Date.now() - recordedAt) / (1000 * 60 * 60 * 24);
  // Linear decay: 1.0 at day 0, 0 at day 90+
  return Math.max(0, 1 - daysSince / 90);
}
