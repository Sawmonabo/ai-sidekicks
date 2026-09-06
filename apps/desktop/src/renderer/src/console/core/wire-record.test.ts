// The record rule, driven over every carrier the wire can put in front of it.
//
// The module beside this holds the reasoning. What is left for a suite is the two
// clauses a hand-written `typeof value === "object"` keeps losing — that `null` is
// not a record and neither is an array — and the property the predicate has rather
// than merely documents: it decides without reading a key, so a value whose every
// property access throws is answered rather than propagated.

import { describe, expect, it } from "vitest";

import { isWireRecord } from "./wire-record.js";

describe("reading a wire-supplied value as a record", () => {
  it("accepts a value with keys, however it was built", () => {
    expect(isWireRecord({})).toBe(true);
    expect(isWireRecord({ items: [] })).toBe(true);
    // A value that crossed a structured clone or arrived from another realm has no
    // prototype chain left and still carries exactly the keys its producer put on it.
    expect(isWireRecord(Object.create(null))).toBe(true);
  });

  it("refuses an array, which is the clause a hand-written check keeps losing", () => {
    // Every caller enumerates keys or indexes by name next, and an array answers
    // both — with its own indices. Admitting one turns a list into a body whose
    // members are a length and some numbers.
    expect(isWireRecord([])).toBe(false);
    expect(isWireRecord([{ id: "queue-1" }])).toBe(false);
  });

  it("negative control: every non-record the wire can carry is refused", () => {
    // Without these, a predicate written as `value !== undefined` would satisfy the
    // accepting case above and hand a number or a string to a caller that has already
    // decided it is holding something with keys.
    for (const value of [null, undefined, 0, 1, "", "run-1", true, false, Symbol("run")]) {
      expect(isWireRecord(value)).toBe(false);
    }
  });

  it("refuses a function, which is a property container and is not a body", () => {
    // Deliberately different from `isConsoleRefusal`, which admits a null-prototype
    // FUNCTION carrying its three members: that guard is recognising a value some
    // producer threw, and this one is deciding whether an untyped payload is a body.
    // No wire delivers a function, so one arriving here is a fault rather than a row.
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

    // The negative control for the totality claim, and it is the whole reason this
    // case exists: reading ANY key off this value throws, in the guard that runs
    // before a caller has established anything about it.
    expect(() => (hostile as { readonly items?: unknown }).items).toThrow();

    readCount = 0;
    expect(isWireRecord(hostile)).toBe(true);
    // The predicate reached its verdict without touching a key. A clause added here
    // that READ one — a `value.constructor`, a `value["items"] !== undefined` — would
    // move this count off zero and throw on this value instead of answering about it.
    expect(readCount).toBe(0);
  });
});
