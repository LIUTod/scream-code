Find files (and optionally directories) by glob pattern, sorted by modification time (most recent first).

Good patterns:
- `*.ts` — files in the current directory matching an extension
- `src/**/*.ts` — recursive with a subdirectory anchor and extension
- `test_*.py` — files whose name starts with a literal prefix

Patterns with no literal anchor (`**/*.ts`, `**`, `*/*`) are accepted, but they may have to walk the whole tree. They run under a time budget: on a very large tree the search stops early and the result is marked partial. Pass `path` or anchor the pattern with a subdirectory (`src/**/*.ts`) to get a complete answer fast.

Not supported:
- `*.{ts,tsx}` — brace expansion. Issue two calls: `*.ts` and `*.tsx`.

Default pruning:
- `.git` and `node_modules` directories are skipped by default, so recursive patterns stay fast and do not drag VCS or dependency trees into the results.
- Naming one of them as its own path segment (e.g. `node_modules/react/src/**/*.js`) re-enables the walk into that name — explicit queries still resolve.

Large-directory warning — avoid recursing into dependency/build output even with an anchor:
- `node_modules/**/*.js`, `.venv/**/*.py`, `__pycache__/**`, `target/**` all match technically but
  typically produce thousands of results that truncate at the {{ MAX_MATCHES }}-match cap and waste the caller context.
  Prefer specific subpaths like `node_modules/react/src/**/*.js`.