export function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Marks an abort the user triggered deliberately (e.g. pressing ESC to
 * interrupt the agent), as distinct from a timeout, an internal error, or any
 * other programmatic abort. It travels as the AbortSignal's `reason`, so code
 * that settles an interrupted operation can tell a user interruption apart from
 * a failure and report it to the model accordingly instead of emitting a
 * neutral "was aborted" that the model mistakes for a system problem.
 *
 * `name` stays 'AbortError' so existing `isAbortError()` checks (and
 * `AbortSignal.throwIfAborted()`) keep treating it as an abort.
 */
export class UserCancellationError extends Error {
  readonly userCancelled = true;

  constructor() {
    super('Aborted by the user');
    this.name = 'AbortError';
  }
}

export function userCancellationReason(): UserCancellationError {
  return new UserCancellationError();
}

export function isUserCancellation(value: unknown): value is UserCancellationError {
  return value instanceof UserCancellationError;
}

/**
 * Marks an abort raised because the *parent agent* interjected a directive into
 * this running subagent (`SendSubagentMessage(operation: "interject")`). Like
 * the user-cancellation reason it travels as the AbortSignal's `reason`, so a
 * tool cut short by the interject reports that a deliberate redirection — not a
 * failure — interrupted it, and points at the `[parent_messages]` block that
 * follows instead of telling the model to wait for a user who never spoke.
 *
 * Deliberately NOT a subclass of `UserCancellationError`: that class means "the
 * human pressed stop", and every `isUserCancellation` consumer (status wording,
 * cancellation paths) must keep treating a parent interject as a non-user
 * abort. `name` stays 'AbortError' so `isAbortError()` and
 * `AbortSignal.throwIfAborted()` keep treating it as an abort.
 */
export class ParentInterjectError extends Error {
  readonly parentInterject = true;

  constructor() {
    super('Aborted by a parent agent interjection');
    this.name = 'AbortError';
  }
}

export function parentInterjectReason(): ParentInterjectError {
  return new ParentInterjectError();
}

export function isParentInterject(value: unknown): value is ParentInterjectError {
  return value instanceof ParentInterjectError;
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

export function linkAbortSignal(source: AbortSignal, target: AbortController): () => void {
  const onAbort = () => {
    target.abort(source.reason);
  };
  if (source.aborted) {
    onAbort();
    return () => {};
  }
  source.addEventListener('abort', onAbort, { once: true });
  return () => {
    source.removeEventListener('abort', onAbort);
  };
}

export interface DeadlineAbortSignal {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly clear: () => void;
}

export function createDeadlineAbortSignal(
  source: AbortSignal,
  timeoutMs: number,
): DeadlineAbortSignal {
  const controller = new AbortController();
  const unlinkAbortSignal = linkAbortSignal(source, controller);
  let didTimeout = false;
  let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    didTimeout = true;
    controller.abort(abortError());
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    clear: () => {
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = undefined;
      unlinkAbortSignal();
    },
  };
}
