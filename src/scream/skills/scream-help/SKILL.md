---
name: scream-code-help
description: Answer Scream Code CLI usage, configuration, and troubleshooting questions. Use when user asks about Scream Code CLI installation, setup, configuration, slash commands, keyboard shortcuts, MCP integration, providers, environment variables, how something works internally, or any questions about Scream Code CLI itself.
---

# Scream Code CLI Help

Help users with Scream Code CLI questions by consulting documentation and source code.

## Strategy

1. **Prefer official documentation** for most questions
2. **Read local source** when in scream-code project itself, or when user is developing with scream-code as a library (e.g., importing from `scream` in their code)
3. **Clone and explore source** for complex internals not covered in docs - **ask user for confirmation first**

## Documentation

Refer to the README.md at the project root for:

- Installation and setup
- Configuration examples
- Slash command reference
- Advanced configuration (permission rules, skills)

### Topic Mapping

| Topic | Source |
|-------|--------|
| Installation, first run | `README.md` |
| Config files, providers, models | `README.md` |
| Slash commands | `README.md` + `src/scream/soul/slash.py`, `src/scream/ui/shell/slash.py` |
| Permission engine | `src/scream/permission/engine.py` |
| Memory system | `src/scream/memory/` |
| Skill system | `src/scream/skill/__init__.py` |
| Architecture | `AGENTS.md` |

## Source Code

Repository: `https://github.com/LIUTod/scream-code`

When to read source:

- In scream-code project directory (check `pyproject.toml` for `name = "scream-code"`)
- User is importing `scream` as a library in their project
- Question about internals not covered in docs (ask user before cloning)
