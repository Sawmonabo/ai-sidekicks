import { describe, expect, it } from "vitest";
import { generateV4PublicKeyPair, signV4Public, verifyV4Public } from "../v4-public.js";
import { InvalidTokenError } from "../errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const empty = new Uint8Array(0);

describe("v4.public sign / verify", () => {
  it("round-trips a payload sign→verify", () => {
    const { publicKey, secretKey } = generateV4PublicKeyPair();
    const payload = encoder.encode("hello, paseto");

    const token = signV4Public(payload, secretKey);
    expect(token.startsWith("v4.public.")).toBe(true);

    const verified = verifyV4Public(token, publicKey);
    expect(decoder.decode(verified)).toBe("hello, paseto");
  });

  it("throws InvalidTokenError on a tampered signature", () => {
    const { publicKey, secretKey } = generateV4PublicKeyPair();
    const payload = encoder.encode("payload");
    const token = signV4Public(payload, secretKey);

    // Flip a byte of the signature; a character flip at the last base64url position can land on
    // padding bits and change nothing.
    const head = token.slice(0, "v4.public.".length);
    const body = token.slice("v4.public.".length);
    const bodyBytes = new Uint8Array(Buffer.from(body, "base64url"));
    bodyBytes[bodyBytes.length - 1]! ^= 0x01;
    const tampered = head + Buffer.from(bodyBytes).toString("base64url");

    expect(() => verifyV4Public(tampered, publicKey)).toThrow(InvalidTokenError);
  });

  it("throws InvalidTokenError when expected footer is absent from token", () => {
    const { publicKey, secretKey } = generateV4PublicKeyPair();
    const payload = encoder.encode("payload");
    const expectedFooter = encoder.encode("kid:k_1");
    const token = signV4Public(payload, secretKey);
    expect(() => verifyV4Public(token, publicKey, expectedFooter)).toThrow(InvalidTokenError);
  });

  it("throws InvalidTokenError when expected footer mismatches token footer", () => {
    const { publicKey, secretKey } = generateV4PublicKeyPair();
    const payload = encoder.encode("payload");
    const token = signV4Public(payload, secretKey, encoder.encode("kid:k_1"));
    expect(() => verifyV4Public(token, publicKey, encoder.encode("kid:k_2"))).toThrow(
      InvalidTokenError,
    );
  });

  // Non-canonical base64url (padding, invalid characters) must be rejected even when Node's
  // lenient decoder yields bytes that pass the signature check.
  it("rejects a token whose body base64url carries `=` padding", () => {
    const { publicKey, secretKey } = generateV4PublicKeyPair();
    const token = signV4Public(encoder.encode("payload"), secretKey);
    expect(() => verifyV4Public(`${token}=`, publicKey)).toThrow(InvalidTokenError);
  });

  // `header.payload.` (trailing dot, empty footer) would otherwise verify like `header.payload`,
  // letting an attacker bypass replay or revocation caches keyed by token text by appending `.`.
  it("rejects a token with a trailing dot and empty footer segment", () => {
    const { publicKey, secretKey } = generateV4PublicKeyPair();
    const token = signV4Public(encoder.encode("payload"), secretKey);
    expect(() => verifyV4Public(`${token}.`, publicKey)).toThrow(InvalidTokenError);
  });

  it("signing with `undefined` footer matches signing with empty Uint8Array footer", () => {
    const { secretKey } = generateV4PublicKeyPair();
    const payload = encoder.encode("payload");

    const tokenUndef = signV4Public(payload, secretKey, undefined);
    const tokenEmpty = signV4Public(payload, secretKey, empty);

    // Ed25519 is deterministic — undefined and empty must produce the same token.
    expect(tokenUndef).toBe(tokenEmpty);
    // Neither should have a footer segment.
    expect(tokenUndef.split(".").length).toBe(3);
  });
});
