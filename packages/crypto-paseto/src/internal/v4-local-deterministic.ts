import { xchacha20 } from "@noble/ciphers/chacha.js";
import { concatBytes } from "@noble/ciphers/utils.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { pae } from "../pae.js";
import { InvalidKeyError } from "../errors.js";
import { base64UrlEncode } from "./base64url.js";

/** The header every `v4.local` token starts with. */
export const V4_LOCAL_HEADER = "v4.local.";
/** The header's bytes, the first piece of the MAC's pre-authentication encoding. */
export const V4_LOCAL_HEADER_BYTES: Uint8Array = new TextEncoder().encode(V4_LOCAL_HEADER);
/** The info string that derives the encryption key and nonce from the key and nonce. */
export const V4_LOCAL_ENCRYPTION_INFO: Uint8Array = new TextEncoder().encode(
  "paseto-encryption-key",
);
/** The info string that derives the authentication key from the key and nonce. */
export const V4_LOCAL_AUTHENTICATION_INFO: Uint8Array = new TextEncoder().encode(
  "paseto-auth-key-for-aead",
);

/**
 * v4.local encrypt with a caller-supplied nonce, so the RFC vectors can reproduce byte-exact
 * tokens. Not re-exported from the package index: production callers use `encryptV4Local`, which
 * supplies a fresh random nonce. Throws `InvalidKeyError` unless key and nonce are 32 bytes.
 *
 * The step order follows the PASETO v4 spec; the MAC covers the nonce, ciphertext, footer and
 * implicit assertion through PAE, never the plaintext.
 */
export function encryptV4LocalDeterministic(
  payload: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  footer?: Uint8Array,
  implicitAssertion?: Uint8Array,
): string {
  if (key.length !== 32) {
    throw new InvalidKeyError("v4.local key must be 32 bytes");
  }
  if (nonce.length !== 32) {
    throw new InvalidKeyError("v4.local nonce must be 32 bytes");
  }

  const f = footer ?? new Uint8Array(0);
  const i = implicitAssertion ?? new Uint8Array(0);

  // Ek (32) || n2 (24) = 56 bytes via BLAKE2b keyed by the key.
  const tmp = blake2b(concatBytes(V4_LOCAL_ENCRYPTION_INFO, nonce), { key, dkLen: 56 });
  const ek = tmp.subarray(0, 32);
  const n2 = tmp.subarray(32, 56);

  // Ak is a separate BLAKE2b derivation, not a slice of the one above.
  const ak = blake2b(concatBytes(V4_LOCAL_AUTHENTICATION_INFO, nonce), { key, dkLen: 32 });

  const ciphertext = xchacha20(ek, n2, payload);

  // MAC over PAE([h, n, c, f, i]).
  const m2 = pae([V4_LOCAL_HEADER_BYTES, nonce, ciphertext, f, i]);
  const tag = blake2b(m2, { key: ak, dkLen: 32 });

  const body = concatBytes(nonce, ciphertext, tag);
  const bodyB64 = base64UrlEncode(body);
  return f.length === 0
    ? `${V4_LOCAL_HEADER}${bodyB64}`
    : `${V4_LOCAL_HEADER}${bodyB64}.${base64UrlEncode(f)}`;
}
