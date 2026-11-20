---
"scream-code": minor
---

A folded work block shows what each edit changed. Under every finished Edit / Write row come its changed lines with their real line numbers — removed lines on a red background, added lines on a green one — up to four per edit and a "… N more" count, so a turn's changes read without Ctrl+O (which still shows the full diff with context). The newest edit always shows its lines; older ones keep them while the block has room (a folded block is now 14 rows instead of 8). `/blockrows` gains "changed lines per edit" (0, 2, 4, 6, 8; 0 turns the preview off) and the folded height offers 14 and 20. The tools report where lines changed, not file contents: deleted text appears only when the call itself carried it (an edit's old text), so an overwrite shows its removed lines as a count. Sessions recorded before this show an edit's changes without line numbers.
