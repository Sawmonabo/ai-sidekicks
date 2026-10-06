// A `Text size` step must drop the row heights measured before it: a height kept from the old
// size would place every row under the reading position wrong, and the scrollbar would never
// settle. The step is the root's inline font size changing, as the appearance writes it.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX } from "../constants.js";
import { ViewportController } from "../viewport-controller.js";
import { useObserveDisplaySettings } from "./useObserveDisplaySettings.js";

/** A height no estimate could produce, so a kept prior is told from a dropped one. */
const MEASURED_HEIGHT_PX = TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX + 37;

afterEach(() => {
  document.documentElement.style.removeProperty("font-size");
});

describe("useObserveDisplaySettings", () => {
  it("drops the measured heights when the root font size changes, and keeps them otherwise", async () => {
    const controller = new ViewportController({ clock: new ManualClock() });
    renderHook(() => {
      useObserveDisplaySettings(controller);
    });
    controller.measurements.acceptedHeight("row-1", MEASURED_HEIGHT_PX);

    // Another style write that leaves the font size alone keeps every height.
    await act(async () => {
      document.documentElement.style.setProperty("--meridian-transcript-width", "44rem");
      await Promise.resolve();
    });
    expect(controller.measurements.acceptedHeight("row-1", 0)).toBe(MEASURED_HEIGHT_PX);

    await act(async () => {
      document.documentElement.style.fontSize = "20px";
      await Promise.resolve();
    });
    // An observation of zero is no measurement, so the answer is the prior, or the estimate
    // where the prior was dropped.
    expect(controller.measurements.acceptedHeight("row-1", 0)).toBe(
      TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX,
    );
  });
});
