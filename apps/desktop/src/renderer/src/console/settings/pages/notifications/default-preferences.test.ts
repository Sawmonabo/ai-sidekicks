// What the page shows for a trigger nobody has stored, and what it refuses to touch.
//
// Driven as pure functions rather than through a rendered page, because the two claims
// are about a SET: that every registered trigger is covered, and that a stored record
// is never completed from a default. Both are one line to assert here and awkward to
// reach through a DOM.

import { describe, expect, it } from "vitest";

import { ATTENTION_TRIGGERS } from "../../../bridge/index.js";
import {
  DEFAULT_PREFERENCE_MEMBER,
  defaultPreferenceFor,
  preferencesWithDefaults,
} from "./default-preferences.js";

describe("preferences nobody has stored", () => {
  it("covers every registered trigger when the store is empty", () => {
    const withDefaults = preferencesWithDefaults([]);
    expect(withDefaults.preferences.map((preference) => preference.key)).toStrictEqual([
      ...ATTENTION_TRIGGERS,
    ]);
    expect(withDefaults.defaultedKeys.size).toBe(ATTENTION_TRIGGERS.length);
  });

  it("notifies by default, so nothing is withheld that nobody asked to withhold", () => {
    expect(defaultPreferenceFor("mention").value).toStrictEqual({
      [DEFAULT_PREFERENCE_MEMBER]: true,
    });
  });

  it("leaves a stored record exactly as it arrived, and fills only the gaps beside it", () => {
    const stored = { key: "mention", value: { mentions: false } };
    const withDefaults = preferencesWithDefaults([stored]);
    expect(withDefaults.preferences[0]).toBe(stored);
    expect(withDefaults.defaultedKeys.has("mention")).toBe(false);
    expect(withDefaults.preferences).toHaveLength(ATTENTION_TRIGGERS.length);
  });

  it("negative control: a stored key that is not a trigger is kept, and adds no default", () => {
    // The store is keyed by an opaque string and this page has never claimed
    // otherwise, so an unregistered key renders — and does not suppress a trigger's
    // own default, which would hide a switch behind a key nobody can read.
    const withDefaults = preferencesWithDefaults([{ key: "digest", value: { weekly: true } }]);
    expect(withDefaults.preferences.map((preference) => preference.key)).toStrictEqual([
      "digest",
      ...ATTENTION_TRIGGERS,
    ]);
    expect(withDefaults.defaultedKeys.has("digest")).toBe(false);
  });
});
