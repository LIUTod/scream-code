# Scream Code CLI Tools

## Guidelines

- Tools should not refer to types in `scream/wire/` unless they are explicitly implementing a UI / runtime bridge. When importing things like `ToolReturnValue` or `DisplayBlock`, prefer `ltod.tooling`.
