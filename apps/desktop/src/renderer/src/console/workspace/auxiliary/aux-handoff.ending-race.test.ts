// An ending that arrives before anything has rendered still reaches the hand-off.
//
// THE INTERLEAVING THIS IS ABOUT. The shell's ending report is one-shot — its `closed`
// listener sends it to the renderer that asked and forgets the window — so an ending
// that lands while nothing is subscribed is not late, it is gone. The subscriptions
// used to be opened by an effect above the hand-off, which runs after the detached
// projection COMMITS, so every ending between `detachPane` resolving and that commit
// reached nobody: the deck kept a placeholder over a dead window and the required
// crash notice was never rendered.
//
// NOTHING HERE RENDERS, deliberately. The defect lives in the gap between a promise
// settling and React committing, so a case that mounted a component would be asserting
// against whatever the renderer happened to schedule; driving the hand-off directly is
// what makes "before any effect" a property of the case rather than of the runner.

import { describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { AuxiliaryHandoff } from "./aux-handoff.js";
import {
  ModelledShell,
  SERVED_WINDOW_ID,
  refusingPlane,
  servingPort,
} from "./aux-handoff.test-support.js";

/** A detached timeline pane, and the shell that opened its window. */
async function detachedUnderModelledShell(): Promise<{
  readonly handoff: AuxiliaryHandoff;
  readonly shell: ModelledShell;
  readonly windowId: string;
}> {
  const shell = new ModelledShell();
  const handoff = new AuxiliaryHandoff({ auxiliaryWindows: shell.plane });
  await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });
  const windowId = shell.windowFor("pane-1", "session-1");
  expect(windowId).toBeDefined();
  return { handoff, shell, windowId: windowId ?? "" };
}

describe("AuxiliaryHandoff — an ending before the first render", () => {
  it("receives a crash reported in the turn the detach resolved in", async () => {
    const { handoff, shell, windowId } = await detachedUnderModelledShell();

    // No effect has run, no projection has committed, and nothing above the hand-off
    // has asked it to watch anything: this is the window the report used to fall into.
    expect(shell.reportWindowLost(windowId, "the window's renderer stopped")).toBe(true);
    // The queue is synchronous and the DRAIN is not, so the report is read some number
    // of chained turns later. The shared boundary rather than a count of them, per
    // `core/macrotask-boundary.test-support.ts`: a chain that grows one link deeper
    // stops being waited for, and the case then reports an absence that was in flight.
    await crossMacrotaskBoundary();

    expect(handoff.lostWindow("pane-1")?.lostReason).toBe("the window's renderer stopped");
    expect(handoff.detached()).toHaveLength(0);
  });

  it("receives an orderly return reported the same way", async () => {
    // The second signal, because the two are opened together and a fix that armed only
    // the crash watch would leave a window closed from its own header holding a
    // placeholder nothing ever clears.
    const { handoff, shell, windowId } = await detachedUnderModelledShell();

    // Asked of the PLANE rather than of the hand-off, because `returnToDeck` is the
    // case that never needed a signal: it drops its own record before the close is
    // even acknowledged. This is the window closing from its own header, which only
    // the shell can report.
    await shell.plane.closeAuxiliary({ windowId });
    await crossMacrotaskBoundary();

    expect(handoff.detached()).toHaveLength(0);
    // NOTHING is noted, which is the whole difference from the crash arm: the pane came
    // back because somebody asked for it.
    expect(handoff.lostWindow("pane-1")).toBeUndefined();
  });

  it("gives the pane back when its window ends before the detach resolves", async () => {
    // THE SECOND HALF OF THE SAME INTERLEAVING. The window is created and then dies
    // while the detach reply is still in flight, so the report arrives BEFORE the
    // record it has to be matched against exists. Both ending handlers dropped it, and
    // the fulfillment then filed a detached pane for a window that was already gone:
    // a placeholder over nothing, with the crash noted nowhere and no way to clear it.
    const shell = new ModelledShell();
    const handoff = new AuxiliaryHandoff({ auxiliaryWindows: shell.plane });
    shell.holdDetachReplies();

    const detaching = handoff.detach({
      paneId: "pane-1",
      kind: "timeline",
      sessionId: "session-1",
    });
    // Already open, because the shell mints the window before it answers — which is
    // what makes this an ending the renderer could really be told about.
    const windowId = shell.windowFor("pane-1", "session-1") ?? "";
    expect(shell.reportWindowLost(windowId, "the window's renderer stopped")).toBe(true);
    await crossMacrotaskBoundary();
    shell.releaseDetachReplies();
    await detaching;

    expect(handoff.detached()).toHaveLength(0);
    // The crash is still NOTED, which is the difference between giving the pane back
    // and pretending the press did nothing.
    expect(handoff.lostWindow("pane-1")?.lostReason).toBe("the window's renderer stopped");
  });

  it("keeps no record at all for a detach the plane refused", async () => {
    // The other end of the pending record: it is REMOVED on the refusal rather than
    // left standing. A record that outlived a detach which opened nothing would catch
    // the next report about that pane and file a crash note about a window this build
    // never created.
    const handoff = new AuxiliaryHandoff({ auxiliaryWindows: planeThatRefusesOnlyTheDetach() });

    const outcome = await handoff.detach({
      paneId: "pane-1",
      kind: "timeline",
      sessionId: "session-1",
    });

    expect(outcome.outcome).toBe("refused");
    expect(handoff.detached()).toHaveLength(0);
    expect(handoff.noteWindowLost("pane-1", SERVED_WINDOW_ID, "gone")).toBeUndefined();
    expect(handoff.lostWindows()).toHaveLength(0);
  });

  it("negative control: a detach the plane refused leaves no subscription open", async () => {
    // Without this the fix would arm both watches for every press, including one that
    // opened nothing — and their own refusal would then sit in a placeholder for a
    // window this build never created, which is the permanent-notice-about-a-hazard
    // shape the watches are scoped to avoid.
    const handoff = new AuxiliaryHandoff({ auxiliaryWindows: planeThatRefusesOnlyTheDetach() });

    const outcome = await handoff.detach({
      paneId: "pane-1",
      kind: "timeline",
      sessionId: "session-1",
    });

    expect(outcome.outcome).toBe("refused");
    expect(handoff.paneErrorRefusal).toBeUndefined();
    expect(handoff.paneReturnRefusal).toBeUndefined();
  });
});

/**
 * A plane that serves the subscriptions and refuses only the detach.
 *
 * Composed from the two ports the shared support module already declares rather than
 * hand-building a refusal here: a case that spelled its own would be asserting against
 * its own vocabulary rather than the one the port raises.
 */
function planeThatRefusesOnlyTheDetach(): ReturnType<typeof servingPort> {
  return { ...servingPort(), detachPane: refusingPlane().detachPane };
}
