<script lang="ts">
import { computed, h, defineComponent } from 'vue';
import { marked } from 'marked';
import CodeBlock from './CodeBlock.vue';

export default defineComponent({
  props: {
    content: { type: String, required: true },
  },
  setup(props) {
    const nodes = computed(() => {
      const tokens = marked.lexer(props.content);
      return tokens.flatMap((token) => renderToken(token));
    });

    return () => h('div', { class: 'markdown-body' }, nodes.value);
  },
});

function renderToken(token: marked.Token): ReturnType<typeof h>[] {
  switch (token.type) {
    case 'paragraph':
      return [h('p', { class: 'md-p' }, renderInline(token.tokens))];
    case 'heading':
      return [h(`h${token.depth}`, { class: `md-h${token.depth}` }, renderInline(token.tokens))];
    case 'code':
      return [h(CodeBlock, { code: token.text, lang: token.lang ?? 'text' })];
    case 'blockquote':
      return [h('blockquote', { class: 'md-blockquote' }, token.tokens.flatMap((t) => renderToken(t)))];
    case 'list': {
      const items = token.items.map((item) =>
        h('li', { class: 'md-li' }, item.tokens.flatMap((t) => renderToken(t))),
      );
      return [h(token.ordered ? 'ol' : 'ul', { class: token.ordered ? 'md-ol' : 'md-ul' }, items)];
    }
    case 'hr':
      return [h('hr', { class: 'md-hr' })];
    case 'space':
      return [];
    case 'html':
      return [h('div', { class: 'md-html', innerHTML: token.text })];
    case 'table':
      return [h('div', { class: 'md-table-wrap', style: 'overflow-x:auto' }, [renderTable(token)])];
    case 'br':
      return [h('br')];
    case 'text':
      // List items deliver their inline content as a nested `text` token.
      return [h('span', { class: 'md-text' }, token.tokens ? renderInline(token.tokens) : token.text)];
    case 'def':
      return [];
    default:
      // Fallback: render raw text so content is never silently lost.
      return [h('p', { class: 'md-p' }, token.raw ?? '')];
  }
}

function renderTable(token: marked.Token): ReturnType<typeof h> {
  const t = token as { header: marked.Token[]; rows: marked.Token[][]; align: ('center' | 'left' | 'right' | null)[] };
  const headerCells = (t.header ?? []).map((cell, i) => {
    const align = t.align?.[i];
    return h('th', { class: 'md-th', style: align ? `text-align:${align}` : '' }, cell.tokens ? renderInline(cell.tokens) : String((cell as { text?: string }).text ?? ''));
  });
  const bodyRows = (t.rows ?? []).map((row) =>
    h('tr', {}, row.map((cell, i) => {
      const align = t.align?.[i];
      return h('td', { class: 'md-td', style: align ? `text-align:${align}` : '' }, cell.tokens ? renderInline(cell.tokens) : String((cell as { text?: string }).text ?? ''));
    })),
  );
  return h('table', { class: 'md-table' }, [
    h('thead', {}, [h('tr', {}, headerCells)]),
    h('tbody', {}, bodyRows),
  ]);
}

function renderInline(tokens: marked.Token[]): (string | ReturnType<typeof h>)[] {
  return tokens.map((token) => {
    switch (token.type) {
      case 'text':
        return token.text;
      case 'codespan':
        return h('code', { class: 'md-code' }, token.text);
      case 'strong':
        return h('strong', { class: 'md-strong' }, renderInline(token.tokens));
      case 'em':
        return h('em', { class: 'md-em' }, renderInline(token.tokens));
      case 'del':
        return h('del', { class: 'md-del' }, renderInline(token.tokens));
      case 'link': {
        const href = token.href;
        if (href && !/^(https?:|mailto:|#|\/)/i.test(href)) {
          return token.raw ?? '';
        }
        return h('a', { class: 'md-a', href, target: '_blank', rel: 'noopener' }, renderInline(token.tokens));
      }
      case 'image':
        return h('img', { class: 'md-img', src: token.href, alt: token.text ?? '', loading: 'lazy' });
      case 'br':
        return h('br');
      case 'html':
        return h('span', { innerHTML: token.text });
      default:
        return token.raw ?? '';
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
.markdown-body :deep(.md-blockquote) {
  margin: 0.6em 0; padding-left: 1em; border-left: 3px solid var(--color-accent);
  color: var(--color-text-muted);
}
.markdown-body :deep(.md-code) {
  background: var(--color-surface-sunken); padding: 0.15em 0.35em; border-radius: 4px;
  font-family: var(--font-mono); font-size: 0.9em;
}
.markdown-body :deep(.md-a) { color: var(--color-info); text-decoration: none; }
.markdown-body :deep(.md-a:hover) { text-decoration: underline; }
.markdown-body :deep(.md-hr) { border: none; border-top: 1px solid var(--color-line); margin: 1em 0; }
.markdown-body :deep(.md-strong) { font-weight: 600; }
.markdown-body :deep(.md-em) { font-style: italic; }
.markdown-body :deep(.md-del) { text-decoration: line-through; }
.markdown-body :deep(.md-img) { max-width: 100%; border-radius: 8px; }
.markdown-body :deep(.md-table) { border-collapse: collapse; width: 100%; margin: 0.6em 0; font-size: 0.9em; }
.markdown-body :deep(.md-th), .markdown-body :deep(.md-td) { border: 1px solid var(--color-line); padding: 6px 10px; text-align: left; }
.markdown-body :deep(.md-th) { background: var(--color-surface-sunken); font-weight: 600; }
.markdown-body :deep(.md-html) { margin: 0.6em 0; }
</style>
