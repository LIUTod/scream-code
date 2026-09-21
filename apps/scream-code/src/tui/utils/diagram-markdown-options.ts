/**
 * The Markdown options every transcript surface should pass to the renderer.
 *
 * Diagram drawing hangs off `MarkdownOptions.transform`, and the option is read
 * once when the component is built — so a surface that forgets it silently shows
 * diagrams as source while others draw them. One factory keeps the three call
 * sites (assistant reply, plan box, side-chat answer) from drifting apart.
 */

import type { MarkdownOptions } from '@liutod-scream/pi-tui';

import type { ColorPalette } from '../theme/colors';
import { createDiagramTheme } from '../theme/pi-tui-theme';

import { createMarkdownTransform, type MarkdownMessageKind } from './markdown-transform';
import { createMermaidTransformer } from './mermaid-diagram';

/**
 * @param colors Palette the drawing is painted with; resolved per use, not here.
 * @param messageKind Which surface this is — thinking text never gets a picture.
 * @param isStreaming Read on every render, so a component can flip this as the
 *   reply completes without rebuilding the Markdown instance.
 */
export function diagramMarkdownOptions(
  colors: ColorPalette,
  messageKind: MarkdownMessageKind = 'assistant',
  isStreaming: () => boolean = () => false,
): MarkdownOptions {
  const theme = createDiagramTheme(colors);
  return {
    transform: createMarkdownTransform(messageKind, isStreaming, [
      createMermaidTransformer({ getTheme: () => theme }),
    ]),
  };
}
