import { describe, expect, it } from "vitest";
import { randomBytes } from "@noble/hashes/utils.js";
import { generateV4PublicKeyPair, signV4Public, verifyV4Public } from "../v4-public.js";
import { encryptV4Local, decryptV4Local } from "../v4-local.js";
import { InvalidTokenError } from "../errors.js";

const encoder = new TextEncoder();
const empty = new Uint8Array(0);

describe("footer / implicit-assertion canonicalization (undefined ≡ Uint8Array(0))", () => {
  describe("v4.public", () => {
    it("signing with `undefined` footer matches signing with empty Uint8Array footer", () => {
      // `publicKey` is destructured for symmetry with sibling tests / future-
      // proofing; the `_` prefix matches `eslint.config.mjs` `varsIgnorePattern`.
      const { publicKey: _publicKey, secretKey } = generateV4PublicKeyPair();
      const payload = encoder.encode("payload");

      const tokenUndef = signV4Public(payload, secretKey, undefined);
      const tokenEmpty = signV4Public(payload, secretKey, empty);

      // Ed25519 is deterministic — undefined and empty must produce the same token.
      expect(tokenUndef).toBe(tokenEmpty);
      // Neither should have a footer segment.
      expect(tokenUndef.split(".").length).toBe(3);
    });

    it("verify accepts either form for an unfooted token", () => {
      const { publicKey, secretKey } = generateV4PublicKeyPair();
      const token = signV4Public(encoder.encode("p"), secretKey);
      expect(() => verifyV4Public(token, publicKey, undefined)).not.toThrow();
      expect(() => verifyV4Public(token, publicKey, empty)).not.toThrow();
    });

    it("implicit assertion `undefined` and empty Uint8Array sign to the same token", () => {
      const { publicKey, secretKey } = generateV4PublicKeyPair();
      const payload = encoder.encode("payload");
      const t1 = signV4Public(payload, secretKey, undefined, undefined);
      const t2 = signV4Public(payload, secretKey, undefined, empty);
      expect(t1).toBe(t2);
      expect(() => verifyV4Public(t1, publicKey, undefined, empty)).not.toThrow();
    });

    it("rejects mismatch: footer expected, token has none", () => {
      const { publicKey, secretKey } = generateV4PublicKeyPair();
      const token = signV4Public(encoder.encode("p"), secretKey);
      expect(() => verifyV4Public(token, publicKey, encoder.encode("kid"))).toThrow(
        InvalidTokenError,
      );
    });

    it("rejects mismatch: footer absent expected, token has one", () => {
      const { publicKey, secretKey } = generateV4PublicKeyPair();
      const token = signV4Public(encoder.encode("p"), secretKey, encoder.encode("kid"));
      expect(() => verifyV4Public(token, publicKey, undefined)).toThrow(InvalidTokenError);
      expect(() => verifyV4Public(token, publicKey, empty)).toThrow(InvalidTokenError);
    });
  });

  describe("v4.local", () => {
    it("implicit assertion `undefined` and empty Uint8Array round-trip equivalently", () => {
      const key = randomBytes(32);
      const payload = encoder.encode("payload");
      const t1 = encryptV4Local(payload, key, undefined, undefined);
      // Same token can be decrypted with either undefined or empty IA.
      expect(() => decryptV4Local(t1, key, undefined, undefined)).not.toThrow();
      expect(() => decryptV4Local(t1, key, undefined, empty)).not.toThrow();
    });

    it("decrypt accepts either footer form for an unfooted token", () => {
      const key = randomBytes(32);
      const token = encryptV4Local(encoder.encode("p"), key);
      expect(() => decryptV4Local(token, key, undefined)).not.toThrow();
      expect(() => decryptV4Local(token, key, empty)).not.toThrow();
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
});
