import type { Agent } from '../../agent';
import type { QuestionAnswers, QuestionResult } from '../../rpc';

/** Severity a plugin can report through `ui.notify`. */
export type PluginNoticeLevel = 'info' | 'warn' | 'error';

/** The yes/no question a plugin may ask the user. */
export interface PluginConfirmRequest {
  readonly title: string;
  readonly body?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
}

/** A handle for one progress series; the host renders text, not a bar. */
export interface PluginProgress {
  /** Update the current step text. Throttled to ~5 updates/second. */
  update(label: string): void;
  done(message?: string): void;
  fail(message?: string): void;
}

/**
 * Host interaction surface for code plugins.
 *
 * Every method degrades instead of throwing: a headless host (SDK, `/line`,
 * print mode) has no dialog, so `confirm` resolves `false` and says so through
 * `notify`. A plugin must never be able to wedge a session by asking.
 */
export interface PluginUi {
  notify(level: PluginNoticeLevel, message: string): void;
  confirm(request: PluginConfirmRequest): Promise<boolean>;
  progress(title: string): PluginProgress;
}

/**
 * `QuestionResult` may be the answer map itself or a wrapper carrying
 * `answers`; both shapes reach a plugin depending on the host.
 */
function readAnswer(result: QuestionResult, question: string): string | true | undefined {
  if (result === null) return undefined;
  if ('answers' in result) {
    const wrapped = result as { answers?: QuestionAnswers };
    return wrapped.answers?.[question];
  }
  return result[question];
}

/** Progress text is a status line; a burst of updates must not flood it. */
const PROGRESS_MIN_INTERVAL_MS = 200;

/**
 * Build the `ui` surface for one plugin activation.
 *
 * `notify` rides the existing `warning` event (the host already renders it as a
 * status message) with `code: 'plugin:<level>'` so the UI could style levels
 * later without a new event type. `confirm` rides `requestQuestion`, the same
 * channel `AskUserQuestion` uses, so the TUI needs no new dialog code.
 */
export function createPluginUi(agent: Agent, pluginId: string): PluginUi {
  const notify = (level: PluginNoticeLevel, message: string): void => {
    agent.eventBus.dispatch({
      type: 'warning',
      message: `[${pluginId}] ${message}`,
      code: `plugin:${level}`,
    });
  };

  return {
    notify,

    async confirm(request: PluginConfirmRequest): Promise<boolean> {
      const ask = agent.rpc?.requestQuestion;
      const confirmLabel = request.confirmLabel ?? 'Yes';
      if (ask === undefined) {
        notify('warn', `"${request.title}" needs a confirmation, but this host cannot ask; denied.`);
        return false;
      }
      try {
        const response = await ask.call(agent.rpc, {
          questions: [
            {
              question: request.title,
              ...(request.body === undefined ? {} : { body: request.body }),
              options: [{ label: confirmLabel }, { label: request.cancelLabel ?? 'No' }],
            },
          ],
        });
        return readAnswer(response, request.title) === confirmLabel;
      } catch {
        // A cancelled question is a "no", not a plugin failure.
        return false;
      }
    },

    progress(title: string): PluginProgress {
      let lastEmit = 0;
      const emit = (level: PluginNoticeLevel, text: string): void => {
        const now = Date.now();
        if (level === 'info' && now - lastEmit < PROGRESS_MIN_INTERVAL_MS) return;
        lastEmit = now;
        notify(level, text);
      };
      emit('info', `${title}…`);
      return {
        update: (label) => {
          emit('info', `${title}: ${label}`);
        },
        done: (message) => {
          emit('info', message ?? `${title}: done`);
        },
        fail: (message) => {
          emit('error', message ?? `${title}: failed`);
        },
      };
    },
  };
}
