/**
 * localStorage helpers with failure isolation. Storage can be unavailable
 * (private browsing, disabled cookies, quota) — every access is wrapped so a
 * throw never escapes into app logic.
 *
 * Two flavours:
 * - `readStoredString` / `writeStoredString` for bare string values
 *   (`'light'`, `'goal'`, `'1'`). Reading a legacy raw value always works.
 * - `readStoredJSON` / `writeStoredJSON` for structured values. Plain numbers
 *   are valid JSON, so legacy numeric strings (e.g. `'288'`) still parse.
 */

export function readStoredString(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/** Parsed JSON, or undefined on missing key / unavailable storage / corrupt JSON. */
export function readStoredJSON<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return undefined;
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function writeStoredJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
