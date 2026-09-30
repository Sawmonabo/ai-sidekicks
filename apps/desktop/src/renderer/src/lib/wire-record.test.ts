// The record rule over every carrier the wire can present: `null` and arrays are not records (the
// clauses a hand-written `typeof value === "object"` loses), and the predicate decides without
// reading a key, so a value whose every property access throws is answered, not propagated.

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

  it("negative control: every non-record the wire can carry is refused", () => {
    // Without these, `value !== undefined` would satisfy the accepting case above.
    for (const value of [null, undefined, 0, 1, "", "run-1", true, false, Symbol("run")]) {
      expect(isWireRecord(value)).toBe(false);
    }
  });

  it("refuses a function, which is a property container and is not a body", () => {
    // Unlike `isRefusal`, which admits a function carrying its members because it recognizes a
    // thrown value, this decides whether a payload is a body, and no wire delivers a function.
    expect(isWireRecord(() => "run-1")).toBe(false);
    expect(isWireRecord(function named(): void {})).toBe(false);
  });

  it("answers without reading a property, so a hostile carrier does not escape it", () => {
    let readCount = 0;
    const hostile = new Proxy(
      {},
      {
        get() {
          readCount += 1;
          throw new Error("this getter is hostile");
        },
      },
    );

    // Negative control for totality: reading any key off this value throws.
    expect(() => (hostile as { readonly items?: unknown }).items).toThrow();

    readCount = 0;
    expect(isWireRecord(hostile)).toBe(true);
    // The predicate reached its verdict without touching a key; a clause that read one would move
    // this count off zero.
    expect(readCount).toBe(0);
  });
});
