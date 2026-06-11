import type { MemoryMemo, MemoryMemoSummary } from './models.js';
import { createMemoryMemo, toSummary } from './models.js';
import type { MemoryMemoStore } from './store.js';
import { computeRelevanceScore } from './scoring.js';

export interface DuplicateGroup {
  /** Memos identified as duplicates/similar. */
  memos: MemoryMemoSummary[];
  /** Suggested merged memo content. */
  merged: {
    userNeed: string;
    approach: string;
    outcome: string;
    whatFailed: string;
    whatWorked: string;
  };
  /** Reason this group was flagged. */
  reason: string;
}

export interface ConsolidationPlan {
  duplicateGroups: DuplicateGroup[];
  /** Memos that appear to be resolved (outcome indicates completion). */
  resolved: MemoryMemoSummary[];
  /** Memos that appear stale (no updates > 30 days). */
  stale: MemoryMemoSummary[];
  summary: {
    totalMemos: number;
    duplicatesFound: number;
    resolvedFound: number;
    staleFound: number;
    memosAfterConsolidation: number;
  };
}

const SIMILARITY_THRESHOLD = 0.45;
const STALE_DAYS = 30;

/**
 * Analyze all memos and produce a consolidation plan.
 *
 * Pure logic — no LLM call. Uses keyword similarity to find near-duplicate
 * memos, flags resolved/stale entries.
 */
export async function buildConsolidationPlan(
  store: MemoryMemoStore,
): Promise<ConsolidationPlan> {
  const allMemos: MemoryMemo[] = [];
  for await (const memo of store.read()) {
    allMemos.push(memo);
  }

  const summaries = allMemos.map(toSummary);
  const duplicateGroups = findDuplicateGroups(summaries);
  const resolved = findResolved(summaries);
  const stale = findStale(summaries, STALE_DAYS);

  const dedupedCount = duplicateGroups.reduce((acc, g) => acc + g.memos.length - 1, 0);

  return {
    duplicateGroups,
    resolved,
    stale,
    summary: {
      totalMemos: allMemos.length,
      duplicatesFound: dedupedCount,
      resolvedFound: resolved.length,
      staleFound: stale.length,
      memosAfterConsolidation:
        allMemos.length - dedupedCount - resolved.length - stale.length,
    },
  };
}

/**
 * Apply a consolidation plan: delete duplicates, resolved, and stale memos,
 * appending merged replacements for duplicates.
 */
export async function applyConsolidation(
  store: MemoryMemoStore,
  plan: ConsolidationPlan,
): Promise<{ deleted: number; created: number }> {
  let deleted = 0;
  let created = 0;

  // Delete resolved memos
  for (const memo of plan.resolved) {
    await store.delete(memo.id);
    deleted++;
  }

  // Delete stale memos (just remove, they're outdated)
  for (const memo of plan.stale) {
    await store.delete(memo.id);
    deleted++;
  }

  // Handle duplicates: delete originals, append merged
  for (const group of plan.duplicateGroups) {
    const newest = group.memos.reduce((a, b) =>
      a.recordedAt > b.recordedAt ? a : b,
    );
    const merged = createMemoryMemo({
      sourceSessionId: newest.sourceSessionId,
      sourceSessionTitle: newest.sourceSessionTitle,
      userNeed: group.merged.userNeed,
      approach: group.merged.approach,
      outcome: group.merged.outcome,
      whatFailed: group.merged.whatFailed,
      whatWorked: group.merged.whatWorked,
      extractionSource: 'compaction', // merged memos are post-hoc
    });

    // Delete all originals
    for (const memo of group.memos) {
      await store.delete(memo.id);
      deleted++;
    }

    // Append merged
    await store.append(merged);
    created++;
  }

  return { deleted, created };
}

function findDuplicateGroups(memos: MemoryMemoSummary[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const used = new Set<string>();

  for (let i = 0; i < memos.length; i++) {
    const first = memos[i];
    if (!first || used.has(first.id)) continue;

    const cluster: MemoryMemoSummary[] = [first];

    for (let j = i + 1; j < memos.length; j++) {
      const candidate = memos[j];
      if (!candidate || used.has(candidate.id)) continue;

      // Check similarity against all memos already in the cluster
      const isSimilar = cluster.some((m) => {
        const score = computeRelevanceScore(
          candidate,
          `${m.userNeed} ${m.approach}`,
        );
        return score >= SIMILARITY_THRESHOLD;
      });

      if (isSimilar) {
        cluster.push(candidate);
      }
    }

    if (cluster.length > 1) {
      for (const m of cluster) used.add(m.id);
      groups.push(buildDuplicateGroup(cluster));
    }
  }

  return groups;
}

function buildDuplicateGroup(cluster: MemoryMemoSummary[]): DuplicateGroup {
  // Merge: use the most recent memo's fields as base
  const sorted = [...cluster].sort((a, b) => b.recordedAt - a.recordedAt);
  const newest = sorted[0]!;

  // Collect all unique whatFailed entries
  const failures = new Set(
    cluster
      .map((m) => m.whatFailed)
      .filter((p) => p && p !== 'none' && p !== '无'),
  );

  // Collect all unique whatWorked entries
  const successes = new Set(
    cluster
      .map((m) => m.whatWorked)
      .filter((w) => w && w !== 'none' && w !== '无'),
  );

  // Determine best outcome: prefer completion indicators
  const outcomes = cluster.map((m) => m.outcome);
  const hasDone = outcomes.some((o) => o.includes('完成') || o.toLowerCase().includes('done'));
  const bestOutcome = hasDone
    ? '完成'
    : newest.outcome;

  return {
    memos: cluster,
    merged: {
      userNeed: newest.userNeed,
      approach: `合并 ${cluster.length} 条相关记录。最新方案: ${newest.approach}`,
      outcome: bestOutcome,
      whatFailed: failures.size > 0 ? [...failures].join('; ') : 'none',
      whatWorked: successes.size > 0 ? [...successes].join('; ') : 'none',
    },
    reason: `发现 ${cluster.length} 条相似记录（关键词重叠 > ${Math.round(SIMILARITY_THRESHOLD * 100)}%）`,
  };
}

function isOutcomeCompleted(outcome: string): boolean {
  const lower = outcome.toLowerCase();
  return (
    lower.includes('完成') ||
    lower.includes('done') ||
    lower.includes('completed') ||
    lower.includes('成功') ||
    lower.includes('success')
  );
}

function findResolved(memos: MemoryMemoSummary[]): MemoryMemoSummary[] {
  return memos.filter(
    (m) =>
      isOutcomeCompleted(m.outcome) &&
      // Only flag memos older than 7 days as "resolved"
      (Date.now() - m.recordedAt) > 7 * 24 * 60 * 60 * 1000,
  );
}

function findStale(
  memos: MemoryMemoSummary[],
  staleDays: number,
): MemoryMemoSummary[] {
  const threshold = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  return memos.filter(
    (m) =>
      m.recordedAt < threshold &&
      !isOutcomeCompleted(m.outcome) &&
      !m.outcome.includes('blocked'),
  );
}
