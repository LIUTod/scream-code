# Contributing to Scream Code

Thank you for your interest in contributing!

## Getting Started

- Node.js >= 22.0.0
- pnpm 10.33.0

```bash
pnpm install
pnpm run build
pnpm test
```

## Development Workflow

1. Open an issue before sending a feature PR.
2. Follow the pull request template.
3. Add tests for new functionality.
4. Generate a changeset if your change affects a published package.

## Project Structure

- `apps/scream-code`: CLI / TUI application
- `apps/vis`: Visual debugging tools
- `packages/agent-core`: Agent engine
- `packages/node-sdk`: Public TypeScript SDK
- `packages/ltod`: LLM provider abstraction
- `packages/jian`: Execution environment
- `packages/oauth`: OAuth utilities
- `packages/telemetry`: Telemetry infrastructure
