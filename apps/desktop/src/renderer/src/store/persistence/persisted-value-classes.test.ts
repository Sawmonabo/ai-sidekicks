// The closed value-class enumeration is declared once and every enumerated name reaches a
// validator. A name with no validator would not crash; it would fall through and the
// chokepoint would admit whatever it was handed, so every name is driven here.

import { describe, expect, it } from "vitest";

import { IDENTIFIER_MAX_LENGTH } from "@renderer/lib/identifier-grammar.js";
import { isRefusal } from "@renderer/lib/refusal.js";
import {
  PERSISTED_VALUE_CLASSES,
  isPersistedValueClass,
  measureRecordByteLength,
  validatePersistedAddress,
  validatePersistedValue,
} from "./persisted-value-classes.js";
import {
  PERSISTENCE_REFUSAL_CODES,
  PERSISTENCE_REFUSAL_ORIGIN,
  refusePersistence,
} from "./persistence-refusals.js";

/**
 * A value no class admits: not an object, not an array, not a scheme name. Every class shape
 * must reject it, which makes "the name reached a validator" observable.
 */
const ADMITTED_BY_NOTHING = 42;

describe("the value-class enumeration is declared once and reaches a validator", () => {
  it("routes every enumerated class to a SHAPE check rather than falling through", () => {
    const codesByClass = PERSISTED_VALUE_CLASSES.map(
      (valueClass) =>
        [valueClass, validatePersistedValue(valueClass, ADMITTED_BY_NOTHING)?.code] as const,
    );

    // `value-shape-invalid`, never `value-class-unknown`, which would mean a name with
    // nothing behind it.
    for (const [valueClass, code] of codesByClass) {
      expect([valueClass, code]).toStrictEqual([valueClass, "value-shape-invalid"]);
    }
    expect(codesByClass).toHaveLength(PERSISTED_VALUE_CLASSES.length);
  });

  it("negative control: a class outside the enumeration is refused by NAME", () => {
    // Guards against a `validatePersistedValue` that refused everything with
    // `value-shape-invalid` and stopped discriminating.
    const refusal = validatePersistedValue("composer-draft", ADMITTED_BY_NOTHING);

    expect(refusal?.code).toBe("value-class-unknown");
    // The refusal names the closed set, so an author who guessed a class is told which exist.
    expect(refusal?.detail).toContain(String(PERSISTED_VALUE_CLASSES.length));
    for (const valueClass of PERSISTED_VALUE_CLASSES) {
      expect(refusal?.detail).toContain(valueClass);
    }
  });

  it("negative control: the classes admit the UI state they exist for", () => {
    // Guards against a validator table that rejected everything.
    expect(validatePersistedValue("scheme", "dark")).toBeUndefined();
    expect(validatePersistedValue("expansion", ["run-01", "run-02"])).toBeUndefined();
    expect(validatePersistedValue("scroll-position", { transcript: 240 })).toBeUndefined();
  });

  it("refuses prose through the write chokepoint, whatever class is claimed", () => {
    // Composer drafts stay in window memory: a durable copy would need encrypted storage the
    // renderer lacks. If one class's shape were widened (`selection` to `Record<string, string>`)
    // draft text would reach IndexedDB in an unencrypted database outside every erasure
    // selector. Every admissible class is tried, so no class takes this.
    const draftText =
      "Can you rerun the migration against the staging database and tell me what the " +
      "row counts look like afterwards? I think the last pass dropped something.";
    for (const valueClass of PERSISTED_VALUE_CLASSES) {
      expect([valueClass, validatePersistedValue(valueClass, draftText)]).not.toStrictEqual([
        valueClass,
        undefined,
      ]);
    }
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
  it("carries the console's three fields, with persistence named as the origin", () => {
    const refusal = refusePersistence("quota-exceeded", "there is no room left");

    // A view that renders console refusals renders this one without knowing persistence exists.
    expect(isRefusal(refusal)).toBe(true);
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
    expect(isRefusal(fromValidation)).toBe(true);
  });

  it("negative control: a bare object is not mistaken for a console refusal", () => {
    // `isRefusal` must be able to say no, or every assertion in this block is vacuous.
    expect(isRefusal({ code: "quota-exceeded", detail: "no room" })).toBe(false);
    expect(isRefusal(undefined)).toBe(false);
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
    // The refusal must not carry the prose; its length is what finds the call site.
    expect(refusal?.detail).not.toContain(PROSE_KEY);
  });

  it("refuses a path in either component, which the VALUE grammar deliberately admits", () => {
    // `IDENTIFIER_PATTERN` admits `/` because path-shaped values are excluded by the class
    // shapes. An address has no class shape, so the separator is excluded at the address.
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
    // Guards against a `validatePersistedAddress` that refused everything.
    expect(validatePersistedAddress("global", "scheme")).toBeUndefined();
    expect(validatePersistedAddress("01H8XG2M4Q6R8T0V2X4Z6B8D0F", "layout")).toBeUndefined();
    expect(validatePersistedAddress("session-01H8", "scroll-position")).toBeUndefined();
  });
});

describe("one byte measurement, over the whole record rather than only its value", () => {
  it("counts the address and the class, not just the serialized value", () => {
    // A cap over the value alone would leave the key unbounded.
    const value = ["run-01"];
    const serializedValueLength = JSON.stringify(value).length;

    const short = measureRecordByteLength("s", "k", "expansion", value);
    const longer = measureRecordByteLength("session-01H8", "expansion", "expansion", value);

    expect(short).toBe(1 + 1 + "expansion".length + serializedValueLength);
    expect(longer).toBeGreaterThan(short);
  });

  it("counts BYTES, so a multi-byte character is not measured as one", () => {
    // `String.length` counts UTF-16 code units; a byte ceiling counting those would admit
    // several times its claim once the charset widens past ASCII.
    const ascii = measureRecordByteLength("ss", "kk", "pin", null);
    const multiByte = measureRecordByteLength("é", "€", "pin", null);

    expect("é€".length).toBe(2);
    expect(multiByte - ascii).toBe(1);
  });

  it("negative control: an empty value still costs its address", () => {
    // Guards against a measurement that returned zero for anything small.
    expect(measureRecordByteLength("", "", "pin", null)).toBe("pin".length + "null".length);
  });
});
