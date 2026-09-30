// Strict RFC 8032 Ed25519 verification on the v4.public path.
//
// `@noble/curves` defaults its ed25519 wrapper to `zip215: true`, which skips the small-order
// public-key rejection. Against a small-order key the `[8][k]A` term drops out of the cofactored
// verification equation, so a single `(R, S)` pair verifies for every message: a universal forgery
// on the path that authenticates v4.public tokens. `verifyV4Public` therefore pins
// `{ zip215: false }`, and this file is the guard that keeps it pinned.
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

// y = 1, x = 0: the identity point, canonically encoded and order 1. Strict RFC 8032 refuses this
// small-order key class and ZIP-215 admits it.
function smallOrderPublicKey(): Uint8Array {
  const publicKey = new Uint8Array(32);
  publicKey[0] = 1;
  return publicKey;
}

// R = the identity encoding, S = 0: derived from no message or secret key.
function smallOrderSignature(): Uint8Array {
  const signature = new Uint8Array(SIGNATURE_LENGTH);
  signature[0] = 1;
  return signature;
}

// `verifyV4Public` runs four gates (header, segment count, footer, strict base64url) before the
// signature check. Canonical unpadded base64url keeps them all satisfied, so a rejection can only
// come from the signature check.
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

    // This bare noble call is the negative control, not a duplicate of the assertion below. It
    // runs on the exact triple `verifyV4Public` checks and proves the forgery is accepted at the
    // library default. Without it the rejection below is unattributable: a garbage-token test stays
    // green with the `{ zip215: false }` fix reverted, because an earlier parse gate throws anyway.
    // If it ever fails, noble has made strict the default; the explicit option must still stay.
    expect(ed25519.verify(signature, preAuthenticationEncoding, publicKey)).toBe(true);

    expect(() => verifyV4Public(token, publicKey)).toThrow(InvalidTokenError);
    // The message proves the signature check rejected it, not parsing.
    expect(() => verifyV4Public(token, publicKey)).toThrow(/signature verification failed/);
  });
});
