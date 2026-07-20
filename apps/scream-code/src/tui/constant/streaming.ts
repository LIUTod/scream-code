// Extracts useful string fields from partially streamed JSON tool args.
// This is intentionally a preview parser, not a full JSON parser.
export const STREAMING_ARGS_FIELD_RE =
  /"(path|file_path|command|pattern|query|url|description|title|name)"\s*:\s*"((?:\\.|[^"\\])*)"/g;

// Bounds live tool-argument previews; final tool.call payloads remain complete.
// 8KB is enough for the preview fields (path/command/pattern/url/description)
// without re-parsing a 64KB buffer on every delta — parse consumers slice
// their own window from the accumulated buffer.
export const STREAMING_ARGS_PREVIEW_MAX_CHARS = 8 * 1024;

// Bounds the ACCUMULATED streaming-arguments buffer itself. Kept generous
// (1MB ≈ 25k lines) so live previews can render from the stream's tail —
// the old 8KB accumulation cap visibly froze Write previews mid-file.
// Parse cost stays bounded because every consumer slices its own window
// (parseStreamingArgs reads the head, the Write tail preview reads the tail).
export const STREAMING_ARGS_BUFFER_MAX_CHARS = 1024 * 1024;

// Coalesces high-frequency model/tool deltas before rebuilding TUI components.
export const STREAMING_UI_FLUSH_MS = 50;

// Bounds pathological provider error bodies (e.g. a proxy 502 whose body is a
// full HTML page) rendered inline in the transcript so they can't flood the
// scrollback. Full text is still kept in the persisted session.
export const MAX_TRANSCRIPT_ERROR_LINES = 8;
