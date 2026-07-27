import { ed25519 } from "@noble/curves/ed25519.js";
import { pae } from "./pae.js";
import { InvalidKeyError, InvalidTokenError } from "./errors.js";

const HEADER = "v4.public.";
const HEADER_BYTES = new TextEncoder().encode(HEADER);
const SIGNATURE_LENGTH = 64; // Ed25519 signatures are 64 bytes.

export interface V4PublicKeyPair {
  readonly publicKey: Uint8Array; // 32 bytes
  readonly secretKey: Uint8Array; // 32 bytes (Ed25519 "seed" per RFC 8032)
}

export function generateV4PublicKeyPair(): V4PublicKeyPair {
  // noble-curves v2.x convenience helper: returns { secretKey, publicKey }
  // matching our V4PublicKeyPair shape. Equivalent to:
  //   const secretKey = ed25519.utils.randomSecretKey();
  //   const publicKey = ed25519.getPublicKey(secretKey);
  const pair = ed25519.keygen();
  return { publicKey: pair.publicKey, secretKey: pair.secretKey };
}

export function signV4Public(
  payload: Uint8Array,
  secretKey: Uint8Array,
  footer?: Uint8Array,
  implicitAssertion?: Uint8Array,
): string {
  assertSecretKey(secretKey);

  const f = footer ?? new Uint8Array(0);
  const i = implicitAssertion ?? new Uint8Array(0);

  // PAE input order per paseto-spec §v4.public: [header, payload, footer, ia].
  const m2 = pae([HEADER_BYTES, payload, f, i]);
  const sig = ed25519.sign(m2, secretKey);

  const bodyBytes = concat(payload, sig);
  const body = base64UrlEncode(bodyBytes);

  return f.length === 0 ? `${HEADER}${body}` : `${HEADER}${body}.${base64UrlEncode(f)}`;
}

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
  // PASETO §2: a token is exactly `header.payload` or `header.payload.footer`.
  // A trailing dot with empty footer (`v4.public.<body>.`) is non-canonical —
  // two distinct token strings would otherwise verify against the same public
  // key, and exact-string controls (replay/revocation caches keyed by token
  // text) would be defeatable by appending `.`.
  if (parts.length === 2 && parts[1] === "") {
    throw new InvalidTokenError("v4.public token has trailing dot with empty footer");
  }

  // Footer canonicalization: undefined ≡ Uint8Array(0). See design spec §6.
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

  // Noble 2.x: ed25519.verify(signature, message, publicKey).
  //
  // `{ zip215: false }` is load-bearing, not a style choice. Noble's ed25519
  // wrapper defaults to `zip215: true` — the consensus-friendly ZIP-215 decode
  // rules — which skips the small-order public-key rejection. Against a
  // small-order public key the `[8][k]A` term drops out of the cofactored
  // verification equation, so one `(R, S)` pair verifies for *every* message:
  // universal forgery on the path that authenticates v4.public auth tokens.
  // `zip215: false` selects strict RFC 8032 / FIPS 186-5 verification, which
  // also rejects non-canonical point encodings (`y >= p`). That matches what
  // paseto-spec Version4.md §Verify actually specifies — libsodium's
  // `crypto_sign_verify_detached`, which refuses small-order and
  // non-canonically-encoded public keys.
  //
  // Pass the option literally at this call site. Noble branches on the option
  // being absent — it tests for `undefined` and falls back to a wrapper built
  // with `zip215: true` — so `{}` and `{ zip215: undefined }` both resolve
  // back to permissive. That fallback is deliberate upstream behavior, not an
  // incidental gap a later patch might close, so the hazard is permanent.
  // Only `{}` is *silent*, though: `{ zip215: undefined }` is a compile error
  // here under `exactOptionalPropertyTypes`. So the realistic regression —
  // hoisting this into a shared or spread options object that drops the key —
  // is the one the compiler cannot see. `ed25519-strict-verification.test.ts`
  // is the sole guard: a bare 3-arg call, `{}`, and `{ zip215: undefined }`
  // each turn exactly its three strict-verification tests red, and nothing
  // else in the package.
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
  // PASETO §2 requires strictly canonical base64url (RFC 4648 §5, unpadded):
  // no `=` padding, no whitespace, no characters outside `[A-Za-z0-9_-]`.
  // Node's `Buffer.from(s, "base64url")` is lenient — it tolerates `=`
  // padding and silently ignores invalid characters — so two different
  // textual strings can decode to the same bytes. That would let a tampered
  // token re-verify and break exact-string controls layered on top (e.g.,
  // replay/revocation caches keyed by token string).
  //
  // Round-trip canonicalization: decode, then re-encode with Node's canonical
  // (no-padding) base64url, and require byte equality against the input.
  // Any deviation (padding, whitespace, alternate alphabet, stray chars)
  // fails this check.
  const decoded = new Uint8Array(Buffer.from(s, "base64url"));
  if (Buffer.from(decoded).toString("base64url") !== s) {
    throw new InvalidTokenError("base64url input is not strictly canonical");
  }
  return decoded;
}

// Structural (non-secret) equality for footer comparison. Footer is public
// metadata; constant-time discipline is not required here.
function bytesEqualStructural(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
