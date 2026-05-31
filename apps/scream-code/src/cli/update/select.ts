import { gt, valid } from 'semver';

import { type UpdateTarget } from './types';

export function selectUpdateTarget(
  currentVersion: string,
  latest: string | null,
): UpdateTarget | null {
  if (latest === null) return null;
  if (valid(currentVersion) === null || valid(latest) === null) return null;
  if (!gt(latest, currentVersion)) return null;
  return { version: latest };
}
