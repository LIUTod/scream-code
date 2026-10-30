import { describe, expect, it } from 'vitest';

import { mapStreamJsonMode } from '#/cli/run-stream-json';
import { friendlyProviderError } from '#/line/session-driver';

describe('permission mapping (reuse of run-stream-json mapStreamJsonMode)', () => {
  it('maps yolo/bypassPermissions to permission yolo', () => {
    expect(mapStreamJsonMode('yolo')).toEqual({ permission: 'yolo', planMode: false });
    expect(mapStreamJsonMode('bypassPermissions')).toEqual({ permission: 'yolo', planMode: false });
  });

  it('maps dontAsk to manual (the approval handler does the denying)', () => {
    expect(mapStreamJsonMode('dontAsk')).toEqual({ permission: 'manual', planMode: false });
  });

  it('maps auto to permission auto (channel parity)', () => {
    expect(mapStreamJsonMode('auto')).toEqual({ permission: 'auto', planMode: false });
  });

  it('maps unknown values to auto (fail-open default parity)', () => {
    expect(mapStreamJsonMode(undefined)).toEqual({ permission: 'auto', planMode: false });
    expect(mapStreamJsonMode('nonsense')).toEqual({ permission: 'auto', planMode: false });
  });

  it('maps plan to plan mode', () => {
    expect(mapStreamJsonMode('plan')).toEqual({ permission: 'manual', planMode: true });
  });
});

describe('friendlyProviderError', () => {
  it('maps provider error codes to a retry hint', () => {
    expect(friendlyProviderError('provider.rate_limit', '')).toContain('稍后重试');
    expect(friendlyProviderError('provider.auth_error', '')).toContain('稍后重试');
    expect(friendlyProviderError('provider.timeout', '')).toContain('稍后重试');
  });

  it('passes through other errors with their message', () => {
    expect(friendlyProviderError('some.code', 'detail here')).toBe('处理失败：detail here');
    expect(friendlyProviderError('some.code', '')).toBe('处理失败：some.code');
  });
});
