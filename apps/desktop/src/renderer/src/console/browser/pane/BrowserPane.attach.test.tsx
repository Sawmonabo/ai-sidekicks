// What the pane does before it reads anything, and what it draws when it has no view.
//
// The binding's own lifetime is the suite beside this one. Here the claim is about the
// PANE: the view is asked for ahead of every read it makes, a refused view withholds
// those reads instead of opening them against a pane the host has said it has nothing
// for, and a window swapped underneath the pane asks the new one for a view of its own.
//
// THE ORDER IS THE SUBJECT AND NOT THE SETTLED STATE. A pane that attached and then
// subscribed and a pane that subscribed and then attached settle identically, so every
// assertion below reads the recorded call SEQUENCE rather than the tree afterwards.

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TEST_PANE_ID,
  browserPaneRegion,
  mountBrowserPaneForSubject,
} from "./BrowserPane.test-support.js";
import { calledOperations, recordedViewBridge } from "./view-binding.test-support.js";

/** The sentence a pane with no view renders in place of its chrome. */
const NO_VIEW_TITLE = "This pane has no page view.";

describe("the browser pane's view lifecycle", () => {
  it("asks for a view before it opens a single read", async () => {
    const recorded = recordedViewBridge({ attach: "served" });
    await mountBrowserPaneForSubject(recorded.bridge, DEFAULT_TEST_PANE_ID);

    const operations = calledOperations(recorded.calls);
    expect(operations[0]).toBe("attach");
    // Non-vacuous by construction: a pane that opened no reads at all would satisfy the
    // line above, so the reads have to be there for the ordering to mean anything.
    expect(operations).toContain("subscribe-navigation");
    expect(operations).toContain("subscribe-pages");
  });

  it("opens no read at all when the host says it has no view", async () => {
    const recorded = recordedViewBridge({ attach: "refused" });
    await mountBrowserPaneForSubject(recorded.bridge, DEFAULT_TEST_PANE_ID);

    expect(calledOperations(recorded.calls)).toStrictEqual(["attach"]);
  });

  it("says so on the pane's own surface rather than leaving it blank", async () => {
    const recorded = recordedViewBridge({ attach: "refused" });
    await mountBrowserPaneForSubject(recorded.bridge, DEFAULT_TEST_PANE_ID);

    // The pane keeps its region, so the deck's own close and the heading trail still
    // work — what it loses is the chrome over a page it does not have.
    expect(browserPaneRegion().textContent).toContain(NO_VIEW_TITLE);
    expect(screen.queryByLabelText("Destination")).toBeNull();
  });

  it("draws the chrome for a build that never asked for a view", async () => {
    // The negative control for the two cases above, and the one that keeps them honest:
    // every browser operation in this build refuses `wire-unregistered`, so a pane that
    // treated "nobody asked" as "the host said no" would render the absence for every
    // session — and both cases above would still pass.
    const recorded = recordedViewBridge({ attach: "unasked" });
    await mountBrowserPaneForSubject(recorded.bridge, DEFAULT_TEST_PANE_ID);

    expect(browserPaneRegion().textContent).not.toContain(NO_VIEW_TITLE);
    expect(screen.getByLabelText("Destination")).toBeTruthy();
    expect(calledOperations(recorded.calls)).toContain("subscribe-navigation");
  });

  it("asks the new window for a view when the bridge under the pane is replaced", async () => {
    // A pane keeps its `paneId` across a bridge swap, so a view asked for on the retired
    // window is a view in a window this pane is no longer in. The successor's log is
    // what says the question was put again rather than assumed answered.
    const retiredWindow = recordedViewBridge({ attach: "served" });
    const successorWindow = recordedViewBridge({ attach: "served" });
    const mount = await mountBrowserPaneForSubject(retiredWindow.bridge, DEFAULT_TEST_PANE_ID);

    await mount.rebindToBridge(successorWindow.bridge);

    expect(calledOperations(successorWindow.calls)[0]).toBe("attach");
    // And the retired window gets its view back, which is the other half of one act.
    expect(calledOperations(retiredWindow.calls)).toContain("detach");
  });
});
