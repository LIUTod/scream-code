import { ref } from 'vue';

/**
 * Module-level singleton state shared by every Sidebar instance.
 *
 * WebShell mounts the sidebar twice (desktop rail + mobile drawer); without
 * shared state the search query and the collapsed-space set diverge between
 * the two copies. This keeps them as one source of truth.
 */
const query = ref('');
const collapsedSpaces = ref<Set<string>>(new Set());

export function useSidebarState() {
  function toggleSpace(key: string): void {
    const next = new Set(collapsedSpaces.value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsedSpaces.value = next;
  }

  function clearSearch(): void {
    query.value = '';
  }

  return { query, collapsedSpaces, toggleSpace, clearSearch };
}
