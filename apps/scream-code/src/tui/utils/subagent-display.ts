import { t } from '@scream-code/config';
import { subagentRoster } from '@scream-code/scream-code-sdk';

/**
 * Localized description of a subagent type.
 *
 * `t()` returns the key itself when a phrase is missing, so a missing
 * `subagent.desc_<name>` entry would surface as `subagent.desc_<name>` in the
 * UI. Fall back to the profile's own description instead — that way a new
 * subagent type reads fine with zero translation work, and the translated
 * phrase still wins wherever someone has written one.
 */
export function localizedSubagentDesc(name: string): string {
  const key = `subagent.desc_${name}`;
  const translated = t(key);
  if (translated !== key) return translated;
  return subagentRoster().find((entry) => entry.name === name)?.description ?? name;
}
