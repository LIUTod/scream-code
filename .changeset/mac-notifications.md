---
"scream-code": patch
---

macOS notifications no longer come from Script Editor. The background posted them through `osascript`, so each banner carried Script Editor's name and icon and a click opened Script Editor on a new document. Now an open Scream terminal raises the notification from the terminal app (OSC 9, or the bell where the terminal has no notifications), and a click brings that window forward; with `terminal-notifier` installed the background also shows them when no terminal is open. The same terminal fallback now covers a session over SSH (where the background's toast would show on the remote screen, if anywhere) and a Linux without a desktop or `notify-send`. On Linux a title or message starting with "-" no longer makes `notify-send` fail.
