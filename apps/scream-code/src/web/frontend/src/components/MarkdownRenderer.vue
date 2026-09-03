<script lang="ts">
import { computed, h, defineComponent, ref, watch } from 'vue';
import { marked, type Token } from 'marked';
import CodeBlock from './CodeBlock.vue';
import { openImageLightbox } from '../utils/imageLightbox';

// Enable GFM features (task lists, tables, strikethrough) and line breaks.
marked.setOptions({ gfm: true, breaks: false });

/**
 * Size guard for settled messages: a giant log/code dump would otherwise run
 * marked.lexer over the whole body and patch thousands of vnodes at once.
 * Long finalized messages render a preview until the user expands them.
 * Streaming messages are exempt (rAF-coalesced already, and truncating
 * mid-stream would fight the fence-trim logic).
 */
const MAX_INLINE_MARKDOWN_CHARS = 40_000;
const COLLAPSED_PREVIEW_CHARS = 6_000;

export default defineComponent({
  props: {
    content: { type: String, required: true },
    streaming: { type: Boolean, default: false },
  },
  setup(props) {
    // While streaming, coalesce re-renders to at most one per animation
    // frame (chunks arrive as separate macrotasks; Vue's microtask batching
    // cannot merge them). When streaming ends, force one full render with
    // the final content so nothing is left in a stale frame.
    const renderContent = ref(props.content);
    let rafId: number | null = null;

    // Size guard: 'expanded' resets whenever the body swaps wholesale (i.e.
    // the component is reused for a different message via :key-less patching).
    const expanded = ref(false);
    let lastSource = props.content;
    watch(
      () => props.content,
      (value) => {
        if (!value.startsWith(lastSource) && !lastSource.startsWith(value)) expanded.value = false;
        lastSource = value;
      },
    );
    const guarded = computed(
      () => !props.streaming && !expanded.value && renderContent.value.length > MAX_INLINE_MARKDOWN_CHARS,
    );

    watch(
      () => props.content,
      (value) => {
        if (!props.streaming) {
          renderContent.value = value;
          return;
        }
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          renderContent.value = props.content;
        });
      },
    );

    watch(
      () => props.streaming,
      (streaming, wasStreaming) => {
        if (wasStreaming && !streaming) {
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          renderContent.value = props.content;
        }
      },
    );

    const nodes = computed(() => {
      const source = guarded.value ? previewOf(renderContent.value) : renderContent.value;
      const safeContent = trimPartialClosingFences(source);
      const tokens = marked.lexer(safeContent);
      return tokens.flatMap((token) => renderToken(token, props.streaming));
    });

    const totalChars = computed(() => renderContent.value.length);

    return () => {
      const children = nodes.value.slice();
      if (guarded.value) {
        children.push(
          h(
            'button',
            { class: 'md-expand', type: 'button', onClick: () => { expanded.value = true; } },
            `展开全文（共 ${totalChars.value.toLocaleString()} 字符，当前仅预览前 ${COLLAPSED_PREVIEW_CHARS.toLocaleString()}）`,
          ),
        );
      }
      return h('div', { class: 'markdown-body' }, children);
    };
  },
});

/**
 * Cut a giant body down to the preview window at a line boundary (so we never
 * slice through a code fence mid-line). Anything after the cut is dropped
 * until the user expands.
 */
function previewOf(content: string): string {
  const cut = content.lastIndexOf('\n', COLLAPSED_PREVIEW_CHARS);
  return (cut > COLLAPSED_PREVIEW_CHARS / 2 ? content.slice(0, cut) : content.slice(0, COLLAPSED_PREVIEW_CHARS)) + '\n…';
}

/**
 * During streaming, a ``` fence may be open but not yet closed.
 * marked.lexer will treat everything after an unclosed ``` as code content,
 * swallowing the rest of the message. Trim the trailing unclosed fence
 * so the partial code block renders as text instead.
 */
function trimPartialClosingFences(content: string): string {
  // Count ``` fences in the content.
  const fenceRegex = /^(`{3,})/gm;
  let openFence: string | null = null;
  let openFenceIndex = -1;
  let openFenceLength = 0;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(content)) !== null) {
    const fence = match[1]!;
    if (openFence === null) {
      openFence = fence;
      openFenceIndex = match.index;
      openFenceLength = fence.length;
    } else if (fence.length >= openFenceLength) {
      // Closing fence found.
      openFence = null;
    }
  }
  if (openFence !== null) {
    // Unclosed fence: trim everything from the opening fence onwards.
    return content.substring(0, openFenceIndex).trimEnd();
  }
  return content;
}

/**
 * Loose view over marked's discriminated token union. Casting through
 * `unknown` is intentional: the renderers access a superset of fields that
 * the union cannot express generically, and the `type` switch already
 * narrows which fields are populated at runtime.
 */
interface LooseToken {
  type: string;
  raw?: string;
  text?: string;
  href?: string;
  lang?: string;
  depth?: number;
  ordered?: boolean;
  tokens?: Token[];
  items?: { task: boolean; checked: boolean; tokens: Token[] }[];
  header?: Token[];
  rows?: Token[][];
  align?: ('center' | 'left' | 'right' | null)[];
}

function asLoose(token: Token): LooseToken {
  return token as unknown as LooseToken;
}

function renderToken(token: Token, streaming = false): ReturnType<typeof h>[] {
  const t = asLoose(token);
  switch (t.type) {
    case 'paragraph':
      return [h('p', { class: 'md-p' }, renderInline(t.tokens ?? []))];
    case 'heading':
      return [h(`h${t.depth ?? 2}`, { class: `md-h${t.depth ?? 2}` }, renderInline(t.tokens ?? []))];
    case 'code':
      return [h(CodeBlock, { code: t.text ?? '', lang: t.lang ?? 'text', streaming })];
    case 'blockquote':
      return [h('blockquote', { class: 'md-blockquote' }, (t.tokens ?? []).flatMap((n) => renderToken(n, streaming)))];
    case 'list': {
      const items = (t.items ?? []).map((item) => {
        const children: (ReturnType<typeof h> | string)[] = [];
        if (item.task) {
          children.push(h('input', { type: 'checkbox', checked: item.checked, disabled: true, class: 'md-checkbox' }));
        }
        children.push(...item.tokens.flatMap((n) => renderToken(n, streaming)));
        return h('li', { class: ['md-li', item.task ? 'md-task' : ''] }, children);
      });
      return [h(t.ordered ? 'ol' : 'ul', { class: t.ordered ? 'md-ol' : 'md-ul' }, items)];
    }
    case 'hr':
      return [h('hr', { class: 'md-hr' })];
    case 'space':
      return [];
    case 'html':
      // Raw HTML from the model is dangerous (XSS). Render escaped text.
      return [h('pre', { class: 'md-raw-html' }, t.text ?? '')];
    case 'table':
      return [h('div', { class: 'md-table-wrap', style: 'overflow-x:auto' }, [renderTable(t)])];
    case 'br':
      return [h('br')];
    case 'text':
      return [h('span', { class: 'md-text' }, t.tokens ? renderInline(t.tokens) : (t.text ?? ''))];
    case 'def':
      return [];
    default:
      return [h('p', { class: 'md-p' }, t.raw ?? '')];
  }
}

function renderTable(token: LooseToken): ReturnType<typeof h> {
  const headerCells = (token.header ?? []).map((cell, i) => {
    const align = token.align?.[i];
    const c = asLoose(cell);
    return h('th', { class: 'md-th', style: align ? `text-align:${align}` : '' }, c.tokens ? renderInline(c.tokens) : String(c.text ?? ''));
  });
  const bodyRows = (token.rows ?? []).map((row) =>
    h('tr', {}, row.map((cell, i) => {
      const align = token.align?.[i];
      const c = asLoose(cell);
      return h('td', { class: 'md-td', style: align ? `text-align:${align}` : '' }, c.tokens ? renderInline(c.tokens) : String(c.text ?? ''));
    })),
  );
  return h('table', { class: 'md-table' }, [
    h('thead', {}, [h('tr', {}, headerCells)]),
    h('tbody', {}, bodyRows),
  ]);
}

function renderInline(tokens: Token[]): (string | ReturnType<typeof h>)[] {
  return tokens.map((token) => {
    const t = asLoose(token);
    switch (t.type) {
      case 'text':
        return t.text ?? '';
      case 'codespan':
        return h('code', { class: 'md-code' }, t.text ?? '');
      case 'strong':
        return h('strong', { class: 'md-strong' }, renderInline(t.tokens ?? []));
      case 'em':
        return h('em', { class: 'md-em' }, renderInline(t.tokens ?? []));
      case 'del':
        return h('del', { class: 'md-del' }, renderInline(t.tokens ?? []));
      case 'link': {
        const href = t.href;
        if (href && !/^(https?:|mailto:|#|\/)/i.test(href)) {
          return t.raw ?? '';
        }
        return h('a', { class: 'md-a', href, target: '_blank', rel: 'noopener' }, renderInline(t.tokens ?? []));
      }
      case 'image': {
        // Wrap in a real button so the zoom affordance is keyboard reachable;
        // the shared lightbox shows the image at natural size.
        const imgSrc = t.href ?? '';
        return h(
          'button',
          {
            type: 'button',
            class: 'md-img-btn',
            title: '点击图片放大预览',
            'aria-label': t.text ? `放大预览图片：${t.text}` : '放大预览图片',
            onClick: () => openImageLightbox(imgSrc, t.text ?? ''),
          },
          [h('img', { class: 'md-img', src: imgSrc, alt: t.text ?? '', loading: 'lazy' })],
        );
      }
      case 'br':
        return h('br');
      case 'html':
        return h('code', { class: 'md-raw-inline' }, t.text ?? '');
      case 'escape':
        return t.text ?? '';
      default:
        return t.raw ?? '';
    }
  });
}
</script>

<style scoped>
.markdown-body :deep(.md-p) { margin: 0.6em 0; }
.markdown-body :deep(.md-h1), .markdown-body :deep(.md-h2), .markdown-body :deep(.md-h3) {
  margin: 1em 0 0.5em; font-weight: 600;
}
.markdown-body :deep(.md-h1) { font-size: 1.5em; border-bottom: 1px solid var(--color-line); padding-bottom: 0.3em; }
.markdown-body :deep(.md-h2) { font-size: 1.3em; }
.markdown-body :deep(.md-h3) { font-size: 1.15em; }
.markdown-body :deep(.md-ul), .markdown-body :deep(.md-ol) { margin: 0.6em 0; padding-left: 1.5em; }
.markdown-body :deep(.md-li) { margin: 0.25em 0; }
.markdown-body :deep(.md-task) { list-style: none; margin-left: -1.2em; }
.markdown-body :deep(.md-checkbox) { margin-right: 6px; vertical-align: middle; accent-color: var(--color-accent); }
.markdown-body :deep(.md-blockquote) {
  margin: 0.6em 0; padding: var(--space-1) var(--space-4); border-left: 3px solid var(--color-accent);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  background: var(--color-accent-soft);
  color: var(--color-text-muted);
}
.markdown-body :deep(.md-code) {
  background: var(--color-surface-sunken); padding: 0.15em 0.35em; border-radius: var(--radius-xs);
  border: 1px solid var(--color-line);
  font-family: var(--font-mono); font-size: 0.9em;
}
.markdown-body :deep(.md-a) { color: var(--color-info); text-decoration: none; transition: color var(--dur-fast) var(--ease-out); }
.markdown-body :deep(.md-a:hover) { color: var(--color-accent); text-decoration: underline; }
.markdown-body :deep(.md-hr) { border: none; border-top: 1px solid var(--color-line); margin: 1em 0; }
.markdown-body :deep(.md-strong) { font-weight: 600; }
.markdown-body :deep(.md-em) { font-style: italic; }
.markdown-body :deep(.md-del) { text-decoration: line-through; color: var(--color-text-muted); }
.markdown-body :deep(.md-img-btn) { display: block; max-width: 100%; padding: 0; border: 0; background: none; cursor: zoom-in; }
.markdown-body :deep(.md-img) { max-width: 100%; border-radius: var(--radius-md); }
.markdown-body :deep(.md-table) { border-collapse: collapse; width: 100%; margin: 0.6em 0; font-size: 0.9em; }
.markdown-body :deep(.md-th), .markdown-body :deep(.md-td) { border: 1px solid var(--color-line); padding: 6px 10px; text-align: left; }
.markdown-body :deep(.md-th) { background: var(--color-surface-sunken); font-weight: 600; }
.markdown-body :deep(.md-html) { margin: 0.6em 0; }
.markdown-body :deep(.md-expand) {
  display: block;
  width: 100%;
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px dashed var(--color-line-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-family: inherit;
  cursor: pointer;
  text-align: center;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.markdown-body :deep(.md-expand:hover) {
  border-color: var(--color-accent-bd);
  color: var(--color-text);
}
</style>
