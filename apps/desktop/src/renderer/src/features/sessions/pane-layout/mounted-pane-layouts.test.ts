// Which mounted pane layout a palette act reaches, and the refusal when none is mounted.
//
// The refusal arm is the half that fails silently: a row run from a window with no
// deck has nothing to act on, and a command that quietly did nothing would be
// indistinguishable from one that ran.

import { describe, expect, it } from "vitest";

import { PANE_LAYOUT_NOT_MOUNTED_REFUSAL, MountedPaneLayouts } from "./mounted-pane-layouts.js";
import { createSpyingPaneLayoutActs } from "./pane-layout-acts.test-support.js";

describe("which deck a command acts on", () => {
  it("performs on the newest mounted deck", () => {
    const seat = new MountedPaneLayouts();
    const first = createSpyingPaneLayoutActs();
    const second = createSpyingPaneLayoutActs();
    seat.adopt(first);
    seat.adopt(second);

    expect(seat.perform("focusNextPane")).toStrictEqual({
      status: "performed",
      act: "focusNextPane",
    });
    expect(second.focusNextPane).toHaveBeenCalledTimes(1);
    expect(first.focusNextPane).not.toHaveBeenCalled();
  });

  it("releases by identity, so an earlier unmount does not drop the newest", () => {
    const seat = new MountedPaneLayouts();
    const first = createSpyingPaneLayoutActs();
    const second = createSpyingPaneLayoutActs();
    const releaseFirst = seat.adopt(first);
    seat.adopt(second);
    releaseFirst();

    seat.perform("closeFocusedPane");
    expect(second.closeFocusedPane).toHaveBeenCalledTimes(1);
  });

  it("refuses rather than doing nothing when no deck is mounted", () => {
    const outcome = new MountedPaneLayouts().perform("focusNextPane");
    expect(outcome).toStrictEqual({ status: "refused", refusal: PANE_LAYOUT_NOT_MOUNTED_REFUSAL });
  });

  it("negative control: a seat holding one deck performs rather than refusing", () => {
    // Without this the case above would pass over a seat that refused every press.
    const seat = new MountedPaneLayouts();
    seat.adopt(createSpyingPaneLayoutActs());
    expect(seat.perform("focusNextPane").status).toBe("performed");
  });
});
