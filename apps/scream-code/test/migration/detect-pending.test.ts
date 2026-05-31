import { describe, expect, it } from 'vitest';
import { detectPendingMigration } from '#/migration/detect-pending';

describe('detectPendingMigration', () => {
  it('always returns null (migration feature disabled)', async () => {
    const plan = await detectPendingMigration({
      sourceHome: '/any/source',
      targetHome: '/any/target',
    });
    expect(plan).toBeNull();
  });
});
