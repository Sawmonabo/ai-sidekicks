// The hand-off, end to end over a real fixture bridge.
//
// ITS OWN SUITE BESIDE `aux-handoff.test.ts`, which drives the four gates against a
// hand-written port and is the right place for the gates themselves. What is asserted
// here is the other half: that the gates PASS over the bridge every fixture window,
// screenshot and browser-tier run is built on, so the deck's placeholder, its focus
// control and its return control are states a surface can actually be in. With the
// shell's window plane unserved, every one of these cases refused at gate 4 under
// every scenario there is — which is a surface nothing had drawn rather than a
// surface with a refusal in it.

import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../../bridge/index.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { FLAGSHIP_SCENARIO } from "../../bridge/scenarios/flagship.js";
import { AuxiliaryHandoff } from "./aux-handoff.js";

/** The pane these cases move into a window. */
const PANE_ID = "pane-timeline-1";

/** A hand-off over the flagship's own fixture bridge — the port under test. */
function handoffOverFixture(): AuxiliaryHandoff {
  const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
  return new AuxiliaryHandoff({ growth: bridge.growth });
}

describe("the hand-off over the fixture bridge", () => {
  it("detaches a timeline pane, focuses its window, and returns it to the deck", async () => {
    const handoff = handoffOverFixture();

    const outcome = await handoff.detach({
      paneId: PANE_ID,
      kind: "timeline",
      sessionId: FLAGSHIP_SCENARIO.sessionId,
    });

    expect(outcome.outcome).toBe("detached");
    expect(handoff.detached().map((pane) => pane.paneId)).toStrictEqual([PANE_ID]);
    // Both acts answer with `undefined`, which is this class's way of saying nothing
    // was refused. A refusal here is what the placeholder's two controls used to get
    // for every press.
    expect(await handoff.focus(PANE_ID)).toBeUndefined();
    expect(await handoff.returnToDeck(PANE_ID)).toBeUndefined();
    expect(handoff.detached()).toStrictEqual([]);
  });

  it("still refuses a pane kind that has no window route, over the same bridge", async () => {
    const handoff = handoffOverFixture();

    // The negative control for the served plane: gate 1 is a local fact and a served
    // wire must not have moved it. A plane that answered for any pane at all would
    // open a hardened window onto a route this build cannot render.
    const outcome = await handoff.detach({
      paneId: "pane-approvals-1",
      kind: "approvals",
      sessionId: FLAGSHIP_SCENARIO.sessionId,
    });

    expect(outcome.outcome).toBe("refused");
    if (outcome.outcome === "refused") {
      expect(outcome.refusal.code).toBe("kind-not-detachable");
    }
  });

  it("opens the crashed-window signal without refusing, so the slot states no fault", async () => {
    const handoff = handoffOverFixture();
    await handoff.detach({
      paneId: PANE_ID,
      kind: "timeline",
      sessionId: FLAGSHIP_SCENARIO.sessionId,
    });

    // Not awaited to completion: `watchPaneErrors` resolves only when the drain ends,
    // and the drain is the subscription's whole life. Crossing a macrotask boundary is
    // what lets the subscribe settle and the drain park on its first read.
    void handoff.watchPaneErrors();
    await crossMacrotaskBoundary();

    // The refusal this used to hold rendered in the placeholder as a permanent notice
    // about a hazard the window does not have.
    expect(handoff.paneErrorRefusal).toBeUndefined();
    handoff.stopWatchingPaneErrors();
  });
});
