import { ed25519 } from "@noble/curves/ed25519.js";
import { pae } from "./pae.js";
import { InvalidKeyError, InvalidTokenError } from "./errors.js";

const HEADER = "v4.public.";
const HEADER_BYTES = new TextEncoder().encode(HEADER);
const SIGNATURE_LENGTH = 64; // Ed25519 signature size in bytes

/** An Ed25519 key pair for `v4.public` tokens. */
export interface V4PublicKeyPair {
  readonly publicKey: Uint8Array; // 32 bytes
  readonly secretKey: Uint8Array; // 32 bytes (Ed25519 "seed" per RFC 8032)
}

/** Generates a fresh random Ed25519 key pair. */
export function generateV4PublicKeyPair(): V4PublicKeyPair {
  const pair = ed25519.keygen();
  return { publicKey: pair.publicKey, secretKey: pair.secretKey };
}

/**
 * Signs `payload` into a `v4.public` token. The optional footer is carried in the token; the
 * implicit assertion is signed but not carried. Throws `InvalidKeyError` unless the key is 32
 * bytes.
 */
export function signV4Public(
  payload: Uint8Array,
  secretKey: Uint8Array,
  footer?: Uint8Array,
  implicitAssertion?: Uint8Array,
): string {
  assertSecretKey(secretKey);

  const f = footer ?? new Uint8Array(0);
  const i = implicitAssertion ?? new Uint8Array(0);

  // PAE input order per the PASETO spec: [header, payload, footer, implicit assertion].
  const m2 = pae([HEADER_BYTES, payload, f, i]);
  const sig = ed25519.sign(m2, secretKey);

  const bodyBytes = concat(payload, sig);
  const body = base64UrlEncode(bodyBytes);

  return f.length === 0 ? `${HEADER}${body}` : `${HEADER}${body}.${base64UrlEncode(f)}`;
}

/**
 * Verifies a `v4.public` token and returns its payload. The footer and implicit assertion must
 * equal the ones used to sign. Throws `InvalidKeyError` for a bad key and `InvalidTokenError` for
 * a malformed token or a signature that does not verify, including a small-order or non-canonical
 * public key.
 */
export function verifyV4Public(
  token: string,
  publicKey: Uint8Array,
  footer?: Uint8Array,
  implicitAssertion?: Uint8Array,
): Uint8Array {
  assertPublicKey(publicKey);

  if (!token.startsWith(HEADER)) {
    throw new InvalidTokenError("v4.public header mismatch");
  }

  const remainder = token.slice(HEADER.length);
  const parts = remainder.split(".");
  if (parts.length > 2) {
    throw new InvalidTokenError("v4.public token has too many segments");
  }
  // A trailing dot with an empty footer (`v4.public.<body>.`) is non-canonical: two token strings
  // would verify against the same key, and appending `.` would defeat replay or revocation checks
  // keyed by token text.
  if (parts.length === 2 && parts[1] === "") {
    throw new InvalidTokenError("v4.public token has trailing dot with empty footer");
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

  let bodyBytes: Uint8Array;
  try {
    bodyBytes = base64UrlDecode(parts[0]!);
  } catch {
    throw new InvalidTokenError("body base64url decode failed");
  }
  if (bodyBytes.length < SIGNATURE_LENGTH) {
    throw new InvalidTokenError("body too short for v4.public signature");
  }

  const sig = bodyBytes.subarray(bodyBytes.length - SIGNATURE_LENGTH);
  const payload = bodyBytes.subarray(0, bodyBytes.length - SIGNATURE_LENGTH);

  const ia = implicitAssertion ?? new Uint8Array(0);
  const m2 = pae([HEADER_BYTES, payload, tokenFooter, ia]);

  // `{ zip215: false }` is load-bearing. Noble defaults to ZIP-215 decoding, which admits
  // small-order public keys; against one, a single (R, S) pair verifies for every message, a
  // universal forgery on the path that authenticates v4.public tokens. `false` selects strict
  // RFC 8032 verification, which also rejects non-canonical point encodings and matches libsodium.
  // Pass the option literally here: noble falls back to the permissive default when it is absent,
  // `{}` or `{ zip215: undefined }`, and the compiler catches only the last. The
  // strict-verification test is the guard.
  let ok: boolean;
  try {
    ok = ed25519.verify(sig, m2, publicKey, { zip215: false });
  } catch {
    throw new InvalidTokenError("signature decode failed");
  }
  if (!ok) {
    throw new InvalidTokenError("signature verification failed");
  }

  return payload;
}

function assertSecretKey(key: Uint8Array): void {
  if (key.length !== 32) {
    throw new InvalidKeyError("v4.public secret key must be 32 bytes");
  }
}

function assertPublicKey(key: Uint8Array): void {
  if (key.length !== 32) {
    throw new InvalidKeyError("v4.public public key must be 32 bytes");
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
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
