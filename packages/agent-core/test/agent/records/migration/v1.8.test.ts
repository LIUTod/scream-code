import { describe, expect, it } from 'vitest';

import { migrateV1_7ToV1_8 } from '../../../../src/agent/records/migration/v1.8';
import { runMigration } from './utils';

describe('1.7 to 1.8', () => {
  it('passes records through unchanged (additive record type)', () => {
    expect(
      runMigration(migrateV1_7ToV1_8, [
        {
          type: 'metadata',
          protocol_version: '1.7',
          created_at: 1,
        },
        {
          type: 'permission.record_grant_revocation',
          pattern: 'Bash',
        },
      ]),
    ).toMatchInlineSnapshot(`
      [wire] metadata                             { "protocol_version": "1.8", "created_at": "<time>" }
      [wire] permission.record_grant_revocation   { "pattern": "Bash" }
    `);
  });
});
