Use this tool to inspect the agent's own persistent assets: skills, MCP server declarations, configuration files, the memory store, and the knowledge base. It reports what exists, where it lives, and whether it looks valid.

**When to use:**
- The user asks "what skills do you have?", "show me your mcp config", "how is your memory set up?", "where is your knowledge base?"
- Auditing your own configuration and data (e.g. checking whether mcp.json parses, whether skill frontmatter is intact)

**Inventory questions — this tool is the single answering view.** When the user asks what you have, in ANY wording (skills / plugins / capabilities / MCP / tools / 技能 / 插件 / 能力), treat it as one intent and answer from this inventory: it reports the skill packages in the three standard skill scopes (user, plugin-managed, project) with live `invocable` status from the skill registry, plus MCP declarations. Skills discovered from non-standard locations (nested directories, `.agents/skills`) may not appear here. Pair it with the system-prompt skills section for the "callable right now" view. Division of labor: **InspectOwnAssets = inventory (read-only)**, **ManagePlugin = changes (install/enable/remove)**, **Skill tool = invocation**.

You must NOT modify any of these assets unless the user explicitly asks you to — this tool is strictly read-only.

**When NOT to use:**
- Reading the user's workspace files — use `read` / `glob` / `grep` instead
- Writing or editing anything — this tool is strictly read-only

**How to use:**
- Call with no arguments (or `scope: "all"`) to inspect everything
- Narrow with `scope: "skills"` / `"mcp"` / `"config"` / `"memory"` / `"knowledge"` to inspect a single category

This tool never writes, creates, or modifies any file.
