// The view a pane holds: asked for once, given back once, and never given back twice.
//
// The pane's own composition is the suite next door. This one drives the binding through
// its hook, because three of the claims below are about moments a rendered pane does not
// expose — a teardown reached while the attach is still in flight, an attach the host
// refused, and a host that answered the teardown and kept the view.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { consoleTripwires } from "../../core/tripwires.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { calledOperations, recordedViewBridge } from "./view-binding.test-support.js";
import { VIEW_BINDING_SITE, useBrowserPaneView } from "./view-binding.js";

const PANE_ID = "pane-browser-view";

/** Let the attach or teardown call settle and its publish commit. */
async function settle(): Promise<void> {
  await act(async () => {
    await crossMacrotaskBoundary();
  });
}

beforeEach(() => {
  consoleTripwires.setThrowOnReport(false);
  consoleTripwires.reset();
});

afterEach(() => {
  consoleTripwires.reset();
  consoleTripwires.setThrowOnReport(import.meta.env.DEV);
});

describe("the browser pane's view binding", () => {
  it("asks for a view exactly once and reports the page it was given", async () => {
    const recorded = recordedViewBridge({ attach: "served" });
    const { result, unmount } = renderHook(() => useBrowserPaneView(recorded.bridge, PANE_ID));
    await settle();

    expect(recorded.calls).toStrictEqual([{ operation: "attach", paneId: PANE_ID }]);
    expect(result.current).toMatchObject({ kind: "attached", page: { pageId: "page-1" } });
    unmount();
  });

  it("gives the view back when the pane goes, once and with its own pane id", async () => {
    const recorded = recordedViewBridge({ attach: "served" });
    const { unmount } = renderHook(() => useBrowserPaneView(recorded.bridge, PANE_ID));
    await settle();

    unmount();
    await settle();

    expect(calledOperations(recorded.calls)).toStrictEqual(["attach", "detach"]);
    expect(recorded.calls.at(-1)).toStrictEqual({ operation: "detach", paneId: PANE_ID });
  });

  it("gives nothing back when the attach was refused", async () => {
    // The negative control for the case above, and the one that matters most: a
    // teardown for a view that was never created names a pane the host never heard of,
    // and a host free to treat that as an error would turn every refused attach into a
    // second failure at unmount.
    const recorded = recordedViewBridge({ attach: "refused" });
    const { result, unmount } = renderHook(() => useBrowserPaneView(recorded.bridge, PANE_ID));
    await settle();

    expect(result.current).toMatchObject({ kind: "refused" });
    unmount();
    await settle();

    expect(calledOperations(recorded.calls)).toStrictEqual(["attach"]);
  });

  it("tells the two absences apart rather than reporting one as the other", async () => {
    // A build whose browser namespace is registered nowhere never asked, so the pane
    // draws its chrome; a host that answered and said no has taken a view away. Reported
    // as one arm, the first would tell a person the host refused a question nobody put.
    const recorded = recordedViewBridge({ attach: "unasked" });
    const { result, unmount } = renderHook(() => useBrowserPaneView(recorded.bridge, PANE_ID));
    await settle();

    expect(result.current).toMatchObject({ kind: "unasked" });
    unmount();
  });

  it("gives back a view that arrived after the pane had already gone", async () => {
    // Open and closed inside one round trip, which a deck invites: the reply lands on a
    // binding nothing renders, and the view it carries would otherwise be resident for
    // the life of the window with no renderer that knows it exists. The unmount runs
    // before anything is awaited, so the attach is genuinely still out.
    const recorded = recordedViewBridge({ attach: "served" });
    const { unmount } = renderHook(() => useBrowserPaneView(recorded.bridge, PANE_ID));
    unmount();
    await settle();
    await settle();

    expect(calledOperations(recorded.calls)).toStrictEqual(["attach", "detach"]);
  });

  it("records a host that answered the teardown and kept the view", async () => {
    // The pane has unmounted, so there is no surface left to render this on — the
    // diagnostic band is the only place a view still painting over a rectangle nothing
    // publishes can be seen at all.
    const recorded = recordedViewBridge({ attach: "served", detach: "refused" });
    const { unmount } = renderHook(() => useBrowserPaneView(recorded.bridge, PANE_ID));
    await settle();

    unmount();
    await settle();

    expect(consoleTripwires.firingCount("cleanup-refused")).toBe(1);
    const [report] = consoleTripwires.reports();
    expect(report?.site).toBe(VIEW_BINDING_SITE);
    expect(report?.detail).toContain(PANE_ID);
    expect(report?.detail).toContain("call-rejected");
  });

  it("records nothing for a teardown this build never put to a host", async () => {
    // The negative control for the record above. `wire-unregistered` means this
    // console's own port declined before any request left the process, so nothing
    // refused — a firing here would put V1's designed absence on the diagnostic band
    // once per browser pane anybody ever closed.
    const recorded = recordedViewBridge({ attach: "served", detach: "unasked" });
    const { unmount } = renderHook(() => useBrowserPaneView(recorded.bridge, PANE_ID));
    await settle();

    unmount();
    await settle();

    expect(calledOperations(recorded.calls)).toStrictEqual(["attach", "detach"]);
    expect(consoleTripwires.firingCount("cleanup-refused")).toBe(0);
  });
});
