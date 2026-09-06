// The refusal shape, driven rather than described.
//
// `ConsoleRefusal` exists so that five producers stop minting five vocabularies for
// three renderers, and the whole value of that is structural: the shape has to be
// recognisable from OUTSIDE the module that built it, because a refusal crossing a
// family boundary arrives as an `unknown` result or a caught error. So the cases
// below are about recognition and about what survives the trip — the guard, the
// message an error carries, and the refusal an error still holds after the throw.

import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ConsoleRefusalError,
  isConsoleRefusal,
  refuse,
  type ConsoleRefusal,
  type NarrowedRefusal,
} from "./refusal.js";

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
    // The whole point of `origin` is that a refusal surfacing three layers up still
    // names its author; a builder that filled in a default would make every refusal
    // claim the same one.
    expect(refuse("keybindings", "unparseable", "detail").origin).toBe("keybindings");
    expect(refuse("growth-port", "unparseable", "detail").origin).toBe("growth-port");
  });
});

describe("refuse — the producer's own union survives the call", () => {
  // The claim these three cases make together is what retired the spreads. Every
  // producer that owns a closed code union used to write
  // `{ ...refuse(origin, code, detail), code }`, whose only job was to put back the
  // narrowing a `string` parameter had widened away. These say the builder carries
  // it, that it carries the RIGHT one, and that a plain `string` caller is unmoved.
  //
  // Each case reads its code out of a PARAMETER rather than a local constant, which
  // is both the honest instrument and the real shape: assignment narrowing collapses
  // `const code: "a" | "b" = "a"` to `"a"` at every later use, so a case written that
  // way would infer one member and prove nothing about the union — and a producer's
  // constructor is a function taking its vocabulary as a parameter anyway, which is
  // the call these cases stand in for.

  /** A producer that owns a two-member vocabulary. No return annotation: inference is the subject. */
  function refuseEither(code: "a" | "b") {
    return refuse("producer", code, "detail");
  }

  /** A caller with no vocabulary at all — the many wide sites across the console. */
  function refuseAnything(code: string) {
    return refuse("producer", code, "detail");
  }

  it("gives back the union it was handed, not `string`", () => {
    // The fail-first case: against a non-generic `refuse`, `code` here is `string`
    // and `toEqualTypeOf` reports the mismatch. Nothing about it is a runtime claim
    // — the spread it replaces was invisible at runtime too, which is exactly why the
    // duplication it caused could survive as many copies as there were producers.
    expectTypeOf(refuseEither("a").code).toEqualTypeOf<"a" | "b">();
    expectTypeOf(refuseEither("a")).toEqualTypeOf<NarrowedRefusal<"a" | "b">>();
  });

  it("negative control: a refusal typed to one member refuses another member's value", () => {
    // Without this, the case above would pass against a builder that answered `any`
    // on `code` — which narrows nothing and would let every producer's vocabulary
    // through every producer's door. `NarrowedRefusal<"a">` is the target a producer
    // annotates, and a `"b"` refusal is not one.
    // @ts-expect-error TS2322: `"b"` is not assignable to the `"a"` this target holds.
    const mismatched: NarrowedRefusal<"a"> = refuse("producer", "b", "detail");
    // Read it, so the directive above suppresses an assignment that really happens
    // rather than one the compiler elided.
    expect(mismatched.code).toBe("b");
  });

  it("leaves a caller that has no union where it was", () => {
    // The other half of the compatibility claim: `Code` infers as `string` for a
    // caller holding one, `NarrowedRefusal<string>` reads as `ConsoleRefusal`, and
    // the many wide call sites across the console keep compiling untouched.
    const wide: ConsoleRefusal = refuseAnything("whatever-the-seam-said");
    expectTypeOf(refuseAnything("x").code).toEqualTypeOf<string>();
    expect(wide.code).toBe("whatever-the-seam-said");
  });
});

describe("ConsoleRefusalError — a refusal that had to travel as an exception", () => {
  const refusal = refuse("growth-port", "not-registered", "No wire serves this operation yet.");

  it("is an Error, so a boundary that catches Errors catches it", () => {
    expect(new ConsoleRefusalError(refusal)).toBeInstanceOf(Error);
  });

  it("keeps the refusal intact for the catch site to render", () => {
    const error = new ConsoleRefusalError(refusal);
    expect(error.refusal).toStrictEqual(refusal);
    expect(isConsoleRefusal(error.refusal)).toBe(true);
  });

  it("puts origin, code, and detail in the message, in that order", () => {
    // A stack trace is where an error is read when nothing rendered it, so the
    // message has to carry the same three facts the card would have shown.
    expect(new ConsoleRefusalError(refusal).message).toBe(
      "growth-port: not-registered: No wire serves this operation yet.",
    );
  });

  it("names itself, so a test asserts on the class rather than on message text", () => {
    expect(new ConsoleRefusalError(refusal).name).toBe("ConsoleRefusalError");
  });

  it("passes a cause through to the platform error", () => {
    const underlying = new TypeError("indexedDB is not defined");
    expect(new ConsoleRefusalError(refusal, { cause: underlying }).cause).toBe(underlying);
  });
});

describe("isConsoleRefusal — recognition across a family boundary", () => {
  it("accepts what refuse built", () => {
    expect(isConsoleRefusal(refuse("persistence", "quota-exhausted", "detail"))).toBe(true);
  });

  it("accepts a structurally identical literal, because the shape is the contract", () => {
    // Deliberate: a producer that widens its own closed union into this shape at its
    // boundary has not called `refuse`, and its result is still a refusal.
    expect(isConsoleRefusal({ code: "c", detail: "d", origin: "o" })).toBe(true);
  });

  it("negative control: rejects the values a constant-true guard would accept", () => {
    // Without these, a guard whose body was `return true` would pass every case
    // above and the two positive assertions would prove nothing.
    expect(isConsoleRefusal(null)).toBe(false);
    expect(isConsoleRefusal(undefined)).toBe(false);
    expect(isConsoleRefusal("growth-port: not-registered: detail")).toBe(false);
    expect(isConsoleRefusal(42)).toBe(false);
    expect(isConsoleRefusal({})).toBe(false);
    expect(isConsoleRefusal([])).toBe(false);
  });

  it("rejects a partial refusal rather than rendering a card with a blank author", () => {
    expect(isConsoleRefusal({ code: "c", detail: "d" })).toBe(false);
    expect(isConsoleRefusal({ code: "c", origin: "o" })).toBe(false);
    expect(isConsoleRefusal({ detail: "d", origin: "o" })).toBe(false);
  });

  it("rejects a refusal whose fields are the right names and the wrong types", () => {
    // The renderers put `code` in mono verbatim; a number there would render, and a
    // nested object would render as "[object Object]" in the one field a person is
    // meant to be able to paste into an issue.
    expect(isConsoleRefusal({ code: 7, detail: "d", origin: "o" })).toBe(false);
    expect(isConsoleRefusal({ code: "c", detail: { text: "d" }, origin: "o" })).toBe(false);
    expect(isConsoleRefusal({ code: "c", detail: "d", origin: null })).toBe(false);
  });
});

describe("isConsoleRefusal — total, because every caller is already on a failure path", () => {
  /** The unguarded read the guard used to perform, so the counterfactual is runnable. */
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
    // The negative control, and it is the whole reason this case exists: the read the
    // guard used to perform THROWS on this value. A predicate that throws is not a
    // guard — it escapes the `catch` that called it and unmounts the surface whose
    // only job was to report the failure.
    expect(() => readDirectly(hostile)).toThrow();
    expect(isConsoleRefusal(hostile)).toBe(false);
  });

  it("answers false when only one of the three members is unreadable", () => {
    // The partial case, which is the realistic one: two members read fine and the
    // third throws, so a guard that short-circuits on the first two still reaches it.
    const partiallyHostile = {
      code: "c",
      detail: "d",
      get origin(): never {
        throw new Error("this getter is hostile");
      },
    };
    expect(() => partiallyHostile.origin).toThrow();
    expect(isConsoleRefusal(partiallyHostile)).toBe(false);
  });

  it("answers false for a null-prototype object carrying nothing", () => {
    expect(isConsoleRefusal(Object.create(null))).toBe(false);
  });

  it("accepts a null-prototype carrier, object or function, that holds the three members", () => {
    // A refusal that crossed a structured clone or arrived from another realm has no
    // prototype chain left, and it is still a refusal. The function case is the one
    // the old `typeof value !== "object"` pre-check rejected outright: a function is a
    // property container too, and `typeof` calls it neither `"object"` nor `null`.
    const nullPrototypeObject = Object.assign(Object.create(null) as object, {
      code: "c",
      detail: "d",
      origin: "o",
    });
    expect(isConsoleRefusal(nullPrototypeObject)).toBe(true);

    const carrierFunction = Object.assign(function carrier(): void {}, {
      code: "c",
      detail: "d",
      origin: "o",
    });
    Object.setPrototypeOf(carrierFunction, null);
    expect(isConsoleRefusal(carrierFunction)).toBe(true);
  });
});
