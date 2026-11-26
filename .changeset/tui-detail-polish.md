---
"scream-code": patch
---

Interface polish for the approval panel, the model picker and a few details around them.

- The approval panel reads in the interface language: the key hint, the working directory label and the danger line were fixed English text. The hint now includes Esc.
- The approval panel is laid out as title (the file and how much changed), one line for the source and the request, the diff, then the question directly above the choices. An Edit's diff is drawn by the same code as the activity block (soft bands, changed words on a deeper band, file line numbers), inside a dashed frame.
- A command's approval shows the command first, then the warning and the danger, then the question.
- The approval panel fits the terminal: on a short terminal the choices, the question and the key hints stay, and the source line, the frame, the unchanged lines and the diff itself give way in that order.
- A refusal can carry a note: press Tab on "Reject" and type it. The separate "Reject with feedback" choice is gone.
