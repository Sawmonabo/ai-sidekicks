import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { jsonUtf8ByteLength } from "../jsonrpc/byte-length.js";
import { SCHEMA_FORMATS, wireByteLength } from "../schema-check.js";

describe("wireByteLength", () => {
  it("counts every attachment a nested placeholder names beside the JSON", () => {
    const value = { entries: [{ audio: { $bytes: 0 } }, { image: { $bytes: 1 } }] };
    expect(wireByteLength(value, [new Uint8Array(10), new Uint8Array(7)])).toBe(
      jsonUtf8ByteLength(value) + 17,
    );
  });

  it("measures infinite where a placeholder names no attachment", () => {
    expect(wireByteLength({ audio: { $bytes: 1 } }, [new Uint8Array(10)])).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(wireByteLength({ audio: { $bytes: 0 } }, undefined)).toBe(Number.POSITIVE_INFINITY);
  });
});

// The web-address case table the Rust checks read too, so the two sides cannot drift.
interface WebAddressCaseTable {
  readonly faults: readonly { readonly address: string; readonly fault: string | null }[];
  readonly texts: readonly {
    readonly name: string;
    readonly text: string;
    readonly web: string | null;
    readonly https: string | null;
  }[];
}

const webAddressCases = JSON.parse(
  readFileSync(
    new URL(
      "../../../../crates/sidekicks-contracts/tests/fixtures/web-address.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as WebAddressCaseTable;

describe("SCHEMA_FORMATS", () => {
  // Each format is the parse half of its schema; a `pattern` beside it holds the rest (the
  // `http` start of a web address, the NUL an https: address may not carry).
  it("takes a web address only when it parses with an http: or https: scheme", () => {
    const isWebAddress = SCHEMA_FORMATS["web-url"];
    for (const { address, fault } of webAddressCases.faults) {
      expect(isWebAddress(address), address).toBe(fault === null);
    }
    for (const { name, text } of webAddressCases.texts.filter(({ web }) => web !== null)) {
      expect(isWebAddress(text), name).toBe(true);
    }
  });

  it("takes an https: address exactly where the Rust address type keeps one", () => {
    for (const { name, text, https } of webAddressCases.texts.filter(
      ({ text }) => !text.includes("\0"),
    )) {
      expect(SCHEMA_FORMATS["https-url"](text), name).toBe(https !== null);
    }
  });

  it("holds a number to its Rust integer type's range", () => {
    expect(SCHEMA_FORMATS.uint32.validate(0xffff_ffff)).toBe(true);
    expect(SCHEMA_FORMATS.uint32.validate(0x1_0000_0000)).toBe(false);
    expect(SCHEMA_FORMATS.uint32.validate(-1)).toBe(false);
    expect(SCHEMA_FORMATS.uint32.validate(1.5)).toBe(false);
    expect(SCHEMA_FORMATS.int64.validate(-(2 ** 63))).toBe(true);
    expect(SCHEMA_FORMATS.int64.validate(2 ** 64)).toBe(false);
    expect(SCHEMA_FORMATS.int64.validate(-(2 ** 64))).toBe(false);
  });
});
