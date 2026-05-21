import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decryptV4Local } from "../v4-local.js";
import { encryptV4LocalDeterministic } from "../internal/v4-local-deterministic.js";
import { InvalidTokenError } from "../errors.js";

interface PasetoV4Vector {
  name: string;
  "expect-fail": boolean;
  key?: string;
  nonce?: string;
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

describe("PASETO v4.local RFC vector conformance (4-E-*)", () => {
  const localVectors = FILE.tests.filter((t) => t.name.startsWith("4-E-"));

  it("filter covers at least one positive vector", () => {
    expect(localVectors.length).toBeGreaterThan(0);
    expect(localVectors.some((v) => !v["expect-fail"])).toBe(true);
  });

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

      it(`${v.name} (positive) — deterministic encrypt reproduces vector token byte-exact`, () => {
        const key = hex(v.key!);
        const nonce = hex(v.nonce!);
        const footer = utf8(v.footer);
        const ia = utf8(v["implicit-assertion"]);
        const produced = encryptV4LocalDeterministic(utf8(v.payload!), key, nonce, footer, ia);
        expect(produced).toBe(v.token);
      });
    }
  }

  it(`processed ${localVectors.length} vectors`, () => {
    expect(localVectors.length).toBeGreaterThan(0);
  });
});
