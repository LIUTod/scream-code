/**
 * /grants — inspect and revoke the session's approve-for-session grants.
 *
 * One grant is one pattern the user approved with "allow for session"
 * (e.g. `Bash`); revoking is immediate, so the next matching call asks again.
 */

import type { Session } from '@scream-code/scream-code-sdk';
import { t } from '@scream-code/config';

import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import { getNoActiveSessionMessage } from '../constant/scream-tui';
import { formatErrorMessage } from '../utils/event-payload';

import type { SlashCommandHost } from './dispatch';

export async function handleGrantsCommand(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(getNoActiveSessionMessage());
    return;
  }

  let grants: string[];
  try {
    grants = await session.getSessionApprovalGrants();
  } catch (error) {
    host.showError(t('grants.load_failed', { msg: formatErrorMessage(error) }));
    return;
  }

  if (grants.length === 0) {
    host.showStatus(t('grants.empty'), host.state.theme.colors.textDim);
    return;
  }

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: t('grants.title', { count: String(grants.length) }),
      hint: t('grants.hint'),
      colors: host.state.theme.colors,
      options: grants.map((pattern) => ({ value: pattern, label: pattern, tone: 'danger' })),
      onSelect: (pattern) => {
        void revokeGrant(host, session, pattern);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function revokeGrant(
  host: SlashCommandHost,
  session: Session,
  pattern: string,
): Promise<void> {
  try {
    const revoked = await session.revokeSessionApprovalGrant(pattern);
    host.restoreEditor();
    if (revoked) {
      host.showStatus(t('grants.revoked', { pattern }), host.state.theme.colors.success);
    } else {
      host.showError(t('grants.revoke_failed', { pattern }));
    }
  } catch {
    host.restoreEditor();
    host.showError(t('grants.revoke_failed', { pattern }));
  }
}
