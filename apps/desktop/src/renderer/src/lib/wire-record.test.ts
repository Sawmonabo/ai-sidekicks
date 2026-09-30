// The record rule over every carrier the wire can present: `null` and arrays are not records (the
// clauses a hand-written `typeof value === "object"` loses).

import { describe, expect, it } from "vitest";

import { isWireRecord } from "./wire-record.js";

describe("reading a wire-supplied value as a record", () => {
  it("accepts a value with keys, however it was built", () => {
    expect(isWireRecord({})).toBe(true);
    expect(isWireRecord({ items: [] })).toBe(true);
    // A value from a structured clone or another realm has no prototype chain but keeps its keys.
    expect(isWireRecord(Object.create(null))).toBe(true);
  });

  it("refuses an array, which is the clause a hand-written check keeps losing", () => {
    // Callers enumerate keys or index by name next, and an array answers with its own indices.
    expect(isWireRecord([])).toBe(false);
    expect(isWireRecord([{ id: "queue-1" }])).toBe(false);
  });

  it("refuses every non-record the wire can carry", () => {
    // Without these, `value !== undefined` would satisfy the accepting case above.
    for (const value of [null, undefined, 0, 1, "", "run-1", true, false, Symbol("run")]) {
      expect(isWireRecord(value)).toBe(false);
    }
  });
});
