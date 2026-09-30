// Which panes pay for the overlay motion observation. The pane that draws a native view is the
// only consumer that needs overlays sampled during a transition, so nothing else may install it.
// The suite reads `AirspaceRegistry.observedOverlayCount`, the live armings across every
// observer, on three states: a page host that accepts the rectangle (the positive control), a
// page host that declares the pane gone (the publisher disposes itself mid-frame), and two panes,
// since the cost and its retirement are per pane.

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { airspaceRegistryFor } from "@renderer/lib/airspace-registries.js";
import { refuse } from "@renderer/lib/refusal.js";
import { type AirspaceRegistry } from "@renderer/lib/airspace-registry.js";
import { RecordingPageHost } from "../geometry/geometry-publisher.test-support.js";
import { PAGE_HOST_REFUSAL_ORIGIN } from "../geometry/page-host.js";
import {
  previewPaneContext,
  chromeFor,
  DEFAULT_TEST_PANE_ID,
  recordingActs,
  releaseQueuedPaneFrames,
} from "../PreviewPane.test-support.js";

/** What the page host says when the pane it is addressing has been destroyed. */
const PANE_GONE = "This pane was closed while its view was still reporting.";

/** The second pane, for the case that is about the count being per pane. */
const SECOND_TEST_PANE_ID = "pane-browser-2";

type AirspaceOverlayRegistration = ReturnType<AirspaceRegistry["register"]>;

describe("Preview pane geometry — who watches this window's overlays move", () => {
  // One overlay per case, removed after it: the count is armings, so a leftover overlay would be
  // armed by the next case's pane.
  const registrations: AirspaceOverlayRegistration[] = [];

  afterEach(() => {
    for (const registration of registrations) {
      registration.remove();
    }
    registrations.length = 0;
  });

  /**
   * One overlay in this window's airspace, so an observer has something to arm. A real element,
   * because the registry arms only an overlay that handed one over.
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

  it("arms one observation for a pane whose page host accepts its rectangle", async () => {
    // The positive control: without it the other cases pass over a pane that watches nothing.
    registerOverlay();
    const built = previewPaneContext();
    await act(async () => {
      render(chromeFor(built, recordingActs(), new RecordingPageHost()));
    });

    expect(armedOverlayObservations()).toBe(1);
  });

  it("retires the observation when the page host says the pane is gone", async () => {
    registerOverlay();
    const pageHost = new RecordingPageHost();
    pageHost.rejectNextWith(refuse(PAGE_HOST_REFUSAL_ORIGIN, "pane-gone", PANE_GONE));
    const built = previewPaneContext();
    await act(async () => {
      render(chromeFor(built, recordingActs(), pageHost));
    });
    expect(armedOverlayObservations()).toBe(1);

    // The rejection lands on the frame the frozen clock is holding and the publisher disposes
    // itself, terminal because retrying would publish for a destroyed pane every frame. The
    // observation must go with it: the holder's own disposal does not run until the mount ends.
    await releaseQueuedPaneFrames(built.fixture);

    expect(armedOverlayObservations()).toBe(0);
  });

  it("costs one observation per pane, and none once both panes are gone", async () => {
    registerOverlay();
    const first = previewPaneContext(undefined, DEFAULT_TEST_PANE_ID);
    const second = previewPaneContext(first.fixture, SECOND_TEST_PANE_ID);
    let firstPane: ReturnType<typeof render> | undefined;
    let secondPane: ReturnType<typeof render> | undefined;
    await act(async () => {
      firstPane = render(chromeFor(first, recordingActs(), new RecordingPageHost()));
      secondPane = render(chromeFor(second, recordingActs(), new RecordingPageHost()));
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
