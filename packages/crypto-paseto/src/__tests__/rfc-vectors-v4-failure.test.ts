// PASETO v4 failure-vector conformance (4-F-*). Vectors vendored from
// paseto-standard/test-vectors v4.json @ 32d7406591eb022f9eff88abb84106dd9d42c0f2
// (retrieved 2026-05-20); see __fixtures__/PROVENANCE.md.
//
// Asserts the BASE InvalidTokenError (not the MacMismatchError subclass) for every
// vector on purpose: 4-F-4 is rejected at the base64url canonical-form check BEFORE
// the MAC step, so tightening the assertion would make a correct rejection fail.
// MAC-mismatch coverage lives in v4-local.test.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decryptV4Local } from "../v4-local.js";
import { verifyV4Public } from "../v4-public.js";
import { InvalidTokenError } from "../errors.js";

interface PasetoV4Vector {
  name: string;
  "expect-fail": boolean;
  key?: string;
  "public-key"?: string;
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
const FIXTURE = resolve(__dirname, "__fixtures__/v4.json");
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

describe("PASETO v4 RFC failure-vector conformance (4-F-*)", () => {
  const failVectors = FILE.tests.filter((t) => t.name.startsWith("4-F-"));

  it("filter selects only expect-fail vectors and is non-empty", () => {
    expect(failVectors.length).toBeGreaterThan(0);
    expect(failVectors.every((v) => v["expect-fail"])).toBe(true);
  });

  for (const v of failVectors) {
    it(`${v.name} (negative) — decode throws InvalidTokenError`, () => {
      const footer = utf8(v.footer);
      const ia = utf8(v["implicit-assertion"]);
      // Dispatch on the key the vector provides: 4-F-* are cross-purpose vectors, so
      // each ships the key for the (wrong) operation it expects to be refused — e.g.
      // 4-F-1 ships a public-key for a v4.local token, so verify must reject it. The
      // if-guard narrows the optional to string for this synchronous binding; that
      // narrowing would not survive into the deferred expect() closure, so binding the
      // bytes to a const here avoids a non-null assertion at the call site.
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

  it(`processed ${failVectors.length} failure vectors`, () => {
    expect(failVectors.length).toBeGreaterThan(0);
  });
});
