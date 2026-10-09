/**
 * Foreground→background handoff results, read by both UI faces.
 *
 * When the Agent tool hands a still-running child to the background manager it
 * returns an ordinary (non-error) result, in two shapes that both carry the
 * protocol line `status: backgrounded`: one with a `task_id` after a
 * successful registration, and one with a `could not register` warning when
 * registration failed. The second shape emits no `background.task.started`
 * frame, so the result body is the only signal that names the state.
 *
 * Live and replay therefore read the same fact: the protocol LINE, whether it
 * arrives in the `tool.result` frame or in the persisted tool-result message a
 * replay reconstructs.
 */
const BACKGROUNDED_STATUS_LINE = 'status: backgrounded';

/**
 * True when a tool-result output carries the handoff protocol line as its own
 * line. Matching is line-exact after trimming (tolerating `\r`) so an Agent
 * result that merely quotes the phrase inside prose — e.g. a completed
 * subagent's summary — is not mistaken for a handoff.
 */
export function isBackgroundedHandoffResult(output: string): boolean {
  return output.split('\n').some((line) => line.trim() === BACKGROUNDED_STATUS_LINE);
}
