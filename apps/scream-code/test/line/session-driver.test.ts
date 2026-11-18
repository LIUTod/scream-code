import { describe, expect, it } from 'vitest';

import { enginePermissionFor } from '#/line/permission-mode';
import { friendlyProviderError } from '#/line/session-driver';

describe('enginePermissionFor (line config permissionMode)', () => {
  it('maps yolo to yolo and dontAsk to bot', () => {
    expect(enginePermissionFor('yolo')).toBe('yolo');
    expect(enginePermissionFor('dontAsk')).toBe('bot');
  });

  it('maps auto, a missing value and an unknown value to auto', () => {
    expect(enginePermissionFor('auto')).toBe('auto');
    expect(enginePermissionFor(undefined)).toBe('auto');
    expect(enginePermissionFor('nonsense')).toBe('auto');
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
