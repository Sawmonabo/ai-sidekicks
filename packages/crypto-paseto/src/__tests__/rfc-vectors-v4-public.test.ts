import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { signV4Public, verifyV4Public } from "../v4-public.js";
import { InvalidTokenError } from "../errors.js";

interface PasetoV4Vector {
  name: string;
  "expect-fail": boolean;
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

function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

// Some vectors record secret-key as 64 bytes (Ed25519 seed||public). Noble 2.x
// accepts the 32-byte seed; we slice the seed if a 64-byte secret-key is given.
function seedFromVector(v: PasetoV4Vector): Uint8Array {
  if (v["secret-key-seed"]) return hex(v["secret-key-seed"]);
  if (v["secret-key"]) {
    const raw = hex(v["secret-key"]);
    return raw.length === 64 ? raw.subarray(0, 32) : raw;
  }
  throw new Error(`vector ${v.name} missing secret-key / secret-key-seed`);
}

describe("PASETO v4.public RFC vector conformance (4-S-*)", () => {
  const publicVectors = FILE.tests.filter((t) => t.name.startsWith("4-S-"));

  it("filter selects at least one positive vector", () => {
    expect(publicVectors.length).toBeGreaterThan(0);
    expect(publicVectors.some((v) => !v["expect-fail"])).toBe(true);
  });

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

  it(`processed ${publicVectors.length} vectors`, () => {
    expect(publicVectors.length).toBeGreaterThan(0);
  });
});
