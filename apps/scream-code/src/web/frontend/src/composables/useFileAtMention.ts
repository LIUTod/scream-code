/**
 * @ file-mention state for the composer, driven by the read-only
 * /api/v1/files REST surface (no backend changes).
 *
 * Model: the token after "@" is "<dirRel><tail>". The menu lists entries of
 * <dirRel> (fetched once per dir, cached briefly) filtered against <tail>
 * with the shared fuzzy ladder. Picking a file closes the token
 * ("@path "); picking a directory keeps the menu open for drill-down
 * ("@dir/"). Selecting from the root ("@..") walks up but can never escape
 * the session working directory.
 */
import { computed, ref, type Ref } from 'vue';

import {
  buildAtInsertText,
  extractAtQuery,
  filterFileEntries,
  type FileEntryLite,
} from '../utils/fileFuzzy';

const API = '/api/v1/files';
const DIR_TTL_MS = 30_000;

interface DirRecord {
  entries: FileEntryLite[];
  at: number;
}

interface ServerFileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  mtime: number;
}

/** Collapse "." / ".." segments against an absolute base; null on escape. */
function resolveDirRel(workDir: string, dirRel: string): string | null {
  const base = workDir.replace(/\/+$/, '');
  const baseParts = base.split('/').filter(Boolean);
  const stack = [...baseParts];
  for (const seg of dirRel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      // Popping at or below the base depth escapes the work dir.
      if (stack.length <= baseParts.length) return null;
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  const abs = `/${stack.join('/')}`;
  return abs === base || abs.startsWith(`${base}/`) ? abs : null;
}

export function useFileAtMention(
  text: Ref<string>,
  textareaRef: Ref<HTMLTextAreaElement | null>,
  workDir: Ref<string | undefined>,
) {
  const dirCache = new Map<string, DirRecord>();
  const activeDir = ref<string | null>(null);
  const dirEntries = ref<FileEntryLite[]>([]);
  const dirLoading = ref(false);
  const dirMissing = ref(false);
  const index = ref(0);
  const dismissed = ref(false);

  /** Latest @ token parsed from the caret position (refreshed on input events). */
  const atMatch = ref<ReturnType<typeof extractAtQuery>>(null);

  // On the home view no session exists yet; fall back to the server's first
  // allowed root (GET /files/root — the same source NewTask uses as the
  // default project dir) so @ mentions still resolve there.
  const rootFallback = ref('');
  let rootPromise: Promise<void> | null = null;
  function ensureRootFallback(): void {
    if (rootPromise) return;
    rootPromise = (async () => {
      try {
        const res = await fetch(`${API}/root`);
        const data = res.ok ? ((await res.json()) as { roots?: string[] }) : {};
        rootFallback.value = data.roots?.[0] ?? '';
      } catch {
        rootFallback.value = '';
      }
      // The first refresh() cleared atMatch (no scope yet), so re-derive
      // unconditionally now that the root is known.
      refresh();
    })();
  }

  const suggestions = computed<FileEntryLite[]>(() => {
    const match = atMatch.value;
    if (!match) return [];
    const lastSlash = match.query.lastIndexOf('/');
    const tail = match.query.slice(lastSlash + 1);
    return filterFileEntries(dirEntries.value, tail);
  });

  const visible = computed(
    () => atMatch.value !== null && !dismissed.value && (dirLoading.value || suggestions.value.length > 0),
  );

  function splitQuery(q: string): { dirRel: string; tail: string } {
    const lastSlash = q.lastIndexOf('/');
    if (lastSlash === -1) return { dirRel: '', tail: q };
    return { dirRel: q.slice(0, lastSlash), tail: q.slice(lastSlash + 1) };
  }

  /** Set between a programmatic insert and its caret restore; the text
   *  watcher's refresh() would otherwise read the pre-patch DOM value. */
  let pendingCaretRestore = false;
  /** Generation guard: only the newest dir fetch may write menu state. */
  let loadGen = 0;

  async function loadDir(abs: string, relForPath: string): Promise<void> {
    // Bump the generation even on a cache hit, so an in-flight request for a
    // previous directory can never overwrite this state when it resolves.
    const gen = ++loadGen;
    const cached = dirCache.get(abs);
    if (cached && Date.now() - cached.at < DIR_TTL_MS) {
      dirEntries.value = cached.entries;
      dirMissing.value = false;
      return;
    }
    dirLoading.value = true;
    try {
      const res = await fetch(`${API}/list?path=${encodeURIComponent(abs)}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { entries: ServerFileEntry[] };
      if (gen !== loadGen) return; // a newer dir request won the race
      const prefix = relForPath ? `${relForPath.replace(/\/+$/, '')}/` : '';
      const entries: FileEntryLite[] = data.entries.map((e) => ({
        path: `${prefix}${e.name}`,
        isDir: e.type === 'dir',
      }));
      dirCache.set(abs, { entries, at: Date.now() });
      dirEntries.value = entries;
      dirMissing.value = false;
    } catch {
      if (gen !== loadGen) return;
      dirEntries.value = [];
      dirMissing.value = true;
      // Invalidate the claim so retyping re-attempts the fetch instead of
      // latching onto a permanently empty directory.
      activeDir.value = null;
    } finally {
      if (gen === loadGen) dirLoading.value = false;
    }
  }

  /** Recompute the menu from the caret. Cheap; safe on every input event. */
  function refresh(): void {
    if (pendingCaretRestore) return;
    const el = textareaRef.value;
    // Programmatic text changes (send/insert/draft-restore) reach refresh()
    // before Vue patches the DOM; parsing the stale DOM value would
    // resurrect an old token. The next real input/keyup refreshes from the
    // patched DOM, so skipping here is safe.
    if (el && el.value !== text.value) {
      atMatch.value = null;
      return;
    }
    let wd = workDir.value?.trim();
    if (!wd) {
      // No session scope (home view): kick off the one-time /files/root
      // lookup; the menu gains its scope when that lands.
      ensureRootFallback();
      wd = rootFallback.value;
    }
    if (!el || !wd) {
      atMatch.value = null;
      return;
    }
    const caret = el.selectionStart ?? el.value.length;
    const match = extractAtQuery(el.value.slice(0, caret));
    if (!match) {
      atMatch.value = null;
      dismissed.value = false;
      return;
    }
    // Reset the dismiss flag only when the token itself changes (typing
    // continues to mean "keep the menu"), same semantics as the slash menu.
    const prev = atMatch.value;
    if (!prev || prev.start !== match.start || prev.query !== match.query) dismissed.value = false;
    atMatch.value = match;
    index.value = 0;

    const { dirRel } = splitQuery(match.query);
    const abs = resolveDirRel(wd, dirRel);
    if (abs === null) {
      // Outside the workspace or above the filesystem root: nothing to list.
      activeDir.value = null;
      dirEntries.value = [];
      dirMissing.value = true;
      return;
    }
    if (activeDir.value === abs) return; // same dir, tail filter is client-side
    activeDir.value = abs;
    void loadDir(abs, dirRel);
  }

  function move(delta: number): void {
    const n = suggestions.value.length;
    if (n > 0) index.value = (index.value + delta + n) % n;
  }

  /** Replace the @token with the picked entry; returns true when handled. */
  function confirm(entry?: FileEntryLite): boolean {
    const match = atMatch.value;
    const chosen = entry ?? suggestions.value[index.value];
    if (!match || !chosen) return false;
    const el = textareaRef.value;
    if (!el) return false;
    const caret = el.selectionStart ?? el.value.length;
    const insert = buildAtInsertText(chosen.path, chosen.isDir);
    const before = text.value.slice(0, match.start);
    const after = text.value.slice(caret);
    text.value = before + insert.text + after;
    // Re-derive the menu after v-model applies; dir picks keep it open.
    // The guard stops the text watcher's refresh() (which fires before the
    // DOM patch and would read a stale value/caret) from clobbering the match.
    pendingCaretRestore = true;
    const afterPaint = () => {
      const pos = match.start + insert.cursorOffset;
      el.focus();
      el.setSelectionRange(pos, pos);
      pendingCaretRestore = false;
      refresh();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(afterPaint);
    else void Promise.resolve().then(afterPaint);
    return true;
  }

  function dismiss(): void {
    dismissed.value = true;
  }

  /** Clear the menu state when the composer value changes from outside. */
  function reset(): void {
    atMatch.value = null;
    dismissed.value = false;
    index.value = 0;
  }

  return { visible, suggestions, index, dirLoading, dirMissing, refresh, move, confirm, dismiss, reset };
}
