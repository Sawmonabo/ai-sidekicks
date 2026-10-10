// A `Text size` step must drop the row heights measured before it: a height kept from the old
// size would place every row under the reading position wrong, and the scrollbar would never
// settle. The step is the root's inline font size changing, as the appearance writes it, and the
// heights are the session's, which outlive the transcript's mount.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { RememberedRowHeights } from "#renderer/store/session/remembered-row-heights.js";
import { ViewportController } from "../controller.js";
import { useObserveDisplaySettings } from "./useObserveDisplaySettings.js";

afterEach(() => {
  document.documentElement.style.removeProperty("font-size");
});

describe("useObserveDisplaySettings", () => {
  it("drops the session's row heights when the root font size changes, and keeps them otherwise", async () => {
    const rememberedRowHeights = new RememberedRowHeights();
    const controller = new ViewportController({ clock: new ManualClock(), rememberedRowHeights });
    renderHook(() => {
      useObserveDisplaySettings(controller);
    });
    controller.measurements.acceptedHeight("row-1", 133);

    // Another style write that leaves the font size alone keeps every height.
    await act(async () => {
      document.documentElement.style.setProperty("--meridian-transcript-width", "44rem");
      await Promise.resolve();
    });
    expect(rememberedRowHeights.heightOf("row-1")).toBe(133);

    await act(async () => {
      document.documentElement.style.fontSize = "20px";
      await Promise.resolve();
    });
    expect(rememberedRowHeights.heightOf("row-1")).toBeUndefined();
  });
});
