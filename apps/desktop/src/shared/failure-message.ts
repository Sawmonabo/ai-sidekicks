// The one way main, the renderer and the package's scripts put a caught value into text, for a log
// line or a refusal: a thrown value need not be an `Error`, so anything else is shown as its
// string. A script Node runs directly imports it, so it imports nothing of its own: `src/`'s build
// cannot name the `.ts` file such an import would need.

/** The message of `failure` when it is an `Error`, otherwise the value as a string. */
export function describeFailure(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
