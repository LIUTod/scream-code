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

// --- Smooth streaming (token pacing) ----------------------------------------
// Decouples arrival from display: token deltas land in the draft buffer and a
// per-frame budget advances how much is shown, so fast models stream smoothly
// instead of dumping 50ms bursts, slow models keep up (arrival-triggered) and
// network bursts are smoothed across frames instead of jumping in one block.

// Frame cadence for the progressive renderer. 50ms (20fps) keeps the stream
// visibly smooth while bounding markdown re-parses: every frame re-renders the
// full text, so a higher cadence would double re-parse cost for little visible
// gain (the pacing budget, not the frame rate, is what smooths bursts).
export const SMOOTH_FRAME_MS = 50;

// Minimum chars shown per frame: keeps the stream moving even when the model
// is slow or the rate window is empty (never freeze mid-stream).
export const MIN_CHARS_PER_FRAME = 1;

// Base ceiling chars per frame while the display is keeping up: 25 chars at
// the 50ms cadence ≈ 500 chars/s. An oversized burst is spread across frames
// instead of rendered at once; a stream faster than that would otherwise stay
// behind for its whole duration and land in one jump at finalize.
export const MAX_CHARS_PER_FRAME = 25;

// Backlog (chars arrived but not yet shown) past which catch-up pacing kicks
// in. Below the threshold the base budget above is unchanged; a stream faster
// than ~500 chars/s crosses it and is caught up with instead of accumulating
// until finalize.
export const SMOOTH_CATCHUP_THRESHOLD = 250;

// Catch-up budget = ceil(backlog / DIVISOR) chars per frame. Growing the
// budget with the backlog converges the display to a bounded lag of ≈DIVISOR
// frames (8 × 50ms ≈ 400ms) instead of an unbounded one.
export const SMOOTH_CATCHUP_DIVISOR = 8;

// Hard ceiling of the catch-up budget, so even a huge backlog drains as a
// fast frame-by-frame animation rather than one full-text dump.
export const SMOOTH_CATCHUP_MAX_PER_FRAME = 300;

// Assumed arrival rate used until the first speed sample lands, so the very
// first (often large) block is paced sensibly instead of crawling at MIN=1.
export const DEFAULT_ARRIVAL_TOK_PER_SEC = 50;

// Bounds pathological provider error bodies (e.g. a proxy 502 whose body is a
// full HTML page) rendered inline in the transcript so they can't flood the
// scrollback. Full text is still kept in the persisted session.
export const MAX_TRANSCRIPT_ERROR_LINES = 8;
