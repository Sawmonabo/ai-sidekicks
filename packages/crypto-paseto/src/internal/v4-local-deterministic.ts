import { xchacha20 } from "@noble/ciphers/chacha.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { pae } from "../pae.js";
import { InvalidKeyError } from "../errors.js";

/**
 * Internal-only deterministic v4.local encrypt.
 *
 * NOT re-exported from `src/index.ts`. Production callers must use
 * `encryptV4Local` from `../v4-local.ts`, which calls into this function with
 * a fresh random nonce. This seam exists so RFC vector encrypt round-trips
 * can feed the vector's recorded `nonce` and produce byte-exact tokens.
 *
 * Algorithm: paseto-spec/docs/01-Protocol-Versions/Version4.md §v4.local Encrypt.
 *
 * Step ordering matches the spec — do not reorder. Step 4 (MAC) computes over
 * the nonce, ciphertext, footer, and implicit assertion via PAE; never over
 * the plaintext.
 */

const HEADER = "v4.local.";
const HEADER_BYTES = new TextEncoder().encode(HEADER);
const ENC_INFO = new TextEncoder().encode("paseto-encryption-key");
const AUTH_INFO = new TextEncoder().encode("paseto-auth-key-for-aead");

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

  // Step 3: derive Ek (32) || n2 (24) = 56 bytes via BLAKE2b keyed by k.
  const tmp = blake2b(concat(ENC_INFO, nonce), { key, dkLen: 56 });
  const ek = tmp.subarray(0, 32);
  const n2 = tmp.subarray(32, 56);

  // Step 4: derive Ak — separate BLAKE2b derivation, NOT a slice of tmp.
  const ak = blake2b(concat(AUTH_INFO, nonce), { key, dkLen: 32 });

  // Step 5: encrypt.
  const ciphertext = xchacha20(ek, n2, payload);

  // Step 6: MAC over PAE([h, n, c, f, i]).
  const m2 = pae([HEADER_BYTES, nonce, ciphertext, f, i]);
  const tag = blake2b(m2, { key: ak, dkLen: 32 });

  // Step 7: assemble body and token.
  const body = concat3(nonce, ciphertext, tag);
  const bodyB64 = base64UrlEncode(body);
  return f.length === 0 ? `${HEADER}${bodyB64}` : `${HEADER}${bodyB64}.${base64UrlEncode(f)}`;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function concat3(a: Uint8Array, b: Uint8Array, c: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length + c.length);
  out.set(a, 0);
  out.set(b, a.length);
  out.set(c, a.length + b.length);
  return out;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
