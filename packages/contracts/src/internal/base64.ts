// Internal helper for the contracts package; the package's exports map closes `internal/*`.

/**
 * The decoded byte count of a standard-alphabet base64 string, or -1 if the value does not decode.
 * Uses `atob` because `Buffer` is not a Worker global and the control plane consumes this package.
 */
export function decodedByteLength(base64Value: string): number {
  // zod runs every check on a schema, so a refinement calling this still runs after `z.base64()`
  // rejected the input, and `atob` throws on non-base64. -1 keeps that failure inside the ZodError.
  try {
    return atob(base64Value).length;
  } catch {
    return -1;
  }
}
