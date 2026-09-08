// The ledger's own rules and the composer it takes, driven without a stream.
//
// Both consumers reach the ledger through a bridge, a subscription, and a React hook,
// so the three claims that are its own — the count rises per delivery, only the newest
// refusal is kept, and a clear resets both together — are asserted here rather than
// through three layers that have nothing to do with them.
//
// AND THE COMPOSER IS ASSERTED HERE TOO, because it is now one function rather than
// the two identical ones `queue/` and `quotas/` each wrote. What each stream still
// owns is its own origin and its own sentence; what this module owns is the code and
// the shape, and the cases below are what say which is which.

import { describe, expect, it } from "vitest";

import { refuse, refusedMemberPaths, type ConsoleRefusal } from "../../core/index.js";
import {
  UnreadableDeliveryLedger,
  unreadableDeliveryRefusalComposerFor,
  type UnreadableDeliveryIssues,
} from "./unreadable-deliveries.js";

/** A composer shaped exactly as the two real ones are: origin, code, member paths. */
function testRefusalFor(issues: UnreadableDeliveryIssues): ConsoleRefusal {
  return refuse("test-stream", "delivery-unreadable", refusedMemberPaths(issues).join(", "));
}

/** One issue list, as a parse of a registered shape hands it over. */
function issuesOn(member: string): UnreadableDeliveryIssues {
  return [{ path: [member] }];
}

describe("UnreadableDeliveryLedger", () => {
  it("reads as nothing recorded before anything is", () => {
    const ledger = new UnreadableDeliveryLedger(testRefusalFor);

    expect(ledger.reading).toStrictEqual({
      unreadableDeliveryCount: 0,
      unreadableRefusal: undefined,
    });
  });

  it("counts every delivery and keeps only the newest refusal", () => {
    // The count and the refusal answer different questions — how far behind, and
    // what failed most recently — so the second delivery must move both, one by
    // rising and one by being replaced.
    const ledger = new UnreadableDeliveryLedger(testRefusalFor);

    ledger.record(issuesOn("state"));
    ledger.record(issuesOn("priority"));

    expect(ledger.reading.unreadableDeliveryCount).toBe(2);
    expect(ledger.reading.unreadableRefusal?.detail).toBe("priority");
    expect(ledger.reading.unreadableRefusal?.origin).toBe("test-stream");
  });

  it("clears the count and the refusal together", () => {
    const ledger = new UnreadableDeliveryLedger(testRefusalFor);
    ledger.record(issuesOn("state"));

    ledger.clear();

    expect(ledger.reading).toStrictEqual({
      unreadableDeliveryCount: 0,
      unreadableRefusal: undefined,
    });
  });

  it("negative control: a clear does not un-record the deliveries that follow it", () => {
    // Without this a `clear` that also stopped recording would read identically to a
    // correct one on every case above, and a stream that superseded its backlog once
    // would then report a live gap as closed forever.
    const ledger = new UnreadableDeliveryLedger(testRefusalFor);
    ledger.record(issuesOn("state"));
    ledger.clear();

    ledger.record(issuesOn("channelId"));

    expect(ledger.reading.unreadableDeliveryCount).toBe(1);
    expect(ledger.reading.unreadableRefusal?.detail).toBe("channelId");
  });
});

describe("unreadableDeliveryRefusalComposerFor", () => {
  it("carries the stream's own origin and its own words", () => {
    const composed = unreadableDeliveryRefusalComposerFor({
      origin: "session-queue",
      sentence:
        "A queue delivery did not match the registered row shape, so it changed no row here",
    })([{ path: ["state"] }, { path: ["rows", 0, "priority"] }]);

    expect(composed).toStrictEqual({
      origin: "session-queue",
      code: "delivery-unreadable",
      detail:
        "A queue delivery did not match the registered row shape, so it changed no row here: state, rows.0.priority.",
    });
  });

  it("says the same thing about a different stream, in that stream's words", () => {
    // The two composers this replaced differed in exactly these two members and in
    // nothing else, which is the whole reason there is one function here now.
    const composed = unreadableDeliveryRefusalComposerFor({
      origin: "provider-account-quota",
      sentence:
        "A provider-account delivery did not match the registered notification shape, so it moved no account or quota here",
    })([{ path: ["kind"] }]);

    expect(composed.origin).toBe("provider-account-quota");
    expect(composed.code).toBe("delivery-unreadable");
    expect(composed.detail).toBe(
      "A provider-account delivery did not match the registered notification shape, so it moved no account or quota here: kind.",
    );
  });

  it("negative control: it names the members and never the payload", () => {
    // Without this the composer could quote what failed to parse — an unbounded and
    // unvalidated value on screen to explain why an unvalidated value was refused —
    // and every case above would still read the same.
    const composed = unreadableDeliveryRefusalComposerFor({
      origin: "session-queue",
      sentence:
        "A queue delivery did not match the registered row shape, so it changed no row here",
    })([{ path: [] }]);

    expect(composed.detail).toBe(
      "A queue delivery did not match the registered row shape, so it changed no row here: the payload.",
    );
  });
});
