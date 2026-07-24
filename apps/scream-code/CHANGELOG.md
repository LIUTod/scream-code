# scream-code

## 0.11.0

### Minor Changes

- [#10](https://github.com/LIUTod/scream-code/pull/10) [`9da302d`](https://github.com/LIUTod/scream-code/commit/9da302d823244eb87c57e247c0836fdaab2bf80a) - Add `--wolfpack` CLI flag to start with WolfPack batch mode enabled.

  Previously WolfPack mode could only be toggled at runtime via the `/wolfpack`
  slash command. This adds a CLI startup option (`--wolfpack`) symmetric to the
  existing `--plan` and `--auto` flags, so users can launch a session with
  WolfPack already active.
