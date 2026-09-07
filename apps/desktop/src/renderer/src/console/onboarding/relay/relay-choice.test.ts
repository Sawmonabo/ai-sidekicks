// Three relay options, all visible, one default, and a fail-closed reading.
//
// The identifiers are normative and the count is the design: collapsing the third
// option behind an advanced control is a named defect, so a test that admitted two
// would admit exactly that. The reading is fail-closed for the reason the module
// states — mapping an unknown identifier onto the nearest of the three would report
// a choice nobody made.

import { describe, expect, it } from "vitest";

import {
  readRelayMethodId,
  RELAY_METHOD_IDS,
  RELAY_METHOD_OPTIONS,
  RELAY_METHOD_OPTIONS_IN_ORDER,
} from "./relay-choice.js";

describe("the three-way choice", () => {
  it("carries exactly the three normative identifiers, in order", () => {
    expect([...RELAY_METHOD_IDS]).toStrictEqual(["free-public-relay", "self-host", "hosted-saas"]);
  });

  it("marks exactly one of them as the option the choice opens on", () => {
    const defaults = RELAY_METHOD_OPTIONS_IN_ORDER.filter((option) => option.isDefault);
    expect(defaults.map((option) => option.id)).toStrictEqual(["free-public-relay"]);
  });

  it("says what each option means and what it will ask for", () => {
    for (const id of RELAY_METHOD_IDS) {
      const option = RELAY_METHOD_OPTIONS[id];
      expect(option.consequence.length).toBeGreaterThan(40);
      expect(option.inputs.length).toBeGreaterThan(20);
      expect(option.label).not.toBe(id);
    }
  });
});

describe("reading a reported relay identifier", () => {
  it("reads each of the three", () => {
    for (const id of RELAY_METHOD_IDS) {
      expect(readRelayMethodId(id)).toBe(id);
    }
  });

  it.each(["", "self host", "selfhost", "SELF-HOST", "free-public-relay-2"])(
    "answers undefined for %o rather than the nearest match",
    (candidate) => {
      expect(readRelayMethodId(candidate)).toBeUndefined();
    },
  );
});
