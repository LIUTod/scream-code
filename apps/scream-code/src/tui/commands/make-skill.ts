import type { Session } from '@scream-code/scream-code-sdk';

import { LLM_NOT_SET_MESSAGE, NO_ACTIVE_SESSION_MESSAGE } from '../constant/scream-tui';
import { isAbortError } from '../utils/errors';
import { isBusy } from '../utils/app-state';
import type { SlashCommandHost } from './dispatch';

export async function handleMakeSkillCommand(host: SlashCommandHost, args: string): Promise<void> {
  if (host.state.appState.model.trim().length === 0) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }

  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  if (isBusy(host.state.appState)) {
    host.showError('请等待当前回复完成后再使用 /make-skill');
    return;
  }

  await activateMakeSkill(host, session, args.trim());
}

async function activateMakeSkill(host: SlashCommandHost, session: Session, initialRequest: string): Promise<void> {
  host.deferUserMessages = true;
  host.beginSessionRequest();
  try {
    const skillArgs = JSON.stringify({ initialRequest });
    await session.activateSkill('make-skill', skillArgs);
    host.streamingUI.finalizeTurn((item) => {
      host.sendQueuedMessage(session, item);
    });
  } catch (error) {
    if (isAbortError(error)) {
      host.setAppState({ streamingPhase: 'idle' });
      host.resetLivePane();
      return;
    }
    const msg = error instanceof Error ? error.message : String(error);
    host.failSessionRequest(`Make skill failed: ${msg}`);
  } finally {
    host.deferUserMessages = false;
  }
}
