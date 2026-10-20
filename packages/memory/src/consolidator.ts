import type {
  DigestEvidence,
  DigestKind,
  MemoryDigest,
  MemoryMemo,
  MemoryMemoSummary,
  SupersededStatement,
} from './models.js';
import { generateDigestId } from './models.js';
import type { MemoryMemoStore } from './store.js';
import { STOP_WORDS, computeKeywordSimilarity } from './scoring.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Limits that bound the two memory layers.
 *
 * A memo is never deleted to make room for a digest: /dream folds it into a
 * card first, and only the grace window (or the episodic TTL) reclaims it.
 */
export const DREAM_CONSTANTS = {
  /** Active memos beyond this are pruned by least-recently-hit (manual memos are kept). */
  ACTIVE_MEMO_CAP: 2000,
  /** Digests beyond this are evicted, dormant-first. */
  DIGEST_CAP: 200,
  /** How long a digested memo stays restorable before it is physically deleted. */
  GRACE_DAYS: 14,
  /** Unfolded, never-hit episodic memos older than this are reclaimed. */
  EPISODIC_TTL_DAYS: 90,
  /** Digests unconfirmed this long and never hit become dormant (not deleted). */
  DORMANT_DAYS: 180,
  /** Cosine similarity at or above which two memo embeddings share a topic. */
  VECTOR_THRESHOLD: 0.82,
  /** Keyword Jaccard used when no embeddings are available. */
  KEYWORD_THRESHOLD: 0.45,
  /** Newest active memos considered by one dream run. */
  MAX_CANDIDATES: 200,
} as const;

/** Digest rows scanned when matching topics and reporting totals. */
const DIGEST_SCAN_LIMIT = 10_000;
/** Memos quoted per cluster so the model can judge the topic. */
const CLUSTER_SAMPLE_SIZE = 3;
/** Historical statements one digest keeps. */
const MAX_SUPERSEDED = 10;
/** Evidence entries one digest keeps (newest win). */
const MAX_EVIDENCE = 20;

/** One memo quoted in a cluster so the model can judge what the group is about. */
export interface DreamClusterSample {
  id: string;
  userNeed: string;
  approach: string;
  outcome: string;
  recordedAt: number;
}

/** A proposed topic group. Nothing is written or deleted until apply. */
export interface DreamCluster {
  id: string;
  /** Short phrase shared by the group's memos; a hint, not the final digest topic. */
  topicHint: string;
  memoIds: string[];
  /** Newest few memos, for the preview only. */
  sample: DreamClusterSample[];
  /** Oldest evidence timestamp across the whole cluster (not just the sample). */
  recordedFrom: number;
  /** Newest evidence timestamp across the whole cluster. */
  recordedTo: number;
  /** Rough classification to start from when writing the digest. */
  kindGuess: DigestKind;
}

export interface DreamPlanMaintenance {
  /** Digested memos whose grace window has already passed. */
  expiredDigested: number;
  /** Unfolded episodic memos past the TTL. */
  expiredEpisodic: number;
  /** Active memos above ACTIVE_MEMO_CAP. */
  overCap: number;
  /** Digests that would be marked dormant. */
  dormant: number;
}

export interface DreamPlan {
  clusters: DreamCluster[];
  existingDigests: Array<{ id: string; topic: string; kind: DigestKind }>;
  maintenance: DreamPlanMaintenance;
  summary: {
    totalMemos: number;
    clusters: number;
    estimatedLlmCalls: number;
  };
}

/** The digest the model writes for one cluster. */
export interface DreamDigestDraft {
  topic: string;
  kind: DigestKind;
  /** One concise rule a future turn can act on. */
  statement: string;
  confidence: 'high' | 'medium' | 'low';
  /** Memos backing the statement; must be a subset of the cluster's memoIds. */
  evidenceIds: string[];
}

export interface DreamClusterInput {
  memoIds: string[];
  digest: DreamDigestDraft;
}

export interface DreamApplyInput {
  clusters: DreamClusterInput[];
  /**
   * Undo a previous induction inside its grace window: restores the memos it
   * folded and deletes the card. Runs before any cluster is applied.
   */
  undoDigestId?: string;
}

export interface DreamApplyResult {
  /** New digests created. */
  created: number;
  /** Existing digests refreshed (statement updated or re-confirmed). */
  updated: number;
  /** Memos folded into a digest and moved to `digested`. */
  archived: number;
  /** Memos restored by an undo request. */
  restored: number;
  deletedExpired: number;
  deletedStale: number;
  /** Digests evicted to stay under DIGEST_CAP. */
  evicted: number;
  /** Digests newly marked dormant. */
  dormant: number;
  totalMemos: number;
  totalDigests: number;
}

interface ValidatedCluster {
  memoIds: string[];
  evidenceIds: string[];
  digest: DreamDigestDraft;
}

/**
 * Build a read-only dream plan: which active memos cluster into topics, which
 * digests already exist, and how much maintenance is pending.
 *
 * Clustering uses memo embeddings when the store has an available engine,
 * otherwise keyword similarity. Pairs without vectors fall back to keywords, so
 * a partially embedded store still clusters. Nothing is written here.
 */
export async function buildDreamPlan(
  store: MemoryMemoStore,
  options?: { projectDir?: string },
): Promise<DreamPlan> {
  const now = Date.now();
  const listed = await store.list({
    limit: DREAM_CONSTANTS.MAX_CANDIDATES,
    ...(options?.projectDir === undefined ? {} : { projectDir: options.projectDir }),
  });
  // `listed.total` counts active memos only; the store can still hold memos in
  // their grace window. "Empty" must mean the table is genuinely empty,
  // otherwise a second /dream run would report an empty library and hide the
  // pending maintenance work.
  const totalRow = await store.list({ limit: 1, includeDigested: true });
  const clusters = await clusterMemos(store, listed.memos, options?.projectDir);
  const activeDigests = await store.listDigests({
    status: 'active',
    limit: DREAM_CONSTANTS.DIGEST_CAP,
  });
  const maintenance = await countMaintenance(store, listed.total, activeDigests, now);

  return {
    clusters,
    existingDigests: activeDigests.map((digest) => ({
      id: digest.id,
      topic: digest.topic,
      kind: digest.kind,
    })),
    maintenance,
    summary: {
      totalMemos: totalRow.total,
      clusters: clusters.length,
      estimatedLlmCalls: clusters.length,
    },
  };
}

/**
 * Apply model-written digests: create or refresh cards, mark folded memos as
 * `digested` (they are *not* deleted — the grace window reclaims them later),
 * then run maintenance.
 *
 * Validation runs over every cluster before the first write, so a single
 * out-of-range evidence id aborts the whole batch without touching the store.
 */
export async function applyDreamPlan(
  store: MemoryMemoStore,
  input: DreamApplyInput,
): Promise<DreamApplyResult> {
  const validated = (input.clusters ?? []).map((cluster, index) =>
    validateCluster(cluster, index),
  );
  const now = Date.now();
  let restored = 0;
  if (input.undoDigestId !== undefined && input.undoDigestId.length > 0) {
    restored = await store.restoreMemosFromDigest(input.undoDigestId);
    await store.deleteDigest(input.undoDigestId);
  }
  const existing = await store.listDigests({ limit: DIGEST_SCAN_LIMIT });
  // Scope matters: the same topic in two projects is two different rules.
  const digestsByTopic = new Map<string, MemoryDigest>(
    existing.map((digest) => [digestKey(digest.topic, digest.appliesTo), digest]),
  );

  let created = 0;
  let updated = 0;
  let archived = 0;

  for (const cluster of validated) {
    const active: MemoryMemo[] = [];
    for (const id of cluster.memoIds) {
      const memo = await store.get(id);
      // A memo deleted or folded between plan and apply is skipped, not revived.
      if (memo === undefined || (memo.status ?? 'active') !== 'active') continue;
      active.push(memo);
    }
    if (active.length === 0) continue;

    const evidenceMemos = cluster.evidenceIds
      .map((id) => active.find((memo) => memo.id === id))
      .filter((memo): memo is MemoryMemo => memo !== undefined);
    // Never build a card whose cited evidence no longer exists.
    if (evidenceMemos.length === 0) continue;

    const evidence: DigestEvidence[] = evidenceMemos.map((memo) => ({
      id: memo.id,
      title: memo.userNeed.slice(0, 80),
      at: memo.recordedAt,
    }));
    const appliesTo = sharedProjectDir(active);
    const topic = cleanTopic(cluster.digest.topic);
    const key = digestKey(topic, appliesTo);
    const prior = digestsByTopic.get(key);

    let digest: MemoryDigest;
    if (prior === undefined) {
      digest = {
        id: generateDigestId(),
        topic,
        kind: cluster.digest.kind,
        statement: cluster.digest.statement.trim(),
        appliesTo,
        confidence: cluster.digest.confidence,
        evidence,
        evidenceFrom: Math.min(...evidence.map((entry) => entry.at)),
        evidenceTo: Math.max(...evidence.map((entry) => entry.at)),
        createdAt: now,
        updatedAt: now,
        lastConfirmedAt: now,
        hitCount: 0,
        status: 'active',
      };
      created += 1;
    } else {
      const statement = cluster.digest.statement.trim();
      const statementChanged =
        normalizeStatement(prior.statement) !== normalizeStatement(statement);
      const mergedEvidence = mergeEvidence(prior.evidence, evidence);
      const superseded: SupersededStatement[] | undefined = statementChanged
        ? [...(prior.superseded ?? []), { statement: prior.statement, at: prior.updatedAt }].slice(
            -MAX_SUPERSEDED,
          )
        : prior.superseded;
      digest = {
        ...prior,
        topic,
        kind: cluster.digest.kind,
        statement,
        appliesTo,
        confidence: cluster.digest.confidence,
        evidence: mergedEvidence,
        evidenceFrom: Math.min(...mergedEvidence.map((entry) => entry.at)),
        evidenceTo: Math.max(...mergedEvidence.map((entry) => entry.at)),
        // `updatedAt` tracks the conclusion itself; an unchanged statement only
        // moves `lastConfirmedAt`.
        updatedAt: statementChanged ? now : prior.updatedAt,
        lastConfirmedAt: now,
        // Re-deriving a dormant card puts it back in the injection pool.
        status: 'active',
        superseded,
      };
      updated += 1;
    }

    await store.upsertDigest(digest);
    digestsByTopic.set(key, digest);
    archived += await store.markMemosDigested(
      active.map((memo) => memo.id),
      digest.id,
      now,
    );
    await embedDigest(store, digest);
  }

  const maintenanceAt = Date.now();
  const deletedExpired = await store.deleteDigestedBefore(
    maintenanceAt - DREAM_CONSTANTS.GRACE_DAYS * DAY_MS,
  );
  const deletedStale = await store.deleteStaleEpisodicBefore(
    maintenanceAt - DREAM_CONSTANTS.EPISODIC_TTL_DAYS * DAY_MS,
  );
  await store.pruneActiveMemos(DREAM_CONSTANTS.ACTIVE_MEMO_CAP);
  const dormant = await store.markDigestsDormant(
    maintenanceAt - DREAM_CONSTANTS.DORMANT_DAYS * DAY_MS,
  );
  const evicted = await store.evictDigests(DREAM_CONSTANTS.DIGEST_CAP);
  const totalMemos = (await store.list({ limit: 1, includeDigested: true })).total;
  const totalDigests = (await store.listDigests({ limit: DIGEST_SCAN_LIMIT })).length;

  return {
    created,
    updated,
    archived,
    restored,
    deletedExpired,
    deletedStale,
    evicted,
    dormant,
    totalMemos,
    totalDigests,
  };
}

/**
 * Identity of a rule: the same topic in two projects is two different rules,
 * and a global card is different from a project-scoped one.
 */
function digestKey(topic: string, appliesTo: string | undefined): string {
  return `${normalizeTopic(topic)}|${appliesTo ?? ''}`;
}

function validateCluster(cluster: DreamClusterInput, index: number): ValidatedCluster {
  const label = `cluster ${index + 1}`;
  const memoIds = [...new Set(cluster.memoIds ?? [])];
  if (memoIds.length === 0) {
    throw new Error(`Dream ${label} has no memoIds`);
  }
  const digest = cluster.digest;
  if (digest === undefined) {
    throw new Error(`Dream ${label} has no digest`);
  }
  if (digest.topic.trim().length === 0) {
    throw new Error(`Dream ${label} has an empty topic`);
  }
  if (digest.statement.trim().length === 0) {
    throw new Error(`Dream ${label} has an empty statement`);
  }
  const evidenceIds = [...new Set(digest.evidenceIds ?? [])];
  if (evidenceIds.length === 0) {
    throw new Error(`Dream ${label} has no evidenceIds`);
  }
  const allowed = new Set(memoIds);
  for (const id of evidenceIds) {
    if (!allowed.has(id)) {
      throw new Error(`Dream ${label} cites evidence ${id} outside its memoIds`);
    }
  }
  return { memoIds, evidenceIds, digest };
}

async function clusterMemos(
  store: MemoryMemoStore,
  memos: MemoryMemoSummary[],
  projectDir: string | undefined,
): Promise<DreamCluster[]> {
  if (memos.length < 2) return [];

  const engine = store.getEmbeddingEngine();
  const cosine =
    engine !== undefined && engine.available
      ? (a: Float32Array, b: Float32Array): number => engine.cosineSimilarity(a, b)
      : undefined;

  // Vectors are only usable with an engine (it owns the similarity math); a
  // store without one clusters on keywords instead.
  const vectors = new Map<string, Float32Array>();
  if (cosine !== undefined) {
    const known = new Set(memos.map((memo) => memo.id));
    for (const row of await store.listMemoEmbeddings(projectDir)) {
      if (!known.has(row.memoId) || row.vector.length === 0) continue;
      vectors.set(row.memoId, Float32Array.from(row.vector));
    }
  }

  // Union-find over candidate ids: similarity is transitive within a topic.
  const parent = new Map<string, string>(memos.map((memo) => [memo.id, memo.id]));
  const find = (id: string): string => {
    let root = id;
    for (;;) {
      const next = parent.get(root);
      if (next === undefined || next === root) break;
      root = next;
    }
    let cursor = id;
    while (cursor !== root) {
      const next = parent.get(cursor);
      if (next === undefined) break;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  for (let i = 0; i < memos.length; i++) {
    const first = memos[i]!;
    for (let j = i + 1; j < memos.length; j++) {
      const second = memos[j]!;
      const firstVector = vectors.get(first.id);
      const secondVector = vectors.get(second.id);
      const similar =
        cosine !== undefined && firstVector !== undefined && secondVector !== undefined
          ? cosine(firstVector, secondVector) >= DREAM_CONSTANTS.VECTOR_THRESHOLD
          : keywordSimilarity(first, second) >= DREAM_CONSTANTS.KEYWORD_THRESHOLD;
      if (similar) union(first.id, second.id);
    }
  }

  const groups = new Map<string, MemoryMemoSummary[]>();
  for (const memo of memos) {
    const root = find(memo.id);
    const group = groups.get(root);
    if (group === undefined) {
      groups.set(root, [memo]);
    } else {
      group.push(memo);
    }
  }

  const clusters = [...groups.values()]
    .filter((group) => group.length >= 2)
    .map((group) => [...group].toSorted((a, b) => b.recordedAt - a.recordedAt))
    .toSorted(
      (a, b) =>
        b.length - a.length || (b[0]?.recordedAt ?? 0) - (a[0]?.recordedAt ?? 0),
    );

  return clusters.map((group, index) => ({
    id: `cluster-${index + 1}`,
    topicHint: buildTopicHint(group),
    memoIds: group.map((memo) => memo.id),
    sample: group.slice(0, CLUSTER_SAMPLE_SIZE).map((memo) => ({
      id: memo.id,
      userNeed: memo.userNeed,
      approach: memo.approach,
      outcome: memo.outcome,
      recordedAt: memo.recordedAt,
    })),
    recordedFrom: Math.min(...group.map((memo) => memo.recordedAt)),
    recordedTo: Math.max(...group.map((memo) => memo.recordedAt)),
    kindGuess: guessKind(group),
  }));
}

function keywordSimilarity(a: MemoryMemoSummary, b: MemoryMemoSummary): number {
  return computeKeywordSimilarity(
    a,
    `${b.userNeed} ${b.approach} ${b.whatFailed} ${b.whatWorked}`,
  );
}

/** Words shared by every memo in the group (ASCII words + CJK bigrams). */
function buildTopicHint(memos: MemoryMemoSummary[]): string {
  let shared: Set<string> | undefined;
  for (const memo of memos) {
    const tokens = topicTokens(`${memo.userNeed} ${memo.approach} ${(memo.tags ?? []).join(' ')}`);
    shared =
      shared === undefined
        ? tokens
        : new Set([...shared].filter((token) => tokens.has(token)));
  }
  const anchors = [...(shared ?? [])].filter((token) => token.length >= 2).toSorted();
  if (anchors.length > 0) return anchors.slice(0, 4).join(' ');
  const newest = memos.reduce((a, b) => (a.recordedAt >= b.recordedAt ? a : b));
  return newest.userNeed.slice(0, 60);
}

function topicTokens(text: string): Set<string> {
  const lower = text.toLowerCase();
  const tokens = new Set<string>();
  for (const match of lower.matchAll(/[a-z0-9]+/g)) {
    if (match[0].length >= 3 && !STOP_WORDS.has(match[0])) tokens.add(match[0]);
  }
  for (const match of lower.matchAll(/[一-鿿㐀-䶿]+/g)) {
    const run = match[0];
    for (let i = 0; i < run.length - 1; i++) {
      tokens.add(run.slice(i, i + 2));
    }
  }
  return tokens;
}

/** Heuristic starting point; the model owns the final `kind`. */
function guessKind(memos: MemoryMemoSummary[]): DigestKind {
  const text = memos
    .map((memo) =>
      [memo.userNeed, memo.approach, memo.whatFailed, memo.whatWorked, ...(memo.tags ?? [])].join(
        ' ',
      ),
    )
    .join(' ')
    .toLowerCase();
  if (/偏好|喜欢|希望|一律|总是|prefer|always|never|不要/.test(text)) return 'preference';
  if (/失败|报错|踩坑|坑|pitfall|error|fail|broken/.test(text)) return 'pitfall';
  if (/流程|步骤|命令|先.*再|step|procedure|how to|用法/.test(text)) return 'procedure';
  return 'fact';
}

async function countMaintenance(
  store: MemoryMemoStore,
  activeTotal: number,
  activeDigests: readonly MemoryDigest[],
  now: number,
): Promise<DreamPlanMaintenance> {
  const graceCutoff = now - DREAM_CONSTANTS.GRACE_DAYS * DAY_MS;
  const episodicCutoff = now - DREAM_CONSTANTS.EPISODIC_TTL_DAYS * DAY_MS;
  const dormantCutoff = now - DREAM_CONSTANTS.DORMANT_DAYS * DAY_MS;

  let expiredDigested = 0;
  let expiredEpisodic = 0;
  // Maintenance is store-wide even when the plan itself is project-scoped.
  for await (const memo of store.read()) {
    if ((memo.status ?? 'active') === 'digested') {
      if (memo.digestedAt !== undefined && memo.digestedAt < graceCutoff) expiredDigested += 1;
      continue;
    }
    if (memo.extractionSource === 'manual') continue;
    if ((memo.kind ?? 'episodic') !== 'episodic') continue;
    if ((memo.lastHitAt ?? memo.recordedAt) >= episodicCutoff) continue;
    expiredEpisodic += 1;
  }

  return {
    expiredDigested,
    expiredEpisodic,
    overCap: Math.max(0, activeTotal - DREAM_CONSTANTS.ACTIVE_MEMO_CAP),
    dormant: activeDigests.filter(
      (digest) => digest.lastConfirmedAt < dormantCutoff && digest.lastHitAt === undefined,
    ).length,
  };
}

function mergeEvidence(
  previous: readonly DigestEvidence[],
  next: readonly DigestEvidence[],
): DigestEvidence[] {
  const merged = new Map<string, DigestEvidence>();
  for (const entry of [...previous, ...next]) merged.set(entry.id, entry);
  return [...merged.values()].toSorted((a, b) => a.at - b.at).slice(-MAX_EVIDENCE);
}

function sharedProjectDir(memos: readonly MemoryMemo[]): string | undefined {
  const dirs = new Set(memos.map((memo) => memo.projectDir ?? ''));
  if (dirs.size !== 1) return undefined;
  const [only] = [...dirs];
  return only === undefined || only === '' ? undefined : only;
}

/** Keep the digest searchable by vector. Failures must not drop an applied card. */
async function embedDigest(store: MemoryMemoStore, digest: MemoryDigest): Promise<void> {
  const engine = store.getEmbeddingEngine();
  if (engine === undefined || !engine.available) return;
  try {
    const vectors = await engine.embedBatch([`${digest.topic}: ${digest.statement}`]);
    const vector = vectors?.[0];
    if (vector === undefined) return;
    await store.setDigestEmbedding(digest.id, [...vector], engine.modelName);
  } catch {
    // Embeddings are an optimisation; the card itself is already persisted.
  }
}

function normalizeTopic(topic: string): string {
  return cleanTopic(topic).toLowerCase();
}

/** Topics are identifiers: outer whitespace trimmed, inner runs collapsed. */
function cleanTopic(topic: string): string {
  return topic.trim().replaceAll(/\s+/g, ' ');
}

function normalizeStatement(statement: string): string {
  return statement.trim().replaceAll(/\s+/g, ' ');
}
