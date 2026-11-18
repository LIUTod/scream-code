/**
 * Host output: `host.log` is read long after the fact, so every line carries
 * a timestamp. stdout and stderr both land in the log (see `startHostDetached`).
 */

function stamp(): string {
  return new Date().toISOString();
}

export function hostOut(message: string): void {
  process.stdout.write(`${stamp()} ${message}\n`);
}

export function hostErr(message: string): void {
  process.stderr.write(`${stamp()} ${message}\n`);
}
