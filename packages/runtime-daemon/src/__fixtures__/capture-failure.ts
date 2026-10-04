// What a call threw or rejected with, for asserting on the error itself; each fails the test when
// the call succeeded instead.

/** Runs `body` and returns what it threw; throws if it returned. */
export function captureThrow(body: () => unknown): unknown {
  try {
    body();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the operation to throw, but it returned");
}

/** Awaits `pending` (or the promise `body` returns) and returns its rejection; throws if it resolved. */
export async function captureRejection(
  pending: Promise<unknown> | (() => Promise<unknown>),
): Promise<unknown> {
  try {
    await (typeof pending === "function" ? pending() : pending);
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the operation to reject, but it resolved");
}
