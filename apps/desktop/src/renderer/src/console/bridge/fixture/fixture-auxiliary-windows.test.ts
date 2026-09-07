// The shell's window plane: what it mints, what it refuses, and the one act that
// puts a loss on the crashed-window signal.
//
// The plane is driven directly here, because what these cases assert is what the
// model does. That the deck's placeholder, focus control and return control are
// reachable THROUGH it is a claim about the wiring rather than about the model, so it
// is asserted where the wiring lives — `workspace/auxiliary/aux-handoff.fixture-served.test.ts`,
// which is also the side of the family DAG that may read this one.

import { describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { FixtureAuxiliaryWindowPlane } from "./fixture-auxiliary-windows.js";
import type { GrowthOutcome } from "../growth-port/index.js";

/** The pane a case moves into a window. Any deck-addressable key will do. */
const PANE_ID = "pane-timeline-1";

/** The served window handle, or a failure naming what came back instead. */
function servedWindowId(outcome: GrowthOutcome<{ readonly windowId: string }>): string {
  expect(outcome.status).toBe("served");
  return outcome.status === "served" ? outcome.value.windowId : "";
}

describe("the fixture's auxiliary-window plane", () => {
  it("mints a handle for a pane, and answers a second detach with the same one", () => {
    const plane = new FixtureAuxiliaryWindowPlane();

    const first = servedWindowId(plane.detachPane({ paneId: PANE_ID }));
    const second = servedWindowId(plane.detachPane({ paneId: PANE_ID }));

    // The negative control for the idempotence: a plane that minted per CALL would
    // hand back a second handle here, and the first window would be one nothing could
    // focus or close again — a pane's body in two windows at once, which is the state
    // the shell it stands in for cannot be in.
    expect(second).toBe(first);
    expect(plane.focusAuxiliary({ windowId: first }).status).toBe("served");
  });

  it("refuses a detach that names no pane, and mints nothing for it", () => {
    const plane = new FixtureAuxiliaryWindowPlane();

    const blank = plane.detachPane({ paneId: "   " });
    // The sweep in `fixture-growth-port.test.ts` addresses every served operation with
    // one request shape, so this arm is reached at runtime with no `paneId` at all.
    const absent = plane.detachPane({ paneId: undefined as unknown as string });

    expect(blank.status).toBe("unavailable");
    expect(absent.status).toBe("unavailable");
    if (blank.status === "unavailable") {
      // Never `wire-unregistered`: the fixture SERVES this operation, and naming an
      // unbuilt wire would send a reader to a document owing something this bridge
      // already stands in for.
      expect(blank.code).toBe("reply-unscripted");
    }
  });

  it("serves focus and close for a handle it opened, and refuses any other", () => {
    const plane = new FixtureAuxiliaryWindowPlane();
    const windowId = servedWindowId(plane.detachPane({ paneId: PANE_ID }));

    expect(plane.focusAuxiliary({ windowId }).status).toBe("served");
    expect(plane.focusAuxiliary({ windowId: "no-such-window" }).status).toBe("unavailable");
    expect(plane.closeAuxiliary({ windowId }).status).toBe("served");
    // Closed, so the handle is spent: a plane that went on answering for it would be
    // reporting an act on a window that is not there.
    expect(plane.focusAuxiliary({ windowId }).status).toBe("unavailable");
    expect(plane.closeAuxiliary({ windowId }).status).toBe("unavailable");
  });

  it("opens a pane-error signal that stays open and quiet", async () => {
    const plane = new FixtureAuxiliaryWindowPlane();
    const signal = plane.subscribePaneErrors();
    expect(signal.status).toBe("served");
    if (signal.status !== "served") {
      return;
    }

    let hasEnded = false;
    const drained: unknown[] = [];
    const drain = (async () => {
      for await (const paneError of signal.value.events) {
        drained.push(paneError);
      }
      hasEnded = true;
    })();

    await crossMacrotaskBoundary();
    // THE NEGATIVE CONTROL FOR THE WHOLE STREAM. An iterable that ended immediately
    // would satisfy every other case here and would reach the watch's drain as a
    // producer closing the signal — so every fixture window's placeholder would carry
    // "the signal that reports a lost window ended", a stated fault where nothing is
    // wrong. `hasEnded` false at this boundary is what says the signal is genuinely open.
    expect(hasEnded).toBe(false);
    expect(drained).toStrictEqual([]);

    signal.value.close();
    await drain;
    expect(hasEnded).toBe(true);
  });

  it("reports the shell closing a window, to every open signal, and forgets it", async () => {
    const plane = new FixtureAuxiliaryWindowPlane();
    const windowId = servedWindowId(plane.detachPane({ paneId: PANE_ID }));
    const signal = plane.subscribePaneErrors();
    expect(signal.status).toBe("served");
    if (signal.status !== "served") {
      return;
    }

    const losses: { readonly paneId: string; readonly reason: string }[] = [];
    const drain = (async () => {
      for await (const paneError of signal.value.events) {
        losses.push(paneError);
      }
    })();

    expect(plane.reportWindowClosedByShell("no-such-window", "gone")).toBe(false);
    expect(plane.reportWindowClosedByShell(windowId, "the window was closed")).toBe(true);
    await crossMacrotaskBoundary();

    expect(losses).toStrictEqual([{ paneId: PANE_ID, reason: "the window was closed" }]);
    // Reported AND forgotten: the pane is back in the deck, so the handle is spent
    // exactly as a close spends one.
    expect(plane.focusAuxiliary({ windowId }).status).toBe("unavailable");

    signal.value.close();
    await drain;
  });
});
