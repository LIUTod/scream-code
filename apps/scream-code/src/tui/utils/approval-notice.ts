/**
 * One approval outcome, shaped for the two places it can land.
 *
 * A live approval and its replayed counterpart must read the same and carry the
 * same tone, so both build the notice through here instead of composing the
 * wording twice. `detail` holds everything after the separator — the action the
 * panel showed plus any reviewer feedback — leaving the caller to pick the
 * separator its surface uses (`已批准: …` for a standalone row, `已批准 · …` for a
 * step of the work block).
 */

export type ApprovalNoticeTone = 'approved' | 'approved_session' | 'rejected' | 'cancelled';

export interface ApprovalNotice {
  /** Localized outcome label, scope included (`已批准（当前会话）`). */
  readonly label: string;
  /** Action string plus quoted feedback, ready to concatenate behind a separator. */
  readonly detail: string;
  readonly tone: ApprovalNoticeTone;
}

/** Caller-owned labels: live and replay keep their own i18n keys. */
export interface ApprovalNoticeLabels {
  readonly approved: string;
  readonly approvedSession: string;
  readonly rejected: string;
  readonly cancelled: string;
}

export function buildApprovalNotice(args: {
  readonly decision: 'approved' | 'rejected' | 'cancelled';
  readonly scope?: 'session' | undefined;
  readonly action: string;
  readonly feedback?: string | undefined;
  readonly labels: ApprovalNoticeLabels;
}): ApprovalNotice {
  const sessionScoped = args.decision === 'approved' && args.scope === 'session';
  const tone: ApprovalNoticeTone = sessionScoped ? 'approved_session' : args.decision;
  const label =
    args.decision === 'approved'
      ? sessionScoped
        ? args.labels.approvedSession
        : args.labels.approved
      : args.decision === 'rejected'
        ? args.labels.rejected
        : args.labels.cancelled;
  const feedback =
    args.feedback !== undefined && args.feedback.length > 0 ? ` — "${args.feedback}"` : '';
  return { label, detail: `${args.action}${feedback}`, tone };
}
