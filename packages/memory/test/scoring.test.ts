import { describe, it, expect } from 'vitest';

import {
  buildProjectTagCloud,
  computeRelevanceScore,
  rankMemos,
} from '../src/scoring.js';
import type { MemoryMemoSummary } from '../src/models.js';

function makeMemo(
  overrides: Partial<MemoryMemoSummary> & { id: string },
): MemoryMemoSummary {
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
  };
}

describe('computeRelevanceScore', () => {
  it('gives a higher score to same-project memos', () => {
    const sameProject = makeMemo({
      id: 'same',
      userNeed: 'Fix auth bug',
      approach: 'Add jwt refresh',
      projectDir: '/workspace/project',
    });
    const otherProject = makeMemo({
      id: 'other',
      userNeed: 'Fix auth bug',
      approach: 'Add jwt refresh',
      projectDir: '/workspace/other',
    });

    const sameScore = computeRelevanceScore(
      sameProject,
      'auth jwt',
      0,
      '/workspace/project',
    );
    const otherScore = computeRelevanceScore(
      otherProject,
      'auth jwt',
      0,
      '/workspace/project',
    );

    expect(sameScore).toBeGreaterThan(otherScore);
  });

  it('counts the latest distillation towards keyword overlap', () => {
    const recordedAt = Date.now();
    const withDistilled = makeMemo({
      id: 'distilled',
      userNeed: '修构建',
      approach: '别的方法',
      recordedAt,
      distilled: 'redis 连接池要复用',
    });
    const without = makeMemo({
      id: 'plain',
      userNeed: '修构建',
      approach: '别的方法',
      recordedAt,
    });

    expect(computeRelevanceScore(withDistilled, 'redis')).toBeGreaterThan(
      computeRelevanceScore(without, 'redis'),
    );
  });

  it('boosts memos that share tags with the project tag cloud', () => {    const cloud = new Set(['react']);
    const tagged = makeMemo({
      id: 'tagged',
      userNeed: 'Fix bug',
      approach: 'Change config',
      tags: ['react'],
    });
    const untagged = makeMemo({
      id: 'untagged',
      userNeed: 'Fix bug',
      approach: 'Change config',
    });

    const taggedScore = computeRelevanceScore(tagged, 'bug', 0, '/workspace/project', cloud);
    const untaggedScore = computeRelevanceScore(untagged, 'bug', 0, '/workspace/project', cloud);

    expect(taggedScore).toBeGreaterThan(untaggedScore);
  });
});

describe('rankMemos', () => {
  it('ranks same-project memo above cross-project memo for equal keywords', () => {
    const memos = [
      makeMemo({
        id: 'other',
        userNeed: 'Deploy to production',
        approach: 'Use docker compose',
        projectDir: '/workspace/other',
      }),
      makeMemo({
        id: 'same',
        userNeed: 'Deploy to production',
        approach: 'Use docker compose',
        projectDir: '/workspace/project',
      }),
    ];

    const ranked = rankMemos(memos, 'deploy docker', {
      currentProjectDir: '/workspace/project',
      projectTagCloud: buildProjectTagCloud(memos, '/workspace/project'),
      minScore: 0,
      maxResults: 5,
    });

    expect(ranked[0]!.memo.id).toBe('same');
    expect(ranked[1]!.memo.id).toBe('other');
  });

  it('ranks memos with project tag overlap higher', () => {
    const memos = [
      makeMemo({
        id: 'overlap',
        userNeed: 'Build landing page',
        approach: 'Use nextjs',
        projectDir: '/workspace/other',
        tags: ['react'],
      }),
      makeMemo({
        id: 'none',
        userNeed: 'Build landing page',
        approach: 'Use nextjs',
        projectDir: '/workspace/other',
        tags: ['vue'],
      }),
    ];

    const ranked = rankMemos(memos, 'landing page', {
      currentProjectDir: '/workspace/project',
      projectTagCloud: new Set(['react']),
      minScore: 0,
      maxResults: 5,
    });

    expect(ranked[0]!.memo.id).toBe('overlap');
    expect(ranked[1]!.memo.id).toBe('none');
  });
});

describe('buildProjectTagCloud', () => {
  it('collects unique tags from the current project only', () => {
    const memos = [
      makeMemo({ id: 'a', projectDir: '/workspace/project', tags: ['react'] }),
      makeMemo({ id: 'b', projectDir: '/workspace/project', tags: ['auth', 'react'] }),
      makeMemo({ id: 'c', projectDir: '/workspace/other', tags: ['vue'] }),
    ];

    const cloud = buildProjectTagCloud(memos, '/workspace/project');
    expect([...cloud]).toEqual(['react', 'auth']);
  });
});
