// The scheme vocabulary, and the derivation that keeps its three readers in step.
//
// `SCHEME_PREFERENCES` had three hand-written copies — one in the store, one in the
// persistence value classes, one here — and the way that fails is silent: a third
// scheme would be renderable, refused on write, and accepted on read, each by a
// different list. The list is derived now, and `ConsoleScheme` is derived from the
// same tuple rather than written beside it. Neither derivation is visible at a call
// site, so the cases below are what says the wiring is real: adding a scheme has to
// widen the preference list and the guard together, and nothing may widen the guard
// without widening the list.
//
// `contrast.test.ts` beside this file measures the colours. This file is about the
// vocabulary the colours are looked up through.

import { describe, expect, it } from "vitest";
import {
  CONSOLE_SCHEMES,
  SCHEME_COLOR_TOKENS,
  SCHEME_PREFERENCES,
  SYSTEM_SCHEME_PREFERENCE,
  TOKEN_PREFIX,
  isSchemePreference,
  participantHueTokenName,
  schemeColor,
  tokenReference,
  tokenVariableName,
} from "./tokens.js";

describe("the scheme vocabulary — one tuple, three readers", () => {
  it("renders in light and dark", () => {
    expect(CONSOLE_SCHEMES).toStrictEqual(["light", "dark"]);
  });

  it("offers every scheme as a preference, plus the one that defers to the system", () => {
    // Derived, not re-listed: this is the assertion that the derivation is what is
    // actually shipped rather than a comment on a hand-written copy.
    expect(SCHEME_PREFERENCES).toStrictEqual([...CONSOLE_SCHEMES, SYSTEM_SCHEME_PREFERENCE]);
    expect(SCHEME_PREFERENCES).toHaveLength(CONSOLE_SCHEMES.length + 1);
  });

  it("keeps the system preference out of the set of things that paint", () => {
    // `ConsoleScheme` is a resolved answer and always paints something; a
    // preference may decline to answer. Conflating them is how "system" reaches a
    // colour lookup that has no such column.
    expect(CONSOLE_SCHEMES).not.toContain(SYSTEM_SCHEME_PREFERENCE);
  });
});

describe("isSchemePreference — the single guard on the way in and the way back", () => {
  it("accepts every preference in the vocabulary", () => {
    const rejected = SCHEME_PREFERENCES.filter((preference) => !isSchemePreference(preference));
    expect(rejected).toStrictEqual([]);
  });

  it("negative control: rejects what a constant-true guard would accept", () => {
    // Two guards is how a record written by an older build gets accepted on read
    // after being refused on write, so this one has to actually refuse.
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
    expect(participantHueTokenName(0)).toBe("hue-00");
    expect(participantHueTokenName(9)).toBe("hue-09");
    expect(participantHueTokenName(11)).toBe("hue-11");
  });
});

describe("schemeColor — resolving a token for one scheme", () => {
  it("returns the value the generated sheet emits for that scheme", () => {
    for (const scheme of CONSOLE_SCHEMES) {
      const resolved = schemeColor("text", scheme);
      expect(resolved).toStrictEqual(SCHEME_COLOR_TOKENS.get("text")?.[scheme]);
    }
  });

  it("gives the two schemes different values for a scheme-varying token", () => {
    // Negative control for the lookup: one that ignored its scheme argument would
    // satisfy the case above by returning the same pair member twice.
    expect(schemeColor("ground", "light")).not.toStrictEqual(schemeColor("ground", "dark"));
  });

  it("throws on a token that does not exist rather than painting a default", () => {
    expect(() => schemeColor("text-loud", "light")).toThrow(RangeError);
  });
});
