// Where the rail says the window is. The destination set is the routing folder's and the
// highlight is the rail's; only a driven window shows them agreeing, including a session screen
// sitting under the sessions destination. Cases drive the real `AppProviders` against the
// fixture bridge the `console-unit` project compiles in. Wiring beyond the rail is
// `providers.test.ts`; the token sheet is `AppBootstrap.tokens.test.ts`.

import { act, cleanup, fireEvent, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSIONS_HASH, mountApp, settleRegisteredBodies } from "@test/helpers/mount-app.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";

/** A window opened straight into a session, the way a saved link does. */
const SESSION_HASH = "#/session/session-alpha";

const WORKFLOWS_HASH = "#/workflows";

/** Click a rail destination by the label a person reads on it. */
async function clickRailDestination(mounted: RenderResult, label: string): Promise<void> {
  const button = mounted.getByLabelText(label);
  await act(async () => {
    fireEvent.click(button);
    await crossMacrotaskBoundary();
  });
  // The press warms its destination, and a loader-backed one arrives a chunk later.
  await settleRegisteredBodies();
}

/** Which destination the rail is showing as current, by its accessible name. */
function currentRailDestination(mounted: RenderResult): string | null {
  const current = mounted.container.querySelector("[aria-current='page']");
  return current === null ? null : current.getAttribute("aria-label");
}

describe("AppProviders — the rail's three destinations, and where the window is", () => {
  beforeEach(() => {
    window.location.hash = SESSION_HASH;
  });

  afterEach(() => {
    cleanup();
    window.location.hash = SESSIONS_HASH;
  });

  it("offers sessions, workflows, and settings, and nothing else", async () => {
    const mounted = await mountApp();

    const labels = [...mounted.container.querySelectorAll(".meridian-rail__button")].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels).toStrictEqual(["Sessions", "Workflows", "Settings"]);
  });

  it("puts a session screen under the sessions destination", async () => {
    // A session is inside the sessions destination; highlighting nothing would read as the
    // console losing track of where it is.
    const mounted = await mountApp();

    expect(currentRailDestination(mounted)).toBe("Sessions");
  });

  it("navigates to the workflows destination and highlights it", async () => {
    const mounted = await mountApp();

    await clickRailDestination(mounted, "Workflows");

    expect(window.location.hash).toBe(WORKFLOWS_HASH);
    expect(currentRailDestination(mounted)).toBe("Workflows");
    // Asserted on the workflows frame, since "something is on screen" would not notice the
    // reserved-screen absence rendering if the feature stopped registering.
    expect(mounted.container.querySelectorAll(".meridian-workflows-destination")).toHaveLength(1);
    expect(mounted.container.querySelector(".meridian-screen-notice")).toBeNull();
  });
});
