// Main's one way to put a caught value into a log line or a refusal: a thrown value need not be an
// `Error`, so anything else is shown as its string.

/** The message of `failure` when it is an `Error`, otherwise the value as a string. */
export function describeFailure(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
