import { describe, expect, it } from 'vitest';

import { queuedNotice } from '#/line/notices';

describe('queuedNotice', () => {
  it('says it was received, how far back it is, and how to abort', () => {
    expect(queuedNotice(1)).toBe('收到，前面还有 1 条在处理中。回复 /stop 可中止当前任务。');
    expect(queuedNotice(3)).toContain('前面还有 3 条');
    expect(queuedNotice(1)).toContain('/stop');
  });
});
