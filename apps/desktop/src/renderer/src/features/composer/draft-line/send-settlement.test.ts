// The settlement identity over literals: which completions may be written and which refusal
// the bar renders. The hook-level suites drive the same rules through a real re-address.

import { describe, expect, it } from "vitest";

import { refuse } from "@renderer/lib/refusal.js";
import {
  NO_COMPOSER_REFUSALS,
  addressedOperationKey,
  attemptIdsAtAddress,
  isSettlementCurrent,
  renderableRefusal,
  withSettledRefusal,
  type ComposerSendOperation,
  type ComposerSettlementIdentity,
} from "./send-settlement.js";

const ADDRESS_A = "session-message|session-1";
const ADDRESS_B = "session-message|session-2";

const SEND_REFUSAL = refuse("composer-send", "queue.full", "That session's queue is full.");

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

  it("discards a completion issued at an address the composer has left", () => {
    // A send to A awaiting the daemon while the composer moves to B must not write A's verdict
    // under B.
    const act = identity(ADDRESS_A, "send", 3);
    expect(isSettlementCurrent(act, ADDRESS_B, FIRST_VISIT, newestAttempts(act))).toBe(false);
  });

  it("discards a completion issued on an earlier visit to the SAME address", () => {
    // The composer left A and came back: the key matches but the stay does not, and admitting
    // it would clear a draft typed later.
    const act = identity(ADDRESS_A, "send", 3);
    expect(isSettlementCurrent(act, ADDRESS_A, SECOND_VISIT, newestAttempts(act))).toBe(false);
  });

  it("discards a completion whose operation has since issued a newer attempt", () => {
    const act = identity(ADDRESS_A, "send", 3);
    const superseded = identity(ADDRESS_A, "send", 4);
    expect(isSettlementCurrent(act, ADDRESS_A, FIRST_VISIT, newestAttempts(superseded))).toBe(
      false,
    );
  });

  it("negative control: another ADDRESS's newer attempt does not supersede this one", () => {
    // Keyed by operation alone, a send from B would retire A's attempt and drop A's refusal.
    const act = identity(ADDRESS_A, "send", 1);
    const elsewhere = identity(ADDRESS_B, "send", 2);
    expect(isSettlementCurrent(act, ADDRESS_A, FIRST_VISIT, newestAttempts(act, elsewhere))).toBe(
      true,
    );
  });
});

describe("composer refusals by operation — a refusal stands until the act settles clean", () => {
  it("renders the refusal a send settled as", () => {
    const refusalsByOperation = withSettledRefusal(
      NO_COMPOSER_REFUSALS,
      identity(ADDRESS_A, "send", 1),
      SEND_REFUSAL,
    );

    expect(refusalsByOperation.send?.refusal).toStrictEqual(SEND_REFUSAL);
    expect(renderableRefusal(refusalsByOperation)).toStrictEqual(SEND_REFUSAL);
  });

  it("clears the refusal when the next send settles without a refusal", () => {
    const refused = withSettledRefusal(
      NO_COMPOSER_REFUSALS,
      identity(ADDRESS_A, "send", 1),
      SEND_REFUSAL,
    );
    const afterSendSucceeded = withSettledRefusal(
      refused,
      identity(ADDRESS_A, "send", 2),
      undefined,
    );

    expect(renderableRefusal(afterSendSucceeded)).toBeUndefined();
  });

  it("negative control: an empty record renders nothing", () => {
    // Refusals are held under `(bridge, draftKey)`, so a re-address drops them; there is no
    // read-time address comparison.
    expect(renderableRefusal(NO_COMPOSER_REFUSALS)).toBeUndefined();
  });
});

describe("the attempt register is bounded by the address, not by the mount", () => {
  it("keeps the entry for the address it is narrowed to", () => {
    const send = identity(ADDRESS_A, "send", 3);

    expect(attemptIdsAtAddress(newestAttempts(send), ADDRESS_A, FIRST_VISIT)).toStrictEqual(
      newestAttempts(send),
    );
  });

  it("drops the entries of another address and of an earlier visit to this one", () => {
    // `isSettlementCurrent` compares the identity's own pair before the register, so nothing
    // looks either of these up again.
    const current = identity(ADDRESS_A, "send", 9);
    const otherAddress = identity(ADDRESS_B, "send", 7);
    const earlierVisit = identity(ADDRESS_A, "send", 5, FIRST_VISIT);

    expect(
      attemptIdsAtAddress(
        newestAttempts(earlierVisit, otherAddress, { ...current, visit: SECOND_VISIT }),
        ADDRESS_A,
        SECOND_VISIT,
      ),
    ).toStrictEqual(newestAttempts({ ...current, visit: SECOND_VISIT }));
  });

  it("holds at most one entry per operation however many acts were dispatched", () => {
    // The ceiling is the closed operation vocabulary, whatever was dispatched.
    let register: Record<string, number> = {};
    for (let attemptId = 1; attemptId <= 40; attemptId += 1) {
      const visit = attemptId;
      register = {
        ...register,
        ...newestAttempts(identity(ADDRESS_A, "send", attemptId, visit)),
      };
      register = attemptIdsAtAddress(register, ADDRESS_A, visit);
    }

    expect(Object.keys(register)).toHaveLength(1);
  });

  it("negative control: an address with no act on it narrows to nothing", () => {
    // Without this, a function returning its input would satisfy the retention case.
    expect(
      attemptIdsAtAddress(newestAttempts(identity(ADDRESS_B, "send", 3)), ADDRESS_A, FIRST_VISIT),
    ).toStrictEqual({});
  });
});
