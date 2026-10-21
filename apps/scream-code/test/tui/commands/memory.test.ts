import { getLocale, setLocale } from '@scream-code/config';
import type { MemoryMemoSummary } from '@scream-code/memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatMemoryMemoForInjection } from '#/tui/commands/memory';

function makeSummary(overrides: Partial<MemoryMemoSummary> = {}): MemoryMemoSummary {
  return {
    id: 'memo-test',
    sourceSessionId: 'session-1234567890',
    sourceSessionTitle: 'Session',
    userNeed: 'Fix login token refresh',
    approach: 'Add axios interceptor',
    outcome: '完成',
    whatFailed: 'none',
    whatWorked: 'Interceptor refreshes the token',
    extractionSource: 'exit',
    recordedAt: Date.now(),
    projectDir: '',
    ...overrides,
  };
}

describe('formatMemoryMemoForInjection', () => {
  let originalLocale: ReturnType<typeof getLocale>;

  beforeEach(() => {
    originalLocale = getLocale();
    setLocale('zh');
  });

  afterEach(() => {
    setLocale(originalLocale);
  });

  it('renders the latest distillation line when the memo has one', () => {
    const text = formatMemoryMemoForInjection(
      makeSummary({ distilled: '刷新令牌统一走 axios 拦截器' }),
    );
    expect(text).toContain('- **最新归纳**: 刷新令牌统一走 axios 拦截器');
  });

  it('omits the latest distillation line when it is empty or missing', () => {
    expect(formatMemoryMemoForInjection(makeSummary())).not.toContain('最新归纳');
    expect(formatMemoryMemoForInjection(makeSummary({ distilled: '' }))).not.toContain(
      '最新归纳',
    );
  });

  it('renders the note line when the memo has one', () => {
    const text = formatMemoryMemoForInjection(makeSummary({ note: '先跑 typecheck' }));
    expect(text).toContain('- **笔记**: 先跑 typecheck');
  });
});
