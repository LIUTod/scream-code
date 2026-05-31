import { describe, expect, it } from 'vitest';

import { selectUpdateTarget } from '#/cli/update/select';

describe('selectUpdateTarget', () => {
  it('returns the latest version when it is newer than current', () => {
    expect(selectUpdateTarget('0.4.0', '0.5.0')).toEqual({ version: '0.5.0' });
  });

  it('returns null when latest equals current', () => {
    expect(selectUpdateTarget('0.5.0', '0.5.0')).toBeNull();
  });

  it('returns null when latest is older than current', () => {
    expect(selectUpdateTarget('0.5.0', '0.3.0')).toBeNull();
  });

  it('returns null when latest is null (cache empty)', () => {
    expect(selectUpdateTarget('0.5.0', null)).toBeNull();
  });

  it('returns null when current is not a valid semver', () => {
    expect(selectUpdateTarget('not-a-version', '0.5.0')).toBeNull();
  });

  it('returns null when latest is not a valid semver', () => {
    expect(selectUpdateTarget('0.5.0', 'not-a-version')).toBeNull();
  });

  it('handles prerelease semver comparisons correctly', () => {
    expect(selectUpdateTarget('0.5.0-rc.1', '0.5.0')).toEqual({ version: '0.5.0' });
    expect(selectUpdateTarget('0.5.0', '0.5.0-rc.1')).toBeNull();
  });
});
