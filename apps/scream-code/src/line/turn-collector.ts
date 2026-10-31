/**
 * Final-content collector for one turn.
 *
 * Lives in its own module because two callers need it: the in-flight turn
 * runner (inbound messages) and the scheduled-task relay (turns this daemon did
 * not initiate).
 */

import type { Event } from '@scream-code/scream-code-sdk';

/**
 * Collects the final content output of one turn from the session event
 * stream (main agent only).
 *
 * Remote-channel reply policy: thinking deltas are a separate event type and
 * never accumulate; intermediate assistant narration BEFORE a tool call is
 * discarded — the IM reply carries only the content that follows the last
 * tool call, i.e. the final answer (the reference parity: it forwards progress
 * for display, but the "reply" is the completion text).
 */
export class LineTurnCollector {
  text = '';
  failure: { code: string; message: string } | undefined;
  ended: 'completed' | 'cancelled' | 'failed' | undefined;
  stepBudgetExhausted = false;
  private activeTurnId: number | undefined;
  private activeAgentId: string | undefined;
  private resolveTurn: () => void;

  constructor(onTurnSettled: () => void) {
    this.resolveTurn = onTurnSettled;
  }

  handleEvent(event: Event): void {
    if (event.type === 'error') {
      if (event.agentId !== 'main') return;
      this.failure = { code: event.code, message: event.message };
      this.resolveTurn();
      return;
    }
    if (event.type === 'turn.started') {
      if (this.activeTurnId !== undefined) return;
      this.activeTurnId = event.turnId;
      this.activeAgentId = event.agentId;
      return;
    }
    if (
      this.activeTurnId === undefined ||
      this.activeAgentId === undefined ||
      !('turnId' in event) ||
      event.turnId !== this.activeTurnId ||
      event.agentId !== this.activeAgentId
    ) {
      return;
    }
    if (event.type === 'tool.call.started' || event.type === 'tool.call.delta') {
      // Drop narration emitted before the tool call.
      this.text = '';
      return;
    }
    if (event.type === 'assistant.delta') {
      this.text += event.delta;
      return;
    }
    if (event.type === 'turn.ended') {
      this.ended = event.reason;
      if (event.reason === 'completed' && event.stepBudgetExhausted === true) {
        this.stepBudgetExhausted = true;
      }
      this.resolveTurn();
    }
  }
}
