# Changesets

A changeset records a user-visible change that has not been released yet.
Releases are manual (see "Releasing" in `AGENTS.md`): the pending files are the
record of what the next release ships, not instructions to a release bot.

## What is published

Only `scream-code` (`apps/scream-code`) is published to npm; it provides the
`scream` command. Every other workspace package is private and bundled into the
CLI. `.changeset/config.json` puts all nine packages in one fixed group, so they
always share one version.

## When to add one

Add a changeset when users can notice the change: behavior, commands and flags,
configuration, output, or a bundled dependency. Internal refactors, tests and
docs need none. Name the CLI package, which is what users install:

```md
---
"scream-code": patch
---

What changed, from the user's point of view.
```

Use `patch` for fixes and small changes, `minor` for backward-compatible
features, `major` for breaking changes. `pnpm changeset` writes the same file
interactively. `npx changeset status` checks that every pending file names a
package that exists in the workspace.

## At release time

After a release is published, delete the changesets it shipped; the files left
describe what is still unreleased. `changeset version` / `changeset publish`
and the "Create Release Pull Request" job in `release.yml` (manual dispatch
only) are not part of the normal flow.

Commit messages follow Conventional Commits and carry no author or agent
identity.
