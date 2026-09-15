// Block-level freeze cache for MarkdownRenderer.
//
// During streaming, marked.lexer re-parses the whole document on every chunk,
// but the tokens for unchanged prefix blocks come out byte-identical. This
// module maps each top-level token to a stable content key and caches the
// rendered vnode array, so appends only pay the render cost for the tail
// blocks that actually changed.
//
// Vue-side safety notes (verified against @vue/runtime-core 3.5):
//   - `patch` bails out immediately on `n1 === n2`, so reusing the exact
//     same vnode objects in the same slot skips patching entirely.
//   - Element vnodes are inert JS objects between renders; reusing them is
//     what the template compiler's static hoisting relies on.
//   - Component vnodes (CodeBlock) are NOT cached: their props carry the
//     `streaming` flag and they own component state, so `code` blocks are
//     always rebuilt by the caller's render function.
//   - A vnode object may only appear once per children array, so within a
//     single render pass a key seen twice falls back to a fresh render.
import type { Token } from 'marked';
import { isVNode, type VNode } from 'vue';

/** Hard cap on cached blocks; on overflow the whole cache is dropped. */
export const BLOCK_CACHE_LIMIT = 200;

/**
 * Stable content key for a top-level token. Content-addressed on purpose:
 * a key must not depend on the block's position in the document, so appends
 * never invalidate prefix blocks. The raw text is also stored on the cache
 * entry so a djb2 collision degrades to a rebuild instead of wrong output.
 */
export function blockKeyOf(token: Token): string {
  const raw = (token as { raw?: string }).raw ?? '';
  return `${token.type}:${raw.length}:${djb2(raw).toString(36)}`;
}

/** djb2 over the raw text — cheap, position-independent content hash. */
function djb2(s: string): number {
  let h = 5381;
  // codePointAt returns undefined only past the end of the string, which the
  // loop bound already excludes; coalesce to keep it strict-safe.
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + (s.codePointAt(i) ?? 0)) | 0;
  return h >>> 0;
}

/** True when the vnode tree contains a component vnode (e.g. CodeBlock). */
function containsComponent(vnodes: VNode[]): boolean {
  const stack = [...vnodes];
  while (stack.length > 0) {
    const vnode = stack.pop()!;
    if (typeof vnode.type === 'object') return true;
    if (Array.isArray(vnode.children)) {
      for (const child of vnode.children) if (isVNode(child)) stack.push(child);
    }
  }
  return false;
}

export interface BlockRenderCache {
  /**
   * Render `tokens`, reusing cached vnodes for blocks whose content key was
   * already rendered (only possible when `source` extends the previous
   * source, i.e. a pure append). `renderBlock` must be pure with respect to
   * anything but the token itself — in practice only the uncached `code`
   * blocks consume the caller's streaming flag.
   */
  render(tokens: Token[], source: string, renderBlock: (token: Token) => VNode[]): VNode[];
  /** Current number of cached blocks (tests / introspection). */
  size(): number;
  /** Drop every cached block. */
  clear(): void;
}

export function createBlockRenderCache(limit = BLOCK_CACHE_LIMIT): BlockRenderCache {
  // key -> { raw, vnodes }. Insertion order is the document order of first
  // render; eviction is whole-cache clear (simple, and appends that churn
  // >limit tail blocks are rare).
  let cache = new Map<string, { raw: string; vnodes: VNode[] }>();
  let lastSource = '';

  return {
    render(tokens, source, renderBlock) {
      // Non-append (generation change, mid-document edit, preview<->full
      // swap): block boundaries shift unpredictably, so drop everything.
      // Keys are content-addressed, so a false "append" would still render
      // correctly — this only controls how much reuse we get.
      const isAppend = lastSource.length > 0 && source.startsWith(lastSource);
      if (!isAppend) cache.clear();
      lastSource = source;

      const out: VNode[] = [];
      // Per-pass dedupe: the same vnode object must not appear twice in one
      // children array (e.g. two identical paragraphs in one document).
      const usedThisPass = new Set<string>();

      for (const token of tokens) {
        const key = blockKeyOf(token);
        const raw = (token as { raw?: string }).raw ?? '';
        const hit = cache.get(key);
        if (hit && hit.raw === raw && !usedThisPass.has(key)) {
          usedThisPass.add(key);
          out.push(...hit.vnodes);
          continue;
        }
        usedThisPass.add(key);
        const vnodes = renderBlock(token);
        // Component-owning blocks (CodeBlock) are rebuilt every pass so the
        // streaming flag and component lifecycle stay live; empty renders
        // (space tokens) are nothing worth caching.
        if (vnodes.length > 0 && !containsComponent(vnodes)) {
          if (cache.size >= limit) cache = new Map();
          cache.set(key, { raw, vnodes });
        }
        out.push(...vnodes);
      }
      return out;
    },
    size: () => cache.size,
    clear: () => {
      cache = new Map();
      lastSource = '';
    },
  };
}
