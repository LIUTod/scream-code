import type { PermissionMode } from '#/types';

/**
 * Normalize a permission mode coming from an untrusted or legacy caller.
 *
 * `manual` was removed as a posture; it normalizes to `yolo` (the default) so
 * an old caller upgrades instead of pushing an invalid mode into the engine.
 * Returns undefined for anything else, which callers turn into a typed error.
 */
export function normalizePermissionMode(value: unknown): PermissionMode | undefined {
  if (value === 'manual') return 'yolo';
  if (value === 'yolo' || value === 'auto' || value === 'ask' || value === 'bot') return value;
  return undefined;
}
