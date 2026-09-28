// Where the rail says the window is.
//
// The rail names the three destinations and highlights where the window is. The
// destination set is the routing family's and the highlight is the rail's; only a
// driven window shows them agreeing, and only a driven window shows a session
// workspace sitting under the sessions destination rather than under an icon that is
// not drawn.
//
// Every case drives the real `ConsoleRoot` against the fixture bridge the
// `console-unit` project compiles in. What the composition root wires beyond the
// rail is `ConsoleRoot.test.tsx`; the token sheet is
// `ConsoleRoot.tokens.test.tsx`.

import { act, cleanup, fireEvent, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSIONS_HASH, mountConsole, settleRegisteredBodies } from "./ConsoleRoot.test-support.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";

/** A window opened straight into a session, the way a saved link does. */
const WORKSPACE_HASH = "#/session/session-alpha";

const WORKFLOWS_HASH = "#/workflows";

/** Click a rail destination by the label a person reads on it. */
async function clickRailDestination(mounted: RenderResult, label: string): Promise<void> {
  const button = mounted.getByLabelText(label);
  await act(async () => {
    fireEvent.click(button);
    await crossMacrotaskBoundary();
  });
  // The press warms the destination it navigates to, and a destination whose family
  // registered a loader arrives a chunk later. Waited through the shared helper rather
  // than a boundary count here, for the reason that helper gives.
  await settleRegisteredBodies();
}

/** Which destination the rail is showing as current, by its accessible name. */
function currentRailDestination(mounted: RenderResult): string | null {
  const current = mounted.container.querySelector("[aria-current='page']");
  return current === null ? null : current.getAttribute("aria-label");
}

describe("ConsoleRoot — the rail's three destinations, and where the window is", () => {
  beforeEach(() => {
    window.location.hash = WORKSPACE_HASH;
  });

  afterEach(() => {
    cleanup();
    window.location.hash = SESSIONS_HASH;
  });

  it("offers sessions, workflows, and settings, and nothing else", async () => {
    // The defect: the rail shipped a Workspace destination where the surface set names
    // Workflows, so the destination that opens the workflow builder could not be reached at
    // all and one that has no address of its own carried an icon.
    const mounted = await mountConsole();

    const labels = [...mounted.container.querySelectorAll(".meridian-rail__button")].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels).toStrictEqual(["Sessions", "Workflows", "Settings"]);
  });

  it("puts a session workspace under the sessions destination", async () => {
    // A window opened straight into a session is INSIDE the sessions destination,
    // which is where a person got there from. Highlighting nothing — the answer a
    // rail gives when the route names a destination it does not draw — reads as
    // the console losing track of where it is.
    const mounted = await mountConsole();

    expect(currentRailDestination(mounted)).toBe("Sessions");
  });

  it("navigates to the workflows destination and highlights it", async () => {
    const mounted = await mountConsole();

    await clickRailDestination(mounted, "Workflows");

    expect(window.location.hash).toBe(WORKFLOWS_HASH);
    expect(currentRailDestination(mounted)).toBe("Workflows");
    // The workflows family claims this slot, so the destination mounts the
    // definitions browser rather than the reserved-slot absence. Asserted on the
    // scope groups, which are the one thing only that surface renders: the frame
    // would happily render an absence here again if the family stopped registering,
    // and a check for "something is on screen" would not notice.
    expect(mounted.container.querySelectorAll(".meridian-workflow__scope-heading")).toHaveLength(3);
    expect(mounted.container.querySelector(".meridian-surface-absence")).toBeNull();
  });
});
