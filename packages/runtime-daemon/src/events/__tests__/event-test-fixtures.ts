// Helpers shared by the event tests.

/** Renders bytes as continuous lowercase hex, so a failure diffs as text. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
