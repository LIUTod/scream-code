# Cold-start comprehension eval — baseline results

Eval: `packages/evals/src/cold-start.eval.ts`
Harness: `runEvalPrompt` (fresh isolated session per run, yolo permissions, temp workspace with 3-module TS fixture).

## What it measures

Cost and correctness of answering a "where/why" question about an unfamiliar
codebase: `(1)` which module owns retry decisions, `(2)` why that decision is
kept out of the HTTP layer (only discoverable from a source comment).

| Metric | Meaning |
| --- | --- |
| `inputTokens` | context cost — proxy for how much reading the agent needed |
| `outputTokens` | answer verbosity |
| `totalTokens` | overall cost |
| correctness | output must name `scheduler` and mention socket/timeout/backoff/budget |

## Baseline (no semantic search MCP connected)

| Field | Value |
| --- | --- |
| Status | pending — run with `SCREAM_EVAL_MODEL=provider/model pnpm -C packages/evals run eval` |
| Runs | — |

## Variant B (zvec-grep MCP connected + workspace indexed)

| Field | Value |
| --- | --- |
| Status | pending — requires `zg server on` and `zg index` on the eval workspace; run the same command with the server up |
| Runs | — |

## How to fill this in

1. Baseline: `SCREAM_EVAL_MODEL=<provider/model> pnpm -C packages/evals run eval` (with no search MCP configured).
2. Variant: install/index once (`zg index --embedding local/potion-code-16m-v2` on a copy of the fixture), add the `zvec-grep` HTTP entry, re-run.
3. Record `usage` numbers from the vitest output plus pass/fail, 3 runs each, and note the mean.

Decision rule: if Variant B meaningfully lowers `totalTokens` while keeping
correctness at 100%, the MCP search slot earns its keep; otherwise revisit.
