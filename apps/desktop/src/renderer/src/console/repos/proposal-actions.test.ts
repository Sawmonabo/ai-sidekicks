// What the gate may offer, held against the rules the offers were written from.
//
// The cases drive the real tuple and the real table rather than stand-ins, and each
// clean assertion is paired with the case that would pass if the module stopped doing
// the thing — a totality claim is only meaningful beside the key that must not be in
// the table.

import { describe, expect, it } from "vitest";

import { PROPOSAL_ACTIONS, PROPOSAL_ACTION_PRESENTATION } from "./proposal-actions.js";

describe("the modelled actions — declared once, and closed where the spec closes them", () => {
  it("offers three modelled actions and no fourth", () => {
    expect(PROPOSAL_ACTIONS).toStrictEqual(["commit", "push", "prepare-proposal"]);
  });

  it("gives every action a presentation, and no key beyond them", () => {
    expect(Object.keys(PROPOSAL_ACTION_PRESENTATION).sort()).toStrictEqual(
      [...PROPOSAL_ACTIONS].sort(),
    );
  });
});
