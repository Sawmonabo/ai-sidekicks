// The pane's own refusals: the code each constructor mints, and the set they close.
//
// Every case is about a claim a refusal would otherwise make falsely — that a
// rejection off the wire said nothing machine-readable when it did, that the pane
// authored a refusal its port raised, or that "the codes this pane mints" is a number
// in a sentence rather than a list something can fail against.

import { describe, expect, it } from "vitest";

import {
  ARTIFACT_PANE_REFUSAL_CODES,
  manifestReadInFlightRefusal,
  payloadFetchInFlightRefusal,
  readFailureRefusal,
} from "./artifact-pane-refusals.js";
import { growthAnswerReading } from "./artifact-pane-reading.js";

describe("artifact pane refusals — a read that threw", () => {
  it("names this reader as the origin and never quotes the rejected value", () => {
    // The sentence names the leg and stops there: a rejection off the wire can carry
    // participant content as readily as a schema failure can. The copy this replaces
    // interpolated `error.message` into it.
    const refusal = readFailureRefusal(new Error("/Users/someone/secret-branch"));
    expect(refusal.code).toBe("read-threw");
    expect(refusal.origin).toBe("artifact-pane-reader");
    expect(refusal.detail).not.toContain("secret-branch");
  });

  it("keeps a daemon envelope's dotted code, its own words, and its retry hint", () => {
    // The arm the three-arm copy did not have: everything arrived as `read-threw`
    // with the daemon's code and sentence discarded, so a 403 and a rate limit read
    // the same and neither said what to do next.
    const refusal = readFailureRefusal({
      message: "Deleting this artifact is not permitted.",
      data: { type: "artifact.delete_forbidden", fields: { retryAfter: 30 } },
    });
    expect(refusal.code).toBe("artifact.delete_forbidden");
    expect(refusal.detail).toBe("Deleting this artifact is not permitted.");
    expect(refusal.retry?.afterSeconds).toBe(30);
  });

  it("keeps the origin a refusal thrown across the bridge already named", () => {
    // Structural rather than `instanceof`: the value crossed a realm, so its
    // prototype chain is gone and an `instanceof` reading would silently replace the
    // author's origin with this pane's.
    const refusal = readFailureRefusal({
      refusal: { origin: "growth-port", code: "wire-unregistered", detail: "Not checked." },
    });
    expect(refusal.origin).toBe("growth-port");
    expect(refusal.code).toBe("wire-unregistered");
  });

  it("negative control: a value whose `message` getter throws does not escape", () => {
    // This function runs inside the scheduler's `onError`, which is the one handler
    // that exists so a failure is never swallowed. A throw from here would be a
    // second failure raised while reporting the first, outside every `catch`.
    const hostile = {
      get message(): string {
        throw new Error("read me and see");
      },
    };
    const refusal = readFailureRefusal(hostile);
    expect(refusal.origin).toBe("artifact-pane-reader");
    expect(refusal.detail.length).toBeGreaterThan(0);
  });
});

describe("artifact pane refusals — the closed vocabulary", () => {
  it("is exactly the codes the module's own constructors mint, each named once", () => {
    // The claim the prose that stood here could not make. It said "the three codes
    // this pane mints" beside four constants, and a sentence is not something a
    // fifth code can fail against. Every constructor in this module is driven and
    // its code checked into the set, so a code minted without being enumerated —
    // and a member enumerated that nothing mints — both fail here.
    const unreadableReply = growthAnswerReading("The delete", { status: "served" } as never);
    const minted = [
      readFailureRefusal(new Error("boom")).code,
      payloadFetchInFlightRefusal("artifact-1").code,
      manifestReadInFlightRefusal("artifact-1").code,
      unreadableReply.status === "refused" ? unreadableReply.refusal.code : "nothing-was-refused",
    ];

    expect([...ARTIFACT_PANE_REFUSAL_CODES].toSorted()).toStrictEqual(minted.toSorted());
    expect(new Set(ARTIFACT_PANE_REFUSAL_CODES).size).toBe(ARTIFACT_PANE_REFUSAL_CODES.length);
  });

  it("negative control: a code the port owns is not a member of this pane's set", () => {
    // `growth-port`'s own vocabulary reaches this pane on every refused read and is
    // rendered unchanged. A set that admitted one would be claiming authorship of a
    // refusal this module never mints.
    expect([...ARTIFACT_PANE_REFUSAL_CODES]).not.toContain("wire-unregistered");
    expect([...ARTIFACT_PANE_REFUSAL_CODES]).not.toContain("reply-abandoned");
  });
});
