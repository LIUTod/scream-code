Perform exact string replacements against the text view returned by Read.

- By default, old_string must occur exactly once. If it matches multiple locations, add surrounding context.
- Prefer Edit for targeted changes to existing files; use Write only for new files or complete overwrites.
- To modify a file, always use Edit; do not run a Shell `sed` command for edits.
- When making several independent changes to different files (or several str_replace edits to one file), issue multiple Edit calls in parallel within a single response; edits to the same file are serialized automatically by a write lock.
- When several parallel Edit calls target the same file, a write lock serializes them; they apply in the order the calls appear in your response. An edit fails with `old_string not found` if its old_string was taken from text an earlier edit already replaced - base every old_string on the latest Read view and order dependent edits accordingly.
- Edit refuses if `old_string` lands inside an unresolved merge conflict block, or if `new_string` would introduce `<<<<<<<`/`=======`/`>>>>>>>` markers. To clean up a conflict, include the markers in `old_string` so Edit replaces them.
- Line-range mode: pass `start_line` + `end_line` (1-indexed against the model view of the most recent Read) together with `new_string`, omitting `old_string`; the whole window is replaced, and `new_string: ''` deletes it. The anchor from that Read is required — line numbers are only meaningful against it — `replace_all` is rejected, and `end_line` must not exceed the file's total line count. A range strictly inside a conflict block is refused; widen it to cover the whole block, markers included. After a line-range edit the file's anchor changes — Read the file again before another line-range edit on the same file (str_replace edits are unaffected).
- Prefer `old_string` for surgical string edits; prefer line-range mode for large structural swaps of text you have just read.
