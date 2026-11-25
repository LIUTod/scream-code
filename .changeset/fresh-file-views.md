---
"@scream-code/agent-core": minor
---

The model keeps an up-to-date view of the files it works on in long sessions, so its edits keep matching instead of failing and pushing it to edit through the shell. Clearing old tool results now keeps the newest Read of a file it has since edited (up to three, each under 6k tokens), and a cleared Read names the file to read again. After a full compaction, the files it was working on come back as their current text, numbered like Read (up to five files, 5k tokens each, 50k in all and never more than 15% of the context window). A file it read or edited that changed outside its own edits — by you, a formatter or a command — comes back before the next step as the changed lines. An Edit's result now ends with the edited lines as they are, numbered like Read.
