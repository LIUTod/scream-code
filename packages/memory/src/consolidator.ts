import { randomUUID } from 'node:crypto';

import type { DistilledSource, MemoryMemo, MemoryMemoSummary } from './models.js';
import { createMemoryMemo } from './models.js';
import type { MemoryMemoStore } from './store.js';
import type { EmbeddingEngine } from './embeddings.js';

/**
 * Dream turns a pile of raw memos into something more reusable. It does that
 * with three distinct moves, and the distinction is the whole design:
 *
 * - **merge**   several near-identical memories → one fuller memory (the only
 *               move that replaces sources, and it is undoable)
 * - **distil**  one memory → the same memory plus a one-sentence rule
 * - **induce**  several related-but-distinct memories → one NEW rule memory,
 *               leaving every source untouched
 *
 * Nothing here deletes a memory for being old. "The task is finished" is the
 * normal happy outcome of a memo, not a reason to throw it away.
 */

export interface DuplicateGroup {
  /** What the members have in common, for the model to name the merged memo. */
  topic: string;
  /** Mean pairwise cosine similarity inside the group (0 when keyword-based). */
  cohesion: number;
  memos: MemoryMemoSummary[];
  /** Starter content. `distilled` is deliberately empty — the model writes it. */
  merged: {
    userNeed: string;
    approach: string;
    outcome: string;
    whatFailed: string;
    whatWorked: string;
    tags?: string[];
    distilled: string;
  };
  /** Why this group was flagged. */
  reason: string;
  /** How similarity was judged: stored vectors, or a keyword fallback. */
  basis: 'vector' | 'keyword';
}

export interface NearMiss {
  aId: string;
  bId: string;
  aNeed: string;
  bNeed: string;
  score: number;
}

export interface DistillCandidate {
  memo: MemoryMemoSummary;
  /** Why it is worth distilling — never a reason to remove it. */
  why: 'completed-7d' | 'stale-30d' | 'verbose';
}

export interface InductionCluster {
  /** Shared tag that ties the members together. */
  topic: string;
  reason: string;
  memos: MemoryMemoSummary[];
}

export interface ConsolidationPlan {
  version: 2;
  duplicateGroups: DuplicateGroup[];
  nearMisses: NearMiss[];
  distillCandidates: DistillCandidate[];
  inductionClusters: InductionCluster[];
  summary: {
    totalMemos: number;
    /** Memos /dream has not looked at yet — the work this run covers. */
    unseen: number;
    duplicateGroups: number;
    nearMisses: number;
    distillCandidates: number;
    inductionClusters: number;
    /** Memos that already carry a rule. */
    distilledCount: number;
  };
}

export interface ConsolidationMerge {
  memoIds: string[];
  merged: {
    userNeed: string;
    approach: string;
    outcome: string;
    whatFailed: string;
    whatWorked: string;
    tags?: string[];
    distilled: string;
  };
  /** Allow replacing a memo that already carries a rule. Off by default. */
  allowSupersede?: boolean;
}

export interface ConsolidationDistillation {
  memoId: string;
  distilled: string;
}

export interface ConsolidationInduction {
  topic: string;
  sourceMemoIds: string[];
  rule: {
    userNeed: string;
    approach: string;
    distilled: string;
    tags?: string[];
  };
}

export interface ConsolidationApplyInput {
  merges: ConsolidationMerge[];
  distillations: ConsolidationDistillation[];
  inductions: ConsolidationInduction[];
}

export interface ConsolidationApplyResult {
  merged: Array<{ mergedId: string; sourceIds: string[]; mergeId: string }>;
  distilled: string[];
  induced: string[];
  skipped: Array<{ id: string; reason: string }>;
}

/** Cosine above which two memories are the same experience written twice.
 * Calibrated against a real 87-memo library: 0.95→0 pairs, 0.90→2, 0.88→3,
 * 0.86→4, 0.82→6. 0.86 keeps merges conservative — a wrong merge loses detail. */
const MERGE_SIMILARITY = 0.86;
/** Below this a pair is not even worth showing as a near miss. */
const NEAR_MISS_SIMILARITY = 0.8;
/** Keyword fallback when no vectors are available (engine never loaded). */
const MERGE_SIMILARITY_KEYWORD = 0.55;

const RESOLVED_DAYS = 7;
const STALE_DAYS = 30;

const MAX_DUPLICATE_GROUPS = 8;
const MAX_GROUP_MEMOS = 5;
const MAX_NEAR_MISSES = 12;
const MAX_DISTILL_CANDIDATES = 15;
const MAX_INDUCTION_CLUSTERS = 4;
const MAX_CLUSTER_MEMOS = 4;

/** Character caps for the plan's summaries. The plan is handed to a model and
 * echoed back through a tool call, so its size is a correctness concern. */
/** Serialized-plan ceiling. The loop truncates tool results above 5000 tokens
 * and the cut lands mid-JSON — the model then cannot parse the plan at all
 * (observed: "the output got truncated", followed by nine steps of poking the
 * sqlite file by hand). ~2.6 characters per token on a CJK library, so 11.5k
 * characters stays clear of the cap. */
const PLAN_CHAR_BUDGET = 11_500;
const CAP_NEED = 140;
const CAP_LEAN_NEED = 90;
const CAP_APPROACH = 130;
/** Merge drafts keep most of the text; see trimToBudget. */
const CAP_DRAFT_APPROACH = 1_200;
const CAP_OUTCOME = 80;
const CAP_RULE = 200;

const COMPLETED_OUTCOME = /完成|done|completed|成功|success|已解决|fixed|resolved/iu;
/** Substring matching alone would read "部分完成" as finished, which is how the
 * previous implementation ended up proposing 60 of 87 memories for deletion. */
const NOT_COMPLETED_OUTCOME = /部分|未完成|进行中|待完成|partial|in progress|ongoing|unfinished/iu;

function isClearlyCompleted(outcome: string): boolean {
  return COMPLETED_OUTCOME.test(outcome) && !NOT_COMPLETED_OUTCOME.test(outcome);
}

function clip(text: string, max: number): string {
  const flat = text.replaceAll(/\s+/gu, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** A compact summary for the plan: long prose is clipped, bookkeeping stays. */
function toPlanSummary(memo: MemoryMemo): MemoryMemoSummary {
  return {
    id: memo.id,
    recordedAt: memo.recordedAt,
    userNeed: clip(memo.userNeed, CAP_NEED),
    approach: clip(memo.approach, CAP_APPROACH),
    outcome: clip(memo.outcome, CAP_OUTCOME),
    whatFailed: '',
    whatWorked: '',
    tags: memo.tags,
    projectDir: memo.projectDir,
    sourceSessionId: memo.sourceSessionId,
    sourceSessionTitle: memo.sourceSessionTitle,
    extractionSource: memo.extractionSource,
    ...(memo.distilled === undefined ? {} : { distilled: clip(memo.distilled, CAP_RULE) }),
    origin: memo.origin,
  };
}

/** Minimal summary: enough to recognise the memory, nothing to echo back. */
function toLeanSummary(memo: MemoryMemo): MemoryMemoSummary {
  return {
    id: memo.id,
    recordedAt: memo.recordedAt,
    userNeed: clip(memo.userNeed, CAP_LEAN_NEED),
    approach: '',
    outcome: clip(memo.outcome, CAP_OUTCOME),
    whatFailed: '',
    whatWorked: '',
    tags: memo.tags,
    projectDir: '',
    sourceSessionId: '',
    sourceSessionTitle: '',
    extractionSource: memo.extractionSource,
    ...(memo.distilled === undefined ? {} : { distilled: clip(memo.distilled, CAP_LEAN_NEED) }),
    origin: memo.origin,
  };
}

/** Memos that already carry a rule are the refined result: a run must not
 * overwrite one by accident. */
function isDistilledRule(memo: MemoryMemo): boolean {
  return (memo.distilled ?? '').trim().length > 0;
}

function newerThanDays(memo: MemoryMemo, days: number): boolean {
  return Date.now() - memo.recordedAt > days * 24 * 60 * 60 * 1000;
}

/**
 * Analyze memories and propose merges, distillations and inductions.
 *
 * Pure logic — no model call. Similarity uses the stored vectors (the same
 * measure recall uses), so what /dream calls "duplicate" is what recall would
 * treat as the same thing.
 *
 * Incremental by default: only memos no run has looked at are considered, which
 * makes a second `/dream` after a first one nearly empty — and that emptiness is
 * the proof the pass worked.
 */
export async function buildConsolidationPlan(
  store: MemoryMemoStore,
  options?: {
    projectDir?: string;
    includeSeen?: boolean;
    /** Pre-computed vectors; defaults to whatever the store has stored. */
    vectors?: Map<string, Float32Array>;
    /** Similarity engine; defaults to the store's attached engine. */
    engine?: EmbeddingEngine;
  },
): Promise<ConsolidationPlan> {
  const all: MemoryMemo[] = [];
  for await (const memo of store.read(options)) all.push(memo);

  const unseen = all.filter((memo) => memo.dreamedAt === undefined || memo.recordedAt > memo.dreamedAt);
  const candidates = options?.includeSeen === true ? all : unseen;

  const vectors = options?.vectors ?? (await store.allVectors());
  const engine = options?.engine ?? store.getEmbeddingEngine();

  const duplicateGroups = findDuplicateGroups(candidates, vectors, engine);
  const nearMisses = findNearMisses(candidates, duplicateGroups, vectors, engine);
  const distillCandidates = findDistillCandidates(candidates);
  const inductionClusters = findInductionClusters(candidates, duplicateGroups);

  const plan: ConsolidationPlan = {
    version: 2,
    duplicateGroups,
    nearMisses,
    distillCandidates,
    inductionClusters,
    summary: {
      totalMemos: all.length,
      unseen: unseen.length,
      duplicateGroups: duplicateGroups.length,
      nearMisses: nearMisses.length,
      distillCandidates: distillCandidates.length,
      inductionClusters: inductionClusters.length,
      distilledCount: all.filter(isDistilledRule).length,
    },
  };
  return trimToBudget(plan);
}

/** Shrink the plan until it fits one tool result. Order of sacrifice: the
 * weakest signal first (near misses, then induction clusters, then the tail of
 * the distillation queue, then whole duplicate groups), so what survives is what
 * the model can act on. */
function trimToBudget(plan: ConsolidationPlan): ConsolidationPlan {
  const size = (): number => Buffer.byteLength(JSON.stringify(plan), 'utf8');
  const trim = (): boolean => {
    if (plan.nearMisses.length > 0) {
      plan.nearMisses = plan.nearMisses.slice(0, Math.max(0, plan.nearMisses.length - 4));
      return true;
    }
    if (plan.inductionClusters.length > 1) {
      plan.inductionClusters = plan.inductionClusters.slice(0, plan.inductionClusters.length - 1);
      return true;
    }
    if (plan.distillCandidates.length > 1) {
      plan.distillCandidates = plan.distillCandidates.slice(0, Math.ceil(plan.distillCandidates.length / 2));
      return true;
    }
    if (plan.duplicateGroups.length > 1) {
      plan.duplicateGroups = plan.duplicateGroups.slice(0, plan.duplicateGroups.length - 1);
      return true;
    }
    if (plan.duplicateGroups.length === 1 && plan.duplicateGroups[0]!.memos.length > 2) {
      const [group] = plan.duplicateGroups;
      plan.duplicateGroups = [{ ...group!, memos: group!.memos.slice(0, -1) }];
      return true;
    }
    return false;
  };
  let guard = 0;
  while (size() > PLAN_CHAR_BUDGET && guard < 64) {
    if (!trim()) break;
    guard += 1;
  }
  plan.summary = {
    ...plan.summary,
    nearMisses: plan.nearMisses.length,
    distillCandidates: plan.distillCandidates.length,
    inductionClusters: plan.inductionClusters.length,
    duplicateGroups: plan.duplicateGroups.length,
  };
  return plan;
}

/** Single-link clustering over stored vectors. Groups never mix in a memo that
 * already carries a rule — that rule is the refined result, not a duplicate. */
function findDuplicateGroups(
  memos: MemoryMemo[],
  vectors: Map<string, Float32Array>,
  engine: EmbeddingEngine | undefined,
): DuplicateGroup[] {
  const usable = memos.filter((memo) => !isDistilledRule(memo));
  const withVectors = usable.filter((memo) => vectors.has(memo.id));

  if (engine === undefined || withVectors.length < 2) {
    // No vectors to compare: fall back to lexical overlap so an offline library
    // still gets something, but say so in the group's basis.
    return findDuplicateGroupsByKeyword(usable);
  }

  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const memo of withVectors) parent.set(memo.id, memo.id);

  const similarity = new Map<string, number>();
  for (let i = 0; i < withVectors.length; i += 1) {
    for (let j = i + 1; j < withVectors.length; j += 1) {
      const a = withVectors[i]!;
      const b = withVectors[j]!;
      const score = engine.cosineSimilarity(vectors.get(a.id)!, vectors.get(b.id)!);
      if (score >= MERGE_SIMILARITY) {
        union(a.id, b.id);
        similarity.set(`${a.id}|${b.id}`, score);
      }
    }
  }

  const buckets = new Map<string, MemoryMemo[]>();
  for (const memo of withVectors) {
    const root = find(memo.id);
    const bucket = buckets.get(root);
    if (bucket === undefined) buckets.set(root, [memo]);
    else bucket.push(memo);
  }

  const groups: DuplicateGroup[] = [];
  for (const members of buckets.values()) {
    if (members.length < 2) continue;
    const capped = members
      .toSorted((a, b) => b.recordedAt - a.recordedAt)
      .slice(0, MAX_GROUP_MEMOS);
    groups.push({
      topic: clip(commonTopic(capped), CAP_OUTCOME),
      cohesion: meanCohesion(capped, vectors, engine),
      memos: capped.map(toPlanSummary),
      merged: draftMerge(capped),
      reason: `${capped.length} memories with cosine ≥ ${MERGE_SIMILARITY} — the same experience recorded more than once.`,
      basis: 'vector',
    });
  }
  return groups
    .toSorted((a, b) => b.cohesion - a.cohesion)
    .slice(0, MAX_DUPLICATE_GROUPS);
}

function findDuplicateGroupsByKeyword(memos: MemoryMemo[]): DuplicateGroup[] {
  const groups: Array<{ members: MemoryMemo[]; score: number }> = [];
  const claimed = new Set<string>();
  for (const memo of memos) {
    if (claimed.has(memo.id)) continue;
    const members = [memo];
    let total = 0;
    for (const other of memos) {
      if (other.id === memo.id || claimed.has(other.id)) continue;
      const score = keywordScore(memo, other);
      if (score < MERGE_SIMILARITY_KEYWORD) continue;
      members.push(other);
      total += score;
    }
    if (members.length < 2) continue;
    for (const member of members) claimed.add(member.id);
    groups.push({ members: members.slice(0, MAX_GROUP_MEMOS), score: total / (members.length - 1) });
  }
  return groups
    .toSorted((a, b) => b.score - a.score)
    .slice(0, MAX_DUPLICATE_GROUPS)
    .map((group) => ({
      topic: clip(commonTopic(group.members), CAP_OUTCOME),
      cohesion: 0,
      memos: group.members.map(toPlanSummary),
      merged: draftMerge(group.members),
      reason: `${group.members.length} memories with heavy keyword overlap — likely the same experience.`,
      basis: 'keyword' as const,
    }));
}

/** Pairs that are close but below the merge bar: material for the model to
 * judge, cheap enough to show a handful. */
function findNearMisses(
  memos: MemoryMemo[],
  groups: DuplicateGroup[],
  vectors: Map<string, Float32Array>,
  engine: EmbeddingEngine | undefined,
): NearMiss[] {
  if (engine === undefined) return [];
  const inGroup = new Set(groups.flatMap((group) => group.memos.map((memo) => memo.id)));
  const pool = memos.filter((memo) => vectors.has(memo.id) && !isDistilledRule(memo) && !inGroup.has(memo.id));
  const found: NearMiss[] = [];
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      const a = pool[i]!;
      const b = pool[j]!;
      const score = engine.cosineSimilarity(vectors.get(a.id)!, vectors.get(b.id)!);
      if (score < NEAR_MISS_SIMILARITY || score >= MERGE_SIMILARITY) continue;
      found.push({
        aId: a.id,
        bId: b.id,
        aNeed: clip(a.userNeed, CAP_OUTCOME),
        bNeed: clip(b.userNeed, CAP_OUTCOME),
        score: Math.round(score * 1000) / 1000,
      });
    }
  }
  return found.toSorted((a, b) => b.score - a.score).slice(0, MAX_NEAR_MISSES);
}

/**
 * Memos worth turning into a rule. "Completed a week ago" and "untouched for a
 * month" are *distillation* signals, never deletion signals: recall skips a
 * memo whose outcome is still in progress unless it carries a rule, so
 * distilling is what makes such a memory reachable at all.
 */
function findDistillCandidates(memos: MemoryMemo[]): DistillCandidate[] {
  const picked: DistillCandidate[] = [];
  for (const memo of memos) {
    if (isDistilledRule(memo)) continue;
    let why: DistillCandidate['why'] | undefined;
    if (newerThanDays(memo, RESOLVED_DAYS) && isClearlyCompleted(memo.outcome)) why = 'completed-7d';
    else if (newerThanDays(memo, STALE_DAYS)) why = 'stale-30d';
    else if (memo.approach.length > 400) why = 'verbose';
    if (why === undefined) continue;
    picked.push({ memo: toLeanSummary(memo), why });
  }
  return picked
    .toSorted((a, b) => a.memo.recordedAt - b.memo.recordedAt)
    .slice(0, MAX_DISTILL_CANDIDATES);
}

/**
 * Memos that keep coming back around the same topic but are not duplicates.
 * Grouped by shared tag — tags are generated from the memo's own content, so
 * this is a real theme rather than a coincidental two-character overlap.
 * Inducing a rule here adds a memory and leaves every source in place.
 */
function findInductionClusters(
  memos: MemoryMemo[],
  groups: DuplicateGroup[],
): InductionCluster[] {
  const inGroup = new Set(groups.flatMap((group) => group.memos.map((memo) => memo.id)));
  const byTag = new Map<string, MemoryMemo[]>();
  for (const memo of memos) {
    if (inGroup.has(memo.id)) continue;
    for (const tag of memo.tags ?? []) {
      const bucket = byTag.get(tag);
      if (bucket === undefined) byTag.set(tag, [memo]);
      else bucket.push(memo);
    }
  }
  const clusters = [...byTag.entries()]
    .filter(([, bucket]) => bucket.length >= 3)
    .toSorted((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_INDUCTION_CLUSTERS)
    .map(([tag, bucket]) => {
      // A memo can carry several tags; keep each memo in the strongest cluster
      // only, so the model is not asked to induce the same rule twice.
      const members = bucket
        .toSorted((a, b) => b.recordedAt - a.recordedAt)
        .slice(0, MAX_CLUSTER_MEMOS)
        .filter((memo) => !isDistilledRule(memo));
      return { tag, members };
    })
    .filter((cluster) => cluster.members.length >= 3);

  const claimed = new Set<string>();
  const result: InductionCluster[] = [];
  for (const cluster of clusters) {
    const members = cluster.members.filter((memo) => !claimed.has(memo.id));
    if (members.length < 3) continue;
    for (const memo of members) claimed.add(memo.id);
    result.push({
      topic: cluster.tag,
      reason: `${members.length} memories share the tag "${cluster.tag}" — likely one reusable rule behind them.`,
      memos: members.map(toLeanSummary),
    });
  }
  return result;
}

function keywordScore(a: MemoryMemo, b: MemoryMemo): number {
  const left = tokenize(`${a.userNeed} ${a.approach}`);
  const right = tokenize(`${b.userNeed} ${b.approach}`);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= 2) tokens.add(word);
  }
  return tokens;
}

/** The longest tag the members share, else the newest memo's need. */
function commonTopic(members: MemoryMemo[]): string {
  const counts = new Map<string, number>();
  for (const memo of members) {
    for (const tag of memo.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const shared = [...counts.entries()]
    .filter(([, count]) => count === members.length)
    .toSorted((a, b) => b[0].length - a[0].length)[0];
  return shared?.[0] ?? members[0]!.userNeed;
}

function meanCohesion(
  members: MemoryMemo[],
  vectors: Map<string, Float32Array>,
  engine: EmbeddingEngine,
): number {
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const a = vectors.get(members[i]!.id);
      const b = vectors.get(members[j]!.id);
      if (a === undefined || b === undefined) continue;
      total += engine.cosineSimilarity(a, b);
      pairs += 1;
    }
  }
  return pairs === 0 ? 0 : Math.round((total / pairs) * 1000) / 1000;
}

/** Starter content for a merge: the newest member's prose, no wrapper phrases
 * (those would end up inside the embedded text and dilute it). */
function draftMerge(members: MemoryMemo[]): DuplicateGroup['merged'] {
  const newest = members[0]!;
  const tags = new Set<string>();
  for (const memo of members) for (const tag of memo.tags ?? []) tags.add(tag);
  return {
    userNeed: clip(newest.userNeed, CAP_NEED),
    // Long on purpose — this is what the model rewrites, and a tight clip sends
    // it back to the database to re-read the memo. Bounded so a single huge memo
    // cannot exceed the plan budget by itself.
    approach: clip(newest.approach, CAP_DRAFT_APPROACH),
    outcome: newest.outcome,
    whatFailed: members.map((memo) => memo.whatFailed).find((text) => text.trim() !== 'none') ?? 'none',
    whatWorked: newest.whatWorked,
    tags: [...tags].slice(0, 6),
    distilled: '',
  };
}

export interface RuleCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Mechanical checks only: a rule must be short enough to embed and must not be
 * bookkeeping about the pass itself.
 *
 * Deliberately *not* checked: phrasing. An earlier version demanded a trigger
 * marker (当/在…时/先/再) and rejected 11 of 17 rules from a real pass — all of
 * them usable, each costing a full extra tool round. Whether a sentence is a
 * good rule is the skill's job; a regex that guesses wrong is worse than none.
 */
export function checkRuleSentence(text: string): RuleCheck {
  const flat = text.replaceAll(/\s+/gu, ' ').trim();
  if (flat.length === 0) return { ok: false, reason: 'empty' };
  if (flat.length > CAP_RULE) return { ok: false, reason: `longer than ${CAP_RULE} characters` };
  if (flat.length < 8) return { ok: false, reason: 'too short to carry a condition and an action' };
  if (/合并\s*\d+\s*条|综上|合并了|\d+\s*条相关记录/iu.test(flat)) {
    return { ok: false, reason: 'contains bookkeeping wording instead of a rule' };
  }
  return { ok: true };
}

/**
 * Apply one dream pass: merge duplicates, distil existing memories, induce new
 * rules. Only an explicitly listed merge replaces anything; every other memo is
 * left exactly as it was. When an entry cannot be applied, it is reported in
 * `skipped` with a reason instead of failing the whole pass.
 */
export async function applyConsolidation(
  store: MemoryMemoStore,
  input: ConsolidationApplyInput,
): Promise<ConsolidationApplyResult> {
  const result: ConsolidationApplyResult = { merged: [], distilled: [], induced: [], skipped: [] };
  const claimed = new Set<string>();

  for (const merge of input.merges) {
    const ids = [...new Set(merge.memoIds)];
    if (ids.length < 2) {
      result.skipped.push({ id: ids.join(','), reason: 'a merge needs at least two distinct memories' });
      continue;
    }
    if (ids.length > MAX_GROUP_MEMOS) {
      result.skipped.push({ id: ids.join(','), reason: `at most ${MAX_GROUP_MEMOS} memories per merge` });
      continue;
    }
    const sources: MemoryMemo[] = [];
    let blocked: string | undefined;
    for (const id of ids) {
      if (claimed.has(id)) {
        blocked ??= `${id} is already used by another action in this pass`;
        continue;
      }
      const memo = await store.get(id);
      if (memo === undefined) {
        blocked ??= `${id} does not exist`;
        continue;
      }
      if (isDistilledRule(memo) && merge.allowSupersede !== true) {
        blocked ??= `${id} already carries a rule; set allowSupersede to replace it`;
        continue;
      }
      sources.push(memo);
    }
    if (blocked !== undefined || sources.length < 2) {
      result.skipped.push({ id: ids.join(','), reason: blocked ?? 'nothing left to merge' });
      continue;
    }

    const rule = merge.merged.distilled.trim();
    const check = checkRuleSentence(rule);
    if (!check.ok) {
      result.skipped.push({ id: ids.join(','), reason: `merged rule rejected: ${check.reason ?? 'unknown'}` });
      continue;
    }

    const recordedAt = Date.now();
    const merged = createMemoryMemo({
      id: `memo-${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      recordedAt,
      userNeed: merge.merged.userNeed,
      approach: merge.merged.approach,
      outcome: merge.merged.outcome,
      whatFailed: merge.merged.whatFailed,
      whatWorked: merge.merged.whatWorked,
      tags: merge.merged.tags ?? sources.flatMap((memo) => memo.tags ?? []),
      projectDir: sources[0]!.projectDir,
      sourceSessionId: sources[0]!.sourceSessionId,
      sourceSessionTitle: sources[0]!.sourceSessionTitle,
      extractionSource: sources[0]!.extractionSource,
      distilled: rule,
      distilledFrom: sources.map(
        (memo): DistilledSource => ({
          id: memo.id,
          title: clip(memo.userNeed, CAP_OUTCOME),
          at: memo.recordedAt,
        }),
      ),
      distilledAt: recordedAt,
      origin: 'dream',
    });

    await store.append(merged);
    // The snapshot is what makes a merge undoable: without it, "merged by
    // mistake" would be unrecoverable.
    await store.recordMerge(merged.id, sources);
    for (const memo of sources) {
      await store.delete(memo.id);
      claimed.add(memo.id);
    }
    result.merged.push({ mergedId: merged.id, sourceIds: sources.map((memo) => memo.id), mergeId: merged.id });
  }

  for (const distillation of input.distillations) {
    const memo = await store.get(distillation.memoId);
    if (memo === undefined) {
      result.skipped.push({ id: distillation.memoId, reason: 'does not exist' });
      continue;
    }
    if (claimed.has(memo.id)) {
      result.skipped.push({ id: memo.id, reason: 'already used by another action in this pass' });
      continue;
    }
    const check = checkRuleSentence(distillation.distilled);
    if (!check.ok) {
      result.skipped.push({ id: memo.id, reason: `rule rejected: ${check.reason ?? 'unknown'}` });
      continue;
    }
    const distilledAt = Date.now();
    await store.update(memo.id, {
      distilled: distillation.distilled.trim(),
      distilledAt,
      // The memo keeps its own origin: the person recorded it, dream only
      // added the conclusion.
      distilledFrom: memo.distilledFrom ?? [
        { id: memo.id, title: clip(memo.userNeed, CAP_OUTCOME), at: memo.recordedAt },
      ],
    });
    claimed.add(memo.id);
    result.distilled.push(memo.id);
  }

  for (const induction of input.inductions) {
    const ids = [...new Set(induction.sourceMemoIds)];
    if (ids.length < 3) {
      result.skipped.push({ id: induction.topic, reason: 'an induction needs at least three source memories' });
      continue;
    }
    const sources: MemoryMemo[] = [];
    for (const id of ids) {
      const memo = await store.get(id);
      if (memo === undefined) {
        result.skipped.push({ id: induction.topic, reason: `${id} does not exist` });
        sources.length = 0;
        break;
      }
      sources.push(memo);
    }
    if (sources.length !== ids.length) continue;

    const rule = induction.rule.distilled.trim();
    const check = checkRuleSentence(rule);
    if (!check.ok) {
      result.skipped.push({ id: induction.topic, reason: `rule rejected: ${check.reason ?? 'unknown'}` });
      continue;
    }

    const recordedAt = Date.now();
    const induced = createMemoryMemo({
      id: `memo-${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      recordedAt,
      userNeed: induction.rule.userNeed,
      approach: induction.rule.approach,
      outcome: '归纳规则',
      whatFailed: 'none',
      whatWorked: rule,
      tags: induction.rule.tags ?? [...new Set(sources.flatMap((memo) => memo.tags ?? []))],
      projectDir: sources[0]!.projectDir,
      sourceSessionId: sources[0]!.sourceSessionId,
      sourceSessionTitle: sources[0]!.sourceSessionTitle,
      extractionSource: sources[0]!.extractionSource,
      distilled: rule,
      distilledFrom: sources.map(
        (memo): DistilledSource => ({
          id: memo.id,
          title: clip(memo.userNeed, CAP_OUTCOME),
          at: memo.recordedAt,
        }),
      ),
      distilledAt: recordedAt,
      origin: 'dream',
    });
    // Induction is additive on purpose: the sources stay exactly as they were.
    await store.append(induced);
    result.induced.push(induced.id);
  }

  // Stamp only what this pass actually handled. Marking everything pending
  // would let an empty or fully-rejected call swallow the whole backlog — the
  // next runs would propose nothing and /dream would look broken. Anything not
  // acted on stays pending and comes back next time.
  await store.markDreamed([...claimed, ...result.distilled, ...result.induced]);

  return result;
}

export { MERGE_SIMILARITY, NEAR_MISS_SIMILARITY, MERGE_SIMILARITY_KEYWORD, CAP_RULE };
