import { getDefaultTelemetryClient, type TelemetryClient } from './client';

export type CrashPhase = 'startup' | 'runtime' | 'shutdown';

let phase: CrashPhase = 'startup';
let installed = false;
let installedUncaughtHandler:
  | ((error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void)
  | null = null;

export function setCrashPhase(nextPhase: CrashPhase): void {
  phase = nextPhase;
}

export function installCrashHandlers(): () => void {
  return installCrashHandlersForClient(getDefaultTelemetryClient());
}

export function installCrashHandlersForClient(client: TelemetryClient): () => void {
  if (installed && installedUncaughtHandler !== null) {
    return () => {
      uninstallCrashHandlers();
    };
  }
  const trackCrash = (errorType: string, source: string) => {
    try {
      client.track('crash', {
        error_type: errorType,
        where: phase,
        source,
      });
      client.flushSync();
    } catch {
      // Crash telemetry must never mask the original exception.
    }
  };
  installedUncaughtHandler = (error, origin) => {
    if (isAbortError(error)) return;
    trackCrash(error.name || error.constructor.name, origin);
  };
  process.on('uncaughtExceptionMonitor', installedUncaughtHandler);
  installed = true;
  return () => {
    uninstallCrashHandlers();
  };
}

export function uninstallCrashHandlers(): void {
  if (!installed) return;
  if (installedUncaughtHandler !== null) {
    process.off('uncaughtExceptionMonitor', installedUncaughtHandler);
  }
  installedUncaughtHandler = null;
  installed = false;
}

function isAbortError(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    'name' in reason &&
    reason.name === 'AbortError'
  );
}
