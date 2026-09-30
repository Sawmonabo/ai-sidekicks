// Where one file stands against the per-attachment byte bound. The bound is the contract's
// default; no read of the deployment's own bound is made, so every view warns against it.

/**
 * Whether one attachment's length is past the per-attachment bound. A warning ahead of
 * `artifact.too_large`, not a verdict: the upload is still attempted.
 */
export function exceedsAttachmentByteAllowance(
  byteLength: number,
  maximumByteLength: number,
): boolean {
  return byteLength > maximumByteLength;
}
