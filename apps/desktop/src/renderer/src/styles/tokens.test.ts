// The one guard a scheme read off a control or the document root passes.

import { describe, expect, it } from "vitest";
import { SCHEME_PREFERENCES, isSchemePreference } from "./tokens.js";

describe("isSchemePreference — the single guard on a scheme read off the page", () => {
  it("accepts every preference in the vocabulary", () => {
    const rejected = SCHEME_PREFERENCES.filter((preference) => !isSchemePreference(preference));
    expect(rejected).toStrictEqual([]);
  });

  it("rejects a value that is not a preference", () => {
    // Accepted, an unknown scheme would light up an option nobody chose.
    expect(isSchemePreference("sepia")).toBe(false);
    expect(isSchemePreference("")).toBe(false);
    expect(isSchemePreference(null)).toBe(false);
    expect(isSchemePreference(undefined)).toBe(false);
    expect(isSchemePreference(0)).toBe(false);
    expect(isSchemePreference(["light"])).toBe(false);
  });
});
