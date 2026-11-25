import { isInsideTmux, supportsOsc9Notification } from './terminal-notification';

export interface TerminalState {
  notificationKeys: Set<string>;
  focused: boolean;
  /**
   * When the terminal last lost focus (a focus-out report), cleared when it
   * comes back. Undefined while focused, and always on a terminal that does
   * not report focus — which then never counts as "away".
   */
  unfocusedAt?: number | undefined;
  supportsOsc9: boolean;
  insideTmux: boolean;
  progressActive: boolean;
}

export function createTerminalState(): TerminalState {
  return {
    notificationKeys: new Set<string>(),
    focused: true,
    supportsOsc9: supportsOsc9Notification(),
    insideTmux: isInsideTmux(),
    progressActive: false,
  };
}
