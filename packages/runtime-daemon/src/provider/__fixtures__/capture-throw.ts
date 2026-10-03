// The synchronous twin of `captureRejection`, for asserting on the value a call throws.

/** Runs `body` and returns what it threw; throws if it returned. */
export function captureThrow(body: () => unknown): unknown {
  try {
    body();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the operation to throw, but it returned");
}
