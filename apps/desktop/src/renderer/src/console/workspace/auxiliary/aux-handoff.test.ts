// Tearing a pane off into its own window, and the four different ways it is refused.
//
// The gates run in a fixed order and each one produces a DIFFERENT refusal, which
// is the whole point: "this kind cannot be detached", "this build cannot do it
// yet", "this pane does not name enough of a session", and "the wire is not
// registered" are four different sentences a person acts on differently. A single
// generic failure would collapse them into one shrug.

import { describe, expect, it } from "vitest";

import { createRefusingGrowthPort } from "../../bridge/growth-port/growth-port.js";
import { IMPLEMENTED_AUXILIARY_ROUTES } from "../../routing/index.js";
import { AuxiliaryHandoff } from "./aux-handoff.js";
import {
  WIRE_REJECTION_MESSAGE,
  detachingThenRejectingPort,
  rejectingPort,
  servingPort,
} from "./aux-handoff.test-support.js";

describe("AuxiliaryHandoff — what can be detached at all", () => {
  it("answers for a route this build implements without attempting anything", () => {
    const handoff = new AuxiliaryHandoff({ growth: createRefusingGrowthPort() });
    expect(handoff.canDetach("timeline")).toBe(true);
    expect(handoff.routeLabel("timeline")).toBe("Timeline");
  });

  it("says no to a kind that is not an auxiliary route, and offers it no label", () => {
    const handoff = new AuxiliaryHandoff({ growth: createRefusingGrowthPort() });
    expect(handoff.canDetach("terminal")).toBe(false);
    expect(handoff.routeLabel("terminal")).toBeUndefined();
  });

  it("says no to a route this build has not implemented yet", () => {
    // Being in the closed route set and being implemented in THIS build are two
    // separate facts, and this is the case that proves the second one is consulted.
    //
    // Driven through the constructor seam rather than against the module constant,
    // because BOTH routes are implemented on this build — the ledger's `timeline`
    // and the agents family's `agent-console` — so there is no member left to point
    // at, and a case that asserted the constant's contents would now be asserting
    // the opposite of what it was written to prove. The seam moves the FACT and
    // owns no copy of the rule.
    expect(IMPLEMENTED_AUXILIARY_ROUTES).toStrictEqual(["timeline", "agent-console"]);
    const handoff = new AuxiliaryHandoff({
      growth: createRefusingGrowthPort(),
      implementedRoutes: ["timeline"],
    });
    expect(handoff.canDetach("agent-console")).toBe(false);
    // The other side of the same read, so a seam wired to a constant list rather
    // than to the one it was handed would fail here.
    expect(handoff.canDetach("timeline")).toBe(true);
  });
});

describe("AuxiliaryHandoff — the four gates, in order", () => {
  it("refuses a kind that is no route at all", async () => {
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
    const outcome = await handoff.detach({
      paneId: "pane-1",
      kind: "terminal",
      sessionId: "session-1",
    });
    expect(outcome.outcome).toBe("refused");
    expect(outcome.outcome === "refused" && outcome.refusal.code).toBe("kind-not-detachable");
  });

  it("refuses a route whose body has not shipped, before touching the wire", async () => {
    // `servingPort()` would answer the detach, so an ordering defect here shows up
    // as a SERVED outcome rather than as a different refusal — which is the claim
    // the case name makes. The route is unimplemented by the seam, not by the build.
    const handoff = new AuxiliaryHandoff({
      growth: servingPort(),
      implementedRoutes: ["timeline"],
    });
    const outcome = await handoff.detach({
      paneId: "pane-1",
      kind: "agent-console",
      sessionId: "session-1",
      agentId: "agent-1",
    });
    expect(outcome.outcome === "refused" && outcome.refusal.code).toBe("route-not-implemented");
  });

  it("refuses a target the route's own grammar rejects, and echoes none of it", async () => {
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
    const outcome = await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "" });
    expect(outcome.outcome === "refused" && outcome.refusal.code).toBe("target-context-invalid");
    // The offending value is untrusted input the grammar refused; a refusal that
    // quoted it back would put it on screen.
    expect(outcome.outcome === "refused" && outcome.refusal.detail).not.toContain('""');
  });

  it("refuses when the wire is not registered, and says whose it is", async () => {
    const handoff = new AuxiliaryHandoff({ growth: createRefusingGrowthPort() });
    const outcome = await handoff.detach({
      paneId: "pane-1",
      kind: "timeline",
      sessionId: "session-1",
    });
    expect(outcome.outcome === "refused" && outcome.refusal.code).toBe("wire-unregistered");
    expect(handoff.detached()).toHaveLength(0);
  });

  it("negative control: all four gates pass and the pane is detached", async () => {
    // Without this, every case above would pass over a hand-off that refused
    // unconditionally, which is the one implementation that could never work.
    const handoff = new AuxiliaryHandoff({ growth: servingPort("aux-7") });
    const outcome = await handoff.detach({
      paneId: "pane-1",
      kind: "timeline",
      sessionId: "session-1",
    });
    expect(outcome.outcome).toBe("detached");
    expect(handoff.detachedPane("pane-1")?.windowId).toBe("aux-7");
    expect(handoff.detachedPane("pane-1")?.fragment).toContain("timeline");
  });
});

describe("AuxiliaryHandoff — the pane comes back", () => {
  it("drops the local record even when the close could not be delivered", async () => {
    // A window this process can no longer reach is a window whose pane must return
    // to the deck: leaving the placeholder up strands the pane somewhere nobody can
    // focus, which is strictly worse than one stray window.
    const handoff = new AuxiliaryHandoff({
      growth: {
        ...createRefusingGrowthPort(),
        windowDetachPane: async () => ({ status: "served", value: { windowId: "aux-1" } }),
      },
    });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });
    const refusal = await handoff.returnToDeck("pane-1");
    expect(refusal?.code).toBe("wire-unregistered");
    expect(handoff.detached()).toHaveLength(0);
  });

  it("returns the pane and keeps the reason when a window is lost rather than closed", async () => {
    // The reason is kept ON THE HAND-OFF and not merely handed back. A record returned
    // to the drain loop and held nowhere is gone by the time the deck draws the slot
    // it belongs in, which is exactly how the crash detail used to disappear.
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });
    const lost = handoff.noteWindowLost("pane-1", "the window closed unexpectedly");
    expect(lost?.lostReason).toBe("the window closed unexpectedly");
    expect(handoff.detached()).toHaveLength(0);
    expect(handoff.lostWindow("pane-1")?.lostReason).toBe("the window closed unexpectedly");
    expect(handoff.lostWindows()).toHaveLength(1);
  });

  it("publishes the loss, so a surface subscribed to it hears about the crash", async () => {
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });
    const readsAtPublish: (string | undefined)[] = [];
    const unsubscribe = handoff.subscribe(() => {
      readsAtPublish.push(handoff.lostWindow("pane-1")?.lostReason);
    });

    handoff.noteWindowLost("pane-1", "the window closed unexpectedly");
    unsubscribe();

    // The record is stored BEFORE the publish, so the first read a subscriber takes
    // already carries it rather than seeing the pane back with nothing to say.
    expect(readsAtPublish).toStrictEqual(["the window closed unexpectedly"]);
  });

  it("clears the crash record when the same pane is detached again", async () => {
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });
    handoff.noteWindowLost("pane-1", "the window closed unexpectedly");

    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });

    // The body is in a window again, so a note about the last window it was in is a
    // note about nothing.
    expect(handoff.lostWindow("pane-1")).toBeUndefined();
    expect(handoff.detached()).toHaveLength(1);
  });

  it("clears the crash record when the person dismisses it, and publishes that", async () => {
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });
    handoff.noteWindowLost("pane-1", "the window closed unexpectedly");
    let publishCount = 0;
    const unsubscribe = handoff.subscribe(() => {
      publishCount += 1;
    });

    handoff.dismissLostWindow("pane-1");
    handoff.dismissLostWindow("pane-1");
    unsubscribe();

    expect(handoff.lostWindows()).toHaveLength(0);
    // Once, for the dismissal that changed something. A second dismissal of a record
    // that is already gone publishes nothing.
    expect(publishCount).toBe(1);
  });

  it("negative control: a pane whose window was closed on purpose carries no crash record", async () => {
    // Without this, every case above would pass over a hand-off that recorded a loss
    // for every pane that left a window — and the deck would tell a person their
    // window crashed every time they pressed "Return it to the deck".
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });

    await handoff.returnToDeck("pane-1");

    expect(handoff.lostWindows()).toHaveLength(0);
  });

  it("publishes every change to its subscribers", async () => {
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
    const counts: number[] = [];
    const unsubscribe = handoff.subscribe((detached) => {
      counts.push(detached.length);
    });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });
    await handoff.returnToDeck("pane-1");
    unsubscribe();
    expect(counts).toStrictEqual([1, 0]);
  });

  it("does nothing for a pane it never detached", async () => {
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
    expect(await handoff.focus("pane-unknown")).toBeUndefined();
    expect(await handoff.returnToDeck("pane-unknown")).toBeUndefined();
    expect(handoff.noteWindowLost("pane-unknown", "gone")).toBeUndefined();
  });
});

describe("AuxiliaryHandoff — the wire rejects rather than answering", () => {
  // A `GrowthPort` method answers `served` or `unavailable`, and every caller above
  // branches on that pair. A REJECTION is outside it, and is what a live bridge does
  // when its transport is gone. Each case below drove a press that changed nothing
  // and said nothing before the settled call landed: no window, no placeholder, no
  // refusal — the fault reaching the console only as an unhandled rejection.
  //
  // All four calls the hand-off makes are here, the crashed-window subscription
  // included, because what is being claimed is one rule rather than four: the class
  // is the rejecting wire, not the operation that met it. The watch's own suite is
  // about ORDER and keeps its ordering cases.

  it("refuses the detach, in the same arm an unregistered wire lands in", async () => {
    const handoff = new AuxiliaryHandoff({ growth: rejectingPort() });
    const outcome = await handoff.detach({
      paneId: "pane-1",
      kind: "timeline",
      sessionId: "session-1",
    });
    expect(outcome.outcome).toBe("refused");
    expect(outcome.outcome === "refused" && outcome.refusal.code).toBe("wire-rejected");
    // The two are distinguishable on purpose: a wire that answered badly and a wire
    // that was never built are different facts about the build.
    expect(outcome.outcome === "refused" && outcome.refusal.detail).toContain(
      WIRE_REJECTION_MESSAGE,
    );
    expect(handoff.detached()).toHaveLength(0);
  });

  it("refuses the focus the placeholder offers, rather than reporting it done", async () => {
    const handoff = new AuxiliaryHandoff({ growth: detachingThenRejectingPort() });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });

    const refusal = await handoff.focus("pane-1");

    expect(refusal?.code).toBe("wire-rejected");
    expect(refusal?.detail).toContain(WIRE_REJECTION_MESSAGE);
  });

  it("returns the pane to the deck anyway, and still says the close was refused", async () => {
    // Both halves, because they are one rule: a window this process can no longer
    // reach is a window whose pane must come back, and the person is still told the
    // close did not land.
    const handoff = new AuxiliaryHandoff({ growth: detachingThenRejectingPort() });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });

    const refusal = await handoff.returnToDeck("pane-1");

    expect(refusal?.code).toBe("wire-rejected");
    expect(handoff.detached()).toHaveLength(0);
  });

  it("keeps a refusal on the crashed-window watch, rather than reporting calm", async () => {
    // The fourth call, and the one whose silence was worst: the watch installed no
    // stream and wrote no refusal, so the placeholder reported that nothing was wrong
    // over a crash signal that was never opened.
    const handoff = new AuxiliaryHandoff({ growth: rejectingPort() });

    await handoff.watchPaneErrors();

    expect(handoff.paneErrorRefusal?.code).toBe("wire-rejected");
    expect(handoff.paneErrorRefusal?.detail).toContain(WIRE_REJECTION_MESSAGE);
  });

  it("negative control: a wire that answers leaves no refusal on any of the four", async () => {
    // Without this, every case above would pass over a hand-off that refused every
    // call it made, which is the one implementation that could never work.
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
    const outcome = await handoff.detach({
      paneId: "pane-1",
      kind: "timeline",
      sessionId: "session-1",
    });

    expect(outcome.outcome).toBe("detached");
    expect(await handoff.focus("pane-1")).toBeUndefined();
    expect(await handoff.returnToDeck("pane-1")).toBeUndefined();
    // The watch answers `unavailable` on this port rather than rejecting, so its
    // refusal is the unregistered one — a different fact, which is the point.
    await handoff.watchPaneErrors();
    expect(handoff.paneErrorRefusal?.code).toBe("wire-unregistered");
  });
});
