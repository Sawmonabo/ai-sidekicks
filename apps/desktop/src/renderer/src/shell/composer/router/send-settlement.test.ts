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

function identity(
  draftKey: string,
  operation: ComposerSendOperation,
  attemptId: number,
): ComposerSettlementIdentity {
  return { draftKey, operation, attemptId };
}

/** The newest-attempt register, in the shape the controller's ref holds it. */
function newestAttempts(send: number, stop: number): Record<ComposerSendOperation, number> {
  return { send, stop };
}

describe("composer settlement identity — which completions may be written", () => {
  it("admits a completion whose address and attempt are both still current", () => {
    expect(
      isSettlementCurrent(identity(ADDRESS_A, "send", 3), ADDRESS_A, newestAttempts(3, 0)),
    ).toBe(true);
  });

  it("discards a completion issued at an address the composer has left", () => {
    // The finding's own case: a send to A awaiting the daemon while the composer is
    // re-addressed to B. Writing it would put A's verdict under B.
    expect(
      isSettlementCurrent(identity(ADDRESS_A, "send", 3), ADDRESS_B, newestAttempts(3, 0)),
    ).toBe(false);
  });

  it("discards a completion whose operation has since issued a newer attempt", () => {
    expect(
      isSettlementCurrent(identity(ADDRESS_A, "send", 3), ADDRESS_A, newestAttempts(4, 0)),
    ).toBe(false);
  });

  it("negative control: the other operation's newer attempt does not supersede this one", () => {
    // Without this the attempt guard would hold over a register read across the two
    // operations, which is exactly the shared slot the per-operation register replaces.
    expect(
      isSettlementCurrent(identity(ADDRESS_A, "send", 3), ADDRESS_A, newestAttempts(3, 9)),
    ).toBe(true);
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
    expect(renderableRefusal(afterSendSucceeded, ADDRESS_A)).toStrictEqual(STOP_REFUSAL);
  });

  it("renders nothing at an address none of the held refusals was issued under", () => {
    const slots = withSettledRefusal(
      NO_COMPOSER_REFUSALS,
      identity(ADDRESS_A, "send", 1),
      SEND_REFUSAL,
    );

    expect(renderableRefusal(slots, ADDRESS_B)).toBeUndefined();
  });

  it("renders the newer attempt where both operations refused at this address", () => {
    const slots = withSettledRefusal(
      withSettledRefusal(NO_COMPOSER_REFUSALS, identity(ADDRESS_A, "send", 5), SEND_REFUSAL),
      identity(ADDRESS_A, "stop", 4),
      STOP_REFUSAL,
    );

    expect(renderableRefusal(slots, ADDRESS_A)).toStrictEqual(SEND_REFUSAL);
  });

  it("negative control: an empty record renders nothing at every address", () => {
    expect(renderableRefusal(NO_COMPOSER_REFUSALS, ADDRESS_A)).toBeUndefined();
    expect(renderableRefusal(NO_COMPOSER_REFUSALS, ADDRESS_B)).toBeUndefined();
  });
});
