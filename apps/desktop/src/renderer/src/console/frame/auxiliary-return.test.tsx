// The auxiliary window's own way back: the control it wears, and what pressing it
// does to the deck that is holding its slot.
//
// TWO CONSOLES OVER ONE SHELL, which is the production topology and the only way to
// assert the whole path. `Spec-023 §The surface set` gives an auxiliary window its own
// bridge instance and no shared store, so the window and the deck are two renderers —
// but they are two renderers of ONE shell, and the shell is what carries the return
// from the window that closed to the deck that was waiting. The fixture bridge stands
// in for that shell, so a case that hands one bridge to both halves is modelling what
// ships rather than shortcutting it.
//
// The deck's half is the hand-off, driven directly: what a deck DRAWS for a detached
// pane is `workspace/`'s to assert, and what the return does to the set behind that
// drawing is what this window's control is for.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { createRefusingGrowthPort } from "../bridge/growth-port/growth-port.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import { FLAGSHIP_SCENARIO } from "../bridge/scenarios/flagship.js";
import { AuxiliaryHandoff } from "../workspace/auxiliary/aux-handoff.js";
import { type ConsoleRefusal } from "../core/index.js";
import { type ConsoleRoute } from "../routing/index.js";
import { AuxiliaryReturn } from "./AuxiliaryReturn.js";

afterEach(() => {
  cleanup();
});

/** The pane these cases move into a window. */
const PANE_ID = "pane-timeline-1";

/** A control's label, which is also what a person is looking for. */
const RETURN_LABEL = /return it to the deck/i;

/** The control, as the button it is — so `disabled` is read rather than inferred. */
function returnControl(label: RegExp = RETURN_LABEL): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name: label });
}

/** The address a window a deck asked for is opened at. */
function detachedRoute(windowId: string): ConsoleRoute {
  return {
    kind: "auxiliary",
    route: "timeline",
    sessionId: FLAGSHIP_SCENARIO.sessionId,
    windowId,
  };
}

/** Move the pane into a window over `bridge`, and watch for its return. */
async function deckHoldingASlot(bridge: ConsoleBridge): Promise<{
  readonly handoff: AuxiliaryHandoff;
  readonly windowId: string;
}> {
  const handoff = new AuxiliaryHandoff({ growth: bridge.growth });
  const outcome = await handoff.detach({
    paneId: PANE_ID,
    kind: "timeline",
    sessionId: FLAGSHIP_SCENARIO.sessionId,
  });
  expect(outcome.outcome).toBe("detached");
  // Not awaited to completion: the promise resolves only when both drains end, and a
  // drain is a subscription's whole life.
  void handoff.watchWindowSignals();
  await crossMacrotaskBoundary();
  return { handoff, windowId: outcome.outcome === "detached" ? outcome.detached.windowId : "" };
}

const IGNORE_REFUSAL = (): void => undefined;

describe("the auxiliary window's return control", () => {
  it("gives the pane back to the deck, with no crash note", async () => {
    // The whole path, end to end: the window addresses the shell BY ITS OWN HANDLE,
    // the shell closes it and reports the return, and the deck's slot stops being a
    // placeholder. Before this the window could only close itself, which the deck
    // could not distinguish from a window that died — or, worse, could not hear at
    // all, leaving a placeholder for a window that no longer existed.
    const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
    const { handoff, windowId } = await deckHoldingASlot(bridge);
    render(
      <AuxiliaryReturn
        route={detachedRoute(windowId)}
        growth={bridge.growth}
        onRefused={IGNORE_REFUSAL}
      />,
    );

    fireEvent.click(returnControl());
    await crossMacrotaskBoundary();

    expect(handoff.detached()).toStrictEqual([]);
    // And the deck says nothing about it: this is a close somebody asked for.
    expect(handoff.lostWindows()).toStrictEqual([]);
    expect(handoff.paneErrorRefusal).toBeUndefined();
    expect(handoff.paneReturnRefusal).toBeUndefined();
  });

  it("negative control: a window the shell closed on its own still notes the crash", async () => {
    // The pin that keeps the two paths apart. Without it, the case above would pass
    // over a return that had simply replaced the crash path — and a window that died
    // would put its pane back saying nothing about why.
    const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
    const { handoff, windowId } = await deckHoldingASlot(bridge);

    // The shell's own act rather than the control's: nothing was pressed.
    expect(
      handoff.noteWindowLost(PANE_ID, `the window ${windowId} closed unexpectedly`),
    ).toBeDefined();

    expect(handoff.detached()).toStrictEqual([]);
    expect(handoff.lostWindow(PANE_ID)?.lostReason).toContain("closed unexpectedly");
  });

  it("draws nothing at all in a window no deck is holding a slot for", () => {
    // A window opened from the menu bar carries no handle, so there is no window for
    // it to address and no slot for its pane to go back to. A control offered here
    // would be offering a place that does not exist.
    const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });

    const { container } = render(
      <AuxiliaryReturn
        route={{ kind: "auxiliary", route: "timeline" }}
        growth={bridge.growth}
        onRefused={IGNORE_REFUSAL}
      />,
    );

    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("draws nothing in the main window either", () => {
    // The same suppression from the other side: the main window is not an auxiliary
    // one at all, and the discriminator is the handle rather than the chrome.
    const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });

    const { container } = render(
      <AuxiliaryReturn
        route={{ kind: "sessions" }}
        growth={bridge.growth}
        onRefused={IGNORE_REFUSAL}
      />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("states the growth refusal and offers the control again", async () => {
    // A close that could not be asked for leaves the window exactly where it was, so
    // the control comes back rather than staying spent. The refusal travels as the
    // port's own — a `GrowthUnavailable` IS a `ConsoleRefusal` — so nothing here
    // re-mints one and the sentence names the wire that is missing.
    const refusals: ConsoleRefusal[] = [];
    render(
      <AuxiliaryReturn
        route={detachedRoute("aux-window-1")}
        growth={createRefusingGrowthPort()}
        onRefused={(refusal) => {
          refusals.push(refusal);
        }}
      />,
    );

    fireEvent.click(returnControl());
    await crossMacrotaskBoundary();

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.code).toBe("wire-unregistered");
    expect(returnControl().disabled).toBe(false);
  });

  it("negative control: a served close spends the control rather than re-offering it", async () => {
    // Without this, the case above would pass over a control that never disabled at
    // all — and a second press would ask the shell to close a window it is already
    // closing, which the plane answers with a refusal about a window that is gone.
    const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
    const { windowId } = await deckHoldingASlot(bridge);
    render(
      <AuxiliaryReturn
        route={detachedRoute(windowId)}
        growth={bridge.growth}
        onRefused={IGNORE_REFUSAL}
      />,
    );

    fireEvent.click(returnControl());
    await crossMacrotaskBoundary();

    expect(returnControl(/returning it to the deck/i).disabled).toBe(true);
  });
});
