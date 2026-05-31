/**
 * Early-startup process name initialization.
 *
 * Sets the process title so `ps`/`top` and the terminal tab show
 * `Scream Code` from the moment the binary launches — before Commander
 * parses argv, before any preflight, even on `--help`/`--version`.
 *
 * OSC is written to stderr (not stdout) so it still reaches the terminal
 * when stdout is piped, e.g. `scream --print | grep ...`.
 */
import { PRODUCT_NAME } from '#/constant/app';
import { BEL, ESC } from '#/constant/terminal';

export function setProcessTitle(label: string): void {
  try {
    process.title = label;
  } catch {
    /* noop */
  }
  try {
    if (process.stderr.isTTY) {
      process.stderr.write(`${ESC}]0;${label}${BEL}`);
    }
  } catch {
    /* noop */
  }
}

export function initProcessName(name: string = PRODUCT_NAME): void {
  setProcessTitle(name);
}
