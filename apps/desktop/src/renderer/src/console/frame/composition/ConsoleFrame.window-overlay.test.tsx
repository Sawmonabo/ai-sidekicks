// The window's one overlay body: that the frame mounts it, once, and where it does not.
//
// THREE CLAIMS, AND NONE OF THEM IS VISIBLE FROM EITHER SIDE OF THE SEAT. The seat's
// own suite proves it holds one occupant; the collaboration family's proves the body
// works. Only a driven window shows the frame reading the seat at all — and only a
// window with no session open shows the thing the placement exists for: a deep-link
// invitation reaching somebody who has opened nothing.
//
//   • **A window with no session mounts it.** This is the whole defect the placement
//     fixes. Mounted under the members section, the lifecycle's feeds opened only
//     while a session view was on screen, so a first-time recipient saw nothing.
//   • **A window WITH a session mounts exactly one.** Two would be two pairs of
//     channels in one window and two cards answering one single-use invitation.
//   • **An auxiliary window mounts none.** It is a single-purpose window with its own
//     bridge instance and no shared store, and the operating system delivers the deep
//     link to the main window.
//
// Every case drives the real `ConsoleRoot` against the fixture bridge the
// `console-unit` project compiles in, on the scenario that scripts two arrivals — so
// what is being read is the production composition and not a planted seat.

import { act, cleanup, type RenderResult } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { SESSIONS_HASH, mountConsole } from "./ConsoleRoot.test-support.js";

/** The scenario that delivers invitations on this window's deep link. */
const SCENARIO_WITH_ARRIVALS = "collaboration";

/** A window opened straight into a session, the way a saved link does. */
const WORKSPACE_HASH = "#/session/session-alpha";

/** A detached timeline: a window the deep link is never delivered to. */
const AUXILIARY_HASH = "#/window/timeline/session-alpha";

afterEach(() => {
  cleanup();
});

/** Open a window at one address on the scenario that scripts arrivals, and settle it. */
async function windowAt(hash: string): Promise<RenderResult> {
  window.location.hash = hash;
  const mounted = await mountConsole(undefined, undefined, SCENARIO_WITH_ARRIVALS);
  await act(async () => {
    await crossMacrotaskBoundary();
  });
  return mounted;
}

/** Every invitation notice on the document, wherever in the window it was drawn. */
function notices(mounted: RenderResult): readonly Element[] {
  return [...mounted.container.ownerDocument.querySelectorAll(".meridian-invite-notice")];
}

describe("the frame mounts the window's overlay body", () => {
  it("announces an arrival to a window that has no session open", async () => {
    const mounted = await windowAt(SESSIONS_HASH);
    expect(notices(mounted)).toHaveLength(1);
  });

  it("mounts exactly one with a session open", async () => {
    const mounted = await windowAt(WORKSPACE_HASH);
    expect(notices(mounted)).toHaveLength(1);
  });

  it("mounts none in an auxiliary window", async () => {
    const mounted = await windowAt(AUXILIARY_HASH);
    expect(notices(mounted)).toHaveLength(0);
  });

  it("negative control: a scenario that scripts no arrival announces nothing", async () => {
    // Without this every case above would pass over a frame that drew the notice
    // whether or not an invitation had come — and the auxiliary case would pass over
    // a frame that had stopped mounting the overlay anywhere at all.
    window.location.hash = SESSIONS_HASH;
    const mounted = await mountConsole();
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(notices(mounted)).toHaveLength(0);
  });
});
