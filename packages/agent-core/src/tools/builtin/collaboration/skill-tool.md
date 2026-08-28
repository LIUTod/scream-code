Invoke a registered skill from the current skill listing. BLOCKING REQUIREMENT: when a skill from the listing matches the user's request, you MUST call this tool (not free-form text). Do NOT call the same skill repeatedly inside one turn — recursive depth is capped at {{ MAX_SKILL_QUERY_DEPTH }}.

## Currently model-invocable skills
{{ AVAILABLE_SKILLS }}
This list is a construction-time snapshot; for the live catalog inspect the skill registry.

**Not for inventory questions**: when the user asks what you have — in any wording (skills / plugins / capabilities / MCP / tools) — answer with **InspectOwnAssets** (the full read-only catalog), not this listing. To find or install new capabilities, use **ManagePlugin**. This listing exists for **invocation**: when one of the skills above matches the task at hand.

## Matching guide

- A skill matches when the user's request involves the scenarios/trigger conditions listed in the skill's "When to use" line.
- Look for: (a) keywords in the user's request that match the skill's trigger phrases, (b) the task type or scenario described in the skill's "When to use", (c) similar requests the skill was designed for.
- If a skill seems relevant, invoke it first — if it doesn't fit, you can always fall back to doing it yourself.