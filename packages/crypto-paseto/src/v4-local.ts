import { xchacha20 } from "@noble/ciphers/chacha.js";
import { blake2b } from "@noble/hashes/blake2.js";
// `equalBytes` (constant time) lives in @noble/ciphers, not @noble/hashes; `randomBytes` is in
// both.
import { equalBytes, randomBytes } from "@noble/ciphers/utils.js";
import { pae } from "./pae.js";
import { InvalidKeyError, InvalidTokenError, MacMismatchError } from "./errors.js";
import { encryptV4LocalDeterministic } from "./internal/v4-local-deterministic.js";

const HEADER = "v4.local.";
const HEADER_BYTES = new TextEncoder().encode(HEADER);
const ENC_INFO = new TextEncoder().encode("paseto-encryption-key");
const AUTH_INFO = new TextEncoder().encode("paseto-auth-key-for-aead");
const NONCE_LEN = 32; // PASETO v4.local n
const TAG_LEN = 32; // BLAKE2b-MAC output

/**
 * Encrypts `payload` into a `v4.local` token under a 32-byte `key`, with a fresh random nonce per
 * call. The optional footer is carried in the token; the implicit assertion is authenticated but
 * not carried. Throws `InvalidKeyError` if the key is not 32 bytes.
 */
export function encryptV4Local(
  payload: Uint8Array,
  key: Uint8Array,
  footer?: Uint8Array,
  implicitAssertion?: Uint8Array,
): string {
  // A nonce must never be reused under one key.
  const nonce = randomBytes(NONCE_LEN);
  return encryptV4LocalDeterministic(payload, key, nonce, footer, implicitAssertion);
}

/**
 * Verifies and decrypts a `v4.local` token. The footer and implicit assertion must equal the ones
 * used to encrypt. Throws `InvalidKeyError` for a bad key, `MacMismatchError` when the tag does not
 * verify, and `InvalidTokenError` for any other malformed token. Nothing is decrypted before the
 * tag verifies.
 */
export function decryptV4Local(
  token: string,
  key: Uint8Array,
  footer?: Uint8Array,
  implicitAssertion?: Uint8Array,
): Uint8Array {
  if (key.length !== 32) {
    throw new InvalidKeyError("v4.local key must be 32 bytes");
  }

  if (!token.startsWith(HEADER)) {
    throw new InvalidTokenError("v4.local header mismatch");
  }

  const remainder = token.slice(HEADER.length);
  const parts = remainder.split(".");
  if (parts.length > 2) {
    throw new InvalidTokenError("v4.local token has too many segments");
  }
  // A trailing dot with an empty footer (`v4.local.<body>.`) is non-canonical: two token strings
  // would decode to the same plaintext, and appending `.` would defeat replay or revocation checks
  // keyed by token text.
  if (parts.length === 2 && parts[1] === "") {
    throw new InvalidTokenError("v4.local token has trailing dot with empty footer");
  }

  // An undefined footer is the same as an empty one.
  const expF = footer ?? new Uint8Array(0);
  const tokenFooterB64 = parts[1] ?? "";

  if (expF.length === 0 && tokenFooterB64.length > 0) {
    throw new InvalidTokenError("footer-absent-but-present");
  }
  if (expF.length > 0 && tokenFooterB64.length === 0) {
    throw new InvalidTokenError("footer-expected-but-absent");
  }

  let tokenFooter: Uint8Array = new Uint8Array(0);
  if (tokenFooterB64.length > 0) {
    try {
      tokenFooter = base64UrlDecode(tokenFooterB64);
    } catch {
      throw new InvalidTokenError("footer base64url decode failed");
    }
    if (!bytesEqualStructural(expF, tokenFooter)) {
      throw new InvalidTokenError("footer mismatch");
    }
  }

  let body: Uint8Array;
  try {
    body = base64UrlDecode(parts[0]!);
  } catch {
    throw new InvalidTokenError("body base64url decode failed");
  }
  if (body.length < NONCE_LEN + TAG_LEN) {
    throw new InvalidTokenError("body too short for v4.local n||c||t layout");
  }

  const nonce = body.subarray(0, NONCE_LEN);
  const ciphertext = body.subarray(NONCE_LEN, body.length - TAG_LEN);
  const tag = body.subarray(body.length - TAG_LEN);

  // Same key derivation as the encrypt path.
  const tmp = blake2b(concat(ENC_INFO, nonce), { key, dkLen: 56 });
  const ek = tmp.subarray(0, 32);
  const n2 = tmp.subarray(32, 56);
  const ak = blake2b(concat(AUTH_INFO, nonce), { key, dkLen: 32 });

  // Verify the MAC before decrypting. The tag comparison must stay constant time: never `===`,
  // `Buffer.compare` or a short-circuiting loop.
  const ia = implicitAssertion ?? new Uint8Array(0);
  const m2 = pae([HEADER_BYTES, nonce, ciphertext, tokenFooter, ia]);
  const expectedTag = blake2b(m2, { key: ak, dkLen: TAG_LEN });

  if (!equalBytes(tag, expectedTag)) {
    throw new MacMismatchError("v4.local MAC mismatch");
  }

  // XChaCha20 is a stream cipher, so decrypting is the same call as encrypting.
  return xchacha20(ek, n2, ciphertext);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function base64UrlDecode(s: string): Uint8Array {
  // PASETO requires strictly canonical unpadded base64url. Node's `Buffer.from(s, "base64url")`
  // tolerates `=` padding and silently skips invalid characters, so different token strings could
  // decode to the same bytes and defeat replay or revocation checks keyed by token text. Decoding
  // then re-encoding and comparing to the input rejects any deviation.
  const decoded = new Uint8Array(Buffer.from(s, "base64url"));
  if (Buffer.from(decoded).toString("base64url") !== s) {
    throw new InvalidTokenError("base64url input is not strictly canonical");
  }
  return decoded;
}

// The footer is public, so this comparison need not be constant time.
function bytesEqualStructural(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
