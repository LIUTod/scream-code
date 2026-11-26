---
"scream-code": patch
---

Interface polish for the approval panel, the model picker and a few details around them.

- The approval panel reads in the interface language: the key hint, the working directory label and the danger line were fixed English text. The hint now includes Esc.
- The approval panel is laid out as title (the file and how much changed), one line for the source and the request, the diff, then the question directly above the choices. An Edit's diff is drawn by the same code as the activity block (soft bands, changed words on a deeper band, file line numbers), inside a dashed frame.
- A command's approval shows the command first, then the warning and the danger, then the question.
- The approval panel fits the terminal: on a short terminal the choices, the question and the key hints stay, and the source line, the frame, the unchanged lines and the diff itself give way in that order.
- A refusal can carry a note: press Tab on "Reject" and type it. The separate "Reject with feedback" choice is gone.
- The model picker shows what each model is: a quiet column with the provider, the context size and what it can read, so models can be compared before one is picked. The thinking level is a scale of glyphs (the active step bracketed), listing only the levels the model offers, and a model without thinking says so. What the model can read is one row. The page and "no matches" text follow the interface language, and the key hints are no longer in the dimmest grey.
- The model picker fits the terminal too: on a short terminal it drops the capability and image rows, shows fewer models per page, and sheds the page and thinking hints before it would cut off Enter and Esc.
- The slash menu puts what you run first: on a bare `/` the five commands run most lately lead the list, marked "recent", and a one-letter filter such as `/m` lists `/model` before `/memory` once it is the one you use. A better match still wins over use. Counts fade with a half-life of two weeks and are kept in `command-usage.json` in the data directory.
- The slash menu's descriptions no longer shift left as the list narrows: every command name takes the same width.
- Ctrl+↑ and Ctrl+↓ jump to the previous and the next prompt in the transcript. The terminal view already had the keys; each message now marks where it starts, so they work (they did nothing before). Ctrl+Shift+↑/↓ is the same, for desktops that keep Ctrl+↑ for themselves (some use it to switch workspaces). Listed in `/hotkeys`.
- Confirmations that only matter for a moment — "copied", "highlight on", "cancelled", "unchanged", the result of picking a display option — now appear as a toast in the top-right corner and clear themselves, instead of becoming a permanent line in the transcript. Errors, warnings and anything worth reading again stay in the transcript.
