import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryMemoStore } from '../src/store.js';
import { createMemoryMemo, type MemoryMemo } from '../src/models.js';
import { buildConsolidationPlan, applyConsolidation, checkRuleSentence } from '../src/consolidator.js';
import { buildEmbeddingText, type EmbeddingEngine } from '../src/embeddings.js';

/**
 * /dream is a distiller, not a janitor. These tests lock that in:
 * - nothing is removed for being old (only an explicit merge replaces sources,
 *   and it is undoable)
 * - duplicates are judged with the same cosine measure recall uses
 * - a pass is incremental, so running it twice does nothing the second time
 * - the plan stays small enough to be echoed back through a tool call
 */

function makeMemo(id: string, overrides: Partial<Omit<MemoryMemo, 'id'>> = {}): MemoryMemo {
  return {
    sourceSessionId: 's1',
    sourceSessionTitle: 'Session',
    userNeed: 'Need',
    approach: 'Approach',
    outcome: '完成',
    whatFailed: 'none',
    whatWorked: 'none',
    extractionSource: 'exit',
    recordedAt: Date.now(),
    projectDir: '',
    ...overrides,
    id,
  };
}

/** Engine whose vectors are looked up by exact embedded text, so a test can
 * decide similarity instead of hoping a hash lands somewhere useful. */
function makeEngine(vectors: Map<string, Float32Array>): EmbeddingEngine {
  return {
    available: true,
    modelName: 'fake',
    embedBatch: async (texts) => texts.map((text) => vectors.get(text) ?? new Float32Array([1, 0, 0])),
    cosineSimilarity: (a, b) => {
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < a.length; i += 1) {
        dot += a[i]! * b[i]!;
        na += a[i]! * a[i]!;
        nb += b[i]! * b[i]!;
      }
      return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
    },
    ensureReady: async () => true,
  };
}

/** Let the debounced embedding flush run to completion. */
async function settleFlush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(2_100);
  for (let i = 0; i < 20; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const vec = (...values: number[]): Float32Array => Float32Array.from(values);

describe('/dream plan', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-dream-test-'));
    store = new MemoryMemoStore(tmpDir);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('reports nothing to do for an empty library', async () => {
    const plan = await buildConsolidationPlan(store);
    expect(plan).toMatchObject({
      version: 2,
      duplicateGroups: [],
      nearMisses: [],
      distillCandidates: [],
      inductionClusters: [],
    });
    expect(plan.summary.totalMemos).toBe(0);
  });

  it('groups identical memories using stored vectors, not keywords', async () => {
    const vectors = new Map<string, Float32Array>();
    const engine = makeEngine(vectors);
    const a = makeMemo('a', { userNeed: '部署时 npm 404', approach: '等 CDN 传播', whatWorked: '重试' });
    const b = makeMemo('b', { userNeed: '部署时 npm 404', approach: '等 CDN 传播', whatWorked: '重试' });
    const c = makeMemo('c', { userNeed: '完全不同的另一件事', approach: '另一种做法', whatWorked: '别的' });
    vectors.set(buildEmbeddingText(a as never), vec(1, 0, 0));
    vectors.set(buildEmbeddingText(b as never), vec(1, 0, 0));
    vectors.set(buildEmbeddingText(c as never), vec(0, 1, 0));
    for (const memo of [a, b, c]) await store.append(memo);

    // The planner reads vectors keyed by memo id (what the store returns).
    const byId = new Map<string, Float32Array>([
      ['a', vec(1, 0, 0)],
      ['b', vec(1, 0, 0)],
      ['c', vec(0, 1, 0)],
    ]);
    const plan = await buildConsolidationPlan(store, { vectors: byId, engine });
    expect(plan.duplicateGroups).toHaveLength(1);
    expect(plan.duplicateGroups[0]!.memos.map((memo) => memo.id).toSorted()).toEqual(['a', 'b']);
    expect(plan.duplicateGroups[0]!.basis).toBe('vector');
    // The starter draft must not carry wrapper prose into the embedded text.
    expect(plan.duplicateGroups[0]!.merged.approach).not.toMatch(/合并\s*\d+\s*条/u);
    expect(plan.duplicateGroups[0]!.merged.distilled).toBe('');
  });

  it('never proposes an old finished memo for removal, only for distillation', async () => {
    const old = makeMemo('old', {
      outcome: '完成',
      recordedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
    });
    await store.append(old);

    const plan = await buildConsolidationPlan(store);
    expect(plan.distillCandidates.map((candidate) => candidate.memo.id)).toEqual(['old']);
    expect(plan.distillCandidates[0]!.why).toBe('completed-7d');
    // There is no deletion list in the plan at all — that is the point.
    expect(JSON.stringify(plan)).not.toMatch(/"resolved"|"stale"/u);
  });

  it('flags an untouched memo as a distillation candidate, not stale garbage', async () => {
    const stale = makeMemo('stale', {
      outcome: '部分完成',
      recordedAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
    });
    await store.append(stale);
    const plan = await buildConsolidationPlan(store);
    expect(plan.distillCandidates[0]).toMatchObject({ why: 'stale-30d' });
  });

  it('skips memos that already carry a rule', async () => {
    await store.append(
      makeMemo('ruled', {
        distilled: '当部署报 404 时先等两分钟再重试',
        recordedAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
      }),
    );
    const plan = await buildConsolidationPlan(store);
    expect(plan.distillCandidates).toHaveLength(0);
    expect(plan.summary.distilledCount).toBe(1);
  });

  it('clusters by shared tag so an induction has a real theme', async () => {
    const memos = ['t1', 't2', 't3'].map((id) =>
      makeMemo(id, { tags: ['deploy', 'npm'], userNeed: `部署问题 ${id}`, approach: `做法 ${id}` }),
    );
    for (const memo of memos) await store.append(memo);
    const plan = await buildConsolidationPlan(store);
    const cluster = plan.inductionClusters.find((entry) => entry.topic === 'deploy');
    expect(cluster?.memos).toHaveLength(3);
  });

  it('is incremental: what a pass handled does not come back', async () => {
    await store.append(makeMemo('x', { recordedAt: Date.now() - 20 * 24 * 60 * 60 * 1000 }));
    const first = await buildConsolidationPlan(store);
    expect(first.distillCandidates).toHaveLength(1);

    await applyConsolidation(store, {
      merges: [],
      distillations: [{ memoId: 'x', distilled: '当遇到这类需要时，先用现有工具确认一遍' }],
      inductions: [],
    });
    const second = await buildConsolidationPlan(store);
    expect(second.summary.unseen).toBe(0);
    expect(second.distillCandidates).toHaveLength(0);
  });

  it('does not consume the backlog when a pass applies nothing', async () => {
    // An accidental empty call (or one where every entry was rejected) must not
    // stamp the whole library as seen — /dream would then look permanently
    // empty while nothing had been done.
    await store.append(makeMemo('pending', { recordedAt: Date.now() - 20 * 24 * 60 * 60 * 1000 }));
    await applyConsolidation(store, { merges: [], distillations: [], inductions: [] });
    const again = await buildConsolidationPlan(store);
    expect(again.summary.unseen).toBe(1);
    expect(again.distillCandidates).toHaveLength(1);
  });

  it('stays inside the budget even with long merge drafts', async () => {
    // A merge draft keeps the newest memo's approach in full (a clipped draft
    // sends the model back to the database), so the budget has to survive
    // several large groups, not just trimmed summaries.
    const vectors = new Map<string, Float32Array>();
    const engine = makeEngine(new Map());
    const long = '这是一段刻意写得很长的做法描述，用来模拟真实记忆里动辄几百字的正文。'.repeat(12);
    for (let g = 0; g < 5; g += 1) {
      for (let i = 0; i < 4; i += 1) {
        const id = `g${g}-${i}`;
        await store.append(makeMemo(id, { userNeed: `第 ${g} 类问题`, approach: long, whatWorked: long }));
        vectors.set(id, g === 0 ? vec(1, 0, 0) : g === 1 ? vec(0, 1, 0) : g === 2 ? vec(0, 0, 1) : g === 3 ? vec(1, 1, 0) : vec(0, 1, 1));
      }
    }
    const plan = await buildConsolidationPlan(store, { vectors, engine, includeSeen: true });
    const json = JSON.stringify(plan);
    expect(json.length).toBeLessThanOrEqual(11_500);
    expect(() => JSON.parse(json) as unknown).not.toThrow();
  });

  it('keeps the plan small enough to be handed back through a tool call', async () => {
    // The old plan serialized to ~254 KB for 87 memos, which no model can echo
    // back as tool arguments. This is the regression guard for that failure.
    for (let i = 0; i < 200; i += 1) {
      await store.append(
        makeMemo(`m${i}`, {
          userNeed: `需要处理第 ${i} 类问题，这段文字刻意写长一些以模拟真实记忆的冗长描述`.repeat(2),
          approach: `做法是先用工具 A 再检查 B，最后确认 C，第 ${i} 次尝试`.repeat(3),
          whatWorked: `有效的方法描述 ${i}`.repeat(2),
          recordedAt: Date.now() - (i + 1) * 24 * 60 * 60 * 1000,
        }),
      );
    }
    const plan = await buildConsolidationPlan(store, { includeSeen: true });
    const json = JSON.stringify(plan);
    // Two separate ceilings: the old planner serialized 87 memos to 254 KB, and
    // the loop truncates any tool result above 5000 tokens — a cut landing in
    // the middle of the JSON leaves the model with an unparsable plan.
    expect(json.length).toBeLessThanOrEqual(11_500);
    expect(Math.round(json.length / 2.6)).toBeLessThan(5000);
    expect(() => JSON.parse(json) as unknown).not.toThrow();
  });
});

describe('/dream apply', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-dream-apply-'));
    store = new MemoryMemoStore(tmpDir);
    store.setEmbeddingEngine(makeEngine(new Map()));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('distils in place: the memo stays, its origin is untouched, a rule is added', async () => {
    await store.append(
      makeMemo('keep', {
        userNeed: '部署后装不上包',
        approach: '等待后重试',
        outcome: '完成',
        origin: 'user',
      }),
    );
    const result = await applyConsolidation(store, {
      merges: [],
      distillations: [{ memoId: 'keep', distilled: '当 npm 刚发布就安装报 404 时，先等两分钟再重试' }],
      inductions: [],
    });
    expect(result.distilled).toEqual(['keep']);
    const after = await store.get('keep');
    expect(after?.distilled).toContain('先等两分钟');
    // The person recorded it; dream only added the conclusion.
    expect(after?.origin).toBe('user');
    expect(after?.distilledFrom?.[0]?.id).toBe('keep');
  });

  it('merges duplicates, keeps lineage, and can be undone', async () => {
    await store.append(makeMemo('d1', { userNeed: '同一件事', approach: '同一种做法' }));
    await store.append(makeMemo('d2', { userNeed: '同一件事', approach: '同一种做法' }));

    const result = await applyConsolidation(store, {
      merges: [
        {
          memoIds: ['d1', 'd2'],
          merged: {
            userNeed: '同一件事',
            approach: '同一种做法',
            outcome: '完成',
            whatFailed: 'none',
            whatWorked: '一次做完',
            distilled: '当遇到同一件事时，直接用同一种做法一次做完',
          },
        },
      ],
      distillations: [],
      inductions: [],
    });

    expect(result.merged).toHaveLength(1);
    const mergedId = result.merged[0]!.mergedId;
    expect(await store.get('d1')).toBeUndefined();
    expect(await store.get('d2')).toBeUndefined();
    const merged = await store.get(mergedId);
    expect(merged?.origin).toBe('dream');
    expect(merged?.distilledFrom?.map((source) => source.id).toSorted()).toEqual(['d1', 'd2']);

    // Undo: sources come back, the merged result goes away.
    expect(await store.revertMerge(result.merged[0]!.mergeId)).toBe(true);
    expect(await store.get('d1')).toBeDefined();
    expect(await store.get('d2')).toBeDefined();
    expect(await store.get(mergedId)).toBeUndefined();
  });

  it('induces a new rule and leaves every source in place', async () => {
    for (const id of ['i1', 'i2', 'i3']) {
      await store.append(makeMemo(id, { tags: ['deploy'], userNeed: `部署问题 ${id}` }));
    }
    const result = await applyConsolidation(store, {
      merges: [],
      distillations: [],
      inductions: [
        {
          topic: 'deploy',
          sourceMemoIds: ['i1', 'i2', 'i3'],
          rule: {
            userNeed: '部署反复失败',
            approach: '先看日志再改配置最后重部署',
            distilled: '当部署反复失败时，先看日志再改配置，不要直接重部署',
          },
        },
      ],
    });
    expect(result.induced).toHaveLength(1);
    // Sources untouched — induction only adds a memory.
    for (const id of ['i1', 'i2', 'i3']) expect(await store.get(id)).toBeDefined();
    const induced = await store.get(result.induced[0]!);
    expect(induced?.origin).toBe('dream');
    expect(induced?.distilledFrom).toHaveLength(3);
  });

  it('refuses to overwrite a rule without allowSupersede', async () => {
    await store.append(makeMemo('r1', { distilled: '当 X 时做 Y', tagged: undefined } as never));
    await store.append(makeMemo('r2'));
    const result = await applyConsolidation(store, {
      merges: [
        {
          memoIds: ['r1', 'r2'],
          merged: {
            userNeed: 'n',
            approach: 'a',
            outcome: '完成',
            whatFailed: 'none',
            whatWorked: 'w',
            distilled: '当遇到 n 时先用 a 再确认 w',
          },
        },
      ],
      distillations: [],
      inductions: [],
    });
    expect(result.merged).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain('allowSupersede');
    expect(await store.get('r1')).toBeDefined();
  });

  it('reports bad entries instead of failing the whole pass', async () => {
    await store.append(makeMemo('ok'));
    const result = await applyConsolidation(store, {
      merges: [{ memoIds: ['missing-1', 'missing-2'], merged: {} as never }],
      distillations: [
        { memoId: 'ok', distilled: '合并 2 条相关记录' },
        { memoId: 'nope', distilled: '当遇到情况时先做一件事' },
      ],
      inductions: [{ topic: 't', sourceMemoIds: ['a', 'b'], rule: { userNeed: 'n', approach: 'a', distilled: '当 x 时先 y' } }],
    });
    expect(result.skipped.length).toBeGreaterThanOrEqual(3);
    // A later entry still lands even though earlier ones were rejected.
    const second = await applyConsolidation(store, {
      merges: [],
      distillations: [{ memoId: 'ok', distilled: '当遇到情况时先做一件事再确认结果' }],
      inductions: [],
    });
    expect(second.distilled).toEqual(['ok']);
  });
});

describe('checkRuleSentence', () => {
  it('rejects only empty, oversized, or bookkeeping entries', () => {
    // Phrasing is the skill's business: a real pass produced 17 usable rules in
    // styles this validator used to reject, and each rejection cost a round.
    expect(checkRuleSentence('合并 3 条相关记录。最新方案: 用了工具').ok).toBe(false);
    expect(checkRuleSentence('3 条相关记录').ok).toBe(false);
    expect(checkRuleSentence('   ').ok).toBe(false);
    expect(checkRuleSentence('x'.repeat(300)).ok).toBe(false);
  });

  it('accepts the shapes real passes produce', () => {
    expect(checkRuleSentence('写架构分析报告时，每条结论都给出载荷点（文件:行）并逐条亲验').ok).toBe(true);
    expect(checkRuleSentence('记录中期备选事项时，每条都标注证据出处与现状差距').ok).toBe(true);
    expect(checkRuleSentence('要给别人看图就用 ReadMediaFile，别直接贴本地路径').ok).toBe(true);
    expect(checkRuleSentence('When the build fails, check the lockfile first').ok).toBe(true);
    // Taken verbatim from a real pass: all of these were rejected by the old
    // phrasing gate, and every rejection cost a full tool round.
    expect(checkRuleSentence("记录架构演进等中期备选事项时，每条都标注参照侧的证据出处与自己的现状差距，将来才能快速追溯。").ok).toBe(true);
    expect(checkRuleSentence("交付前给每条验收标准配一条可复现命令与退出码，用统一脚本汇总，总退出码 0 才算通过——别用叙述代替证据。").ok).toBe(true);
    expect(checkRuleSentence("自查过的并发/边界缺陷往往还在，交给独立 oracle/reviewer 用突变实验与临时探针挖，并立刻固化成可一键复现的脚本。").ok).toBe(true);
  });
});
