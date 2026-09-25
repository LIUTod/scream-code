/**
 * Who authored a context message.
 *
 * Every injection path writes into history as a user-role message — system
 * reminders (`ContextMemory.appendSystemReminder`), injected context,
 * scheduled notifications, hook results, background completions — so the role
 * on its own answers "may this be rendered in the user slot", not "did the
 * user say this". The two predicates below are the only sanctioned way to ask
 * the authorship question; a raw role comparison at a call site is a bug
 * waiting for the next injection path to be added.
 *
 * This module is a leaf (it imports types only) so the provider projection in
 * `./projector` can depend on it without importing `./index` back.
 */

import type { ContextMessage } from './types';

/**
 * Determines whether a context message counts as a "user prompt" for undo
 * anchoring. Regular user messages and user-triggered skill activations both
 * count; injections, system reminders, scheduled notifications, hook results
 * and model-triggered skills don't.
 *
 * The bar is deliberately lower than {@link isUserAuthoredMessage}: this asks
 * whether the *user acted*, not whether the user wrote the text. A slash
 * command the user typed starts a turn the user expects `/undo` to reverse,
 * even though the message body is a rendered skill prompt.
 */
export function isRealUserPrompt(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined || origin.kind === 'user') return true;
  if (origin.kind === 'skill_activation') {
    return origin.trigger === 'user-slash';
  }
  return false;
}

/**
 * Determines whether a context message was authored by the user as
 * conversation content — a direct user prompt, carrying
 * `origin.kind === 'user'`.
 *
 * Strictly narrower than {@link isRealUserPrompt} on both axes that matter:
 *
 *   - a user-triggered skill activation carries `origin.kind ===
 *     'skill_activation'`. The user acted, but the body is the rendered skill
 *     prompt, not the user's own words: concatenating it into an adjacent user
 *     message, or quoting it back as "the user's request", would misattribute
 *     generated text to the user;
 *   - a message with no `origin` is not user-authored. Every message appended
 *     through `ContextMemory.appendUserMessage` carries one, so a missing
 *     origin means an internal producer wrote the message and its authorship
 *     cannot be claimed for the user.
 *
 * Use this where the question is "are these the user's own words?" — merging
 * adjacent user messages for the provider, recovering the most recent user
 * request, resetting a cadence on genuine user input. Use
 * {@link isRealUserPrompt} where the question is "does this message start a
 * user turn the user could undo?".
 */
export function isUserAuthoredMessage(message: ContextMessage): boolean {
  return message.role === 'user' && message.origin?.kind === 'user';
}
