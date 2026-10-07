// The refusal shape must be recognizable from outside the module that built it, because a
// refusal crossing a layer arrives as an `unknown` result or a caught error.

import { describe, expect, it } from "vitest";
import { isRefusal, refuse } from "./contract.js";

describe("isRefusal — recognition across a layer boundary", () => {
  it("accepts what refuse built", () => {
    expect(isRefusal(refuse("persistence", "quota-exhausted", "detail"))).toBe(true);
  });

  it("rejects the values a constant-true guard would accept", () => {
    // Without these, a guard whose body was `return true` would pass every positive case.
    expect(isRefusal(null)).toBe(false);
    expect(isRefusal(undefined)).toBe(false);
    expect(isRefusal("sessions: session.not_found: detail")).toBe(false);
    expect(isRefusal(42)).toBe(false);
    expect(isRefusal({})).toBe(false);
    expect(isRefusal([])).toBe(false);
  });

  it("rejects a partial refusal rather than rendering a card with a blank author", () => {
    expect(isRefusal({ code: "c", detail: "d" })).toBe(false);
    expect(isRefusal({ code: "c", origin: "o" })).toBe(false);
    expect(isRefusal({ detail: "d", origin: "o" })).toBe(false);
  });

  it("rejects a refusal whose fields are the right names and the wrong types", () => {
    // Renderers read `code` as words and draw `detail` as text: a number has no words and an
    // object would show as "[object Object]".
    expect(isRefusal({ code: 7, detail: "d", origin: "o" })).toBe(false);
    expect(isRefusal({ code: "c", detail: { text: "d" }, origin: "o" })).toBe(false);
    expect(isRefusal({ code: "c", detail: "d", origin: null })).toBe(false);
  });
});

describe("isRefusal — total, because every caller is already on a failure path", () => {
  /** An unguarded read, so the counterfactual is runnable. */
  const readDirectly = (value: unknown): unknown => (value as { readonly code?: unknown }).code;

  it("answers false for a value whose property access throws", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("this getter is hostile");
        },
      },
    );
    // Negative control: a direct read of this value throws. A throwing predicate escapes the
    // `catch` that called it and unmounts the component reporting the failure.
    expect(() => readDirectly(hostile)).toThrow();
    expect(isRefusal(hostile)).toBe(false);
  });
});
