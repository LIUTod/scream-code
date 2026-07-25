import { describe, expect, it } from 'vitest';

import { GraderEmissionGuard } from '../../../../src/tools/builtin/goal/emission-guard';

describe('GraderEmissionGuard', () => {
  it('returns normalized text for first occurrence of actionable feedback', () => {
    const guard = new GraderEmissionGuard();
    const result = guard.filter('Tests are failing in auth module.', 'build-app');
    expect(result).toBe('Tests are failing in auth module.');
  });

  it('returns null for empty string', () => {
    const guard = new GraderEmissionGuard();
    expect(guard.filter('', 'goal-1')).toBeNull();
    expect(guard.filter('   ', 'goal-1')).toBeNull();
  });

  it('filters content-free English phrases', () => {
    const guard = new GraderEmissionGuard();
    expect(guard.filter('redo', 'goal-1')).toBeNull();
    expect(guard.filter('try again', 'goal-1')).toBeNull();
    expect(guard.filter('not good enough', 'goal-1')).toBeNull();
    expect(guard.filter('fix it', 'goal-1')).toBeNull();
    expect(guard.filter('wrong', 'goal-1')).toBeNull();
  });

  it('filters content-free Chinese phrases', () => {
    const guard = new GraderEmissionGuard();
    expect(guard.filter('重做', 'goal-1')).toBeNull();
    expect(guard.filter('不对', 'goal-1')).toBeNull();
    expect(guard.filter('不行', 'goal-1')).toBeNull();
    expect(guard.filter('继续', 'goal-1')).toBeNull();
  });

  it('does not filter short phrases that are actionable', () => {
    const guard = new GraderEmissionGuard();
    expect(guard.filter('Fix the bug', 'goal-1')).toBe('Fix the bug');
    expect(guard.filter('Add tests', 'goal-1')).toBe('Add tests');
  });

  it('deduplicates exact same feedback within same goal', () => {
    const guard = new GraderEmissionGuard();
    const feedback = 'The auth module is missing error handling for expired tokens.';
    expect(guard.filter(feedback, 'goal-1')).toBe(feedback);
    expect(guard.filter(feedback, 'goal-1')).toBeNull();
  });

  it('deduplicates case-insensitively', () => {
    const guard = new GraderEmissionGuard();
    expect(guard.filter('Fix the auth bug', 'goal-1')).toBe('Fix the auth bug');
    expect(guard.filter('fix the AUTH bug', 'goal-1')).toBeNull();
  });

  it('deduplicates after NFKC normalization', () => {
    const guard = new GraderEmissionGuard();
    // Fullwidth 'A' (U+FF21) normalizes to ASCII 'A' under NFKC.
    const fullwidth = 'Ａuth module broken';
    const ascii = 'Auth module broken';
    expect(guard.filter(fullwidth, 'goal-1')).toBe(ascii);
    expect(guard.filter(ascii, 'goal-1')).toBeNull();
  });

  it('keeps different feedback within the same goal', () => {
    const guard = new GraderEmissionGuard();
    expect(guard.filter('Fix auth bug', 'goal-1')).toBe('Fix auth bug');
    expect(guard.filter('Add unit tests', 'goal-1')).toBe('Add unit tests');
    expect(guard.filter('Update docs', 'goal-1')).toBe('Update docs');
  });

  it('isolates deduplication buckets per goal', () => {
    const guard = new GraderEmissionGuard();
    const feedback = 'Fix the auth bug';
    expect(guard.filter(feedback, 'goal-A')).toBe(feedback);
    // Same feedback in a different goal is NOT a duplicate.
    expect(guard.filter(feedback, 'goal-B')).toBe(feedback);
  });

  it('evicts oldest entries when bucket exceeds max size', () => {
    const guard = new GraderEmissionGuard();
    // Fill with 16 unique entries (max capacity).
    for (let i = 0; i < 16; i++) {
      expect(guard.filter(`feedback-${i}`, 'goal-1')).toBe(`feedback-${i}`);
    }
    // 17th entry evicts the oldest; feedback-0 should be re-acceptable.
    expect(guard.filter('feedback-16', 'goal-1')).toBe('feedback-16');
    expect(guard.filter('feedback-0', 'goal-1')).toBe('feedback-0');
  });

  it('resetGoal clears the bucket for that goal only', () => {
    const guard = new GraderEmissionGuard();
    guard.filter('shared feedback', 'goal-A');
    guard.filter('shared feedback', 'goal-B');
    guard.resetGoal('goal-A');
    // goal-A bucket cleared, same feedback accepted again.
    expect(guard.filter('shared feedback', 'goal-A')).toBe('shared feedback');
    // goal-B bucket intact, still deduplicated.
    expect(guard.filter('shared feedback', 'goal-B')).toBeNull();
  });
});
