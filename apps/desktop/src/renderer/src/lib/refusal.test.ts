// The refusal shape must be recognizable from outside the module that built it, because a
// refusal crossing a layer arrives as an `unknown` result or a caught error: the guard, the
// error message, and the refusal an error still holds after the throw.

import { describe, expect, expectTypeOf, it } from "vitest";
import { RefusalError, isRefusal, refuse, type Refusal, type NarrowedRefusal } from "./refusal.js";

describe("refuse — one builder, one field order", () => {
  it("carries the three fields the renderers read", () => {
    const refusal = refuse("persistence", "value-too-large", "The layout snapshot is too big.");
    expect(refusal).toStrictEqual({
      code: "value-too-large",
      detail: "The layout snapshot is too big.",
      origin: "persistence",
    });
  });

  it("names the origin from the argument rather than defaulting one", () => {
    // A builder that filled in a default would make every refusal claim the same author.
    expect(refuse("keybindings", "unparseable", "detail").origin).toBe("keybindings");
    expect(refuse("keybindings", "unparseable", "detail").origin).toBe("keybindings");
  });
});

describe("refuse — the producer's own union survives the call", () => {
  // The builder carries the producer's union, carries the right one, and leaves a plain `string`
  // caller unchanged. Codes come in as parameters, not local constants: assignment narrowing
  // would collapse `const code: "a" | "b" = "a"` to `"a"` and prove nothing about the union.

  /** A producer with a two-member vocabulary; no return annotation, as inference is the subject. */
  function refuseEither(code: "a" | "b") {
    return refuse("producer", code, "detail");
  }

  /** A caller with no vocabulary of its own. */
  function refuseAnything(code: string) {
    return refuse("producer", code, "detail");
  }

  it("gives back the union it was handed, not `string`", () => {
    // Against a non-generic `refuse`, `code` here is `string` and `toEqualTypeOf` reports it.
    expectTypeOf(refuseEither("a").code).toEqualTypeOf<"a" | "b">();
    expectTypeOf(refuseEither("a")).toEqualTypeOf<NarrowedRefusal<"a" | "b">>();
  });

  it("negative control: a refusal typed to one member refuses another member's value", () => {
    // Without this, the case above would pass against a builder that answered `any` on `code`,
    // which narrows nothing.
    // @ts-expect-error TS2322: `"b"` is not assignable to the `"a"` this target holds.
    const mismatched: NarrowedRefusal<"a"> = refuse("producer", "b", "detail");
    // Read it, so the directive suppresses an assignment that really happens.
    expect(mismatched.code).toBe("b");
  });

  it("leaves a caller that has no union where it was", () => {
    // `Code` infers as `string` for a plain caller, and `NarrowedRefusal<string>` reads as
    // `Refusal`.
    const wide: Refusal = refuseAnything("whatever-the-seam-said");
    expectTypeOf(refuseAnything("x").code).toEqualTypeOf<string>();
    expect(wide.code).toBe("whatever-the-seam-said");
  });
});

describe("RefusalError — a refusal that had to travel as an exception", () => {
  const refusal = refuse("sessions", "session.not_found", "No session answers to this id.");

  it("is an Error, so a boundary that catches Errors catches it", () => {
    expect(new RefusalError(refusal)).toBeInstanceOf(Error);
  });

  it("keeps the refusal intact for the catch site to render", () => {
    const error = new RefusalError(refusal);
    expect(error.refusal).toStrictEqual(refusal);
    expect(isRefusal(error.refusal)).toBe(true);
  });

  it("puts origin, code, and detail in the message, in that order", () => {
    // A stack trace is where an unrendered error is read, so the message carries all three facts.
    expect(new RefusalError(refusal).message).toBe(
      "sessions: session.not_found: No session answers to this id.",
    );
  });

  it("names itself, so a test asserts on the class rather than on message text", () => {
    expect(new RefusalError(refusal).name).toBe("RefusalError");
  });

  it("passes a cause through to the platform error", () => {
    const underlying = new TypeError("indexedDB is not defined");
    expect(new RefusalError(refusal, { cause: underlying }).cause).toBe(underlying);
  });
});

describe("isRefusal — recognition across a layer boundary", () => {
  it("accepts what refuse built", () => {
    expect(isRefusal(refuse("persistence", "quota-exhausted", "detail"))).toBe(true);
  });

  it("accepts a structurally identical literal, because the shape is the contract", () => {
    // A producer that widens its own union into this shape without calling `refuse` still
    // yields a refusal.
    expect(isRefusal({ code: "c", detail: "d", origin: "o" })).toBe(true);
  });

  it("negative control: rejects the values a constant-true guard would accept", () => {
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
    // Renderers put `code` in mono verbatim; a number would render and an object would show as
    // "[object Object]".
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

  it("answers false when only one of the three members is unreadable", () => {
    // Two members read fine and the third throws, so a guard must not stop after the first two.
    const partiallyHostile = {
      code: "c",
      detail: "d",
      get origin(): never {
        throw new Error("this getter is hostile");
      },
    };
    expect(() => partiallyHostile.origin).toThrow();
    expect(isRefusal(partiallyHostile)).toBe(false);
  });

  it("answers false for a null-prototype object carrying nothing", () => {
    expect(isRefusal(Object.create(null))).toBe(false);
  });

  it("accepts a null-prototype carrier, object or function, that holds the three members", () => {
    // A refusal that crossed a structured clone or another realm has no prototype chain and is
    // still a refusal; a function is a property container too.
    const nullPrototypeObject = Object.assign(Object.create(null) as object, {
      code: "c",
      detail: "d",
      origin: "o",
    });
    expect(isRefusal(nullPrototypeObject)).toBe(true);

    const carrierFunction = Object.assign(function carrier(): void {}, {
      code: "c",
      detail: "d",
      origin: "o",
    });
    Object.setPrototypeOf(carrierFunction, null);
    expect(isRefusal(carrierFunction)).toBe(true);
  });
});
