/**
 * Fixed system prompt for compaction requests that run on the opt-in
 * housekeeping model (`loop_control.housekeeping_model`).
 *
 * The default compaction request reuses the main loop's system prompt and
 * tool schemas so it shares the routed request's prefix and rides the
 * provider's KV cache. A housekeeping model sits on a different provider, so
 * that rationale is void — and the main-loop prompt encodes loop behavior a
 * cheap auxiliary model should not imitate. This prompt states only the
 * summarizer contract; the per-compaction instruction (sections, file lists,
 * skill-candidate marker) arrives as the tail user message exactly as in the
 * session-model path, so housekeeping runs stay behaviorally identical apart
 * from the system prompt and the (empty) tool set.
 *
 * Kept deliberately neutral: no product names, no persona, no references to
 * specific tools — the model behind it can be any provider's.
 */
export const HOUSEKEEPING_SYSTEM_PROMPT = [
  'You are a faithful summarizer for a software-engineering session history.',
  'Condense the conversation exactly as given: preserve the goals, constraints, decisions, and open items; keep every file path, command, identifier, and error verbatim with its exact meaning.',
  'Never invent or assume facts that are not present in the conversation.',
  'Never call tools.',
  'Follow the summarization instructions given in the final user message, including any required sections or markers.',
  'Respond with the summary only — no preamble and no commentary.',
].join('\n');
