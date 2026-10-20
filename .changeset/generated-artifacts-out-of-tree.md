---
"scream-code": patch
---

Generated plan files no longer create a visible `plan/` folder in the project root when an agent has no session home: they now go to `.scream/plans`, which is already gitignored. The coverage report also moved out of the repository root to `node_modules/.cache/coverage`, so running the test suite no longer leaves a 27 MB `coverage/` directory behind.
