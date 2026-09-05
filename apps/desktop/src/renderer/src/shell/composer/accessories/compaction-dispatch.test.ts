// The compaction call settles, in every arm.
//
// This is the lane's definition of done and it is checkable exactly one way: drive
// the real dispatcher against the real fixture bridge with a canned reply, and
// assert that what comes back is a SETTLED state rather than a promise still in
// flight. The fixture bridge is the collaborator rather than a hand-rolled double,
// because a double would answer whatever this file taught it to and would therefore
// prove nothing about the shape the wire actually admits.
//
// Four arms, and each one is a different failure if it is missed: `applied` and
// `refused` are the two the registered result union carries, a reply that does not
// parse is a daemon composition bug, and a rejection is what a caller meets when the
// driver cannot compact at all — the arm most easily left spinning.

import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../../../console/bridge/index.js";
import type { ConsoleScenario } from "../../../console/bridge/scenario.js";
import { settleCompaction } from "./compaction-dispatch.js";

// Registered `SessionId` / `RunId` values (UUIDs). The dispatcher parses both before
// it sends anything, so a readable name here would refuse at the address rather than
// reaching the call this file is about.
const SESSION_ID = "0d3f4a51-6c2b-4e88-9a17-2b5c8d0e1f34";
const RUN_ID = "7e1a2b3c-4d5e-4f60-8a91-b2c3d4e5f607";

/**
 * A scenario carrying one canned reply and no beats.
 *
 * Deliberately not one of the registered console scenarios: those are the fixture
 * picker's, and a unit that needed a picker entry to run would couple this claim to
 * a list six other lanes are also editing.
 */
function scenarioReplying(result: unknown): ConsoleScenario {
  return {
    id: "compaction-unit",
    label: "Compaction unit",
    purpose: "One canned compaction reply, so the dispatcher's settlement is observable.",
    sessionId: SESSION_ID,
    participantIdsInJoinOrder: ["participant-you"],
    startedAtIso: "2026-01-01T00:00:00.000Z",
    beats: [],
    replies: [{ call: "driver.compactContext", result }],
  };
}

describe("settleCompaction — the call settles in every arm", () => {
  it("settles an applied result and carries its boundary position", async () => {
    const bridge = createFixtureBridge({
      scenario: scenarioReplying({ status: "applied", boundaryPosition: 41 }),
    });
    const settled = await settleCompaction(bridge, SESSION_ID, RUN_ID);
    expect(settled.phase).toBe("settled");
    expect(settled.phase === "settled" ? settled.result : undefined).toStrictEqual({
      status: "applied",
      boundaryPosition: 41,
    });
  });

  it("settles a refusal as data rather than as a rejection", async () => {
    const bridge = createFixtureBridge({
      scenario: scenarioReplying({ status: "refused", reason: "not_permitted" }),
    });
    const settled = await settleCompaction(bridge, SESSION_ID, RUN_ID);
    expect(settled.phase === "settled" ? settled.result.status : undefined).toBe("refused");
  });

  it("negative control: a reply the registered union does not admit is not settled as one", async () => {
    // `capability_undeclared` is deliberately absent from the result union — the
    // static capability gate refuses before dispatch — so a daemon answering it
    // must not reach the surface as a settlement.
    //
    // The code is the FIXTURE's, and that is the seam working rather than a weaker
    // assertion: `driver.compactContext` is a registered method now, so the fixture
    // refuses the SCRIPT before the dispatcher ever sees it. What is claimed here is
    // that an inadmissible reply reaches the surface as a rejection and never as a
    // settled result; which layer caught it is the corpus's business.
    const bridge = createFixtureBridge({
      scenario: scenarioReplying({ status: "refused", reason: "capability_undeclared" }),
    });
    const settled = await settleCompaction(bridge, SESSION_ID, RUN_ID);
    expect(settled.phase).toBe("rejected");
    expect(settled.phase === "rejected" ? settled.refusal.code : undefined).toBe(
      "reply-off-contract",
    );
  });

  it("settles a rejection instead of leaving the caller in flight", async () => {
    // No reply is scripted for the method, so the fixture rejects — the shape a
    // driver that cannot compact produces.
    const bridge = createFixtureBridge({
      scenario: { ...scenarioReplying(undefined), replies: [] },
    });
    const settled = await settleCompaction(bridge, SESSION_ID, RUN_ID);
    expect(settled.phase).toBe("rejected");
    expect(settled.phase === "rejected" ? settled.refusal.detail.length : 0).toBeGreaterThan(0);
  });

  it("negative control: an applied result missing its boundary member does not settle", async () => {
    // `boundaryPosition` is required on the applied arm and is nullable rather than
    // optional, so an absent key is a parse failure and not a null reading.
    const bridge = createFixtureBridge({ scenario: scenarioReplying({ status: "applied" }) });
    const settled = await settleCompaction(bridge, SESSION_ID, RUN_ID);
    expect(settled.phase).toBe("rejected");
  });
});
