import { describe, expect, it } from 'vitest';

import { queuedNotice, tokenCapNotice, tokenCapReply } from '#/line/notices';

describe('queuedNotice', () => {
  it('says it was received, how far back it is, and how to abort', () => {
    expect(queuedNotice(1)).toBe('收到，前面还有 1 条在处理中。回复 /stop 可中止当前任务。');
    expect(queuedNotice(3)).toContain('前面还有 3 条');
    expect(queuedNotice(1)).toContain('/stop');
  });
});

describe('tokenCapNotice', () => {
  it('says what was used against the limit and offers /new, the one way out an IM user has', () => {
    const text = tokenCapNotice({ usedTokens: 5_250_000, limitTokens: 5_000_000 });
    expect(text).toContain('5.3M / 5M');
    expect(text).toContain('已停止调用模型');
    expect(text).toContain('/new');
  });
});

describe('tokenCapReply', () => {
  const cap = { usedTokens: 5_250_000, limitTokens: 5_000_000 };

  it('keeps what the model had already written, then adds the notice', () => {
    const reply = tokenCapReply('  Step one is done: the schema is migrated.  \n', cap);
    expect(reply.startsWith('Step one is done: the schema is migrated.')).toBe(true);
    expect(reply.endsWith(tokenCapNotice(cap))).toBe(true);
  });

  it('is just the notice when nothing was written', () => {
    expect(tokenCapReply('   ', cap)).toBe(tokenCapNotice(cap));
  });
});

