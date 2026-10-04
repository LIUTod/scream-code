/**
 * System-prompt part splitting.
 *
 * The rendered system prompt is split into two request-time blocks:
 *
 * - a **static** part (role/persona, tool-usage rules, CONTRACT sections)
 *   whose bytes are stable for a given role and operating environment, and
 * - a **dynamic** part (working environment listing, AGENTS.md, skills,
 *   self-asset map, role additions) that varies with the session context.
 *
 * Request layers use the split to place a prompt-cache breakpoint after the
 * static block: its bytes are then reused across sessions of the same role
 * (provider prefix cache) while the dynamic block re-pays only its own bytes.
 * The marker below lives in `system.md` between the two sections; it survives
 * rendering verbatim as an HTML comment, so the split is a plain string
 * operation on the rendered prompt.
 */

export const SYSTEM_PROMPT_SPLIT_MARKER = '\n\n<!--scream:system-dynamic-->\n\n';

export interface SystemPromptParts {
  /** Bytes stable across sessions of the same role/environment. */
  readonly staticPart: string;
  /** Bytes that vary with the session context. Empty when the marker is absent. */
  readonly dynamicPart: string;
}

/**
 * Split a rendered system prompt at {@link SYSTEM_PROMPT_SPLIT_MARKER}.
 *
 * When the marker is absent or not unique (for example, a runtime hook
 * replaced the prompt with arbitrary text), the whole prompt is treated as
 * static: request layers then degrade to the single-block form and behave
 * exactly as before the split existed.
 */
export function splitSystemPrompt(rendered: string): SystemPromptParts {
  const parts = rendered.split(SYSTEM_PROMPT_SPLIT_MARKER);
  if (parts.length !== 2) {
    return { staticPart: rendered, dynamicPart: '' };
  }
  const [staticPart = '', dynamicPart = ''] = parts;
  return { staticPart, dynamicPart };
}

/**
 * The system prompt in provider request form: `[static, dynamic]` when the
 * split applies, else the single rendered string. Every request path (main
 * loop, compaction) must use this same form so their requests share the
 * provider-side prefix cache.
 */
export function systemPromptForRequest(rendered: string): string | string[] {
  const { staticPart, dynamicPart } = splitSystemPrompt(rendered);
  return dynamicPart.length > 0 ? [staticPart, dynamicPart] : rendered;
}
