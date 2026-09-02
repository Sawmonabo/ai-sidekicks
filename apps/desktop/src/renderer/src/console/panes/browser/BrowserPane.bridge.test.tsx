// The two ways a bridge answer reaches this pane late, or not at all.
//
// Both concerns are about a moment the pane cannot be looking: a call that rejects
// instead of answering, and a geometry outcome recorded after the frame the pane
// would have had to wait for. They share a file because they share the seam — the
// host, mocked here and nowhere else — and because each is a claim about what is on
// screen when nothing arrived the way the happy path expected.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleBridge } from "../../bridge/index.js";
import { ConsoleRefusalError, refuse } from "../../core/index.js";
import {
  PANE_VIEW_HOST_REFUSAL_ORIGIN,
  resolvePaneViewHost,
  type AttachedPaneViewHost,
  type PaneRectOutcome,
} from "../../browser/view-host.js";
import {
  addressField,
  findRefusalBanner,
  navigationReportingBridge,
  queryRefusalBanner,
  renderBrowserPane,
  reportedState,
} from "./BrowserPane.test-support.js";

// The view host is the ONE seam this pane resolves rather than takes, and 12.11's
// wiring table hands every window an unavailable one until a main-process host
// exists. Spied rather than replaced, so every case that does not name a host runs
// against the real table and gets the real answer.
vi.mock(import("../../browser/view-host.js"), { spy: true });

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

// What the pane says when the host answers after the first frame.
//
// `observe` reads now and writes next frame, so the outcome a pane could copy at
// attach is `undefined` by construction — the interesting ones all arrive later. The
// one that matters most is the host rejecting a rectangle for a pane it says is
// gone: the publisher disposes itself over it and stops, and if that sentence does
// not reach the surface the viewport goes on offering "no page yet" forever.
describe("browser pane geometry outcomes", () => {
  const PANE_GONE = "The pane was destroyed while this window still held it.";

  afterEach(() => {
    vi.mocked(resolvePaneViewHost).mockRestore();
  });

  /** A host that takes rectangles and answers however the case says. */
  function hostAnswering(answer: () => PaneRectOutcome): AttachedPaneViewHost {
    return { state: "attached", transport: "test", setRect: answer };
  }

  it("renders the host's refusal, which lands after the frame the pane cannot wait for", async () => {
    vi.mocked(resolvePaneViewHost).mockReturnValue(
      hostAnswering(() => ({
        status: "rejected",
        refusal: refuse(PANE_VIEW_HOST_REFUSAL_ORIGIN, "pane-gone", PANE_GONE),
      })),
    );
    const { region } = await renderBrowserPane();
    await waitFor(() => {
      expect(region.textContent).toContain(PANE_GONE);
    });
  });

  it("negative control: a host that takes the rectangle raises no refusal", async () => {
    // Without this, a viewport that rendered a refusal unconditionally would satisfy
    // the case above and would report a destroyed pane on every mount. With the host
    // taking rectangles, the sentence under the viewport falls through to the next
    // question down — the navigation wire nobody has registered.
    vi.mocked(resolvePaneViewHost).mockReturnValue(hostAnswering(() => ({ status: "accepted" })));
    const { region } = await renderBrowserPane();
    await waitFor(() => {
      expect(region.textContent).toContain("is not registered on this build yet");
    });
    expect(region.textContent).not.toContain(PANE_GONE);
  });
});
