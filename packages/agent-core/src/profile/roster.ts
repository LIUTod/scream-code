import { DEFAULT_AGENT_PROFILES } from './default';

export interface SubagentRosterEntry {
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string | undefined;
}

/**
 * Ordered roster of the main agent's subagents.
 *
 * Membership is derived from `agent.yaml`'s `subagents:` map — never
 * hand-maintained — so a profile that is registered there shows up here (and
 * therefore in the sidebar and the `/model diy` binder) without any extra
 * bookkeeping. Order follows the map's key order, which is the sidebar
 * display order.
 */
export function subagentRoster(): readonly SubagentRosterEntry[] {
  const subagents = DEFAULT_AGENT_PROFILES['agent']?.subagents ?? {};
  return Object.entries(subagents).map(([name, profile]) => ({
    name,
    description: profile.description ?? '',
    whenToUse: profile.whenToUse,
  }));
}
