import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "./case-table.test-support.js";
import { jsonUtf8ByteLength } from "../jsonrpc/byte-length.js";
import { SCHEMA_FORMATS, ucs2length, wireByteLength } from "../schema-check.js";
import { WEB_ADDRESS_FAULTS, webAddressFault } from "../web-address.js";

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

// The web-address case table the Rust checks read too, so the two sides cannot drift. Parsed, not
// cast, so a fault outside the closed set fails here as it fails the Rust suite.
const webAddressText = z
  .object({
    name: z.string(),
    text: z.string(),
    web: z.string().nullable(),
    https: z.string().nullable(),
  })
  .strict();

const webAddressCases = readCaseTable(
  z
    .object({
      faults: z.array(
        z.object({ address: z.string(), fault: z.enum(WEB_ADDRESS_FAULTS).nullable() }).strict(),
      ),
      texts: z.array(webAddressText),
      httpsCap: z.int().positive(),
      capped: z.array(webAddressText.omit({ web: true })),
    })
    .strict(),
  "web-address.json",
);

describe("SCHEMA_FORMATS", () => {
  // Each format is the parse half of its schema; a `pattern` beside it holds the rest (the
  // `http` start of a web address, the NUL an https: address may not carry), and `maxLength`
  // the cap, counted in code points.
  it.each(webAddressCases.faults)(
    "judges $address as a web address exactly when it draws no fault",
    ({ address, fault }) => {
      expect(webAddressFault(new URL(address))).toBe(fault);
      expect(SCHEMA_FORMATS["web-url"](address)).toBe(fault === null);
    },
  );

  it("takes every text the Rust web address type keeps", () => {
    for (const { name, text } of webAddressCases.texts.filter(({ web }) => web !== null)) {
      expect(SCHEMA_FORMATS["web-url"](text), name).toBe(true);
    }
  });

  it("takes an https: address exactly where the Rust address type keeps one", () => {
    for (const { name, text, https } of webAddressCases.texts.filter(
      ({ text }) => !text.includes("\0"),
    )) {
      expect(SCHEMA_FORMATS["https-url"](text), name).toBe(https !== null);
    }
  });

  it.each(webAddressCases.capped)(
    "takes $name as an https: address under the cap exactly where the Rust type keeps it",
    ({ text, https }) => {
      expect(
        SCHEMA_FORMATS["https-url"](text) && ucs2length(text) <= webAddressCases.httpsCap,
      ).toBe(https !== null);
    },
  );

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
