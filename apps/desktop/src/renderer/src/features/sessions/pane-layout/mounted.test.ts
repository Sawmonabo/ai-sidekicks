// Which mounted pane layout a palette act reaches, and the refusal when none is mounted.
//
// The refusal arm fails silently otherwise: a command that quietly did nothing would look like
// one that ran.

import { describe, expect, it } from "vitest";

import { PANE_LAYOUT_NOT_MOUNTED_REFUSAL, MountedPaneLayouts } from "./mounted.js";
import { createSpyingPaneLayoutActs } from "./acts.test-support.js";

describe("which pane layout a command acts on", () => {
  it("performs on the newest pane layout mounted in the window the act runs in", () => {
    const mountedLayouts = new MountedPaneLayouts();
    const first = createSpyingPaneLayoutActs();
    const second = createSpyingPaneLayoutActs();
    const inAnotherWindow = createSpyingPaneLayoutActs();
    mountedLayouts.adopt(first, document);
    mountedLayouts.adopt(second, document);
    // Mounted last, but in another window: an act run here never reaches it.
    mountedLayouts.adopt(inAnotherWindow, document.implementation.createHTMLDocument());

    expect(mountedLayouts.perform("focusNextPane", document)).toStrictEqual({
      status: "performed",
      act: "focusNextPane",
    });
    expect(second.focusNextPane).toHaveBeenCalledTimes(1);
    expect(first.focusNextPane).not.toHaveBeenCalled();
    expect(inAnotherWindow.focusNextPane).not.toHaveBeenCalled();
  });

  it("releases by identity, so an earlier unmount does not drop the newest", () => {
    const mountedLayouts = new MountedPaneLayouts();
    const first = createSpyingPaneLayoutActs();
    const second = createSpyingPaneLayoutActs();
    const releaseFirst = mountedLayouts.adopt(first, document);
    mountedLayouts.adopt(second, document);
    releaseFirst();

    mountedLayouts.perform("closeFocusedPane", document);
    expect(second.closeFocusedPane).toHaveBeenCalledTimes(1);
  });

  it("refuses rather than doing nothing when no pane layout is mounted", () => {
    const outcome = new MountedPaneLayouts().perform("focusNextPane", document);
    expect(outcome).toStrictEqual({ status: "refused", refusal: PANE_LAYOUT_NOT_MOUNTED_REFUSAL });
  });
});
