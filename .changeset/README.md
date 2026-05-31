# Changesets

This repository uses [changesets](https://github.com/changesets/changesets) to manage npm package versions and releases.

## Package Publishing Strategy

This repository uses an **independent, manually-selected publishing** strategy. When generating a changeset, only select the publishable packages that this change actually affects. The repository's `.changeset/config.json` already filters out internal workspace packages via `ignore`, so only the publishable packages listed below should appear in the `pnpm changeset` prompt.

Current publishable packages:

| Package | Directory | Description |
| --- | --- | --- |
| `@scream-cli/scream-code` | `apps/scream-code` | CLI / TUI application — provides the `scream` command after install |
| `@scream-cli/scream-code-sdk` | `packages/node-sdk` | Public TypeScript SDK |

All other workspace packages are private internal packages, are not published to npm, and are excluded via `ignore` in `.changeset/config.json`:

- `@scream-cli/agent-core`
- `@scream-cli/scream-code-oauth`
- `@scream-cli/scream-telemetry`
- `@scream-cli/jian`
- `@scream-cli/ltod`
- `@scream-cli/vis`
- `@scream-cli/vis-server`
- `@scream-cli/vis-web`

Version impact from internal dependencies must be judged manually. The published artifacts for CLI and SDK bundle internal workspace packages into the artifact itself; runtime `dependencies` of published packages must not include any `@scream-cli/*` internal workspace packages.

The repository's `.changeset/config.json` sets `updateInternalDependencies: "patch"`. Because internal packages are not published, you still need to manually select all affected publishable packages in the changeset — do not rely solely on automatic dependency bumps to express user-visible changes.

Example scenarios:

| Change | Changeset selection |
| --- | --- |
| Only modifies TUI behavior in `@scream-cli/scream-code` | Add `patch` / `minor` / `major` to `@scream-cli/scream-code` |
| Only modifies internal packages, no user-visible change in SDK / CLI | Usually no changeset needed |
| Internal package fix changes the CLI user experience | Add a changeset to `@scream-cli/scream-code` describing the user-visible fix |
| Internal package adds a new capability exposed by the SDK | Add a changeset to `@scream-cli/scream-code-sdk` |
| SDK behavior change affects CLI user experience | Add changesets to both `@scream-cli/scream-code-sdk` and `@scream-cli/scream-code` |
| Provider abstraction change affects SDK / CLI | Add changesets to the affected `@scream-cli/scream-code-sdk` and/or `@scream-cli/scream-code` |
| Test-only, internal refactor, docs, or private debug tooling changes | Usually no changeset needed |

## Prerequisite: NPM Trusted Publishing (OIDC)

This repository uses npm's **Trusted Publishing** (OIDC-based) for publishing — no `NPM_TOKEN` is required.

### Configuration steps

1. Open each publishable package's page on the npm website, e.g. `https://www.npmjs.com/package/@scream-cli/scream-code`.
2. Go to **Settings** -> **Publishing access**.
3. Find **Automate publishing with GitHub Actions** or **Add trusted publisher**.
4. Click **Add a new trusted publisher**.

Fill in the following:

| Field | Value |
| --- | --- |
| GitHub Organization | `LIUTod` |
| GitHub Repository | `scream-code` |
| GitHub Workflow | `release.yml` |
| Environment | leave empty |

Each publishable package needs its Trusted Publisher configured once. The current GitHub Actions workflow lives at `.github/workflows/release.yml` and already has `id-token: write` configured.

## Development Workflow

### 1. Implement the feature or fix

Complete code, tests, and documentation changes as usual. A changeset is required when the change affects user-visible behavior, public API, dependency ranges, or release artifacts of a publishable package.

### 2. Generate a changeset

From the repository root:

```sh
pnpm changeset
```

Follow the prompts to choose:

- Which publishable packages this change affects;
- The version bump level:
  - `patch`: bug fixes, small changes, follow-up dependency updates;
  - `minor`: backward-compatible new features;
  - `major`: breaking changes;
- A user-facing description of the change.

The command creates a `.changeset/*.md` file that must be committed alongside the code.

### 3. Commit the changeset

```sh
git add .changeset/
git commit -m "chore: add changeset for package release"
git push
```

Commit messages must follow Conventional Commit style. Do not include any author/agent identity in the commit message.

### 4. CI generates the release PR

Once the changeset file is merged into `main`, `.github/workflows/release.yml` uses `changesets/action@v1` to create or update a release PR.

The release PR runs:

- `pnpm changeset version`: bumps publishable package versions and updates changelogs;
- Deletes the consumed `.changeset/*.md` files;
- Uses the title `[CI]: Release packages`.

### 5. Merge the release PR

Once the release PR is merged into `main`, the same workflow runs:

- `pnpm install --frozen-lockfile`
- `pnpm build`
- `pnpm changeset publish`

The packages are then published via npm Trusted Publishing, and a GitHub Release is created.

## Manual Publishing (Not Recommended)

Only publish manually when CI is unavailable. Before publishing manually, make sure you are logged into npm locally and using the Node.js and pnpm versions required by the repository.

```sh
pnpm run version
pnpm run publish
```

The underlying changesets commands are:

```sh
pnpm changeset version
pnpm changeset publish
```

The root-level `pnpm run publish` first runs typecheck, lint, sherif, test, build, and package lint, then runs `changeset publish`.

## Notes

- Every PR that affects publishable-package behavior or public API should include a corresponding changeset.
- Changeset files must be committed to the repository — release PRs are only triggered after they're merged.
- Release PRs require human review and merge; they will not publish automatically.
- Do not add release changesets for private internal packages; only select `@scream-cli/scream-code` and `@scream-cli/scream-code-sdk`.
- If a change in an underlying internal package alters user-visible behavior or public API of a publishable package, add a changeset to the affected publishable package. For example, when a bug fixed in `@scream-cli/agent-core` resolves an issue CLI users encounter, add a changeset to `@scream-cli/scream-code` describing the user-visible fix.
- `@scream-cli/scream-code` is the official CLI package name; after a global install it provides the `scream` command.
- Make sure each publishable package on npm has a Trusted Publisher configured.

## References

- [Changesets documentation](https://github.com/changesets/changesets)
- [Changesets GitHub Action](https://github.com/changesets/action)
- [npm Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers)
