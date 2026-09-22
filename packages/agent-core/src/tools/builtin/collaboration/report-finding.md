Report a code review finding. Use this tool for each issue found during a review. Call it once for each issue.

Use this tool only when acting as a reviewer agent. Do not use it when writing or editing code.

Each finding must be evidence-backed, anchored to the patch under review, and must satisfy every reporting criterion in your review procedure.

Priority: P0 blocks release/operations · P1 fix next cycle · P2 fix eventually · P3 nice to have.

Example:
```json
{
  "title": "Validate input length before buffer copy",
  "body": "When data.length > BUFFER_SIZE, memcpy writes past buffer boundary. Occurs if API returns oversized payloads, causing heap corruption.",
  "priority": "P0",
  "confidence": 0.95,
  "file_path": "src/buffer.c",
  "line_start": 42,
  "line_end": 44
}
```
