// The scheme vocabulary and the derivation that keeps its readers in step. `SCHEME_PREFERENCES`
// and `ColorScheme` are derived from one tuple, and neither derivation is visible at a call site,
// so these cases show the wiring is real: adding a scheme widens the preference list and the
// guard together, and nothing widens the guard without the list. `contrast.test.ts` measures the
// colors; this file covers the vocabulary they are looked up through.

import { describe, expect, it } from "vitest";
import {
  COLOR_SCHEMES,
  SCHEME_COLOR_TOKENS,
  SCHEME_PREFERENCES,
  SYSTEM_SCHEME_PREFERENCE,
  TOKEN_PREFIX,
  isSchemePreference,
  formatHueWheelTokenName,
  schemeColor,
  tokenReference,
  tokenVariableName,
} from "./tokens.js";

describe("the scheme vocabulary — one tuple, three readers", () => {
  it("renders in light and dark", () => {
    expect(COLOR_SCHEMES).toStrictEqual(["light", "dark"]);
  });

  it("offers every scheme as a preference, plus the one that defers to the system", () => {
    // Derived, not re-listed: this shows the derivation is what ships, not a hand-written copy.
    expect(SCHEME_PREFERENCES).toStrictEqual([...COLOR_SCHEMES, SYSTEM_SCHEME_PREFERENCE]);
    expect(SCHEME_PREFERENCES).toHaveLength(COLOR_SCHEMES.length + 1);
  });

  it("keeps the system preference out of the set of things that paint", () => {
    // `ColorScheme` is a resolved answer and always paints; a preference may decline to answer.
    // Conflating them is how "system" reaches a color lookup that has no such column.
    expect(COLOR_SCHEMES).not.toContain(SYSTEM_SCHEME_PREFERENCE);
  });
});

describe("isSchemePreference — the single guard on the way in and the way back", () => {
  it("accepts every preference in the vocabulary", () => {
    const rejected = SCHEME_PREFERENCES.filter((preference) => !isSchemePreference(preference));
    expect(rejected).toStrictEqual([]);
  });

  it("negative control: rejects what a constant-true guard would accept", () => {
    // Two guards would accept on read what was refused on write, so this one must refuse.
    expect(isSchemePreference("sepia")).toBe(false);
    expect(isSchemePreference("")).toBe(false);
    expect(isSchemePreference(null)).toBe(false);
    expect(isSchemePreference(undefined)).toBe(false);
    expect(isSchemePreference(0)).toBe(false);
    expect(isSchemePreference(["light"])).toBe(false);
  });
});

describe("token names — the one place a CSS custom property is spelled", () => {
  it("prefixes every token, so nothing collides with a host page's variables", () => {
    expect(tokenVariableName("text-muted")).toBe(`${TOKEN_PREFIX}text-muted`);
  });

  it("wraps a token in var() for a style object or a template", () => {
    expect(tokenReference("text-muted")).toBe(`var(${TOKEN_PREFIX}text-muted)`);
  });

  it("zero-pads a wheel step, so the emitted sheet sorts in wheel order", () => {
    expect(formatHueWheelTokenName(0)).toBe("hue-00");
    expect(formatHueWheelTokenName(9)).toBe("hue-09");
    expect(formatHueWheelTokenName(11)).toBe("hue-11");
  });
});

describe("schemeColor — resolving a token for one scheme", () => {
  it("returns the value the generated sheet emits for that scheme", () => {
    for (const scheme of COLOR_SCHEMES) {
      const resolved = schemeColor("text", scheme);
      const entry = SCHEME_COLOR_TOKENS.find(([tokenName]) => tokenName === "text");
      expect(resolved).toStrictEqual(entry?.[1][scheme]);
    }
  });

  it("gives the two schemes different values for a scheme-varying token", () => {
    // Negative control: a lookup that ignored its scheme argument would satisfy the case above by
    // returning the same pair member twice.
    expect(schemeColor("ground", "light")).not.toStrictEqual(schemeColor("ground", "dark"));
  });

  it("throws on a token that does not exist rather than painting a default", () => {
    expect(() => schemeColor("text-loud", "light")).toThrow(RangeError);
  });
});
