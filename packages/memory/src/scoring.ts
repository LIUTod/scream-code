import type { MemoryMemoSummary } from './models.js';

export interface RelevanceFactors {
  /** Jaccard similarity of keyword sets (memo vs current query). */
  keywordOverlap: number; // 0-1
  /** Recency score: 1.0 for today, decays to 0 for >90 days. */
  recency: number; // 0-1
  /** Usage boost: +0.1 per previous injection, capped at 0.3. */
  usageBoost: number; // 0-0.3
  /** Project affinity: 1.0 same project, 0.3 same parent dir, 0 otherwise. */
  projectBoost: number; // 0-1
  /** Tag overlap between this memo and the current project's tag cloud. */
  tagOverlap: number; // 0-1
}

export interface ScoredMemo {
  memo: MemoryMemoSummary;
  score: number;
}

export interface RankMemosOptions {
  minScore?: number;
  maxResults?: number;
  currentProjectDir?: string;
  projectTagCloud?: Set<string>;
  /** Optional vector similarity scores keyed by memo id. When provided, keyword
   * and vector scores are blended (60% keyword, 40% vector). */
  vectorScores?: Map<string, number>;
}

export interface QueryIntent {
  /** 0-1: how strongly this is a time-oriented query ("what did I do last week"). */
  temporalBias: number;
  /** 0-1: how strongly this is a factual/technical query ("how to write React components"). */
  factualBias: number;
}

const TEMPORAL_STRONG = /昨天|今天|上周|本周|本月|最近|之前|以前|上次|刚刚|刚刚才|刚才|前天|大前天|前几天|这几天|这几天来|近.*[天周月年]/;
const TEMPORAL_WEAK = /什么时候|何时|多久|几时|哪天|哪一天|多长.*时间/;
const TEMPORAL_ACTION = /做了|干了|处理了|解决了|修复了|完成了|改了|写了|加了|删了|移除了|部署了|发布了/;
const CODE_SIGNAL = /[`'"#]|[{}()[\]]|\.(ts|js|tsx|jsx|py|rs|go|java|cpp|c|h)\b|function |const |import |export |class |async |await |type |interface /;

/**
 * Lightweight regex-based query intent detection.
 * Zero LLM cost — classifies into temporal vs factual bias to adjust scoring weights.
 */
export function detectQueryIntent(query: string): QueryIntent {
  const q = query.trim();
  if (q.length === 0) return { temporalBias: 0.3, factualBias: 0.6 };

  let temporalBias = 0.3;
  let factualBias = 0.6;

  if (TEMPORAL_STRONG.test(q)) {
    temporalBias = 1.0;
  } else if (TEMPORAL_WEAK.test(q)) {
    temporalBias = 0.8;
  } else if (TEMPORAL_ACTION.test(q)) {
    temporalBias = 0.6;
  }

  // Factual queries: have code/tech signals and no temporal words
  if (CODE_SIGNAL.test(q) && !TEMPORAL_STRONG.test(q) && !TEMPORAL_WEAK.test(q)) {
    factualBias = 1.0;
  }

  return { temporalBias, factualBias };
}

/**
 * Multi-factor relevance score for a memory memo against a query.
 * Pure deterministic scoring — no LLM call, no network.
 *
 * When `intent` is provided, keyword weight increases for factual queries
 * and recency weight increases for temporal queries.
 */
export function computeRelevanceScore(
  memo: MemoryMemoSummary,
  query: string,
  usageCount: number = 0,
  currentProjectDir?: string,
  projectTagCloud?: Set<string>,
  intent?: QueryIntent,
): number {
  const ti = intent?.temporalBias ?? 0.3;
  const fi = intent?.factualBias ?? 0.6;

  const factors: RelevanceFactors = {
    keywordOverlap: computeKeywordOverlap(memo, query),
    recency: computeRecency(memo.recordedAt),
    // NOTE: usageCount is always 0 — per-memo usage counting is not yet
    // implemented in the store. When added, increment on each search hit.
    usageBoost: Math.min(0.3, usageCount * 0.1),
    projectBoost: computeProjectBoost(memo.projectDir, currentProjectDir),
    tagOverlap: computeTagOverlap(memo.tags, projectTagCloud),
  };

  // Intent-adjusted weights. At default biases (ti=0.3, fi=0.6) the
  // weights are identical to the original hardcoded values. Temporal
  // queries boost recency; factual queries boost keyword overlap.
  const kwWeight = 0.45 * (1 + (fi - 0.6) * 0.5);
  const recencyWeight = 0.25 * (1 + (ti - 0.3) * 0.571);
  const usageWeight = 0.15;
  const projectWeight = 0.10;
  const tagWeight = 0.05;
  const total = kwWeight + recencyWeight + usageWeight + projectWeight + tagWeight;

  return (
    factors.keywordOverlap * (kwWeight / total) +
    factors.recency * (recencyWeight / total) +
    factors.usageBoost * (usageWeight / total) +
    factors.projectBoost * (projectWeight / total) +
    factors.tagOverlap * (tagWeight / total)
  );
}

/**
 * Score multiple memos against a query, returning sorted results.
 */
export function rankMemos(
  memos: MemoryMemoSummary[],
  query: string,
  options: RankMemosOptions = {},
): ScoredMemo[] {
  const { minScore = 0.3, maxResults = 3, currentProjectDir, projectTagCloud, vectorScores } =
    options;
  const intent = detectQueryIntent(query);
  const hasVectorScores = vectorScores !== undefined && vectorScores.size > 0;

  return memos
    .map((memo) => {
      const keywordScore = computeRelevanceScore(
        memo, query, 0, currentProjectDir, projectTagCloud, intent,
      );
      const vectorScore = vectorScores?.get(memo.id) ?? 0;
      // Blend: 60% keyword + 40% vector when both are available.
      const score = hasVectorScores
        ? keywordScore * 0.6 + vectorScore * 0.4
        : keywordScore;
      return { memo, score };
    })
    .filter((s) => s.score >= minScore)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

/**
 * Build a tag cloud from memos that belong to the current project.
 */
export function buildProjectTagCloud(
  memos: MemoryMemoSummary[],
  projectDir: string,
): Set<string> {
  const cloud = new Set<string>();
  for (const memo of memos) {
    if (memo.projectDir === projectDir && memo.tags !== undefined) {
      for (const tag of memo.tags) {
        cloud.add(tag);
      }
    }
  }
  return cloud;
}

function computeProjectBoost(memoProjectDir: string, currentProjectDir?: string): number {
  if (currentProjectDir === undefined || currentProjectDir.length === 0) return 0;
  if (memoProjectDir === currentProjectDir) return 1;
  if (memoProjectDir.length === 0) return 0;
  const memoParent = parentDir(memoProjectDir);
  const currentParent = parentDir(currentProjectDir);
  if (memoParent.length > 0 && memoParent === currentParent) return 0.3;
  return 0;
}

function parentDir(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const lastSep = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return lastSep > 0 ? trimmed.slice(0, lastSep) : '';
}

function computeTagOverlap(
  memoTags: string[] | undefined,
  projectTagCloud: Set<string> | undefined,
): number {
  if (projectTagCloud === undefined || projectTagCloud.size === 0) return 0;
  if (memoTags === undefined || memoTags.length === 0) return 0;
  const memoSet = new Set(memoTags);
  let intersection = 0;
  for (const tag of memoSet) {
    if (projectTagCloud.has(tag)) intersection++;
  }
  const union = new Set([...memoSet, ...projectTagCloud]).size;
  return union === 0 ? 0 : intersection / union;
}

// Chinese + English stopwords
export const STOP_WORDS = new Set([
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

export function extractKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  // Split CJK and alphanumeric runs so mixed text like "使用redis缓存" becomes
  // "使用 redis 缓存". Then split on non-alphanumeric/non-CJK separators.
  const normalized = lower
    .replaceAll(/([一-鿿㐀-䶿])([a-z0-9])/g, '$1 $2')
    .replaceAll(/([a-z0-9])([一-鿿㐀-䶿])/g, '$1 $2');
  const parts = normalized.split(/[^a-z0-9一-鿿㐀-䶿]+/);
  const tokens: string[] = [];
  for (const part of parts) {
    if (part.length === 0) continue;
    // For CJK text, split into individual characters.
    if (/[一-鿿㐀-䶿]/.test(part)) {
      for (const ch of part) {
        if (ch.length > 0 && !STOP_WORDS.has(ch)) {
          tokens.push(ch);
        }
      }
    }
    // For ASCII text, keep as word if long enough and not a stopword.
    if (/^[a-z0-9]+$/.test(part) && part.length >= 2 && !STOP_WORDS.has(part)) {
      tokens.push(part);
    }
  }
  return [...new Set(tokens)]; // deduplicate
}

export function computeKeywordSimilarity(
  memo: MemoryMemoSummary,
  query: string,
): number {
  return jaccardSimilarity(keywordText(memo), query);
}

/**
 * Ranking variant: the distilled conclusion and the note are separate
 * retrieval surfaces. Score each field on its own and keep the best match —
 * a short conclusion would otherwise be diluted by the long base text.
 */
function computeKeywordOverlap(memo: MemoryMemoSummary, query: string): number {
  return Math.max(
    jaccardSimilarity(keywordText(memo), query),
    jaccardSimilarity(memo.distilled ?? '', query),
    jaccardSimilarity(memo.note ?? '', query),
  );
}

function keywordText(memo: MemoryMemoSummary): string {
  return `${memo.userNeed} ${memo.approach} ${memo.whatFailed} ${memo.whatWorked}`;
}

function jaccardSimilarity(memoText: string, query: string): number {
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
