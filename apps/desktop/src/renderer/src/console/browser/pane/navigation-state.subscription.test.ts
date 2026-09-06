// The stream that is served after nobody is listening, and the stream that breaks.
//
// A subscription is a resource with two ends, and the renderer only ever holds one
// of them. Between the call and its answer the pane can go, and the cleanup that
// runs in that window has nothing to close — so the arriving stream is closed by the
// arrival or by nothing at all, and "by nothing at all" costs one live bridge
// subscription and one live producer per open/close cycle, forever.
//
// The same call can also REJECT, and a served iterator can throw part-way through.
// Both were detached rejections nobody handled, and both left the pane in the state
// it holds before any read answers — no reading, no refusal — so every history
// control stayed disabled with nothing on screen saying why.

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse, type ConsoleRefusal } from "../../core/index.js";
import { useReportedNavigation } from "./navigation-state.js";
import {
  deferredSubscription,
  refusalOf,
  reportedStateOf,
  REPORTED_PAGE,
} from "./navigation-state.test-support.js";

describe("useReportedNavigation — a subscription that answers after the pane has gone", () => {
  it("closes it, because the cleanup that ran had nothing to close", async () => {
    const { bridge, serve, close } = deferredSubscription();
    const { unmount } = renderHook(() => useReportedNavigation(bridge, "pane-browser-1"));
    unmount();
    serve();
    await waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  it("negative control: a stream served to a live pane is drained, not closed on arrival", async () => {
    // Without this, closing every served stream on sight would satisfy the case
    // above and would also make the subscription useless: no reading would ever
    // reach the chrome, and every history control would stay disabled forever.
    const { bridge, serve, close } = deferredSubscription({
      events: [REPORTED_PAGE],
      staysOpen: true,
    });
    const { result } = renderHook(() => useReportedNavigation(bridge, "pane-browser-1"));
    serve();
    await waitFor(() => {
      expect(reportedStateOf(result.current)).toStrictEqual(REPORTED_PAGE);
    });
    expect(close).not.toHaveBeenCalled();
  });
});

// The producer that simply finishes.
//
// Not a failure, and not nothing: the pane WAS being told where the page is and is
// not being told now. Falling out of the loop left the bridge handle allocated until
// unmount and left the chrome holding the last frame — a URL in the address field, a
// history flag on each control — as though a subscription were still behind them.
describe("useReportedNavigation — a subscription that ends", () => {
  it("closes the stream once and says the reading is over", async () => {
    const subscription = deferredSubscription({ events: [REPORTED_PAGE], staysOpen: true });
    const { result } = renderHook(() =>
      useReportedNavigation(subscription.bridge, "pane-browser-1"),
    );
    subscription.serve();
    await waitFor(() => {
      expect(reportedStateOf(result.current)).toStrictEqual(REPORTED_PAGE);
    });

    subscription.finish();

    await waitFor(() => {
      expect(result.current.kind).toBe("ended");
    });
    expect(subscription.close).toHaveBeenCalledTimes(1);
    // The half the chrome reads: an ended subscription hands it no state, so nothing
    // it drew off the last frame outlives the producer.
    expect(reportedStateOf(result.current)).toBeUndefined();
    expect(refusalOf(result.current)).toBeUndefined();
  });

  it("ends the same way when the producer never reported anything at all", async () => {
    const subscription = deferredSubscription();
    const { result } = renderHook(() =>
      useReportedNavigation(subscription.bridge, "pane-browser-1"),
    );

    subscription.serve();

    await waitFor(() => {
      expect(result.current.kind).toBe("ended");
    });
    expect(subscription.close).toHaveBeenCalledTimes(1);
  });

  it("negative control: an unmounted pane publishes no ending and closes once", async () => {
    // The cleanup already closed the stream, and there is no surface left to tell. A
    // second close here would be the double-close the one-owner rule exists to
    // prevent, and a state write would be a report nobody sees.
    const subscription = deferredSubscription({ events: [REPORTED_PAGE], staysOpen: true });
    const { result, unmount } = renderHook(() =>
      useReportedNavigation(subscription.bridge, "pane-browser-1"),
    );
    subscription.serve();
    await waitFor(() => {
      expect(result.current.kind).toBe("served");
    });

    unmount();
    subscription.finish();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(subscription.close).toHaveBeenCalledTimes(1);
    expect(result.current.kind).toBe("served");
  });
});

// What a rejecting subscription refuses AS.
//
// The hook normalizes through `core/refusal.ts`'s `normalizeWireRejection`, which is
// the console's one rejection normalizer, and supplies only the pair that names this
// failure's own remedy. A second mapping stood in this module and re-derived three of
// that function's four arms; the case it was missing is the first one below, and it
// is what makes this block a control on the dedup rather than a restatement of it.
describe("useReportedNavigation — a subscription that rejects", () => {
  /** The refusal the hook settles on for a rejection, however the rejection arrived. */
  async function refusalForRejection(failure: unknown): Promise<ConsoleRefusal> {
    const subscription = deferredSubscription();
    const { result } = renderHook(() =>
      useReportedNavigation(subscription.bridge, "pane-browser-1"),
    );

    subscription.reject(failure);

    await waitFor(() => {
      expect(refusalOf(result.current)).toBeDefined();
    });
    const settled = refusalOf(result.current);
    if (settled === undefined) {
      throw new Error("the hook settled on no refusal after the subscription rejected");
    }
    return settled;
  }

  it("passes a refusal that travelled as a rejection through untouched", async () => {
    // The arm the retired mapping did not have: a refusal already names its own
    // author and code, and re-coding it here replaced the one a person would paste
    // into an issue with this module's generic pair.
    const raised = refuse("browser-view-host", "view-host-gone", "The host view was torn down.");

    expect(await refusalForRejection(raised)).toStrictEqual(raised);
  });

  it("keeps a typed wire envelope's own code and message", async () => {
    // Flattening `browser.pane_not_found` into this module's code would throw away
    // the only actionable half — a missing pane and a dead transport are different
    // next moves.
    expect(
      await refusalForRejection({ code: "browser.pane_not_found", message: "No such pane." }),
    ).toStrictEqual({
      code: "browser.pane_not_found",
      detail: "No such pane.",
      origin: "browser-navigation",
    });
  });

  it("refuses an untyped rejection under this module's own pair", async () => {
    const refusal = await refusalForRejection(new Error("the preload went away"));

    expect(refusal.code).toBe("navigation-subscription-failed");
    expect(refusal.origin).toBe("browser-navigation");
    // The sentence names the remedy for a subscription that stopped, which is a
    // different remedy from retrying one control.
    expect(refusal.detail).toContain("Closing the pane and opening it again");
  });

  it("negative control: the three arms do not all answer the same refusal", async () => {
    // Every case above reads one field of one arm, and all of them would pass over a
    // normalizer that answered a single constant. This is the case that fails on one.
    const codes = [
      (await refusalForRejection(refuse("browser-view-host", "view-host-gone", "Torn down."))).code,
      (await refusalForRejection({ code: "browser.pane_not_found", message: "No such pane." }))
        .code,
      (await refusalForRejection(new Error("the preload went away"))).code,
    ];

    expect(new Set(codes).size).toBe(codes.length);
  });
});
