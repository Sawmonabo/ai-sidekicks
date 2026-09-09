// A detached pane survives a navigation, and one session's windows are its own.
//
// THE DEFECT. The hand-off was held for the workspace MOUNT, and the workspace is keyed
// on the route's session inside a surface keyed on the route's address — so leaving a
// session unmounted it. The shell kept the auxiliary window open, because nobody asked
// it to close one, and the deck came back with an empty detached set: the pane rendered
// its body in the main window while its own window was rendering the same pane, and the
// return signal that window eventually sent named a pane no record matched.
//
// Driven with no renderer, because the property is about a LIFETIME rather than about a
// render: what a returning visit reads is decided by which object the registry hands
// back, and a case that mounted a component would be asserting that through whatever
// React scheduled in between.

import { describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { AuxiliaryHandoffRegistry } from "./aux-handoff-registry.js";
import { ModelledShell, servingPort } from "./aux-handoff.test-support.js";

const SESSION_ID = "session-1";
const OTHER_SESSION_ID = "session-2";

describe("AuxiliaryHandoffRegistry — a hand-off outlives the surface that read it", () => {
  it("hands a returning visit the record the first visit wrote", async () => {
    const shell = new ModelledShell();
    const registry = new AuxiliaryHandoffRegistry({ auxiliaryWindows: shell.plane });

    // The first visit: a pane goes into a window of its own.
    await registry
      .handoffFor(SESSION_ID)
      .detach({ paneId: "pane-1", kind: "timeline", sessionId: SESSION_ID });

    // The navigation away and back. Nothing is torn down here because nothing about
    // this registry is torn down by one — which is exactly the claim.
    const onReturning = registry.handoffFor(SESSION_ID);

    expect(onReturning.detached().map((pane) => pane.paneId)).toStrictEqual(["pane-1"]);
    // And the record still names the window the shell actually holds, so the way back
    // is the placeholder's own control rather than a second detach.
    expect(onReturning.detachedPane("pane-1")?.windowId).toBe(
      shell.windowFor("pane-1", SESSION_ID),
    );
  });

  it("still restores the pane when that window's return signal arrives afterwards", async () => {
    const shell = new ModelledShell();
    const registry = new AuxiliaryHandoffRegistry({ auxiliaryWindows: shell.plane });
    const handoff = registry.handoffFor(SESSION_ID);
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: SESSION_ID });
    const windowId = shell.windowFor("pane-1", SESSION_ID) ?? "";

    // The person navigates away and back, then closes the window from its own header.
    expect(registry.handoffFor(SESSION_ID)).toBe(handoff);
    await shell.plane.closeAuxiliary({ windowId });
    await crossMacrotaskBoundary();

    expect(registry.handoffFor(SESSION_ID).detached()).toHaveLength(0);
  });

  it("keeps two sessions' windows apart, even at the same pane id", async () => {
    // A deck mints `pane-N` per layout, so both sessions hold a `pane-1`. One
    // window-wide hand-off would have shown the second session a placeholder for the
    // first session's window.
    const registry = new AuxiliaryHandoffRegistry({ auxiliaryWindows: servingPort() });

    await registry
      .handoffFor(SESSION_ID)
      .detach({ paneId: "pane-1", kind: "timeline", sessionId: SESSION_ID });

    expect(registry.handoffFor(OTHER_SESSION_ID).detached()).toStrictEqual([]);
    expect(registry.handoffFor(SESSION_ID).detached()).toHaveLength(1);
  });

  it("tells only the session whose window crashed, at the same pane id", async () => {
    // THE FAN-OUT. Both decks hold a `pane-1`, so both hand-offs matched a crash
    // report that named only the pane: the session whose window was still open lost
    // its placeholder to another session's crash, and the pane it was showing in a
    // window of its own came back to the deck with a note about a window that never
    // died. One renderer holds every session's hand-off and the shell reports to the
    // renderer, so every hand-off in this window reads every report — which makes the
    // window handle the only thing in the report that can tell them apart.
    const shell = new ModelledShell();
    const registry = new AuxiliaryHandoffRegistry({ auxiliaryWindows: shell.plane });
    const stillOpen = registry.handoffFor(SESSION_ID);
    const crashing = registry.handoffFor(OTHER_SESSION_ID);
    await stillOpen.detach({ paneId: "pane-1", kind: "timeline", sessionId: SESSION_ID });
    await crashing.detach({ paneId: "pane-1", kind: "timeline", sessionId: OTHER_SESSION_ID });
    void stillOpen.watchWindowSignals();
    void crashing.watchWindowSignals();
    await crossMacrotaskBoundary();

    const crashedWindowId = shell.windowFor("pane-1", OTHER_SESSION_ID) ?? "";
    expect(shell.reportWindowLost(crashedWindowId, "the window's renderer stopped")).toBe(true);
    await crossMacrotaskBoundary();

    // The session that crashed hears about it, in its own pane's error slot.
    expect(crashing.detached()).toStrictEqual([]);
    expect(crashing.lostWindow("pane-1")?.lostReason).toBe("the window's renderer stopped");
    // And the session that did not is untouched: its pane is still in its window, and
    // its error slot still says nothing, because nothing about it went wrong.
    expect(stillOpen.detached().map((pane) => pane.paneId)).toStrictEqual(["pane-1"]);
    expect(stillOpen.lostWindow("pane-1")).toBeUndefined();
  });

  it("negative control: a disposed registry keeps no record and says so", async () => {
    // Without this the cases above would pass over a registry that never let go of
    // anything — which is a window's worth of subscriptions surviving the window.
    const registry = new AuxiliaryHandoffRegistry({ auxiliaryWindows: servingPort() });
    await registry
      .handoffFor(SESSION_ID)
      .detach({ paneId: "pane-1", kind: "timeline", sessionId: SESSION_ID });

    registry.dispose();

    expect(registry.isDisposed).toBe(true);
    expect(registry.handoffFor(SESSION_ID).detached()).toStrictEqual([]);
  });
});
