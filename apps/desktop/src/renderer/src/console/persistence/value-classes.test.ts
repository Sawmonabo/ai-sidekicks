// The closed value-class enumeration, and the one place it is declared.
//
// The drift this file exists to catch is invisible to every other check: a class
// name in the enumeration with no validator behind it does not crash, it just
// falls through and the chokepoint admits whatever was handed to it. The types
// make that unrepresentable now — the validator table is keyed by the union the
// enumeration derives — and this file proves the derivation is real by DRIVING
// every enumerated name rather than by reading the source.

import { describe, expect, it } from "vitest";

import { isConsoleRefusal } from "../core/index.js";
import {
  PERSISTED_VALUE_CLASSES,
  PERSISTENCE_REFUSAL_CODES,
  PERSISTENCE_REFUSAL_ORIGIN,
  isPersistedValueClass,
  refusePersistence,
  validatePersistedValue,
} from "./value-classes.js";

/**
 * A value no class admits: not an object, not an array, not a scheme name. Every
 * one of the seven shapes must reject it, which is what makes "the name reached a
 * validator" observable.
 */
const ADMITTED_BY_NOTHING = 42;

describe("the value-class enumeration is declared once and reaches a validator", () => {
  it("routes every enumerated class to a SHAPE check rather than falling through", () => {
    const codesByClass = PERSISTED_VALUE_CLASSES.map(
      (valueClass) =>
        [valueClass, validatePersistedValue(valueClass, ADMITTED_BY_NOTHING)?.code] as const,
    );

    // `value-shape-invalid` and never `value-class-unknown`: the second would mean
    // the name is in the enumeration and nothing behind it knows the name.
    for (const [valueClass, code] of codesByClass) {
      expect([valueClass, code]).toStrictEqual([valueClass, "value-shape-invalid"]);
    }
    expect(codesByClass).toHaveLength(PERSISTED_VALUE_CLASSES.length);
  });

  it("negative control: a class outside the enumeration is refused by NAME", () => {
    // Without this, a `validatePersistedValue` that refused everything with
    // `value-shape-invalid` would pass the case above while having stopped
    // discriminating at all.
    const refusal = validatePersistedValue("composer-draft", ADMITTED_BY_NOTHING);

    expect(refusal?.code).toBe("value-class-unknown");
    // The refusal names the closed set, so an author who guessed a class name is
    // told which names exist rather than only that theirs was wrong.
    expect(refusal?.detail).toContain(String(PERSISTED_VALUE_CLASSES.length));
    for (const valueClass of PERSISTED_VALUE_CLASSES) {
      expect(refusal?.detail).toContain(valueClass);
    }
  });

  it("negative control: the classes admit the UI state they exist for", () => {
    // And the third direction: a validator table that rejected everything would
    // pass both cases above.
    expect(validatePersistedValue("scheme", "dark")).toBeUndefined();
    expect(validatePersistedValue("expansion", ["run-01", "run-02"])).toBeUndefined();
    expect(validatePersistedValue("scroll-position", { timeline: 240 })).toBeUndefined();
  });

  it("narrows a bare string through the same predicate the chokepoint uses", () => {
    for (const valueClass of PERSISTED_VALUE_CLASSES) {
      expect(isPersistedValueClass(valueClass)).toBe(true);
    }
    expect(isPersistedValueClass("composer-draft")).toBe(false);
    expect(isPersistedValueClass("")).toBe(false);
  });
});

describe("a persistence refusal IS a console refusal", () => {
  it("carries the console's three fields, with this family named as the origin", () => {
    const refusal = refusePersistence("quota-exceeded", "there is no room left");

    // The point of the fold: a surface that renders console refusals renders this
    // one without knowing the persistence subtree exists.
    expect(isConsoleRefusal(refusal)).toBe(true);
    expect(refusal.origin).toBe(PERSISTENCE_REFUSAL_ORIGIN);
    expect(refusal.code).toBe("quota-exceeded");
    expect(refusal.detail).toBe("there is no room left");
  });

  it("names its origin on every refusal the chokepoint itself raises", () => {
    const fromValidation = validatePersistedValue("selection", {
      composer: "Can you take another look at this before I merge it?",
    });

    expect(fromValidation?.code).toBe("value-not-identifier-shaped");
    expect(fromValidation?.origin).toBe(PERSISTENCE_REFUSAL_ORIGIN);
    expect(isConsoleRefusal(fromValidation)).toBe(true);
  });

  it("negative control: a bare object is not mistaken for a console refusal", () => {
    // `isConsoleRefusal` is what the fold above rests on, so it has to be able to
    // say no — a guard that returned true for anything would make every assertion
    // in this block vacuous.
    expect(isConsoleRefusal({ code: "quota-exceeded", detail: "no room" })).toBe(false);
    expect(isConsoleRefusal(undefined)).toBe(false);
  });

  it("declares each refusal code exactly once", () => {
    expect(new Set(PERSISTENCE_REFUSAL_CODES).size).toBe(PERSISTENCE_REFUSAL_CODES.length);
    expect(PERSISTENCE_REFUSAL_CODES).toContain("value-class-unknown");
  });
});
