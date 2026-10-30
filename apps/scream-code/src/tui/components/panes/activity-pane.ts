/**
 * Status-area phase shared by the lifecycle controller and the status bar.
 *
 * The former `ActivityPaneComponent` lived here too, but it was never
 * instantiated in production code (only its unit test built it), so the class
 * and its options were removed in favour of the single-row
 * `StatusBarPaneComponent`. The mode union stays, because the controller's
 * `resolveActivityPaneMode()` is typed by it.
 */
export type ActivityPaneMode = 'hidden' | 'waiting' | 'thinking' | 'composing' | 'tool';
