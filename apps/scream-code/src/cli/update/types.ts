/** Where the running CLI was installed from. Drives update command + spawn. */
export type InstallSource = 'source' | 'unsupported';

export interface UpdateTarget {
  readonly version: string;
}

export interface UpdateCache {
  readonly source: 'cdn';
  readonly checkedAt: string | null;
  readonly latest: string | null;
}

export type UpdateDecision = 'none' | 'prompt-install' | 'manual-command';
export type UpdatePreflightResult = 'continue' | 'exit';

export function emptyUpdateCache(): UpdateCache {
  return {
    source: 'cdn',
    checkedAt: null,
    latest: null,
  };
}
