// Internal helper for the @ai-sidekicks/contracts package — NOT re-exported from
// `src/index.ts`.

/**
 * The decoded byte count of a standard-alphabet base64 string, or -1 if the value
 * does not decode at all.
 *
 * `atob` (not `Buffer`) because this package is consumed by the Worker-hosted
 * control plane as well as the daemon, and `Buffer` is not a Worker global.
 *
 * The try/catch is NOT defensive padding: zod evaluates every check on a schema and
 * aggregates the issues rather than short-circuiting at the first failure, so a
 * refinement calling this runs even when the `z.base64()` charset check has already
 * rejected the input — and `atob` THROWS `InvalidCharacterError` on a non-base64
 * string. Without the catch, a garbage value escapes as a raw DOMException out of
 * `safeParse`, which is exactly the call that promised never to throw. Returning -1
 * keeps the failure inside the ZodError, where the caller is looking for it.
 */
export function decodedByteLength(base64Value: string): number {
  try {
    return atob(base64Value).length;
  } catch {
    return -1;
  }
}
