// The settlement identity over literals: a completion from an earlier visit to the same address
// is never written, so it cannot clear a draft typed since.

import { describe, expect, it } from "vitest";

import {
  addressedOperationKey,
  isSettlementCurrent,
  type ComposerSendOperation,
  type ComposerSettlementIdentity,
} from "./settlement.js";

const ADDRESS_A = "session-message|session-1";

const FIRST_VISIT = 1;
const SECOND_VISIT = 2;

function identity(
  draftKey: string,
  operation: ComposerSendOperation,
  attemptId: number,
  visit = FIRST_VISIT,
): ComposerSettlementIdentity {
  return { draftKey, visit, operation, attemptId };
}

/** The newest-attempt register as the controller's ref holds it, keyed by the real key function. */
function newestAttempts(...entries: readonly ComposerSettlementIdentity[]): Record<string, number> {
  return Object.fromEntries(
    entries.map((entry) => [
      addressedOperationKey(entry.draftKey, entry.visit, entry.operation),
      entry.attemptId,
    ]),
  );
}

describe("composer settlement identity — which completions may be written", () => {
  it("admits a completion whose visit and attempt are both still current", () => {
    const act = identity(ADDRESS_A, "send", 3);
    expect(isSettlementCurrent(act, ADDRESS_A, FIRST_VISIT, newestAttempts(act))).toBe(true);
  });

  it("discards a completion issued on an earlier visit to the SAME address", () => {
    // The composer left A and came back: the key matches but the stay does not, and admitting
    // it would clear a draft typed later.
    const act = identity(ADDRESS_A, "send", 3);
    expect(isSettlementCurrent(act, ADDRESS_A, SECOND_VISIT, newestAttempts(act))).toBe(false);
  });
});
