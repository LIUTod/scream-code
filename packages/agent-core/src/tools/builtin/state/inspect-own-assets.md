Use this tool to inspect the agent's own persistent assets: skills, MCP server declarations, configuration files, the memory store, and the knowledge base. It reports what exists, where it lives, and whether it looks valid.

**When to use:**
- The user asks "what skills do you have?", "show me your mcp config", "how is your memory set up?", "where is your knowledge base?"
- Auditing your own configuration and data (e.g. checking whether mcp.json parses, whether skill frontmatter is intact)

You must NOT modify any of these assets unless the user explicitly asks you to — this tool is strictly read-only.

**When NOT to use:**
- Reading the user's workspace files — use `read` / `glob` / `grep` instead
- Writing or editing anything — this tool is strictly read-only

**How to use:**
- Call with no arguments (or `scope: "all"`) to inspect everything
- Narrow with `scope: "skills"` / `"mcp"` / `"config"` / `"memory"` / `"knowledge"` to inspect a single category

This tool never writes, creates, or modifies any file.
