// Which panes pay for the overlay motion observation, read off
// `AirspaceRegistry.observedOverlayCount`, the live armings across every observer. The cost and
// its retirement are per pane.

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { airspaceRegistryFor } from "@renderer/lib/airspace-registries.js";
import { type AirspaceRegistry } from "@renderer/lib/airspace-registry.js";
import { RecordingPageHost } from "../geometry/geometry-publisher.test-support.js";
import {
  previewPaneContext,
  chromeFor,
  DEFAULT_TEST_PANE_ID,
  recordingActs,
} from "../PreviewPane.test-support.js";

/** The second pane, since the count is per pane. */
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
