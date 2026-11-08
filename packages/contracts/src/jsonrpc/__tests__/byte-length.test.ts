// The message limit and every page budget measure a value by its JSON's UTF-8 bytes. The daemon
// measures by the same case table, so a reply one side fits the other never refuses for its size.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { jsonUtf8ByteLength } from "../byte-length.js";

// A row gives its value as JSON, or as `valueText`, JSON text whose number JavaScript reads in its
// own way (`1.0` as 1, a figure past 2^53 rounded).
const byteLengthCases = z
  .array(
    z.union([
      z.object({ note: z.string(), value: z.json(), bytes: z.int().nonnegative() }).strict(),
      z.object({ note: z.string(), valueText: z.string(), bytes: z.int().nonnegative() }).strict(),
    ]),
  )
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../../../../../crates/sidekicks-contracts/tests/fixtures/jsonrpc/byte-length.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );

describe("jsonUtf8ByteLength", () => {
  it.each(byteLengthCases)("measures $note", (byteLengthCase) => {
    const value =
      "value" in byteLengthCase ? byteLengthCase.value : JSON.parse(byteLengthCase.valueText);
    expect(jsonUtf8ByteLength(value)).toBe(byteLengthCase.bytes);
  });

  // A value JSON cannot hold measures as infinitely large, so a refinement reports an issue instead
  // of escaping `.parse()` as an exception.
  it("measures what cannot be serialized as infinite and never throws", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(jsonUtf8ByteLength(cyclic)).toBe(Number.POSITIVE_INFINITY);
    expect(jsonUtf8ByteLength(1n)).toBe(Number.POSITIVE_INFINITY);
  });
});
