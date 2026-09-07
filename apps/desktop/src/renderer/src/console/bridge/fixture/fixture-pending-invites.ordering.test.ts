// The order the pending-invite feed releases what has fallen due in.
//
// A sibling of `fixture-pending-invites.test.ts` rather than a section of it, and the
// seam is the claim: that file is about WHEN a frame reaches a feed — the two delivery
// triggers, the single-use rule, the two brands — and this one is about the sequence a
// person meets what arrived in. Both drive the real namespace through the one harness
// beside them.
//
// THE DEFECT. The due walk answered every due invitation and then every due attempt,
// so one advance that made an entry in each table due released them in TABLE order
// rather than in tick order. The adapter above this namespace preserves feed order, so
// a scenario scripting a retry prompt for tick 100 and an invitation for tick 200 put
// the invitation on screen first — a fixture reading backwards while every frame in it
// was scripted correctly, which is the class of defect a fixture exists to not have.

import { describe, expect, it } from "vitest";

import { FixturePendingInvites } from "./fixture-pending-invites.js";
import {
  LATE_REFERENCE,
  UNREACHED_ATTEMPT,
  attemptFrame,
  drainFrames,
  pendingFrame,
  scenarioWithBothTables,
} from "./fixture-pending-invites.test-support.js";
import { ScenarioEngine } from "../scenario-runtime/index.js";

/** The ticks these cases are scripted at, and the advance that passes both. */
const EARLY_TICK_MS = 100;
const LATER_TICK_MS = 200;
const PAST_BOTH_TICKS_MS = 300;

describe("fixture pending invites — two tables falling due on one advance", () => {
  it("releases them in tick order rather than in table order", async () => {
    // The case the fix is for, and its own negative control: the assertion is on the
    // WHOLE array in order, so the pre-fix order is a different array and fails here.
    // An assertion about membership — that both arrived — would have passed on both
    // implementations and reported nothing.
    const engine = new ScenarioEngine({
      scenario: scenarioWithBothTables(
        [pendingFrame(LATE_REFERENCE, LATER_TICK_MS)],
        [attemptFrame(EARLY_TICK_MS)],
      ),
    });
    const pendingInvites = new FixturePendingInvites(engine);
    const feed = pendingInvites.openPendingFeed();

    engine.advance(PAST_BOTH_TICKS_MS);

    await expect(drainFrames(feed)).resolves.toMatchObject([
      { status: "unavailable", attempt: UNREACHED_ATTEMPT },
      { status: "ready", reference: LATE_REFERENCE },
    ]);
  });

  it("puts the invitation first where the two tick together — the tie rule", async () => {
    // Equal ticks are what a sort per table cannot express at all, so the rule is
    // pinned rather than left to whichever table happens to be walked first: an
    // invitation a person can answer comes before a prompt to retry one that never
    // reached the control plane.
    const engine = new ScenarioEngine({
      scenario: scenarioWithBothTables(
        [pendingFrame(LATE_REFERENCE, EARLY_TICK_MS)],
        [attemptFrame(EARLY_TICK_MS)],
      ),
    });
    const pendingInvites = new FixturePendingInvites(engine);
    const feed = pendingInvites.openPendingFeed();

    engine.advance(EARLY_TICK_MS);

    await expect(drainFrames(feed)).resolves.toMatchObject([
      { status: "ready", reference: LATE_REFERENCE },
      { status: "unavailable", attempt: UNREACHED_ATTEMPT },
    ]);
  });

  it("orders the open-time walk by the same rule", async () => {
    // One due rule with two triggers, so the merge has to reach both: a fix that
    // reached only the advance would leave a feed opened after the tick — the deep
    // link's own case, since a protocol fire precedes any surface — reading in table
    // order still.
    const engine = new ScenarioEngine({
      scenario: scenarioWithBothTables(
        [pendingFrame(LATE_REFERENCE, LATER_TICK_MS)],
        [attemptFrame(EARLY_TICK_MS)],
      ),
    });
    const pendingInvites = new FixturePendingInvites(engine);

    engine.advance(PAST_BOTH_TICKS_MS);
    const openedAfter = pendingInvites.openPendingFeed();

    await expect(drainFrames(openedAfter)).resolves.toMatchObject([
      { status: "unavailable", attempt: UNREACHED_ATTEMPT },
      { status: "ready", reference: LATE_REFERENCE },
    ]);
  });
});
