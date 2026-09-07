// The closed value-class enumeration, and the one place it is declared.
//
// The drift this file exists to catch is invisible to every other check: a class
// name in the enumeration with no validator behind it does not crash, it just
// falls through and the chokepoint admits whatever was handed to it. The types
// make that unrepresentable now — the validator table is keyed by the union the
// enumeration derives — and this file proves the derivation is real by DRIVING
// every enumerated name rather than by reading the source.

import { describe, expect, it } from "vitest";

import { IDENTIFIER_MAX_LENGTH, isConsoleRefusal } from "../core/index.js";
import {
  PERSISTED_VALUE_CLASSES,
  PERSISTENCE_REFUSAL_CODES,
  PERSISTENCE_REFUSAL_ORIGIN,
  isPersistedValueClass,
  measureRecordByteLength,
  refusePersistence,
  validatePersistedAddress,
  validatePersistedValue,
} from "./value-classes.js";

/**
 * A value no class admits: not an object, not an array, not a scheme name. Every
 * every one of the class shapes must reject it, which is what makes "the name reached a
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

describe("a record's ADDRESS passes the same chokepoint as its value", () => {
  const PROSE_KEY = "Rerun the migration and tell me what the row counts look like";

  it("refuses a key that carries prose, naming the component and not quoting it", () => {
    const refusal = validatePersistedAddress("session-01H8", PROSE_KEY);

    expect(refusal?.code).toBe("address-not-identifier-shaped");
    expect(refusal?.origin).toBe(PERSISTENCE_REFUSAL_ORIGIN);
    expect(refusal?.detail).toContain("key");
    expect(refusal?.detail).toContain(String(PROSE_KEY.length));
    // The refusal must not carry the prose one layer further out than the store
    // that refused it — the length is what an author needs to find the call site.
    expect(refusal?.detail).not.toContain(PROSE_KEY);
  });

  it("refuses a path in either component, which the VALUE grammar deliberately admits", () => {
    // The asymmetry is the point. `IDENTIFIER_PATTERN` admits `/` because a
    // path-shaped VALUE is excluded by the class shapes instead — no admitted
    // class has a field that takes a path. An address has no class shape behind
    // it, so the path separator has to be excluded at the address itself.
    const path = "/Users/someone/notes.md";
    expect(validatePersistedValue("selection", { pane: path })).toBeUndefined();

    expect(validatePersistedAddress(path, "layout")?.code).toBe("address-not-identifier-shaped");
    expect(validatePersistedAddress("session-01H8", path)?.code).toBe(
      "address-not-identifier-shaped",
    );
  });

  it("refuses an address component past the identifier ceiling", () => {
    const overLong = "a".repeat(IDENTIFIER_MAX_LENGTH + 1);

    expect(validatePersistedAddress(overLong, "layout")?.code).toBe(
      "address-not-identifier-shaped",
    );
    expect(validatePersistedAddress("session-01H8", overLong)?.code).toBe(
      "address-not-identifier-shaped",
    );
  });

  it("negative control: the addresses the console actually writes are admitted", () => {
    // Without this, a `validatePersistedAddress` that refused everything would
    // pass all three cases above while making the store unwritable.
    expect(validatePersistedAddress("global", "scheme")).toBeUndefined();
    expect(validatePersistedAddress("01H8XG2M4Q6R8T0V2X4Z6B8D0F", "layout")).toBeUndefined();
    expect(validatePersistedAddress("session-01H8", "scroll-position")).toBeUndefined();
    expect(validatePersistedAddress("global", "keybinding.overrides")).toBeUndefined();
  });
});

describe("one byte measurement, over the whole record rather than only its value", () => {
  it("counts the address and the class, not just the serialised value", () => {
    // A cap that measured only the value would let a caller spend the ceiling on
    // the value and then an unbounded further amount on the key.
    const value = ["run-01"];
    const serialisedValueLength = JSON.stringify(value).length;

    const short = measureRecordByteLength("s", "k", "expansion", value);
    const longer = measureRecordByteLength("session-01H8", "expansion", "expansion", value);

    expect(short).toBe(1 + 1 + "expansion".length + serialisedValueLength);
    expect(longer).toBeGreaterThan(short);
  });

  it("counts BYTES, so a multi-byte character is not measured as one", () => {
    // `String.length` counts UTF-16 code units. A ceiling described in bytes that
    // was really counting code units would admit several times what it claims the
    // moment the admitted charset ever widens past ASCII.
    const ascii = measureRecordByteLength("ss", "kk", "pin", null);
    const multiByte = measureRecordByteLength("é", "€", "pin", null);

    expect("é€".length).toBe(2);
    expect(multiByte - ascii).toBe(1);
  });

  it("negative control: an empty value still costs its address", () => {
    // A measurement that returned zero for anything small would make the cap
    // unreachable rather than generous.
    expect(measureRecordByteLength("", "", "pin", null)).toBe("pin".length + "null".length);
  });
});
