import type { IconName } from '../components/ui/SvgIcon.vue';

/**
 * Menu entry model for popovers (L2).
 *
 * The Composer permission / thinking-level chips, ConversationHeader's "more" menu and the
 * Sidebar row "more" menu share this shape: the menu only understands data, not business
 * logic; behavior lands in existing channels via the consumer's select callback (client
 * method / emit). disabled + title is a hard constraint — a non-clickable state must say
 * why, no silent paths allowed.
 */
export interface MenuEntry {
  /** Stable key carried back by the select event. */
  key: string;
  label: string;
  icon?: IconName;
  /** Current-state marker (single-select semantics: check mark on the right). */
  checked?: boolean;
  disabled?: boolean;
  /** Reason that must be provided when disabled (tooltip). */
  title?: string;
  /** Destructive entries (delete) use the danger copy color. */
  tone?: 'default' | 'danger';
}

/** Optional group title: permission mode and standalone toggles like "plan mode" need layering, but no submenus. */
export interface MenuGroup {
  title?: string;
  entries: MenuEntry[];
}

/** Wraps flat entries into a single group, for callers that only have one group of content. */
export function singleGroup(entries: MenuEntry[], title?: string): MenuGroup[] {
  return [{ title, entries }];
}
