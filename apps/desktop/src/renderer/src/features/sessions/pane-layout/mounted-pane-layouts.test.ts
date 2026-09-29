// Which mounted pane layout a palette act reaches, and the refusal when none is mounted.
//
// The refusal arm is the half that fails silently: a row run from a window with no
// pane layout has nothing to act on, and a command that quietly did nothing would be
// indistinguishable from one that ran.

import { describe, expect, it } from "vitest";

import { PANE_LAYOUT_NOT_MOUNTED_REFUSAL, MountedPaneLayouts } from "./mounted-pane-layouts.js";
import { createSpyingPaneLayoutActs } from "./pane-layout-acts.test-support.js";

describe("which pane layout a command acts on", () => {
  it("performs on the newest mounted pane layout", () => {
    const mountedLayouts = new MountedPaneLayouts();
    const first = createSpyingPaneLayoutActs();
    const second = createSpyingPaneLayoutActs();
    mountedLayouts.adopt(first);
    mountedLayouts.adopt(second);

    expect(mountedLayouts.perform("focusNextPane")).toStrictEqual({
      status: "performed",
      act: "focusNextPane",
    });
    expect(second.focusNextPane).toHaveBeenCalledTimes(1);
    expect(first.focusNextPane).not.toHaveBeenCalled();
  });

  it("releases by identity, so an earlier unmount does not drop the newest", () => {
    const mountedLayouts = new MountedPaneLayouts();
    const first = createSpyingPaneLayoutActs();
    const second = createSpyingPaneLayoutActs();
    const releaseFirst = mountedLayouts.adopt(first);
    mountedLayouts.adopt(second);
    releaseFirst();

    mountedLayouts.perform("closeFocusedPane");
    expect(second.closeFocusedPane).toHaveBeenCalledTimes(1);
  });

  it("refuses rather than doing nothing when no pane layout is mounted", () => {
    const outcome = new MountedPaneLayouts().perform("focusNextPane");
    expect(outcome).toStrictEqual({ status: "refused", refusal: PANE_LAYOUT_NOT_MOUNTED_REFUSAL });
  });

  it("negative control: a seat holding one pane layout performs rather than refusing", () => {
    // Without this the case above would pass over a seat that refused every press.
    const mountedLayouts = new MountedPaneLayouts();
    mountedLayouts.adopt(createSpyingPaneLayoutActs());
    expect(mountedLayouts.perform("focusNextPane").status).toBe("performed");
  });
});
