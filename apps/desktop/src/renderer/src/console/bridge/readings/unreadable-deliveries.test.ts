// The ledger's own rules, driven without a stream.
//
// Both consumers reach it through a bridge, a subscription, and a React hook, so the
// three claims that are the ledger's own — the count rises per delivery, only the
// newest refusal is kept, and a clear resets both together — are asserted here rather
// than through three layers that have nothing to do with them.

import { describe, expect, it } from "vitest";

import { refuse, refusedMemberPaths, type ConsoleRefusal } from "../../core/index.js";
import {
  UnreadableDeliveryLedger,
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
