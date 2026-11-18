/**
 * Built-in tools that were renamed, old name → current name.
 *
 * Every built-in tool name is PascalCase. Three tools used to be lowercase
 * (`ast_grep`, `ast_edit`, `python`); the old names still arrive from places
 * the rename cannot rewrite: a user's permission rules and profile tool lists,
 * an SDK caller's active-tool list, a model that keeps using the name it saw
 * earlier. Tool calls in stored sessions are rewritten once by the v1.9 wire
 * migration.
 *
 * An old name is never simply replaced: a plugin or SDK tool may genuinely be
 * called `python`. Tool lists keep the old name and gain the current one
 * (`withCurrentToolNames`), rules match either (`matchPermissionRule`), and a
 * call resolves an exact name first (`preflightToolCall`).
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

/**
 * `names` with the current name added right after each old name of a renamed
 * built-in (order kept, no duplicates). The old name stays: it may also be
 * the name of a user or plugin tool, which must stay enabled. When
 * `ownsName(old)` says such a tool exists, the old name means that tool and
 * the built-in is not added.
 */
export function withCurrentToolNames(
  names: readonly string[],
  ownsName: (name: string) => boolean = () => false,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };
  for (const name of names) {
    push(name);
    if (!ownsName(name)) push(canonicalToolName(name));
  }
  return out;
}

/** The old name a renamed tool used to have, if any. */
export function legacyToolName(name: string): string | undefined {
  for (const [legacy, current] of Object.entries(RENAMED_TOOL_NAMES)) {
    if (current === name) return legacy;
  }
  return undefined;
}
