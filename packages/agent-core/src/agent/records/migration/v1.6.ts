import type { WireMigration, WireMigrationRecord } from './index';

/**
 * v1.5 -> v1.6 is a bump-only migration.
 *
 * v1.6 adds optional `rlm.enter` payload fields (`depth` / `maxDepth`, absent
 * means "keep the defaults" on replay) and the additive `rlm.settings` record
 * type (recursion-cap changes). Both are additive, so records from v1.5
 * remain valid JSON without transformation.
 */
export const migrateV1_5ToV1_6: WireMigration = {
  sourceVersion: '1.5',
  targetVersion: '1.6',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    return record;
  },
};
