// The two ways a bridge answer reaches this pane late, or not at all.
//
// Both concerns are about a moment the pane cannot be looking: a call that rejects
// instead of answering, and a geometry outcome recorded after the frame the pane
// would have had to wait for. They share a file because they share the seam — the
// host, mocked here and nowhere else — and because each is a claim about what is on
// screen when nothing arrived the way the happy path expected.

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConsoleBridge } from "../../bridge/index.js";
import { ConsoleRefusalError, refuse } from "../../core/index.js";
import {
  addressField,
  findRefusalBanner,
  fixtureBrowserBridge,
  liveBrowserBridge,
  navigationReportingBridge,
  paneViewHostRefusing,
  queryRefusalBanner,
  renderBrowserPane,
  reportedState,
} from "./BrowserPane.test-support.js";

// A bridge call that does not answer at all.
//
// Every control in this chrome crosses the preload boundary, and a boundary can fail
// in a way no outcome describes: a torn-down transport, a preload that never
// installed. That arrives as a REJECTED promise rather than an `unavailable` outcome,
// and a `.then` with one argument does not see it — the renderer reports an unhandled
// rejection into a console nobody is reading, and the pane keeps showing whatever was
// on screen before the click, which is indistinguishable from the click not landing.
//
// The claim each case makes is therefore two-part: the refusal is on screen, AND
// nothing was left unhandled. Either half alone passes against the defect.
describe("browser pane bridge rejections", () => {
  const TRANSPORT_FAILURE = new Error("the preload transport went away");

  /** The same bridge, with the navigation verbs rejecting instead of answering. */
  function withRejectingActs(bridge: ConsoleBridge, failure: unknown): ConsoleBridge {
    return {
      ...bridge,
      growth: {
        ...bridge.growth,
        browserNavigate: async () => Promise.reject(failure),
        browserGoBack: async () => Promise.reject(failure),
      },
    };
  }

  /**
   * The host's unhandled-rejection reporter, as much of it as this needs.
   *
   * Reached through `globalThis` and typed here rather than imported, because the
   * renderer's test program deliberately carries no Node types — adding them to
   * reach one listener would put the whole Node surface into the typegraph of every
   * renderer test, which is the leak `src/renderer/tsconfig.test.json` exists to
   * prevent. The renderer source itself never touches this; it is the test looking
   * at the runtime the test is running on.
   */
  interface UnhandledRejectionReporter {
    on(event: "unhandledRejection", listener: (reason: unknown) => void): void;
    off(event: "unhandledRejection", listener: (reason: unknown) => void): void;
  }

  /**
   * Run the case, let one macrotask turn pass, and hand back every unhandled
   * rejection reported in between.
   *
   * The turn is load-bearing: an unhandled rejection is reported at the END of a
   * turn, so a microtask flush would report clean against the defect as well as
   * against the fix. And a runtime with no reporter FAILS here rather than reporting
   * an empty list, because a check that quietly stops checking is worse than one
   * that was never written.
   */
  async function unhandledRejectionsDuring(run: () => Promise<void>): Promise<unknown[]> {
    const reporter = (globalThis as { readonly process?: UnhandledRejectionReporter }).process;
    if (reporter === undefined) {
      throw new Error("this runtime reports no unhandled rejections, so the case cannot run");
    }
    const reported: unknown[] = [];
    const record = (reason: unknown): void => {
      reported.push(reason);
    };
    reporter.on("unhandledRejection", record);
    try {
      await run();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    } finally {
      reporter.off("unhandledRejection", record);
    }
    return reported;
  }

  it("renders a rejected navigate as a refusal and leaves nothing unhandled", async () => {
    const { bridge } = navigationReportingBridge();
    let banner = "";
    const unhandled = await unhandledRejectionsDuring(async () => {
      await renderBrowserPane(withRejectingActs(bridge, TRANSPORT_FAILURE));
      fireEvent.change(addressField(), { target: { value: "https://example.invalid/page" } });
      fireEvent.submit(addressField().closest("form") as HTMLFormElement);
      banner = (await findRefusalBanner()).textContent ?? "";
    });
    expect(banner).toContain("navigation-call-failed");
    expect(unhandled).toStrictEqual([]);
  });

  it("covers the history controls through the same dispatch", async () => {
    // Back, Forward, Reload, Stop, and Navigate all go through one call site, so the
    // case that proves Back is the case that proves the other four.
    const { bridge, report } = navigationReportingBridge();
    let banner = "";
    const unhandled = await unhandledRejectionsDuring(async () => {
      await renderBrowserPane(withRejectingActs(bridge, TRANSPORT_FAILURE));
      report(reportedState("https://example.invalid/page", { canGoBack: true }));
      const back = await waitFor(() => {
        const control = screen.getByRole("button", { name: "Back" });
        expect(control).toHaveProperty("disabled", false);
        return control;
      });
      fireEvent.click(back);
      banner = (await findRefusalBanner()).textContent ?? "";
    });
    expect(banner).toContain("navigation-call-failed");
    expect(unhandled).toStrictEqual([]);
  });

  it("lets a refusal the bridge itself raised through, rather than restating it", async () => {
    // A failure that already names its origin and code is the more informative of
    // the two, and replacing it would lose the only part a person can search for.
    const { bridge } = navigationReportingBridge();
    const raised = new ConsoleRefusalError(
      refuse("preload", "bridge-torn-down", "The window's bridge was replaced mid-call."),
    );
    let banner = "";
    const unhandled = await unhandledRejectionsDuring(async () => {
      await renderBrowserPane(withRejectingActs(bridge, raised));
      fireEvent.change(addressField(), { target: { value: "https://example.invalid/page" } });
      fireEvent.submit(addressField().closest("form") as HTMLFormElement);
      banner = (await findRefusalBanner()).textContent ?? "";
    });
    expect(banner).toContain("bridge-torn-down");
    expect(banner).not.toContain("navigation-call-failed");
    expect(unhandled).toStrictEqual([]);
  });

  it("negative control: a navigation that is served raises no refusal at all", async () => {
    // Without this, a dispatch that refused unconditionally would satisfy every case
    // above and would put a refusal on screen after every successful navigation.
    const { bridge } = navigationReportingBridge();
    const serving: ConsoleBridge = {
      ...bridge,
      growth: {
        ...bridge.growth,
        browserNavigate: async () => ({ status: "served" as const, value: undefined }),
      },
    };
    await renderBrowserPane(serving);
    fireEvent.change(addressField(), { target: { value: "https://example.invalid/page" } });
    fireEvent.submit(addressField().closest("form") as HTMLFormElement);
    await waitFor(() => {
      expect(queryRefusalBanner()).toBeNull();
    });
  });
});

// Two acts in flight over one page, settling out of order.
//
// The reload/stop slot is one control that dispatches two acts, so an operator who
// stops a reload has two calls outstanding over the same pane — and the network the
// page is waiting on decides which of them answers first. A pane that rendered every
// completion as it landed finished that sequence showing the failure of the act the
// operator had already replaced, over a page whose newest act had just succeeded.
describe("browser pane overlapping acts", () => {
  /** A bridge whose reload hangs until the test settles it, and whose stop serves. */
  function withPendingReload(bridge: ConsoleBridge): {
    readonly bridge: ConsoleBridge;
    readonly rejectReload: (failure: unknown) => void;
  } {
    let settle: ((failure: unknown) => void) | undefined;
    return {
      rejectReload: (failure) => {
        settle?.(failure);
      },
      bridge: {
        ...bridge,
        growth: {
          ...bridge.growth,
          browserReload: async () =>
            new Promise((_resolve, reject) => {
              settle = reject;
            }),
          browserStopLoading: async () => ({ status: "served" as const, value: undefined }),
        },
      },
    };
  }

  /** Report a state, then hand back the reload/stop slot as it stands after it. */
  async function slotAfterReport(
    report: (state: ReturnType<typeof reportedState>) => void,
    state: ReturnType<typeof reportedState>,
    label: "Reload" | "Stop",
  ): Promise<HTMLElement> {
    report(state);
    return waitFor(() => {
      const control = screen.getByRole("button", { name: label });
      expect(control).toHaveProperty("disabled", false);
      return control;
    });
  }

  const PAGE = "https://example.invalid/page";

  it("keeps a superseded act's failure off the pane after a newer act was served", async () => {
    // The finding's exact interleaving. On the old code the pane finished here
    // showing the reload's failure, because every completion wrote the banner
    // regardless of which act the operator had run last.
    const { bridge, report } = navigationReportingBridge();
    const overlapping = withPendingReload(bridge);
    await renderBrowserPane(overlapping.bridge);

    fireEvent.click(await slotAfterReport(report, reportedState(PAGE), "Reload"));
    fireEvent.click(
      await slotAfterReport(report, reportedState(PAGE, { isLoading: true }), "Stop"),
    );
    await act(async () => {
      overlapping.rejectReload(new Error("the reload never answered"));
      await Promise.resolve();
    });

    expect(queryRefusalBanner()).toBeNull();
  });

  it("negative control: the same rejection still renders while it is the newest act", async () => {
    // Without this, a pane that swallowed every rejection would satisfy the case
    // above and would report nothing at all when the one act in flight failed.
    const { bridge, report } = navigationReportingBridge();
    const overlapping = withPendingReload(bridge);
    await renderBrowserPane(overlapping.bridge);

    fireEvent.click(await slotAfterReport(report, reportedState(PAGE), "Reload"));
    overlapping.rejectReload(new Error("the reload never answered"));

    expect((await findRefusalBanner()).textContent).toContain("navigation-call-failed");
  });
});

// What the pane says when the host answers after the first frame.
//
// `observe` reads now and writes next frame, so the outcome a pane could copy at
// attach is `undefined` by construction — the interesting ones all arrive later. The
// one that matters most is the host rejecting a rectangle for a pane it says is
// gone: the publisher disposes itself over it and stops, and if that sentence does
// not reach the surface the viewport goes on offering "no page yet" forever.
//
// NOTHING HERE MOCKS THE WIRING TABLE, and that is the correction. These cases used
// to replace `resolvePaneViewHost` outright, which made every one of them pass over a
// pane that called the real table with an empty options bag — so the attached path
// the table promises was exercised by no test and reached by no run. They drive the
// real table now, over the two bridges the console actually runs on.
describe("browser pane geometry outcomes", () => {
  const PANE_GONE = "The pane was destroyed while this window still held it.";

  it("publishes this pane's rectangle to the host the fixture bridge supplies", async () => {
    const published: string[] = [];
    const bridge: ConsoleBridge = {
      ...fixtureBrowserBridge(),
      paneViewHostScript: {
        transport: "scripted",
        holdsPane: (paneId) => {
          published.push(paneId);
          return { holds: true };
        },
      },
    };

    const { region } = await renderBrowserPane(bridge);

    await waitFor(() => {
      expect(published.length).toBeGreaterThan(0);
    });
    // The pane the rectangle is filed under is this pane, not whichever one the
    // window opened first.
    expect(new Set(published)).toStrictEqual(new Set(["pane-browser-1"]));
    // And with the host taking rectangles the sentence under the viewport falls
    // through to the next question down — the navigation wire nobody registered.
    await waitFor(() => {
      expect(region.textContent).toContain("is not registered on this build yet");
    });
  });

  it("renders the host's refusal, which lands after the frame the pane cannot wait for", async () => {
    const { region } = await renderBrowserPane(paneViewHostRefusing(PANE_GONE));
    await waitFor(() => {
      expect(region.textContent).toContain(PANE_GONE);
    });
  });

  it("renders the unavailable host's own sentence under a live bridge, and publishes nothing", async () => {
    // 12.11's third arm, reached through the real wiring table rather than asserted
    // about it: a live window has no view host today, so the publish is suppressed
    // and the pane says why instead of claiming it was never told which page it holds.
    const { region } = await renderBrowserPane(liveBrowserBridge());
    await waitFor(() => {
      expect(region.textContent).toContain("reports its rectangle to nothing");
    });
    expect(region.textContent).not.toContain("has not been told which page it holds");
  });

  it("negative control: the fixture bridge is not the unavailable arm", async () => {
    // Without this, a pane that suppressed every publish — which is what calling the
    // table with an empty bag did — would satisfy the refusal cases above and would
    // look correct in every fixture run and every screenshot.
    const { region } = await renderBrowserPane(fixtureBrowserBridge());
    await waitFor(() => {
      expect(region.textContent).toContain("is not registered on this build yet");
    });
    expect(region.textContent).not.toContain("reports its rectangle to nothing");
    expect(region.textContent).not.toContain(PANE_GONE);
  });
});
