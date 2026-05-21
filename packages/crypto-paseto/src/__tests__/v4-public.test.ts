import { describe, expect, it } from "vitest";
import { generateV4PublicKeyPair, signV4Public, verifyV4Public } from "../v4-public.js";
import { InvalidTokenError } from "../errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("v4.public sign / verify", () => {
  it("round-trips a payload sign→verify", () => {
    const { publicKey, secretKey } = generateV4PublicKeyPair();
    const payload = encoder.encode("hello, paseto");

    const token = signV4Public(payload, secretKey);
    expect(token.startsWith("v4.public.")).toBe(true);

    const verified = verifyV4Public(token, publicKey);
    expect(decoder.decode(verified)).toBe("hello, paseto");
  });

  it("round-trips with a footer", () => {
    const { publicKey, secretKey } = generateV4PublicKeyPair();
    const payload = encoder.encode("payload");
    const footer = encoder.encode("kid:k_2026_05");

    const token = signV4Public(payload, secretKey, footer);
    // Footer present → token has a 4th dot-segment.
    expect(token.split(".").length).toBe(4);

    const verified = verifyV4Public(token, publicKey, footer);
    expect(decoder.decode(verified)).toBe("payload");
  });

  it("round-trips with an implicit assertion (footer absent)", () => {
    const { publicKey, secretKey } = generateV4PublicKeyPair();
    const payload = encoder.encode("payload");
    const ia = encoder.encode("session:abc123");

    const token = signV4Public(payload, secretKey, undefined, ia);
    const verified = verifyV4Public(token, publicKey, undefined, ia);
    expect(decoder.decode(verified)).toBe("payload");
  });

  it("throws InvalidTokenError on a tampered signature", () => {
    const { publicKey, secretKey } = generateV4PublicKeyPair();
    const payload = encoder.encode("payload");
    const token = signV4Public(payload, secretKey);

    // Flip a byte in the decoded signature region (after "v4.public.").
    // A char-domain flip at the last base64url position can land on padding
    // bits and be a no-op on the decoded bytes; byte-domain flip is
    // deterministic.
    const head = token.slice(0, "v4.public.".length);
    const body = token.slice("v4.public.".length);
    const bodyBytes = new Uint8Array(Buffer.from(body, "base64url"));
    bodyBytes[bodyBytes.length - 1]! ^= 0x01;
    const tampered = head + Buffer.from(bodyBytes).toString("base64url");

    expect(() => verifyV4Public(tampered, publicKey)).toThrow(InvalidTokenError);
  });

  it("throws InvalidTokenError when verifying with the wrong public key", () => {
    const { secretKey } = generateV4PublicKeyPair();
    const { publicKey: otherPublic } = generateV4PublicKeyPair();
    const token = signV4Public(encoder.encode("payload"), secretKey);

    expect(() => verifyV4Public(token, otherPublic)).toThrow(InvalidTokenError);
  });

  it("rejects a token that does not start with v4.public.", () => {
    const { publicKey } = generateV4PublicKeyPair();
    expect(() => verifyV4Public("v4.local.AAAA", publicKey)).toThrow(InvalidTokenError);
    expect(() => verifyV4Public("v2.public.AAAA", publicKey)).toThrow(InvalidTokenError);
  });

  it("throws InvalidTokenError when expected footer is absent from token", () => {
    const { publicKey, secretKey } = generateV4PublicKeyPair();
    const payload = encoder.encode("payload");
    const expectedFooter = encoder.encode("kid:k_1");
    // Sign without a footer; verify expects one.
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

  // Strict base64url canonicalization: non-canonical textual forms (padding,
  // invalid chars) must be rejected even when Node's lenient decoder would
  // otherwise produce bytes that pass the signature check. See v4-public.ts
  // §base64UrlDecode for rationale (exact-string controls integrity).
  it("rejects a token whose body base64url carries `=` padding", () => {
    const { publicKey, secretKey } = generateV4PublicKeyPair();
    const token = signV4Public(encoder.encode("payload"), secretKey);
    // PASETO requires unpadded base64url; Node tolerates trailing `=`.
    expect(() => verifyV4Public(`${token}=`, publicKey)).toThrow(InvalidTokenError);
  });

  it("rejects a token whose footer base64url carries `=` padding", () => {
    const { publicKey, secretKey } = generateV4PublicKeyPair();
    const footer = encoder.encode("kid:k_1");
    const token = signV4Public(encoder.encode("payload"), secretKey, footer);
    // token shape: "v4.public.<body>.<footer>" → append `=` to footer.
    expect(() => verifyV4Public(`${token}=`, publicKey, footer)).toThrow(InvalidTokenError);
  });

  it("rejects a token whose body contains a non-base64url character", () => {
    const { publicKey, secretKey } = generateV4PublicKeyPair();
    const token = signV4Public(encoder.encode("payload"), secretKey);
    const head = token.slice(0, "v4.public.".length);
    const body = token.slice("v4.public.".length);
    // Replace the first body char with `$` (outside the base64url alphabet).
    const tampered = `${head}$${body.slice(1)}`;
    expect(() => verifyV4Public(tampered, publicKey)).toThrow(InvalidTokenError);
  });
});
