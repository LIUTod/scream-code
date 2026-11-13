# Edit benchmark

A deterministic benchmark that measures how reliably the agent executes
**file-edit tool calls** (`Edit` / `replace_range`-style edits, anchor
matching, multi-hunk sequencing, long-line handling). It gates the upcoming
edit-format and anchor-recovery changes (#10 / #11): those changes move this
number, and this benchmark is the instrument that shows it.

The benchmark corrupts TypeScript fixture files with controlled mutations and
asks a real model session to repair each one with the Edit tool. The harness
verifies the workspace file byte-for-byte after the turn, so a case passes
only when the edit landed exactly.

## What is measured

Each case pairs a **mutation class** with a **fixture file**:

| Category | Class | What the model must do |
| --- | --- | --- |
| `surgical` | `identifier-rename` | Fix one misspelled identifier occurrence among correct ones |
| `multi-hunk` | `identifier-rename-multi` | Fix the same misspelling at 3+ sites |
| `whitespace` | `subtle-whitespace` | Restore indentation of one statement (±2 spaces) |
| `comment` | `comment-swap` | Replace a wrong comment with the correct wording |
| `boundary` | `boundary-splice` | Fix a literal on a line near the 400/1000-line Read-window boundary |
| `duplicate` | `duplicate-line` | Remove a near-duplicate line inserted above its original |
| `long-line` | `long-line-splice` | Fix one token inside a >300-character line |
| `multi-hunk` | `multi-hunk-double` | Fix an identifier misspelling and an indentation slip in one turn |
| `recovery` | `external-shift` | Fix a mutation while the file on disk has been shifted (1..3 lines inserted/deleted) after the prompt's line numbers were computed — the model must read, discover the shift, and still land the edit |

Fixtures (`src/edit-bench/fixtures.ts`): a ~40-line util, a ~120-line class
file, a generated >1200-line table, deeply nested control flow, and a
regex/string-heavy file carrying the >300-character line. All contents are
plain string constants — deterministic across runs and processes.

Prompts are terse English and state the expected target (e.g. the correct
identifier, the correct comment). The benchmark measures **edit execution** —
locating the spot and landing an exact replacement — not puzzle solving.

## How to run

Unit tests (no model, no network, part of the standard `pnpm test` gates):

```sh
pnpm -C packages/evals exec vitest run src/edit-bench/edit-bench.test.ts --config vitest.config.ts
```

Real benchmark run (sequential, slow, token-billed — scope it while
iterating):

```sh
SCREAM_EVAL_MODEL=provider/model pnpm -C packages/evals exec tsx \
  --import ../../build/register-raw-text-loader.mjs src/edit-bench/cli.ts \
  --seed=7 --max=40 --categories=surgical,multi-hunk
```

Programmatic use:

```ts
import { runEditBenchmark } from '@scream-code/evals';

const report = await runEditBenchmark({ maxCases: 10, categories: ['recovery'] });
```

- `model` defaults to `SCREAM_EVAL_MODEL`; unset → error.
- `screamHome` defaults to the real home (developer provider config); pass a
  temp dir for isolated runs.
- `seed` defaults to a fixed value so default runs are comparable;
  `maxCases` caps the sampled (class × fixture) pairs (default 40 — the full
  applicable pair set is 37).
- Cases always run **strictly sequentially**: the harness tears down its
  workspace and session per run.

## Reading the baseline

- `passed` / `failed`: a case passes only when the post-turn file matches the
  expected content exactly and the turn did not time out.
- `byCategory`: the signal for #10/#11 — e.g. a drop in `boundary` after a
  Read-window change, or in `recovery` after an anchor-recovery change, is
  exactly what the benchmark exists to catch.
- `totalTokens`: cost estimate; budget roughly one session per case.

## Notes and limitations

- Every mutation is seeded: same `(class, fixture, seed)` → same corruption.
- `fix` (the expected-content side) inverts mutations by token/line search
  with neighbour-context disambiguation, so it stays correct on shifted
  content; the recorded line number is only a fast path.
- Tokens inside string literals are fair mutation targets; the benchmark
  cares about edit mechanics, not language semantics.
- Real-model runs are deliberately manual. The `.eval.ts` suites in this
  package stay untouched; this benchmark is never run by `pnpm eval`.
