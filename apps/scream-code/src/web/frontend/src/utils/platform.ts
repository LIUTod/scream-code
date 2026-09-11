/**
 * Platform-aware modifier-key label for keyboard hints in the UI.
 * Apple hardware shows ⌘; Windows/Linux/ChromeOS show Ctrl. Keyboard
 * handlers already accept metaKey||ctrlKey — this only fixes what we
 * *display*.
 */
function detectModKeyLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl';
  const ua = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  return /Mac|iPhone|iPad|iPod/.test(ua) ? '⌘' : 'Ctrl';
}

export const MOD_KEY_LABEL = detectModKeyLabel();
