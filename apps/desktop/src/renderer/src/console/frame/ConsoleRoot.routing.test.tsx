// The address a window opens at, and where the rail says the window is.
//
// Two claims, and neither is visible from the modules underneath.
//
//   • **A window opens at the address it was given.** The Window menu opens an
//     auxiliary window by URL, so the route the store starts on and the hash the
//     window was loaded with have to be the same fact. They were not: the store
//     began on the default route and adopted the hash one commit later, which left
//     the route-to-hash direction closing over `#/sessions` for that commit.
//   • **The rail names the three destinations and highlights where the window is.**
//     The destination set is the routing family's and the highlight is the rail's;
//     only a driven window shows them agreeing, and only a driven window shows a
//     session workspace sitting under the sessions destination rather than under
//     an icon that is not drawn.
//
// Every case drives the real `ConsoleRoot` against the fixture bridge the
// `console-unit` project compiles in. What the composition root wires beyond the
// address is `ConsoleRoot.test.tsx`; the token sheet is
// `ConsoleRoot.tokens.test.tsx`.

import { act, cleanup, fireEvent, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatRoute, type ConsoleRoute } from "../routing/index.js";
import { SESSIONS_HASH, mountConsole, settleRegisteredBodies } from "./ConsoleRoot.test-support.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";

/** An auxiliary window's address: a route the sessions list is not. */
const AUXILIARY_HASH = "#/window/timeline/session-alpha";

/** A window opened straight into a session, the way a saved link does. */
const WORKSPACE_HASH = "#/session/session-alpha";

const SETTINGS_HASH = "#/settings";

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

describe("ConsoleRoot — the window opens at the address it was given", () => {
  beforeEach(() => {
    window.location.hash = SESSIONS_HASH;
  });

  afterEach(() => {
    cleanup();
    window.location.hash = SESSIONS_HASH;
  });

  it("starts on the route parsed from the opening hash, and never passes through the default", async () => {
    window.location.hash = AUXILIARY_HASH;
    const observed: ConsoleRoute[] = [];

    await mountConsole((context) => observed.push(context.route));

    // The FIRST render already carries the auxiliary route. A store that adopted
    // the hash from an effect would render the sessions route once before it, and
    // that one commit is all the route-to-hash direction needs to overwrite the
    // address the window was opened at.
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.map(formatRoute)).not.toContain(SESSIONS_HASH);
    expect(observed[0]).toStrictEqual({
      kind: "auxiliary",
      route: "timeline",
      sessionId: "session-alpha",
    });
    expect(window.location.hash).toBe(AUXILIARY_HASH);
  });

  it("negative control: a window opened with no address still lands on the sessions route", async () => {
    // Without this, a frame that ignored the hash entirely and simply never
    // navigated would satisfy the case above.
    const observed: ConsoleRoute[] = [];

    await mountConsole((context) => observed.push(context.route));

    expect(observed[0]).toStrictEqual({ kind: "sessions" });
    expect(window.location.hash).toBe(SESSIONS_HASH);
  });
});

describe("ConsoleRoot — the rail's three destinations, and where the window is", () => {
  beforeEach(() => {
    window.location.hash = WORKSPACE_HASH;
  });

  afterEach(() => {
    cleanup();
    window.location.hash = SESSIONS_HASH;
  });

  it("offers sessions, workflows, and settings, and nothing else", async () => {
    // The defect: the rail shipped a Workspace destination where `Spec-023
    // §Console Design (Meridian)` §The surface set names Workflows, so the
    // destination that opens the workflow builder could not be reached at all and
    // one that has no address of its own carried an icon.
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

  it("keeps the session this window opened after the route leaves it", async () => {
    // `SessionStoreRegistry` does not close a session when the route moves on, so
    // the way back has to survive the move. It is read from the frame store rather
    // than from the route, which is the distinction the retained id exists for.
    let observed: string | undefined;
    const mounted = await mountConsole((context) => {
      observed = context.frameStore.lastOpenedSessionId;
    });

    await clickRailDestination(mounted, "Settings");
    expect(window.location.hash).toBe(SETTINGS_HASH);

    expect(observed).toBe("session-alpha");
  });

  it("negative control: a window that has opened no session retains none", async () => {
    // Without this, a store that returned a constant id would satisfy the case
    // above and offer a way back into a session this window was never in.
    window.location.hash = SESSIONS_HASH;
    let observed: string | undefined = "not-read";
    await mountConsole((context) => {
      observed = context.frameStore.lastOpenedSessionId;
    });

    expect(observed).toBeUndefined();
  });
});
