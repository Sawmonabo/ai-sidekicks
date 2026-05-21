import { describe, expect, it } from "vitest";
import { randomBytes } from "@noble/hashes/utils.js";
import { encryptV4Local, decryptV4Local } from "../v4-local.js";
import { encryptV4LocalDeterministic } from "../internal/v4-local-deterministic.js";
import { InvalidTokenError, MacMismatchError, InvalidKeyError } from "../errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("v4.local encrypt / decrypt", () => {
  it("round-trips a payload encrypt→decrypt", () => {
    const key = randomBytes(32);
    const payload = encoder.encode("hello, paseto-local");

    const token = encryptV4Local(payload, key);
    expect(token.startsWith("v4.local.")).toBe(true);

    const recovered = decryptV4Local(token, key);
    expect(decoder.decode(recovered)).toBe("hello, paseto-local");
  });

  it("produces a different token each time (nonce freshness)", () => {
    const key = randomBytes(32);
    const payload = encoder.encode("payload");
    const t1 = encryptV4Local(payload, key);
    const t2 = encryptV4Local(payload, key);
    expect(t1).not.toBe(t2);
  });

  it("round-trips with a footer", () => {
    const key = randomBytes(32);
    const payload = encoder.encode("payload");
    const footer = encoder.encode("kid:k_2026_05");
    const token = encryptV4Local(payload, key, footer);
    expect(token.split(".").length).toBe(4);
    const recovered = decryptV4Local(token, key, footer);
    expect(decoder.decode(recovered)).toBe("payload");
  });

  it("round-trips with an implicit assertion (footer absent)", () => {
    const key = randomBytes(32);
    const payload = encoder.encode("payload");
    const ia = encoder.encode("session:abc");
    const token = encryptV4Local(payload, key, undefined, ia);
    const recovered = decryptV4Local(token, key, undefined, ia);
    expect(decoder.decode(recovered)).toBe("payload");
  });

  it("throws MacMismatchError when the MAC is tampered", () => {
    // Body shape is nonce(32) || ciphertext(N) || tag(32); flipping the LSB of
    // the last body byte (= last byte of the BLAKE2b-MAC tag) is deterministic.
    // A char-domain flip can land on base64url padding bits and be a no-op
    // when body length ≡ 4 (mod 6) — see T3 finding. Byte-domain XOR is safe.
    const key = randomBytes(32);
    const token = encryptV4Local(encoder.encode("payload"), key);
    const head = "v4.local.";
    const bodyB64 = token.slice(head.length);
    const bodyBytes = new Uint8Array(Buffer.from(bodyB64, "base64url"));
    bodyBytes[bodyBytes.length - 1]! ^= 0x01;
    const tampered = head + Buffer.from(bodyBytes).toString("base64url");
    expect(() => decryptV4Local(tampered, key)).toThrow(MacMismatchError);
    // MacMismatchError extends InvalidTokenError — consumers can catch broadly.
    try {
      decryptV4Local(tampered, key);
    } catch (e) {
      expect(e instanceof InvalidTokenError).toBe(true);
    }
  });

  it("throws MacMismatchError when decrypting with the wrong key", () => {
    const key = randomBytes(32);
    const otherKey = randomBytes(32);
    const token = encryptV4Local(encoder.encode("payload"), key);
    expect(() => decryptV4Local(token, otherKey)).toThrow(MacMismatchError);
  });

  it("rejects a token that does not start with v4.local.", () => {
    const key = randomBytes(32);
    expect(() => decryptV4Local("v4.public.AAAA", key)).toThrow(InvalidTokenError);
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => encryptV4Local(encoder.encode("p"), new Uint8Array(16))).toThrow(InvalidKeyError);
    expect(() => decryptV4Local("v4.local.AAAA", new Uint8Array(16))).toThrow(InvalidKeyError);
  });

  it("test-only deterministic variant reproduces tokens given a fixed nonce", () => {
    const key = randomBytes(32);
    const nonce = randomBytes(32);
    const payload = encoder.encode("payload");
    const t1 = encryptV4LocalDeterministic(payload, key, nonce);
    const t2 = encryptV4LocalDeterministic(payload, key, nonce);
    expect(t1).toBe(t2);

    // Production path can decrypt what the deterministic variant produced.
    const recovered = decryptV4Local(t1, key);
    expect(decoder.decode(recovered)).toBe("payload");
  });

  // Strict base64url canonicalization: non-canonical textual forms (padding,
  // invalid chars) must be rejected even when Node's lenient decoder would
  // otherwise produce bytes that pass MAC verification. Mirrors the v4.public
  // canonicalization suite — same rationale, same exact-string controls.
  it("rejects a token whose body base64url carries `=` padding", () => {
    const key = randomBytes(32);
    const token = encryptV4Local(encoder.encode("payload"), key);
    expect(() => decryptV4Local(`${token}=`, key)).toThrow(InvalidTokenError);
  });

  it("rejects a token whose footer base64url carries `=` padding", () => {
    const key = randomBytes(32);
    const footer = encoder.encode("kid:k_1");
    const token = encryptV4Local(encoder.encode("payload"), key, footer);
    expect(() => decryptV4Local(`${token}=`, key, footer)).toThrow(InvalidTokenError);
  });

  it("rejects a token whose body contains a non-base64url character", () => {
    const key = randomBytes(32);
    const token = encryptV4Local(encoder.encode("payload"), key);
    const head = token.slice(0, "v4.local.".length);
    const body = token.slice("v4.local.".length);
    // Replace the first body char with `$` (outside the base64url alphabet).
    const tampered = `${head}$${body.slice(1)}`;
    expect(() => decryptV4Local(tampered, key)).toThrow(InvalidTokenError);
  });

  // PASETO §2 exact-string invariant: `header.payload.` (trailing dot, empty
  // footer) is a third textual form that would otherwise decrypt against the
  // same key as `header.payload`. Without this rejection, an attacker can
  // bypass exact-string replay/revocation caches by appending `.`.
  it("rejects a token with a trailing dot and empty footer segment", () => {
    const key = randomBytes(32);
    const token = encryptV4Local(encoder.encode("payload"), key);
    expect(() => decryptV4Local(`${token}.`, key)).toThrow(InvalidTokenError);
  });
});
