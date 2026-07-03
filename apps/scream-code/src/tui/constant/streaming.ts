// Extracts useful string fields from partially streamed JSON tool args.
// This is intentionally a preview parser, not a full JSON parser.
export const STREAMING_ARGS_FIELD_RE =
  /"(path|file_path|command|pattern|query|url|description|title|name)"\s*:\s*"((?:\\.|[^"\\])*)"/g;

// Bounds live tool-argument previews; final tool.call payloads remain complete.
// 8KB is enough for the preview fields (path/command/pattern/url/description)
// without re-parsing a 64KB buffer on every delta — appendSubToolCallDelta
// re-parses the whole buffer per delta, so the cap doubles as a perf bound.
export const STREAMING_ARGS_PREVIEW_MAX_CHARS = 8 * 1024;

// Coalesces high-frequency model/tool deltas before rebuilding TUI components.
export const STREAMING_UI_FLUSH_MS = 50;

// Bounds pathological provider error bodies (e.g. a proxy 502 whose body is a
// full HTML page) rendered inline in the transcript so they can't flood the
// scrollback. Full text is still kept in the persisted session.
export const MAX_TRANSCRIPT_ERROR_LINES = 8;
