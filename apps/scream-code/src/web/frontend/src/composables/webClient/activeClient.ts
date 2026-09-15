import { shallowRef } from 'vue';
import type { UseScreamWebClientReturn } from './types';

/**
 * Active webClient registry (L3).
 *
 * useScreamWebClient is deliberately non-singleton (two hosts each get their own), but some
 * surface objects cannot receive props injection — the components under WebShell (SkillsView
 * entry, settings modal mount point) cannot be changed in this round, so useScreamWebClient
 * registers its instance here on creation and those surfaces read the most recently created
 * client from it. Unregistered when the host unmounts, so tests / multiple instances never
 * bleed into each other.
 */
let active: UseScreamWebClientReturn | null = null;
const activeClientRef = shallowRef<UseScreamWebClientReturn | null>(null);

export function registerActiveWebClient(client: UseScreamWebClientReturn): void {
  active = client;
  activeClientRef.value = client;
}

/** Unregisters only while client is still the registered instance (prevents an inverted unmount order from clearing a fresh instance). */
export function unregisterActiveWebClient(client: UseScreamWebClientReturn): void {
  if (active === client) {
    active = null;
    activeClientRef.value = null;
  }
}

export function getActiveWebClient(): UseScreamWebClientReturn | null {
  return active;
}

/** Reactive view: drives consumer refresh when the registry changes. */
export function useActiveWebClient() {
  return { activeClient: activeClientRef };
}
