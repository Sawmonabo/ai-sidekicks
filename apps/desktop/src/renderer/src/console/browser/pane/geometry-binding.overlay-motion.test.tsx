// Which panes pay for the overlay motion observation, and for how long.
//
// The overlay set lives at the primitive layer and arms no frame inside it: the only
// consumer that needs an overlay sampled
// while a transition CARRIES it is one drawing a native view, so that consumer
// installs the observation and the idle-CPU budget's precondition is that nothing
// else does. The observation was installed when the binding was MINTED, which put it
// outside every terminal the publisher has — so this suite reads the airspace's own
// arming count through the pane, on the four states that separate the two readings:
//
//   • a window with no view host, where every publish is suppressed and the frame
//     loop was armed anyway;
//   • a window whose host is attached, which is the positive control that keeps the
//     other three from passing over an observation that is never installed at all;
//   • a pane the host has declared gone, where the publisher disposes itself mid-frame
//     and the observation used to survive it for the life of the mount;
//   • two panes, because the cost is per pane and the retirement has to be too.
//
// `AirspaceRegistry.observedOverlayCount` is the instrument rather than a spy on the
// observer: it counts the armings that are live right now across every installed
// observer, which is the number the budget is about, and it is the same getter the
// registry's own suite checks the "nothing is watching" floor with.

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { airspaceRegistryFor, type AirspaceRegistry } from "../../core/index.js";
import { BrowserPane } from "./BrowserPane.js";
import {
  browserPaneContext,
  DEFAULT_TEST_PANE_ID,
  liveBrowserBridge,
  paneViewHostRefusing,
  recordingBrowserBridge,
  releaseQueuedPaneFrames,
} from "./BrowserPane.test-support.js";

/** What the scripted host says when the pane it is addressing has been destroyed. */
const PANE_GONE = "This pane was closed while its view was still reporting.";

/** The second pane, for the case that is about the count being per pane. */
const SECOND_TEST_PANE_ID = "pane-browser-2";

type AirspaceOverlayRegistration = ReturnType<AirspaceRegistry["register"]>;

describe("browser pane geometry — who watches this window's overlays move", () => {
  // One overlay for the whole file, registered per case and removed after it: the
  // count this suite reads is armings, so an overlay left behind by a failed case
  // would be armed by the next case's pane and read as its own.
  const registrations: AirspaceOverlayRegistration[] = [];

  afterEach(() => {
    for (const registration of registrations) {
      registration.remove();
    }
    registrations.length = 0;
  });

  /**
   * One overlay in this window's airspace, so an installed observer has something to
   * arm and the count has something to report.
   *
   * A real element, because the registry arms only an overlay that handed one over —
   * an overlay whose rectangle is computed rather than laid out is correct through
   * `moved()` and is deliberately not watched.
   */
  function registerOverlay(): void {
    const element = document.createElement("div");
    document.body.append(element);
    registrations.push(
      airspaceRegistryFor(document).register(
        "dialog",
        () => ({ x: 0, y: 0, width: 10, height: 10 }),
        element,
      ),
    );
  }

  /** How many overlay armings this window is paying for right now. */
  function armedOverlayObservations(): number {
    return airspaceRegistryFor(document).observedOverlayCount;
  }

  it("arms nothing in a window that has no view host", async () => {
    // The live bridge publishes no scripted host, so 12.11's wiring table reaches its
    // unavailable arm and the publisher suppresses every publish. A frame sampler and
    // a document listener armed for a pane drawing nothing is the idle CPU the budget
    // forbids — and it is what the binding armed at mint time, before the host had
    // been consulted at all.
    registerOverlay();
    const built = browserPaneContext(liveBrowserBridge());
    await act(async () => {
      render(<BrowserPane {...built.context} />);
    });

    expect(armedOverlayObservations()).toBe(0);
  });

  it("arms one observation for a pane whose host is attached", async () => {
    // The positive control. Without it every other case here is satisfied by a pane
    // that watches nothing ever, which is the same overlay-yield defect from the
    // other side: a native view painted over a dialog that slid across it.
    registerOverlay();
    const built = browserPaneContext(recordingBrowserBridge(() => undefined));
    await act(async () => {
      render(<BrowserPane {...built.context} />);
    });

    expect(armedOverlayObservations()).toBe(1);
  });

  it("retires the observation when the host says the pane is gone", async () => {
    registerOverlay();
    const built = browserPaneContext(paneViewHostRefusing(PANE_GONE));
    await act(async () => {
      render(<BrowserPane {...built.context} />);
    });
    expect(armedOverlayObservations()).toBe(1);

    // The rejection lands on the frame this window's frozen clock is holding, and the
    // publisher disposes itself over it — terminal, because retrying would publish a
    // rectangle for a pane that no longer exists once per frame forever. The
    // observation is disposed with it or it is not disposed at all: the holder's own
    // disposal does not run until the mount ends.
    await releaseQueuedPaneFrames(built.bridge);

    expect(armedOverlayObservations()).toBe(0);
  });

  it("costs one observation per pane, and none once both panes are gone", async () => {
    registerOverlay();
    const bridge = recordingBrowserBridge(() => undefined);
    const first = browserPaneContext(bridge, DEFAULT_TEST_PANE_ID);
    const second = browserPaneContext(bridge, SECOND_TEST_PANE_ID);
    let firstPane: ReturnType<typeof render> | undefined;
    let secondPane: ReturnType<typeof render> | undefined;
    await act(async () => {
      firstPane = render(<BrowserPane {...first.context} />);
      secondPane = render(<BrowserPane {...second.context} />);
    });

    expect(armedOverlayObservations()).toBe(2);

    await act(async () => {
      firstPane?.unmount();
    });
    expect(armedOverlayObservations()).toBe(1);

    await act(async () => {
      secondPane?.unmount();
    });
    expect(armedOverlayObservations()).toBe(0);
  });
});
