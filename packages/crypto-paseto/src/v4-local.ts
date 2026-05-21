import { xchacha20 } from "@noble/ciphers/chacha.js";
import { blake2b } from "@noble/hashes/blake2.js";
// `equalBytes` is in @noble/ciphers/utils.js (NOT @noble/hashes/utils.js) in
// noble 2.x — the constant-time XOR-OR-accumulator implementation lives there.
// `randomBytes` is exported from both; sourcing both here keeps imports tight.
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

export function encryptV4Local(
  payload: Uint8Array,
  key: Uint8Array,
  footer?: Uint8Array,
  implicitAssertion?: Uint8Array,
): string {
  // Fresh 32-byte nonce per call (invariant I3). Never reused; never logged.
  const nonce = randomBytes(NONCE_LEN);
  return encryptV4LocalDeterministic(payload, key, nonce, footer, implicitAssertion);
}

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
  // PASETO §2: a token is exactly `header.payload` or `header.payload.footer`.
  // A trailing dot with empty footer (`v4.local.<body>.`) is non-canonical —
  // two distinct token strings would otherwise decode to the same secret, and
  // exact-string controls (replay/revocation caches keyed by token text) would
  // be defeatable by appending `.`.
  if (parts.length === 2 && parts[1] === "") {
    throw new InvalidTokenError("v4.local token has trailing dot with empty footer");
  }

  // Footer canonicalization: undefined ≡ Uint8Array(0). Design spec §6.
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

  // Derive Ek, n2, Ak — identical to encrypt path.
  const tmp = blake2b(concat(ENC_INFO, nonce), { key, dkLen: 56 });
  const ek = tmp.subarray(0, 32);
  const n2 = tmp.subarray(32, 56);
  const ak = blake2b(concat(AUTH_INFO, nonce), { key, dkLen: 32 });

  // Step 4 (decrypt): MAC verify BEFORE decryption (invariant I2). The
  // constant-time `equalBytes` is non-negotiable on secret material — never
  // `===`, `Buffer.compare`, or short-circuit byte loops on `tag`.
  const ia = implicitAssertion ?? new Uint8Array(0);
  const m2 = pae([HEADER_BYTES, nonce, ciphertext, tokenFooter, ia]);
  const expectedTag = blake2b(m2, { key: ak, dkLen: TAG_LEN });

  if (!equalBytes(tag, expectedTag)) {
    throw new MacMismatchError("v4.local MAC mismatch");
  }

  // Step 5 (decrypt): only reached after MAC verifies. XChaCha20 is a stream
  // cipher — same call shape for encrypt and decrypt.
  return xchacha20(ek, n2, ciphertext);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function base64UrlDecode(s: string): Uint8Array {
  // PASETO §2 requires strictly canonical base64url (RFC 4648 §5, unpadded):
  // no `=` padding, no whitespace, no characters outside `[A-Za-z0-9_-]`.
  // Node's `Buffer.from(s, "base64url")` is lenient — it tolerates `=`
  // padding and silently ignores invalid characters — so two different
  // textual strings can decode to the same bytes. For v4.local that lets
  // tampered token text pass MAC verification and breaks exact-string
  // controls layered on top (e.g., replay/revocation caches keyed by
  // token string).
  //
  // Round-trip canonicalization: decode, then re-encode with Node's canonical
  // (no-padding) base64url, and require byte equality against the input.
  // Any deviation (padding, whitespace, alternate alphabet, stray chars)
  // fails this check. Matches the v4.public decoder for parity.
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
