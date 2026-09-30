import { InvalidTokenError } from "../errors.js";

/** Encodes bytes as unpadded base64url, the only form a PASETO token carries. */
export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Decodes strictly canonical unpadded base64url. Throws `InvalidTokenError` for any other form:
 * Node's decoder tolerates `=` padding and skips invalid characters, so two token strings could
 * decode to the same bytes and defeat replay or revocation checks keyed by token text. Decoding,
 * re-encoding and comparing with the input rejects any deviation.
 */
export function base64UrlDecode(encoded: string): Uint8Array {
  const decoded = new Uint8Array(Buffer.from(encoded, "base64url"));
  if (base64UrlEncode(decoded) !== encoded) {
    throw new InvalidTokenError("base64url input is not strictly canonical");
  }
  return decoded;
}
