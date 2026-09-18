import { describe, expect, it } from 'vitest';

import { buildApprovalNotice } from '#/tui/utils/approval-notice';

const LABELS = {
  approved: '已批准',
  approvedSession: '已批准（当前会话）',
  rejected: '已拒绝',
  cancelled: '已取消',
};

describe('buildApprovalNotice', () => {
  it('marks a session-wide approval apart from a one-off', () => {
    expect(buildApprovalNotice({ decision: 'approved', action: 'run ls', labels: LABELS })).toEqual({
      label: '已批准',
      detail: 'run ls',
      tone: 'approved',
    });
    expect(
      buildApprovalNotice({
        decision: 'approved',
        scope: 'session',
        action: 'run ls',
        labels: LABELS,
      }),
    ).toEqual({ label: '已批准（当前会话）', detail: 'run ls', tone: 'approved_session' });
  });

  it('never lends the session label to a rejection or a cancellation', () => {
    // `scope` rides on approvals only; a caller passing it through on a rejection
    // must not produce "已批准（当前会话）"-flavoured wording.
    expect(
      buildApprovalNotice({
        decision: 'rejected',
        scope: 'session',
        action: 'run ls',
        labels: LABELS,
      }),
    ).toEqual({ label: '已拒绝', detail: 'run ls', tone: 'rejected' });
    expect(
      buildApprovalNotice({ decision: 'cancelled', scope: 'session', action: 'run ls', labels: LABELS }),
    ).toEqual({ label: '已取消', detail: 'run ls', tone: 'cancelled' });
  });

  it('appends quoted feedback and ignores an empty one', () => {
    expect(
      buildApprovalNotice({ decision: 'approved', action: 'run ls', feedback: 'careful', labels: LABELS })
        .detail,
    ).toBe('run ls — "careful"');
    expect(
      buildApprovalNotice({ decision: 'approved', action: 'run ls', feedback: '', labels: LABELS }).detail,
    ).toBe('run ls');
  });
});
