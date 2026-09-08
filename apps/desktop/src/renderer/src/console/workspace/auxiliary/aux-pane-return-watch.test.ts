// The orderly-return signal, from the deck's side: a window closed itself, and the
// pane's body comes back with nothing said about it.
//
// Split from `aux-pane-error-watch.test.ts`, which owns the ORDER properties both
// watches share — a reply that arrives after its watch was stopped, a detach behind a
// stop, a drain whose stream was closed underneath it. Those are one implementation
// now (`aux-window-signal-watch.ts`) and are asserted once, there. What is asserted
// here is the half that is this signal's own: which set a return writes into, which
// one it must NOT write into, and that a report about a window this pane has left
// reaches nothing.
//
// Every case drives the hand-off's own surface rather than the watch directly,
// because the delegation is part of what has to hold — and the two cases that can be
// are driven over a modelled shell, where the close is the identical plane call the
// auxiliary window's own header control makes.

import { describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { FLAGSHIP_SCENARIO } from "../../bridge/scenarios/flagship.js";
import { AuxiliaryHandoff } from "./aux-handoff.js";
import { ModelledShell, refusingPlane, servingPort } from "./aux-handoff.test-support.js";
import { type ConsoleAuxiliaryWindowPort } from "./aux-window-signal-watch.js";

/** The pane these cases move into a window. */
const PANE_ID = "pane-timeline-1";

/**
 * A hand-off over a modelled shell, and the plane beneath it.
 *
 * A model rather than the fixture bridge, which no longer answers a detach in a
 * browser-mode run at all: the fixture uses the real shell where there is one and
 * refuses where there is not, so the window bookkeeping these cases are about is
 * scaffolding now — see `ModelledShell`.
 */
function overModelledShell(): {
  readonly handoff: AuxiliaryHandoff;
  readonly auxiliaryWindows: ConsoleAuxiliaryWindowPort;
} {
  const shell = new ModelledShell();
  return {
    handoff: new AuxiliaryHandoff({ auxiliaryWindows: shell.plane }),
    auxiliaryWindows: shell.plane,
  };
}

/** Detach the pane and open both signals, which is the state every case starts in. */
async function detachedAndWatching(handoff: AuxiliaryHandoff): Promise<string> {
  const outcome = await handoff.detach({
    paneId: PANE_ID,
    kind: "timeline",
    sessionId: FLAGSHIP_SCENARIO.sessionId,
  });
  expect(outcome.outcome).toBe("detached");
  // Not awaited to completion: `watchWindowSignals` resolves only when both drains
  // end, and a drain is a subscription's whole life.
  void handoff.watchWindowSignals();
  await crossMacrotaskBoundary();
  return outcome.outcome === "detached" ? outcome.detached.windowId : "";
}

describe("AuxiliaryHandoff — the orderly-return signal", () => {
  it("puts the pane back with no crash note when a window closes itself", async () => {
    // THE GAP THIS CLOSES. A window closed from its own header is a close this
    // process did not perform, so without the signal the deck went on showing a
    // placeholder — and a focus control — for a window that no longer exists, until
    // the person reloaded.
    const { handoff, auxiliaryWindows } = overModelledShell();
    const windowId = await detachedAndWatching(handoff);

    // The identical plane call the window's own control makes.
    expect((await auxiliaryWindows.closeAuxiliary({ windowId })).status).toBe("served");
    await crossMacrotaskBoundary();

    expect(handoff.detached()).toStrictEqual([]);
    // And nothing is said about it. A return routed through the crash signal would
    // leave a note in the pane's error slot about a close somebody asked for.
    expect(handoff.lostWindows()).toStrictEqual([]);
    expect(handoff.paneErrorRefusal).toBeUndefined();
    expect(handoff.paneReturnRefusal).toBeUndefined();
  });

  it("negative control: the pane stays in its window until a return is reported", async () => {
    // Without this, the case above would pass over a watch that cleared the detached
    // set the moment it opened — which is a placeholder that never appears at all.
    const { handoff } = overModelledShell();
    await detachedAndWatching(handoff);

    await crossMacrotaskBoundary();

    expect(handoff.detached()).toHaveLength(1);
  });

  it("ignores a return naming a window this pane is no longer in", async () => {
    // A pane that came back can be detached again into a SECOND window, so a report
    // about the first arriving late would otherwise suppress a body that is currently
    // in the second — a slot showing a placeholder for a window nobody closed.
    const { handoff } = overModelledShell();
    await detachedAndWatching(handoff);

    expect(handoff.noteWindowReturned(PANE_ID, "some-other-window")).toBeUndefined();

    expect(handoff.detached()).toHaveLength(1);
  });

  it("negative control: a return naming the recorded window does restore the pane", async () => {
    // Without this, the case above would pass over a method that ignored every
    // report, which is the state the deck was in before this signal existed.
    const { handoff } = overModelledShell();
    const windowId = await detachedAndWatching(handoff);

    expect(handoff.noteWindowReturned(PANE_ID, windowId)).toBeDefined();

    expect(handoff.detached()).toStrictEqual([]);
  });

  it("negative control: a window the shell closed still leaves the crash note", async () => {
    // The other half of the distinction, over a port whose crash signal speaks: the
    // return path must not have made a LOST window quiet. A pane that silently
    // reappears tells the person nothing about why.
    const handoff = new AuxiliaryHandoff({
      auxiliaryWindows: {
        ...servingPort(),
        subscribePaneErrors: async () => ({
          status: "served",
          value: {
            events: (async function* deliver() {
              await Promise.resolve();
              yield { paneId: PANE_ID, reason: "the window closed unexpectedly" };
              await new Promise<void>(() => undefined);
            })(),
            close: () => undefined,
          },
        }),
      },
    });
    await handoff.detach({ paneId: PANE_ID, kind: "timeline", sessionId: "session-1" });

    void handoff.watchWindowSignals();
    await crossMacrotaskBoundary();

    expect(handoff.detached()).toStrictEqual([]);
    expect(handoff.lostWindows()).toHaveLength(1);
    expect(handoff.lostWindow(PANE_ID)?.lostReason).toBe("the window closed unexpectedly");
  });

  it("states the refusal where the return signal is not served, rather than calm", async () => {
    // A build that cannot subscribe cannot notice a window closing itself, and a
    // placeholder showing nothing would be claiming none has. It is read on its own
    // getter rather than fused with the crash signal's, because the two refusals say
    // different things about what this window will and will not notice.
    const handoff = new AuxiliaryHandoff({
      auxiliaryWindows: {
        ...refusingPlane(),
        detachPane: async () => ({ status: "served", value: { windowId: "aux-1" } }),
      },
    });
    await handoff.detach({ paneId: PANE_ID, kind: "timeline", sessionId: "session-1" });

    await handoff.watchWindowSignals();

    expect(handoff.paneReturnRefusal?.code).toBe("shell-absent");
    // An unreceived signal is a notice about what is no longer being watched, never
    // an act that returns anything.
    expect(handoff.detached()).toHaveLength(1);
  });

  it("negative control: the fixture's served return signal leaves no refusal", async () => {
    // Without this, the case above would pass over a watch that refused the moment it
    // opened — a permanent notice on a window whose signal is healthy.
    const { handoff } = overModelledShell();
    await detachedAndWatching(handoff);

    expect(handoff.paneReturnRefusal).toBeUndefined();
    handoff.stopWatchingWindowSignals();
  });
});
