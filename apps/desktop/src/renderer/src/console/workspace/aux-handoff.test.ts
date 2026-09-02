// Tearing a pane off into its own window, and the four different ways it is refused.
//
// The gates run in a fixed order and each one produces a DIFFERENT refusal, which
// is the whole point: "this kind cannot be detached", "this build cannot do it
// yet", "this pane does not name enough of a session", and "the wire is not
// registered" are four different sentences a person acts on differently. A single
// generic failure would collapse them into one shrug.

import { describe, expect, it } from "vitest";

import { createRefusingGrowthPort, type GrowthPort } from "../bridge/growth-port.js";
import { IMPLEMENTED_AUXILIARY_ROUTES } from "../../../../shared/auxiliary-routes.js";
import { AuxiliaryHandoff } from "./aux-handoff.js";

/** A port that serves the three window operations and refuses everything else. */
function servingPort(windowId = "aux-window-1"): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    windowDetachPane: async () => ({ status: "served", value: { windowId } }),
    windowFocusAuxiliary: async () => ({ status: "served", value: undefined }),
    windowCloseAuxiliary: async () => ({ status: "served", value: undefined }),
  };
}

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
    // `agent-console` is a route in the closed set and is deliberately absent from
    // the implemented list until its body lands. The two facts are separate, and
    // this is the case that proves the second one is consulted.
    expect(IMPLEMENTED_AUXILIARY_ROUTES).not.toContain("agent-console");
    const handoff = new AuxiliaryHandoff({ growth: createRefusingGrowthPort() });
    expect(handoff.canDetach("agent-console")).toBe(false);
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
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
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
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });
    const lost = handoff.noteWindowLost("pane-1", "the window closed unexpectedly");
    expect(lost?.lostReason).toBe("the window closed unexpectedly");
    expect(handoff.detached()).toHaveLength(0);
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
