/**
 * Migration detection — permanently disabled.
 *
 * The scream-cli → scream-code migration feature has been removed.
 * This module is kept as a no-op stub so callers do not need to change.
 */
import type { MigrationPlan } from '@scream-cli/migration-legacy';

export interface DetectPendingInput {
  readonly sourceHome: string;
  readonly targetHome: string;
  readonly ignoreMarker?: boolean;
}

export async function detectPendingMigration(
  _input: DetectPendingInput,
): Promise<MigrationPlan | null> {
  return null;
}
