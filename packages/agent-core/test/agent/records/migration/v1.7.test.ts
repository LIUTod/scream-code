import { describe, expect, it } from 'vitest';

import { migrateV1_6ToV1_7 } from '../../../../src/agent/records/migration/v1.7';
import { runMigration } from './utils';

describe('1.6 to 1.7', () => {
  it('passes records through unchanged (additive record type)', () => {
    expect(
      runMigration(migrateV1_6ToV1_7, [
        {
          type: 'metadata',
          protocol_version: '1.6',
          created_at: 1,
        },
        {
          type: 'permission.record_decision',
          turnId: 0,
          toolCallId: 'call_denied',
          toolName: 'Bash',
          policyName: 'user-configured-deny',
          decision: 'deny',
          reason: 'Tool "Bash" was denied by permission rule.',
        },
      ]),
    ).toMatchInlineSnapshot(`
      [wire] metadata                     { "protocol_version": "1.7", "created_at": "<time>" }
      [wire] permission.record_decision   { "turnId": 0, "toolCallId": "call_denied", "toolName": "Bash", "policyName": "user-configured-deny", "decision": "deny", "reason": "Tool \\"Bash\\" was denied by permission rule." }
    `);
  });
});
