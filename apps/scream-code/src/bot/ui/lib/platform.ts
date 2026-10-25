/**
 * How this platform names the command modifier.
 *
 * A shortcut works with either Cmd or Ctrl on every platform; only the label
 * differs, so the hint shown in the UI must follow the platform instead of
 * hard-coding one of them.
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function modKeyLabel(): string {
  return isApplePlatform() ? "⌘" : "Ctrl";
}

export function shortcutLabel(key: string): string {
  return isApplePlatform() ? `⌘${key.toUpperCase()}` : `Ctrl ${key.toUpperCase()}`;
}
