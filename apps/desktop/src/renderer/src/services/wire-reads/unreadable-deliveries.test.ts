// The ledger's own rules and the composer it takes, driven without a stream: the count rises per
// delivery, only the newest refusal is kept, and a clear resets both together. The composer is one
// function for every stream; each stream owns its origin and sentence, and this module the code
// and shape.

import { describe, expect, it } from "vitest";

import { refuse, refusedMemberPaths, type Refusal } from "@renderer/lib/refusal.js";
import {
  UnreadableDeliveryCounter,
  unreadableDeliveryRefusalComposerFor,
  type UnreadableDeliveryIssues,
} from "./unreadable-deliveries.js";

/** A composer shaped exactly as the two real ones are: origin, code, member paths. */
function testRefusalFor(issues: UnreadableDeliveryIssues): Refusal {
  return refuse("test-stream", "delivery-unreadable", refusedMemberPaths(issues).join(", "));
}

/** One issue list, as a parse of a registered shape hands it over. */
function issuesOn(member: string): UnreadableDeliveryIssues {
  return [{ path: [member] }];
}

describe("UnreadableDeliveryCounter", () => {
  it("reads as nothing recorded before anything is", () => {
    const ledger = new UnreadableDeliveryCounter(testRefusalFor);

    expect(ledger.reading).toStrictEqual({
      unreadableDeliveryCount: 0,
      unreadableRefusal: undefined,
    });
  });

  it("counts every delivery and keeps only the newest refusal", () => {
    // The count (how far behind) and the refusal (what failed most recently) answer different
    // questions, so the second delivery must raise one and replace the other.
    const ledger = new UnreadableDeliveryCounter(testRefusalFor);

    ledger.record(issuesOn("state"));
    ledger.record(issuesOn("priority"));

    expect(ledger.reading.unreadableDeliveryCount).toBe(2);
    expect(ledger.reading.unreadableRefusal?.detail).toBe("priority");
    expect(ledger.reading.unreadableRefusal?.origin).toBe("test-stream");
  });

  it("clears the count and the refusal together", () => {
    const ledger = new UnreadableDeliveryCounter(testRefusalFor);
    ledger.record(issuesOn("state"));

    ledger.clear();

    expect(ledger.reading).toStrictEqual({
      unreadableDeliveryCount: 0,
      unreadableRefusal: undefined,
    });
  });

  it("negative control: a clear does not un-record the deliveries that follow it", () => {
    // Without this a `clear` that also stopped recording would read like a correct one above, and a
    // stream that superseded its backlog once would report a live gap as closed forever.
    const ledger = new UnreadableDeliveryCounter(testRefusalFor);
    ledger.record(issuesOn("state"));
    ledger.clear();

    ledger.record(issuesOn("priority"));

    expect(ledger.reading.unreadableDeliveryCount).toBe(1);
    expect(ledger.reading.unreadableRefusal?.detail).toBe("priority");
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
    // The two real composers differ only in these two members, which is why there is one function.
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
    // Without this the composer could quote what failed to parse, an unvalidated value on screen,
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
