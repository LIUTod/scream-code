---
"scream-code": patch
---

Opening a large old session no longer runs out of memory. Sessions written before the compaction debug trail was capped carry every earlier compaction's history inside each snapshot record, so a single line could be hundreds of megabytes; resume parsed all of it only to keep the last two entries, and the reclaim pass parsed it again to empty it. The trail is now cut on the raw bytes before a line is decoded — emptied for snapshots a later one supersedes, the last two kept for the newest — so memory no longer grows with it. On a 683 MB test wire the peak fell from 2.27 GB to 1.12 GB; a real 382 MB session opens in about 600 MB.
