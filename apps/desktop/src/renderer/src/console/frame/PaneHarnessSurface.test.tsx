// The fixture pane harness: what it mounts, out of which board, and what it says
// when it can mount nothing.
//
// The harness is the only door in this revision through which a REGISTERED pane
// body can be opened in a running window, and the `terminal-instance-memory`
// budget's reading is a difference between two heaps taken across that door. So
// three of its properties are load-bearing for a number, not merely for a surface,
// and each has a case below:
//
//   • it resolves the body out of the pane board it was HANDED, so the endurance
//     tier measures the descriptor a family registered rather than a component
//     that happens to sit beside it;
//   • opening a second instance leaves the first one MOUNTED, so the per-instance
//     slope the budget's control compares is a slope and not a series of
//     replacements;
//   • every instance is handed the window's own bridge and stores, so the figure
//     covers the pane's store-bound state and not a pane bound to nothing.
//
// The body mounted here is a stub, deliberately: the subject of this file is the
// harness, and a real emulator under a DOM shim would answer questions about the
// shim. The real body is mounted by the endurance tier, in a real window, which is
// where the budget's own reading is taken.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createRefusingGrowthPort } from "../bridge/growth-port.js";
import { type ConsoleRoute } from "../routing/index.js";
import { ConsolePaneRegistry, type ConsolePaneContext, type PaneKind } from "../seats/index.js";
import { FrameStore } from "../store/index.js";
import { PaneHarnessSurface } from "./PaneHarnessSurface.js";
import { type ConsoleSurfaceContext } from "./surface-registry.js";

afterEach(cleanup);

/** The session every harness route below is addressed at. */
const HARNESS_SESSION_ID = "session-under-harness";

/** A test-attribute name, so a case can read what a mounted body was handed. */
const MOUNTED_PANE_ID_ATTRIBUTE = "data-harness-pane-id";

function harnessRoute(paneKind: string): ConsoleRoute {
  return { kind: "pane-harness", paneKind, sessionId: HARNESS_SESSION_ID };
}

/**
 * A board carrying one stub body for one kind.
 *
 * The REAL `ConsolePaneRegistry`, because the harness's resolve is the subject: a
 * hand-rolled lookup here would prove the test's lookup works. What is a stub is
 * the BODY, which reports the paneId and the bridge identity it was handed so the
 * cases below can read them off the tree.
 */
function boardWithStubBody(kind: PaneKind): ConsolePaneRegistry {
  const registry = new ConsolePaneRegistry();
  registry.register({
    kind,
    owner: "pane-harness-test",
    render: (context: ConsolePaneContext) => (
      <div
        {...{ [MOUNTED_PANE_ID_ATTRIBUTE]: context.paneId }}
        data-harness-session={context.sessionStore === undefined ? "absent" : "present"}
      />
    ),
  });
  return registry;
}

/**
 * The surface context a window would hand this surface.
 *
 * The frame store is the real class because the harness reads the route through it
 * in a running window; the two persistence stores are cast away because
 * constructing them opens a database to hand a surface that only passes them
 * through — `RouteSurface.test.tsx` and `legacy-surfaces.test.ts` cast for the same
 * reason.
 */
function surfaceContextFor(route: ConsoleRoute): ConsoleSurfaceContext {
  return {
    route,
    bridge: { growth: createRefusingGrowthPort() },
    frameStore: new FrameStore({ initialRoute: route }),
    // Present, so a case can tell "the harness passed the window's store through"
    // from "the harness passed nothing" — which is the difference between a pane
    // that holds session state and one that renders its not-bound absence.
    sessionStore: {},
    sessionStoreRegistry: {},
    uiStateStore: {},
    draftStore: {},
  } as unknown as ConsoleSurfaceContext;
}

function mountedPaneIds(): readonly string[] {
  return [...document.querySelectorAll(`[${MOUNTED_PANE_ID_ATTRIBUTE}]`)].map(
    (element) => element.getAttribute(MOUNTED_PANE_ID_ATTRIBUTE) ?? "",
  );
}

/**
 * Press a control the way a person does, and let React finish reacting.
 *
 * `act` rather than a bare `click()`: a real event lands outside React's batching,
 * so the commit it causes settles after the call rather than inside it — which
 * React reports as a warning and a case observes as a tree one render behind.
 */
async function pressControl(controlName: string, times = 1): Promise<void> {
  await act(async () => {
    for (let press = 0; press < times; press += 1) {
      screen.getByRole("button", { name: controlName }).click();
    }
    await Promise.resolve();
  });
}

describe("the fixture pane harness", () => {
  it("mounts nothing until it is asked to, and one body per ask", async () => {
    render(
      <PaneHarnessSurface
        context={surfaceContextFor(harnessRoute("terminal"))}
        paneRegistry={boardWithStubBody("terminal")}
      />,
    );

    // The measurement's baseline: the surface is open, the route is resolved, and
    // no instance is held. A harness that mounted one on arrival would fold that
    // instance into the baseline and report every later one as free.
    expect(mountedPaneIds()).toStrictEqual([]);
    expect(screen.getByText("terminal panes open: 0")).toBeTruthy();

    await pressControl("Open a pane");
    expect(mountedPaneIds()).toStrictEqual(["pane-harness-terminal-0"]);
    expect(screen.getByText("terminal panes open: 1")).toBeTruthy();
  });

  it("leaves the earlier instances mounted when another is opened", async () => {
    render(
      <PaneHarnessSurface
        context={surfaceContextFor(harnessRoute("terminal"))}
        paneRegistry={boardWithStubBody("terminal")}
      />,
    );
    await pressControl("Open a pane", 3);

    // Three distinct instances, in order, each with its own stable identity. This
    // is what makes the budget's slope check a slope: if opening the second
    // replaced the first, every reading after the baseline would be the cost of
    // ONE pane and the control would compare a number against itself.
    expect(mountedPaneIds()).toStrictEqual([
      "pane-harness-terminal-0",
      "pane-harness-terminal-1",
      "pane-harness-terminal-2",
    ]);

    await pressControl("Close the newest pane");
    expect(mountedPaneIds()).toStrictEqual(["pane-harness-terminal-0", "pane-harness-terminal-1"]);
  });

  it("hands each instance the window's own session store", async () => {
    render(
      <PaneHarnessSurface
        context={surfaceContextFor(harnessRoute("terminal"))}
        paneRegistry={boardWithStubBody("terminal")}
      />,
    );
    await pressControl("Open a pane");

    // The pane bodies this harness exists to measure read their state off the
    // window's stores, and a pane handed none renders its not-bound absence — a
    // surface that would sit well inside any budget while holding none of what the
    // budget is about.
    expect(
      document
        .querySelector(`[${MOUNTED_PANE_ID_ATTRIBUTE}]`)
        ?.getAttribute("data-harness-session"),
    ).toBe("present");
  });

  it("refuses an address that names no pane kind, by the parser's own code", () => {
    render(
      <PaneHarnessSurface
        context={surfaceContextFor(harnessRoute("not-a-pane-kind"))}
        paneRegistry={boardWithStubBody("terminal")}
      />,
    );

    // The console's one admission point for an untyped address decides this, and
    // its code reaches the screen verbatim rather than a sentence this surface
    // wrote.
    expect(screen.getByText(/pane-kind-unknown/u)).toBeTruthy();
    expect(mountedPaneIds()).toStrictEqual([]);
  });

  it("says a pane kind is reserved rather than stubbed when no family registered it", async () => {
    render(
      <PaneHarnessSurface
        context={surfaceContextFor(harnessRoute("terminal"))}
        // A real board that claims a DIFFERENT kind: `terminal` is a pane kind and
        // this composition has no body for it.
        paneRegistry={boardWithStubBody("browser")}
      />,
    );

    expect(screen.getByText("No family has registered a body for this pane kind.")).toBeTruthy();
    // The open control is inert, so a driver cannot mount an absence and count it.
    expect(screen.getByRole("button", { name: "Open a pane" }).hasAttribute("disabled")).toBe(true);
    await pressControl("Open a pane");
    expect(mountedPaneIds()).toStrictEqual([]);
  });

  it("negative control: it resolves out of the board it was handed, not a singleton", async () => {
    // Every case above reads bodies out of a board built here. Without this one
    // they would all pass over a harness that reached for `consolePaneRegistry` —
    // which the composition root fills with the production families, so `terminal`
    // would resolve and the assertions would still be green while the parameter
    // was doing nothing.
    render(
      <PaneHarnessSurface
        context={surfaceContextFor(harnessRoute("terminal"))}
        paneRegistry={new ConsolePaneRegistry()}
      />,
    );
    await pressControl("Open a pane");
    expect(mountedPaneIds()).toStrictEqual([]);
    expect(screen.getByText("No family has registered a body for this pane kind.")).toBeTruthy();
  });

  it("says so when it is mounted on an address it does not serve", () => {
    render(
      <PaneHarnessSurface
        context={surfaceContextFor({ kind: "workflows" })}
        paneRegistry={boardWithStubBody("terminal")}
      />,
    );
    expect(
      screen.getByText("This surface was mounted on an address it does not serve."),
    ).toBeTruthy();
  });
});
