# Skills

A skill is a markdown package the agent loads on demand. It is prompt material,
not code: invoking a skill injects its body into the conversation.

## Shape

Two layouts are supported:

```
my-skill/SKILL.md          # directory skill (may ship supporting files)
my-skill.md                # flat skill
```

`SKILL.md` needs YAML frontmatter:

```markdown
---
name: my-skill
description: One sentence shown in the skill listing.
---

Body: the instructions the agent follows once the skill is invoked.
```

- Both fields are required for a directory skill (`SKILL.md`): the parser throws,
  and the scanner downgrades that to a warning, so the skill is skipped instead
  of half-registered.
- Flat `<name>.md` skills are more forgiving — `name` falls back to the file name
  and `description` to the first body line.

## Where skills are discovered

| Root | Scope |
|---|---|
| `~/.scream-code/skills/` | user |
| `<git-root>/.scream-code/skills/` | project (the git root, not the current directory) |
| `<git-root>/.agents/skills/` | project (alternate convention) |
| `extraSkillDirs` in `config.toml` | extra roots |
| `plugins/managed/<plugin>/` | installed plugin packages |

Project skills override user skills with the same name. `mergeAllAvailableSkills`
in `config.toml` merges every discovered skill instead of the project-scoped set.

## Invoking

- `Skill` tool — the agent calls it with `skill` and optional `args`.
- `/skill:<name>` — the user invokes one directly.
- `/skill` — pick from a list.
- A bare `/name` also works for built-in skills (e.g. `/dream`, `/image`).

## Built-in skills

| Skill | Purpose |
|---|---|
| `image` | Generate or edit an image via the `ImageGenerate` tool; also `/image` |
| `dream` | Memory consolidation: plan → confirm → apply; also `/dream` |
| `make-skill` | Turn the current conversation into a reusable skill package |

## Authoring a new skill

1. Run `/make-skill` and answer the prompts, or write the `SKILL.md` yourself.
2. `MakeSkillPlan` drafts a package (name, description, body, supporting files).
3. `MakeSkillApply` writes it into the plugin center, where `/plugin` manages it.

Skills are listed in the system prompt when the session starts, so a skill added
mid-session needs a new session (or `/skill` refresh) to appear.

## What a skill is not

- Not a subagent: no separate context, no separate tool set.
- Not a plugin: no executable entry point.
- Not a permission grant: invoking a skill does not widen the tool policy.
