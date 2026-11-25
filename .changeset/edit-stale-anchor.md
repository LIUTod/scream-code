---
"@scream-code/agent-core": patch
---

Edit no longer refuses a string edit because its anchor is stale. Models pass the anchor of their last Read on every Edit, and their own earlier edit of the file changes it; that refusal ("File has changed since last read") was the most common Edit failure and what pushed models into editing files through the shell. An `old_string` edit now applies whenever its text matches the current file, noting an outside change only when someone other than the model changed it. Line-range edits can keep using the numbers of the last Read across the model's own edits: Edit keeps a short history of each file's views (Read, Edit and now Write record them) and carries the window across, refusing only when those very lines were already changed. Read, Edit and the working-set reminder now say the anchor is only needed for line ranges, and no longer tell the model not to re-read.
