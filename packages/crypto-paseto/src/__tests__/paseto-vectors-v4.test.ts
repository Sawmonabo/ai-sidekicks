// PASETO v4 conformance against the upstream vectors vendored in `../__fixtures__/v4.json`
// (see `../__fixtures__/PROVENANCE.md`): 4-E-* for v4.local, 4-S-* for v4.public, 4-F-* for the
// failures.
//
// Every failure asserts the base InvalidTokenError, not the MacMismatchError subclass, on purpose:
// 4-F-4 is rejected at the base64url canonical-form check before the MAC step, so a stricter
// assertion would fail a correct rejection. MAC-mismatch coverage lives in v4-local.test.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decryptV4Local } from "../v4-local.js";
import { encryptV4LocalDeterministic } from "../internal/v4-local-deterministic.js";
import { signV4Public, verifyV4Public } from "../v4-public.js";
import { InvalidTokenError } from "../errors.js";

interface PasetoV4Vector {
  name: string;
  "expect-fail": boolean;
  key?: string;
  nonce?: string;
  "public-key"?: string;
  "secret-key"?: string;
  "secret-key-seed"?: string;
  token: string;
  payload: string | null;
  footer: string;
  "implicit-assertion": string;
}

interface VectorFile {
  tests: PasetoV4Vector[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "../__fixtures__/v4.json");
const FILE: VectorFile = JSON.parse(readFileSync(FIXTURE, "utf8"));

function hex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error(`odd-length hex: ${s}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

// Some vectors record secret-key as 64 bytes (Ed25519 seed||public); noble takes the 32-byte seed.
function seedFromVector(v: PasetoV4Vector): Uint8Array {
  if (v["secret-key-seed"]) return hex(v["secret-key-seed"]);
  if (v["secret-key"]) {
    const raw = hex(v["secret-key"]);
    return raw.length === 64 ? raw.subarray(0, 32) : raw;
  }
  throw new Error(`vector ${v.name} missing secret-key / secret-key-seed`);
}

describe("PASETO v4.local vector conformance (4-E-*)", () => {
  const localVectors = FILE.tests.filter((t) => t.name.startsWith("4-E-"));

  for (const v of localVectors) {
    if (v["expect-fail"]) {
      it(`${v.name} (negative) — decrypt throws InvalidTokenError`, () => {
        const key = hex(v.key!);
        const footer = utf8(v.footer);
        const ia = utf8(v["implicit-assertion"]);
        expect(() => decryptV4Local(v.token, key, footer, ia)).toThrow(InvalidTokenError);
      });
    } else {
      it(`${v.name} (positive) — decrypt returns expected payload`, () => {
        const key = hex(v.key!);
        const footer = utf8(v.footer);
        const ia = utf8(v["implicit-assertion"]);
        const recovered = decryptV4Local(v.token, key, footer, ia);
        expect(utf8Decode(recovered)).toBe(v.payload);
      });

      it(
        `${v.name} (positive) — deterministic encrypt reproduces ` + `vector token byte-exact`,
        () => {
          const key = hex(v.key!);
          const nonce = hex(v.nonce!);
          const footer = utf8(v.footer);
          const ia = utf8(v["implicit-assertion"]);
          const produced = encryptV4LocalDeterministic(utf8(v.payload!), key, nonce, footer, ia);
          expect(produced).toBe(v.token);
        },
      );
    }
  }
});

describe("PASETO v4.public vector conformance (4-S-*)", () => {
  const publicVectors = FILE.tests.filter((t) => t.name.startsWith("4-S-"));

  for (const v of publicVectors) {
    if (v["expect-fail"]) {
      it(`${v.name} (negative) — verify throws InvalidTokenError`, () => {
        const pub = hex(v["public-key"]!);
        const footer = utf8(v.footer);
        const ia = utf8(v["implicit-assertion"]);
        expect(() => verifyV4Public(v.token, pub, footer, ia)).toThrow(InvalidTokenError);
      });
    } else {
      it(`${v.name} (positive) — verify returns expected payload`, () => {
        const pub = hex(v["public-key"]!);
        const footer = utf8(v.footer);
        const ia = utf8(v["implicit-assertion"]);
        const recovered = verifyV4Public(v.token, pub, footer, ia);
        expect(utf8Decode(recovered)).toBe(v.payload);
      });

      it(`${v.name} (positive) — sign round-trip reproduces vector token byte-exact`, () => {
        const seed = seedFromVector(v);
        const footer = utf8(v.footer);
        const ia = utf8(v["implicit-assertion"]);
        const produced = signV4Public(utf8(v.payload!), seed, footer, ia);
        expect(produced).toBe(v.token);
      });
    }
  }
});

describe("PASETO v4 failure-vector conformance (4-F-*)", () => {
  const failVectors = FILE.tests.filter((t) => t.name.startsWith("4-F-"));

  for (const v of failVectors) {
    it(`${v.name} (negative) — decode throws InvalidTokenError`, () => {
      const footer = utf8(v.footer);
      const ia = utf8(v["implicit-assertion"]);
      // 4-F-* are cross-purpose vectors: each ships the key for the wrong operation, e.g. 4-F-1
      // ships a public-key for a v4.local token, so verify must reject it. Binding the bytes to a
      // const here avoids a non-null assertion inside the deferred expect() closure.
      if (v.key) {
        const key = hex(v.key);
        expect(() => decryptV4Local(v.token, key, footer, ia)).toThrow(InvalidTokenError);
      } else if (v["public-key"]) {
        const publicKey = hex(v["public-key"]);
        expect(() => verifyV4Public(v.token, publicKey, footer, ia)).toThrow(InvalidTokenError);
      } else {
        throw new Error(`vector ${v.name} has neither key nor public-key`);
      }
    });
  }
});
