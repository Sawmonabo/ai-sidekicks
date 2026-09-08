// The membership row both members-model suites build their cases on.
//
// Here rather than copied into each because a duplicated fixture DRIFTS: the two
// files would go on reading as though they asserted about one default row while
// asserting about two, and the divergence would surface as a failure in whichever
// suite was edited second, about a fact that suite never mentions.

import type { MembershipRow } from "./members-model.js";

/**
 * A row with every fact stated, so a case overrides only the fact it is about.
 *
 * Every fact PRESENT is the point: this model's interesting cases are the absent
 * ones, and a fixture that already left facts out could not tell an absence a case
 * asked for from one it inherited.
 */
export function membershipRow(overrides: Partial<MembershipRow> = {}): MembershipRow {
  return {
    participantId: "participant-you",
    membershipId: "membership-1",
    role: "owner",
    state: "active",
    ...overrides,
  };
}
