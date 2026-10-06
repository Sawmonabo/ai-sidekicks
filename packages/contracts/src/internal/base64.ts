// Internal helper for the contracts package; the package's exports map closes `internal/*`.
// `atob` decodes because `Buffer` is not a Worker global and the control plane consumes this
// package.

/** A base64 value's bytes, or that it does not decode. */
export type Base64Decoding = { decodable: true; bytes: Uint8Array } | { decodable: false };

/**
 * Decodes a standard-alphabet base64 value. Only `atob`'s refusal of the value reads as
 * undecodable; any other throw surfaces.
 */
export function decodeBase64(base64Value: string): Base64Decoding {
  const binary = decodeBinaryString(base64Value);
  if (binary === null) {
    return { decodable: false };
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return { decodable: true, bytes };
}

/**
 * The decoded byte count of a standard-alphabet base64 string, or -1 if the value does not decode.
 * zod runs every check on a schema, so a refinement calling this still runs after `z.base64()`
 * refused the input; -1 keeps that failure inside the ZodError.
 */
export function decodedByteLength(base64Value: string): number {
  return decodeBinaryString(base64Value)?.length ?? -1;
}

// `atob`'s one-character-per-byte string, or null where `atob` refuses the value as not base64.
function decodeBinaryString(base64Value: string): string | null {
  try {
    return atob(base64Value);
  } catch (error) {
    if (error instanceof DOMException && error.name === "InvalidCharacterError") {
      return null;
    }
    throw error;
  }
}
