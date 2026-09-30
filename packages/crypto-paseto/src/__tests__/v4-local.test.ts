import { describe, expect, it } from "vitest";
import { randomBytes } from "@noble/hashes/utils.js";
import { encryptV4Local, decryptV4Local } from "../v4-local.js";
import { InvalidTokenError, MacMismatchError, InvalidKeyError } from "../errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const empty = new Uint8Array(0);

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

  it("throws MacMismatchError when the MAC is tampered", () => {
    // Body is nonce(32) || ciphertext(N) || tag(32); flipping the last body byte alters the tag. A
    // character flip can land on base64url padding bits and change nothing, so flip a byte.
    const key = randomBytes(32);
    const token = encryptV4Local(encoder.encode("payload"), key);
    const head = "v4.local.";
    const bodyB64 = token.slice(head.length);
    const bodyBytes = new Uint8Array(Buffer.from(bodyB64, "base64url"));
    bodyBytes[bodyBytes.length - 1]! ^= 0x01;
    const tampered = head + Buffer.from(bodyBytes).toString("base64url");
    expect(() => decryptV4Local(tampered, key)).toThrow(MacMismatchError);
    // MacMismatchError extends InvalidTokenError, so callers can catch broadly.
    try {
      decryptV4Local(tampered, key);
    } catch (e) {
      expect(e instanceof InvalidTokenError).toBe(true);
    }
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => encryptV4Local(encoder.encode("p"), new Uint8Array(16))).toThrow(InvalidKeyError);
    expect(() => decryptV4Local("v4.local.AAAA", new Uint8Array(16))).toThrow(InvalidKeyError);
  });

  // Non-canonical base64url (padding, invalid characters) must be rejected even when Node's
  // lenient decoder yields bytes that pass MAC verification.
  it("rejects a token whose body base64url carries `=` padding", () => {
    const key = randomBytes(32);
    const token = encryptV4Local(encoder.encode("payload"), key);
    expect(() => decryptV4Local(`${token}=`, key)).toThrow(InvalidTokenError);
  });

  // `header.payload.` (trailing dot, empty footer) would otherwise decrypt like `header.payload`,
  // letting an attacker bypass replay or revocation caches keyed by token text by appending `.`.
  it("rejects a token with a trailing dot and empty footer segment", () => {
    const key = randomBytes(32);
    const token = encryptV4Local(encoder.encode("payload"), key);
    expect(() => decryptV4Local(`${token}.`, key)).toThrow(InvalidTokenError);
  });

  it("rejects mismatch: footer expected, token has none", () => {
    const key = randomBytes(32);
    const token = encryptV4Local(encoder.encode("p"), key);
    expect(() => decryptV4Local(token, key, encoder.encode("kid"))).toThrow(InvalidTokenError);
  });

  it("rejects mismatch: footer absent expected, token has one", () => {
    const key = randomBytes(32);
    const token = encryptV4Local(encoder.encode("p"), key, encoder.encode("kid"));
    expect(() => decryptV4Local(token, key, undefined)).toThrow(InvalidTokenError);
    expect(() => decryptV4Local(token, key, empty)).toThrow(InvalidTokenError);
  });
});
