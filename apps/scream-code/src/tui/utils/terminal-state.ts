import { isInsideTmux, supportsOsc9Notification } from './terminal-notification';

export interface TerminalState {
  notificationKeys: Set<string>;
  focused: boolean;
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
