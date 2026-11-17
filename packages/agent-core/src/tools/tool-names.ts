/**
 * Built-in tools that were renamed, old name → current name.
 *
 * Every built-in tool name is PascalCase. Three tools used to be lowercase
 * (`ast_grep`, `ast_edit`, `python`); the old names still arrive from places
 * the rename cannot rewrite: a user's permission rules and profile tool lists,
 * an SDK caller's active-tool list, a model that keeps using the name it saw
 * earlier. `canonicalToolName` maps them at those boundaries. Stored sessions
 * are rewritten once by the v1.9 wire migration.
 */
export const RENAMED_TOOL_NAMES: Readonly<Record<string, string>> = {
  ast_grep: 'AstGrep',
  ast_edit: 'AstEdit',
  python: 'Python',
};

/** The current name for `name` (unchanged when it was never renamed). */
export function canonicalToolName(name: string): string {
  return Object.hasOwn(RENAMED_TOOL_NAMES, name) ? RENAMED_TOOL_NAMES[name]! : name;
}

/** The old name a renamed tool used to have, if any. */
export function legacyToolName(name: string): string | undefined {
  for (const [legacy, current] of Object.entries(RENAMED_TOOL_NAMES)) {
    if (current === name) return legacy;
  }
  return undefined;
}
