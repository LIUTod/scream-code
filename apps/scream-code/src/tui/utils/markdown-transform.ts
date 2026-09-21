/**
 * Markdown text transformers.
 *
 * A transformer rewrites Markdown source before the renderer parses it, which
 * is how a fenced block gets replaced by something the terminal can actually
 * draw. Transformers run one after another and each is isolated: one that
 * throws is skipped and the text produced so far is kept. A drawing failure
 * must never take a reply down with it.
 */

/** Which transcript surface the text came from. Drawing rules differ per kind. */
export type MarkdownMessageKind = 'assistant' | 'thinking';

export interface MarkdownTransformContext {
  readonly messageKind: MarkdownMessageKind;
  /** True while the reply is still arriving token by token. */
  readonly streaming: boolean;
  /** Exact columns the renderer has for content — the same width it wraps at. */
  readonly availableWidth: number;
}

export type MarkdownTransformer = (
  markdown: string,
  context: MarkdownTransformContext,
) => string;

/**
 * Bind a message kind and a live streaming signal to a transformer list,
 * producing the callback the Markdown component calls on every render.
 *
 * `isStreaming` is read per render rather than captured, so flipping a
 * preference takes effect on the next frame without rebuilding components.
 */
export function createMarkdownTransform(
  messageKind: MarkdownMessageKind,
  isStreaming: () => boolean,
  transformers: readonly MarkdownTransformer[],
): (markdown: string, availableWidth: number) => string {
  return (markdown, availableWidth) => {
    if (transformers.length === 0) return markdown;
    const context: MarkdownTransformContext = {
      messageKind,
      streaming: isStreaming(),
      availableWidth,
    };
    let text = markdown;
    for (const transform of transformers) {
      try {
        text = transform(text, context);
      } catch {
        // A transformer that cannot handle this text is not worth showing
        // the user an error for — keep whatever the previous one produced.
      }
    }
    return text;
  };
}
