// The settlement identity, driven directly: which completions may be written, and
// which refusal the bar renders once they have been.
//
// The pure half of the defect. The hook-level cases beside this file drive the same
// rules through a real re-address; these state them over literals, so a rule that
// changes here fails on its own terms rather than through whatever the hook happened
// to be doing.

import { describe, expect, it } from "vitest";

import { refuse } from "../../../console/core/index.js";
import {
  NO_COMPOSER_REFUSALS,
  addressedOperationKey,
  isSettlementCurrent,
  renderableRefusal,
  withSettledRefusal,
  type ComposerSendOperation,
  type ComposerSettlementIdentity,
} from "./send-settlement.js";

const ADDRESS_A = "channel-message|session-1|channel-a";
const ADDRESS_B = "channel-message|session-1|channel-b";

const SEND_REFUSAL = refuse("composer-send", "queue.full", "That channel's queue is full.");
const STOP_REFUSAL = refuse("composer-send", "run.not_running", "There is no live turn to stop.");

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

/**
 * The newest-attempt register, in the shape the controller's ref holds it.
 *
 * Built by composing the keys rather than by spelling them, so a change to how an
 * act is keyed cannot leave this suite asserting against the old shape.
 */
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
    // The finding's own case: a send to A awaiting the daemon while the composer is
    // re-addressed to B. Writing it would put A's verdict under B.
    const act = identity(ADDRESS_A, "send", 3);
    expect(isSettlementCurrent(act, ADDRESS_B, FIRST_VISIT, newestAttempts(act))).toBe(false);
  });

  it("discards a completion issued on an earlier visit to the SAME address", () => {
    // The case a key-only comparison called current. The composer left A and came
    // back, so the key matches and the stay does not — and admitting this settlement
    // is what cleared a draft typed after it.
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

  it("negative control: the other operation's newer attempt does not supersede this one", () => {
    // Without this the attempt guard would hold over a register read across the two
    // operations, which is exactly the shared slot the per-key register replaces.
    const act = identity(ADDRESS_A, "send", 3);
    const otherOperation = identity(ADDRESS_A, "stop", 9);
    expect(
      isSettlementCurrent(act, ADDRESS_A, FIRST_VISIT, newestAttempts(act, otherOperation)),
    ).toBe(true);
  });

  it("negative control: another ADDRESS's newer attempt does not supersede this one", () => {
    // The finding this register was re-keyed for: two slots for the whole window let
    // a send from B retire the attempt made at A, so A's own refusal was dropped
    // while the person was looking straight at A.
    const act = identity(ADDRESS_A, "send", 1);
    const elsewhere = identity(ADDRESS_B, "send", 2);
    expect(isSettlementCurrent(act, ADDRESS_A, FIRST_VISIT, newestAttempts(act, elsewhere))).toBe(
      true,
    );
  });
});

describe("composer settlement slots — one act never erases another's refusal", () => {
  it("holds each operation's refusal in its own slot", () => {
    const slots = withSettledRefusal(
      withSettledRefusal(NO_COMPOSER_REFUSALS, identity(ADDRESS_A, "send", 1), SEND_REFUSAL),
      identity(ADDRESS_A, "stop", 2),
      STOP_REFUSAL,
    );

    expect(slots.send?.refusal).toStrictEqual(SEND_REFUSAL);
    expect(slots.stop?.refusal).toStrictEqual(STOP_REFUSAL);
  });

  it("leaves the other operation's refusal standing when one succeeds", () => {
    // The second half of the finding: a concurrent success used to clear the one
    // shared slot, so a Stop refusal nobody had read disappeared because a send
    // happened to land.
    const withStopRefusal = withSettledRefusal(
      NO_COMPOSER_REFUSALS,
      identity(ADDRESS_A, "stop", 1),
      STOP_REFUSAL,
    );
    const afterSendSucceeded = withSettledRefusal(
      withStopRefusal,
      identity(ADDRESS_A, "send", 2),
      undefined,
    );

    expect(afterSendSucceeded.send).toBeUndefined();
    expect(afterSendSucceeded.stop?.refusal).toStrictEqual(STOP_REFUSAL);
    expect(renderableRefusal(afterSendSucceeded)).toStrictEqual(STOP_REFUSAL);
  });

  it("renders the newer attempt where both operations refused at this address", () => {
    const slots = withSettledRefusal(
      withSettledRefusal(NO_COMPOSER_REFUSALS, identity(ADDRESS_A, "send", 5), SEND_REFUSAL),
      identity(ADDRESS_A, "stop", 4),
      STOP_REFUSAL,
    );

    expect(renderableRefusal(slots)).toStrictEqual(SEND_REFUSAL);
  });

  it("negative control: an empty record renders nothing", () => {
    // The address guard that used to stand here is gone deliberately: the slots are
    // held under `(bridge, draftKey)` now, so a re-address DROPS them rather than
    // hiding them behind a read-time comparison the return trip stopped satisfying.
    expect(renderableRefusal(NO_COMPOSER_REFUSALS)).toBeUndefined();
  });
});
