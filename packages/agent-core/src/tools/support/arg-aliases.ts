/**
 * Argument spellings models reach for that differ from a tool's own schema.
 *
 * Tool schemas are closed objects, so a perfectly sensible `limit` or
 * `file_path` is rejected as an unknown property and costs a whole model step
 * to fix. A tool lists the spellings it will accept here and the loop applies
 * them before validation (`ExecutableTool.normalizeArgs`).
 *
 * Only a rename: when the canonical key is already present the alias is left
 * alone, so a call that sets both still fails validation instead of silently
 * letting one value win.
 */
export type ArgAliases = Readonly<Record<string, string>>;

export function renameArgAliases(
  args: Record<string, unknown>,
  aliases: ArgAliases,
): Record<string, unknown> {
  let renamed: Record<string, unknown> | undefined;
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (!Object.hasOwn(args, alias) || Object.hasOwn(args, canonical)) continue;
    renamed ??= { ...args };
    renamed[canonical] = args[alias];
    delete renamed[alias];
  }
  return renamed ?? args;
}
