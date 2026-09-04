// What this pane is showing after the WINDOW under it changes.
//
// The sibling suites swap which pane a slot holds. This one swaps the bridge, which
// is the other half of the same subject and the half nothing was checking: a pane
// rebound to another bridge keeps its `paneId`, so a binding recorded against the
// pane alone still matched and the first committed render exposed the previous
// window's geometry outcome — a rectangle a retired host had accepted, presented
// under the new window's viewport — while the retired publisher was still armed.
//
// THE SEQUENCE IS THE SUBJECT, NOT THE SETTLED STATE. Both the defect and the fix
// settle on the same sentence, because the stale publisher is eventually replaced by
// the effect either way; what separates them is the COMMIT IN BETWEEN. So the probe
// below records the viewport on every commit and the assertions read the whole
// sequence — an assertion taken after the tree has settled passes over the defect.

import { useLayoutEffect } from "react";

import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConsoleBridge } from "../../bridge/index.js";
import { SCRIPTED_PANE_VIEW_HOST_TRANSPORT } from "../../bridge/index.js";
import {
  DEFAULT_TEST_PANE_ID,
  fixtureBrowserBridge,
  liveBrowserBridge,
  mountBrowserPaneForSubject,
} from "./BrowserPane.test-support.js";

/** What a window with no view host says under the viewport. */
const NO_HOST_SENTENCE = "reports its rectangle to nothing";

/** What a window whose host TOOK the rectangle falls through to saying instead. */
const HOST_TOOK_IT_SENTENCE = "is not registered on this build yet";

/**
 * A probe that records the viewport's text on every commit, in order.
 *
 * A layout effect with no dependency list, so it runs on every commit and reads the
 * DOM that commit just wrote — which is exactly the pass a correction made in a
 * passive effect has not run on yet. Mounted as a SIBLING declared after the pane, so
 * the pane's own subtree is in the document by the time this reads it.
 *
 * A factory over the sink rather than a component taking it as a prop, because the
 * mount takes a component TYPE: the type has to be stable across the rerenders, and
 * the sink is per case.
 */
function viewportCommitProbe(commits: string[]): React.ComponentType {
  return function ViewportCommitProbe(): null {
    useLayoutEffect(() => {
      commits.push(document.querySelector('[aria-label="Browser"]')?.textContent ?? "");
    });
    return null;
  };
}

/** A fixture bridge whose scripted host takes every rectangle and records the pane. */
function recordingBrowserBridge(publishedPaneIds: string[]): ConsoleBridge {
  return {
    ...fixtureBrowserBridge(),
    paneViewHostScript: {
      transport: SCRIPTED_PANE_VIEW_HOST_TRANSPORT,
      holdsPane: (paneId) => {
        publishedPaneIds.push(paneId);
        return { holds: true };
      },
    },
  };
}

/** The same, writing which WINDOW took the rectangle into a log two of them share. */
function labelledRecordingBridge(label: string, publishLog: string[]): ConsoleBridge {
  return {
    ...fixtureBrowserBridge(),
    paneViewHostScript: {
      transport: SCRIPTED_PANE_VIEW_HOST_TRANSPORT,
      holdsPane: () => {
        publishLog.push(label);
        return { holds: true };
      },
    },
  };
}

describe("browser pane rebound to another bridge", () => {
  it("never renders the retired window's published view under the new one", async () => {
    const commits: string[] = [];
    const mount = await mountBrowserPaneForSubject(
      recordingBrowserBridge([]),
      DEFAULT_TEST_PANE_ID,
      viewportCommitProbe(commits),
    );
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Browser" }).textContent).toContain(
        HOST_TOOK_IT_SENTENCE,
      );
    });

    // The swap. A live window has no view host, so every commit from here on owes
    // the unavailable host's own sentence.
    const commitsBeforeSwap = commits.length;
    await mount.rebindToBridge(liveBrowserBridge());

    const commitsAfterSwap = commits.slice(commitsBeforeSwap);
    expect(commitsAfterSwap.length).toBeGreaterThan(0);
    // The negative control lives inside this assertion rather than beside it: on the
    // binding that recorded the pane alone, the first of these carried the retired
    // host's accepted rectangle and this line is the one that goes red.
    for (const viewportText of commitsAfterSwap) {
      expect(viewportText).toContain(NO_HOST_SENTENCE);
      expect(viewportText).not.toContain(HOST_TOOK_IT_SENTENCE);
    }
  });

  it("detaches the publisher it is retiring before the successor attaches", async () => {
    // ONE ORDERED LOG RATHER THAN TWO COUNTERS, because the claim is about ORDER: two
    // counters can both be non-zero over an overlap, where a retired publisher goes
    // on writing rectangles to a host the window has left while its replacement is
    // already writing to the new one.
    const publishLog: string[] = [];
    const mount = await mountBrowserPaneForSubject(
      labelledRecordingBridge("retired", publishLog),
      DEFAULT_TEST_PANE_ID,
    );
    await waitFor(() => {
      expect(publishLog).toContain("retired");
    });

    await mount.rebindToBridge(labelledRecordingBridge("successor", publishLog));
    await waitFor(() => {
      expect(publishLog).toContain("successor");
    });

    // Non-vacuous by construction: an empty log makes both of these -1 and the
    // comparison false, and the two waits above are what put a label of each kind in
    // it before the order is read.
    expect(publishLog.lastIndexOf("retired")).toBeLessThan(publishLog.indexOf("successor"));
  });

  it("negative control: an unchanged subject keeps the binding it has", async () => {
    // Without this the two cases above would pass against a binding that considered
    // every render a rebind — which would mint a publisher per pass, re-arm every
    // observer, and never keep a rectangle long enough to dedupe one.
    const publishes: string[] = [];
    const bridge = recordingBrowserBridge(publishes);
    const mount = await mountBrowserPaneForSubject(bridge, DEFAULT_TEST_PANE_ID);
    await waitFor(() => {
      expect(publishes.length).toBeGreaterThan(0);
    });

    const publishesBeforeRerender = publishes.length;
    await mount.rebindToBridge(bridge);
    await mount.rebindTo(DEFAULT_TEST_PANE_ID);

    // A re-mint would publish the pane's rectangle again on attach; the same binding
    // publishes nothing, because nothing invalidated.
    expect(publishes.length).toBe(publishesBeforeRerender);
    expect(screen.getByRole("region", { name: "Browser" }).textContent).toContain(
      HOST_TOOK_IT_SENTENCE,
    );
  });
});
