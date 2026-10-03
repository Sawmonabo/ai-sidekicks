// The one guard a stored scheme preference passes on the way in and the way back.

import { describe, expect, it } from "vitest";
import { SCHEME_PREFERENCES, isSchemePreference } from "./tokens.js";

describe("isSchemePreference — the single guard on the way in and the way back", () => {
  it("accepts every preference in the vocabulary", () => {
    const rejected = SCHEME_PREFERENCES.filter((preference) => !isSchemePreference(preference));
    expect(rejected).toStrictEqual([]);
  });

  it("rejects a stored value that is not a preference", () => {
    // Two guards would accept on read what was refused on write, so this one must refuse.
    expect(isSchemePreference("sepia")).toBe(false);
    expect(isSchemePreference("")).toBe(false);
    expect(isSchemePreference(null)).toBe(false);
    expect(isSchemePreference(undefined)).toBe(false);
    expect(isSchemePreference(0)).toBe(false);
    expect(isSchemePreference(["light"])).toBe(false);
  });
});
