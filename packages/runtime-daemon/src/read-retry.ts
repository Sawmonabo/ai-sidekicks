// The daemon's one read retry: a read that fails in a way another moment can clear is tried once
// more after a fixed 100 ms, git's own lock-retry window, before anything is answered. A second
// failure, or any other, reaches the caller with the system's own reason.

import { setTimeout as sleep } from "node:timers/promises";

/** How long the one retry waits, in milliseconds. */
const READ_RETRY_DELAY_MS = 100;

// The failures the system reports for a moment's contention: a busy or locked entry, an
// interrupted call, or a process or system out of open files.
const RETRYABLE_READ_ERROR_CODES: ReadonlySet<string> = new Set([
  "EAGAIN",
  "EBUSY",
  "EINTR",
  "EMFILE",
  "ENFILE",
]);

/** Whether a filesystem read's failure is one another moment can clear. */
export function isRetryableReadFailure(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" && RETRYABLE_READ_ERROR_CODES.has(code);
}

/**
 * Runs `read`, and once more after {@link READ_RETRY_DELAY_MS} when it fails in a way
 * `isRetryable` accepts; any other failure, and the retry's own, is thrown as it came.
 */
export async function readWithOneRetry<Result>(
  read: () => Promise<Result>,
  isRetryable: (error: unknown) => boolean = isRetryableReadFailure,
): Promise<Result> {
  try {
    return await read();
  } catch (error) {
    if (!isRetryable(error)) {
      throw error;
    }
    await sleep(READ_RETRY_DELAY_MS);
    return read();
  }
}
