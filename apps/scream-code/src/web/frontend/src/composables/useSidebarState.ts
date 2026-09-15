import { ref } from 'vue';

/**
 * Module-level singleton state shared by every Sidebar instance.
 *
 * WebShell mounts the sidebar twice (desktop rail + mobile drawer); without
 * shared state the search query, the collapsed-space set, the long-list
 * expansion and the active section (sessions | files) diverge between the two
 * copies. This keeps them as one source of truth.
 */
const query = ref('');
const collapsedSpaces = ref<Set<string>>(new Set());
/** Groups already expanded via "show N more" (only relevant when a group list exceeds GROUP_COLLAPSE_LIMIT). */
const expandedSpaces = ref<Set<string>>(new Set());
const section = ref<'sessions' | 'files'>('sessions');

/** Groups with more entries than this are collapsed by default. */
export const GROUP_COLLAPSE_LIMIT = 5;

export function useSidebarState() {
  function toggleSpace(key: string): void {
    const next = new Set(collapsedSpaces.value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsedSpaces.value = next;
  }

  /** Groups only expand in one direction (collapsing is governed by the limit); toggling again returns to the default first N entries. */
  function toggleSpaceExpanded(key: string): void {
    const next = new Set(expandedSpaces.value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expandedSpaces.value = next;
  }

  function isSpaceExpanded(key: string): boolean {
    return expandedSpaces.value.has(key);
  }

  function clearSearch(): void {
    query.value = '';
  }

  return {
    query,
    collapsedSpaces,
    expandedSpaces,
    section,
    toggleSpace,
    toggleSpaceExpanded,
    isSpaceExpanded,
    clearSearch,
  };
}
