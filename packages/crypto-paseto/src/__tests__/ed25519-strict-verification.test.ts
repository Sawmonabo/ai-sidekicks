// Strict RFC 8032 Ed25519 verification on the v4.public path.
//
// `@noble/curves` defaults its ed25519 wrapper to `zip215: true`, which skips
// the small-order public-key rejection. Against a small-order public key the
// `[8][k]A` term drops out of the cofactored verification equation, so a single
// `(R, S)` pair verifies for every message — a universal forgery on the path
// that authenticates v4.public tokens. `verifyV4Public` therefore pins
// `{ zip215: false }`; this file is the guard that keeps it pinned.
//
// The same defect was fixed on the daemon's audit-log signing path; this closes
// the crypto-paseto instance. Pre-first-release, so no live exposure.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { pae } from "../pae.js";
import { verifyV4Public } from "../v4-public.js";
import { InvalidTokenError } from "../errors.js";

const HEADER = "v4.public.";
const HEADER_BYTES = new TextEncoder().encode(HEADER);
const EMPTY = new Uint8Array(0);
const SIGNATURE_LENGTH = 64;

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function hex(hexString: string): Uint8Array {
  if (hexString.length % 2 !== 0) throw new Error(`odd-length hex: ${hexString}`);
  const out = new Uint8Array(hexString.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hexString.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// y = 1, x = 0 — the identity point. Canonically encoded and order 1, so it is
// small-order: exactly the key class RFC 8032 strict verification refuses and
// ZIP-215 admits.
function smallOrderPublicKey(): Uint8Array {
  const publicKey = new Uint8Array(32);
  publicKey[0] = 1;
  return publicKey;
}

// R = the identity encoding, S = 0. Nothing about this pair is derived from a
// message or a secret key — that is the point.
function smallOrderSignature(): Uint8Array {
  const signature = new Uint8Array(SIGNATURE_LENGTH);
  signature[0] = 1;
  return signature;
}

// y = p = 2^255 - 19, little-endian. RFC 8032 requires y < p; ZIP-215 accepts
// any y < 2^256 and reduces mod p, so this decodes to y = 0 under the default.
function nonCanonicalPublicKey(): Uint8Array {
  const publicKey = new Uint8Array(32).fill(0xff);
  publicKey[0] = 0xed;
  publicKey[31] = 0x7f;
  return publicKey;
}

// `verifyV4Public` runs four gates (header, segment count, footer, strict
// base64url canonical form) before it reaches the signature check. Encoding the
// body with Node's canonical unpadded base64url keeps every one of those gates
// satisfied, so a rejection can only come from the signature check itself.
function encodeForgedToken(payload: Uint8Array, signature: Uint8Array): string {
  const bodyBytes = new Uint8Array(payload.length + signature.length);
  bodyBytes.set(payload, 0);
  bodyBytes.set(signature, payload.length);
  return `${HEADER}${Buffer.from(bodyBytes).toString("base64url")}`;
}

describe("v4.public strict RFC 8032 verification (small-order public keys)", () => {
  it("rejects the small-order universal forgery that the noble default accepts", () => {
    const publicKey = smallOrderPublicKey();
    const signature = smallOrderSignature();
    const payload = utf8('{"sub":"attacker","role":"admin"}');
    const token = encodeForgedToken(payload, signature);
    const preAuthenticationEncoding = pae([HEADER_BYTES, payload, EMPTY, EMPTY]);

    // This bare noble call is the negative control, not a redundant duplicate
    // of the module assertion below — do not "simplify" it away. It runs on the
    // exact triple `verifyV4Public` will check (same PAE pre-image, same
    // signature, same key) and proves the forgery is genuinely accepted at the
    // library default. Without it, the rejection below is unattributable: a
    // test asserting only that a garbage token throws stays green with the
    // `{ zip215: false }` fix reverted, because some earlier parse gate would
    // throw anyway.
    //
    // If this assertion ever FAILS, noble has changed its default to strict.
    // The explicit `{ zip215: false }` is then redundant but still correct and
    // must stay — pinning it is what makes the guarantee independent of the
    // dependency's default rather than a side effect of it.
    expect(ed25519.verify(signature, preAuthenticationEncoding, publicKey)).toBe(true);

    expect(() => verifyV4Public(token, publicKey)).toThrow(InvalidTokenError);
    // Pin the gate, not just the error class: the message proves rejection came
    // from the signature check rather than from parsing.
    expect(() => verifyV4Public(token, publicKey)).toThrow(/signature verification failed/);
  });

  it("rejects the same forged pair against every message (it is universal, not a one-off)", () => {
    const publicKey = smallOrderPublicKey();
    const signature = smallOrderSignature();

    for (const claims of ['{"sub":"alice"}', '{"sub":"bob","admin":true}', "", "unrelated bytes"]) {
      const payload = utf8(claims);
      const preAuthenticationEncoding = pae([HEADER_BYTES, payload, EMPTY, EMPTY]);

      // One signature, arbitrarily many messages — this is what makes the
      // ZIP-215 default a universal forgery rather than a single bad token.
      expect(ed25519.verify(signature, preAuthenticationEncoding, publicKey)).toBe(true);
      expect(() => verifyV4Public(encodeForgedToken(payload, signature), publicKey)).toThrow(
        InvalidTokenError,
      );
    }
  });

  it("rejects a non-canonically encoded public key (y = p) that ZIP-215 reduces", () => {
    const publicKey = nonCanonicalPublicKey();
    const signature = smallOrderSignature();
    const payload = utf8("non-canonical public key");
    const token = encodeForgedToken(payload, signature);
    const preAuthenticationEncoding = pae([HEADER_BYTES, payload, EMPTY, EMPTY]);

    // The other half of the tightening: `zip215: false` narrows the accepted
    // y range from [0, 2^256) to [0, p), so this key no longer decodes at all.
    // Under the default it reduces to y = 0 — itself small-order, which the
    // same forged pair satisfies.
    expect(ed25519.verify(signature, preAuthenticationEncoding, publicKey)).toBe(true);
    expect(() => verifyV4Public(token, publicKey)).toThrow(InvalidTokenError);
    // Strict mode refuses to decode the point, noble catches that internally
    // and returns false, so this still surfaces as a verification failure
    // rather than the `signature decode failed` catch path.
    expect(() => verifyV4Public(token, publicKey)).toThrow(/signature verification failed/);
  });
});

// `zip215: false` also tightens canonical-encoding acceptance, so the real risk
// of the change is refusing something legitimate. `rfc-vectors-v4-public.test.ts`
// proves the module still accepts every 4-S-* vector; this proves *why* that is
// safe — the upstream vectors' own keys and signatures satisfy strict RFC 8032
// at the primitive level, so acceptance does not rest on wrapper leniency.
describe("upstream 4-S-* vectors satisfy strict RFC 8032 at the primitive level", () => {
  interface PasetoV4Vector {
    name: string;
    "expect-fail": boolean;
    "public-key"?: string;
    token: string;
    footer: string;
    "implicit-assertion": string;
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const FIXTURE = resolve(__dirname, "__fixtures__/v4.json");
  const FILE: { tests: PasetoV4Vector[] } = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const positiveSigningVectors = FILE.tests.filter(
    (vector) => vector.name.startsWith("4-S-") && !vector["expect-fail"],
  );

  // Non-zero-count guard: a `for` loop over an empty filter registers no tests
  // and reports green. Mirrors the guard in the other vector suites.
  it("filter selects at least one positive v4.public vector", () => {
    expect(positiveSigningVectors.length).toBeGreaterThan(0);
  });

  for (const vector of positiveSigningVectors) {
    it(`${vector.name} verifies under a bare { zip215: false } noble call`, () => {
      const publicKey = hex(vector["public-key"]!);
      const bodyBytes = new Uint8Array(
        Buffer.from(vector.token.slice(HEADER.length).split(".")[0]!, "base64url"),
      );
      const signature = bodyBytes.subarray(bodyBytes.length - SIGNATURE_LENGTH);
      const payload = bodyBytes.subarray(0, bodyBytes.length - SIGNATURE_LENGTH);
      const preAuthenticationEncoding = pae([
        HEADER_BYTES,
        payload,
        utf8(vector.footer),
        utf8(vector["implicit-assertion"]),
      ]);

      expect(
        ed25519.verify(signature, preAuthenticationEncoding, publicKey, { zip215: false }),
      ).toBe(true);
    });
  }
});
