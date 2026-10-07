// A read's loading line: nothing while the read is inside the short delay, then its words as a
// line a person can see, not a shape with the words kept for assistive technology alone, said once
// through the app's announcer.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { liveRegionText } from "#test/helpers/live-region.js";
import { LiveAnnouncerProvider } from "../LiveAnnouncer/LiveAnnouncerProvider.js";
import { LOADING_NOTICE_DELAY_MS, LoadingNotice } from "./LoadingNotice.js";

afterEach(() => {
  cleanup();
});

describe("loading notice", () => {
  it("draws nothing inside the delay, then its words as a visible line it says once", () => {
    const clock = new ManualClock(0);
    const { container } = render(
      <LiveAnnouncerProvider clock={clock}>
        <LoadingNotice clock={clock} title="Reading settings…" />
      </LiveAnnouncerProvider>,
    );
    const drawnLine = (): Element | null => container.querySelector(".meridian-loading-notice");
    expect(drawnLine()).toBeNull();

    act(() => {
      clock.advance(LOADING_NOTICE_DELAY_MS - 1);
    });
    expect(drawnLine()).toBeNull();
    expect(liveRegionText(container, "polite")).toBe("");

    act(() => {
      clock.advance(1);
    });
    const line = drawnLine();
    expect(line?.textContent).toBe("Reading settings…");
    expect(line?.closest(".meridian-visually-hidden")).toBeNull();
    expect(line?.querySelector(".meridian-visually-hidden, [aria-hidden='true']")).toBeNull();
    expect(liveRegionText(container, "polite")).toBe("Reading settings…");
  });
});
