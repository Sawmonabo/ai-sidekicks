// The window has one live announcer, a raised banner reaches it, and it runs on the window's clock.
// A second announcer is a second speaker, and a region under `inert` would leave the accessibility
// tree, so a refusal raised inside a dialog would reach nobody.

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";
import { LIVE_ANNOUNCEMENT_HOLD_MS } from "@renderer/components/LiveAnnouncer/live-announcement-caps.js";
import type { WindowBanner } from "@renderer/store/window/window-store.js";
import { liveRegionOf, liveRegionText } from "@test/helpers/live-region.js";
import { AppFrame } from "./AppFrame.js";
import {
  CalmScreen,
  SESSIONS_ROUTE,
  backgroundOf,
  bridgeWrapper,
  frameProps,
  liveBridgeWrapper,
} from "@test/helpers/app-frame-fixtures.js";

/** A refusal wide enough for a banner: what the whole room can do has changed. */
const REFUSAL_BANNER: WindowBanner = {
  id: "banner-session-not-found",
  code: "session.not_found",
  detail: "That session could not be found, so no run can start here.",
  dismissible: false,
};

describe("AppFrame — the window has one live announcer, and the banner reaches it", () => {
  it("mounts exactly one region pair, empty, before anything is announced", () => {
    const { container } = render(
      <AppFrame {...frameProps(SESSIONS_ROUTE)}>
        <CalmScreen />
      </AppFrame>,
      { wrapper: liveBridgeWrapper() },
    );

    // One pair, not one per view: a second announcer anywhere is a second speaker.
    expect(container.querySelectorAll("[data-live-region]")).toHaveLength(2);
    expect(liveRegionText(container, "polite")).toBe("");
    expect(liveRegionText(container, "assertive")).toBe("");
  });

  it("keeps the regions outside the wrapper a modal overlay makes inert", () => {
    const { container } = render(
      <AppFrame {...frameProps(SESSIONS_ROUTE)} modalOverlayOpen>
        <CalmScreen />
      </AppFrame>,
      { wrapper: liveBridgeWrapper() },
    );

    // A region under `inert` leaves the accessibility tree, silencing a refusal raised in a dialog.
    const background = backgroundOf(container);
    expect(background.hasAttribute("inert")).toBe(true);
    expect(background.contains(liveRegionOf(container, "assertive"))).toBe(false);
  });

  it("announces a raised banner in the assertive region, and only when it is raised", () => {
    const { container, rerender } = render(
      <AppFrame {...frameProps(SESSIONS_ROUTE)}>
        <CalmScreen />
      </AppFrame>,
      { wrapper: liveBridgeWrapper() },
    );
    expect(liveRegionText(container, "assertive")).toBe("");

    rerender(
      <AppFrame {...frameProps(SESSIONS_ROUTE, [REFUSAL_BANNER])}>
        <CalmScreen />
      </AppFrame>,
    );

    expect(liveRegionText(container, "assertive")).toBe(REFUSAL_BANNER.detail);
    // The banner still renders; the announcer sits beside it.
    expect(container.querySelector(".meridian-refusal--banner")?.textContent).toContain(
      REFUSAL_BANNER.code,
    );
    // Polite stays silent: the assertive lane is reserved for refusals.
    expect(liveRegionText(container, "polite")).toBe("");
  });

  it("negative control: a banner that is merely still standing is not announced again", () => {
    // Without this, a frame announcing its whole banner list would repeat every standing refusal
    // on every render.
    //
    // The clock moves past the hold window first: inside it the announcer's own coalescing swallows
    // a repeat, so the control would pass whether or not the frame diffs.
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(
        <AppFrame {...frameProps(SESSIONS_ROUTE, [REFUSAL_BANNER])}>
          <CalmScreen />
        </AppFrame>,
        { wrapper: liveBridgeWrapper() },
      );
      expect(liveRegionText(container, "assertive")).toBe(REFUSAL_BANNER.detail);

      act(() => {
        vi.advanceTimersByTime(LIVE_ANNOUNCEMENT_HOLD_MS + 1);
      });
      expect(liveRegionText(container, "assertive")).toBe("");

      rerender(
        <AppFrame {...frameProps(SESSIONS_ROUTE, [REFUSAL_BANNER])} modalOverlayOpen>
          <CalmScreen />
        </AppFrame>,
      );

      expect(liveRegionText(container, "assertive")).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AppFrame — the announcer runs on the window's clock", () => {
  it("holds a fixture window's announcement until the scenario's own clock moves", () => {
    // In fixture mode the fixture clock is the only clock read; on wall time the region would clear
    // on runner speed, not on the scenario's beat. Fake timers stand in for wall time only.
    vi.useFakeTimers();
    try {
      const { bridge, scenarioEngine } = createFixtureBridge({
        scenario: CONCURRENT_STREAMING_SCENARIO,
      });
      const { container } = render(
        <AppFrame {...frameProps(SESSIONS_ROUTE, [REFUSAL_BANNER])}>
          <CalmScreen />
        </AppFrame>,
        { wrapper: bridgeWrapper(bridge, scenarioEngine.clock) },
      );
      expect(liveRegionText(container, "assertive")).toBe(REFUSAL_BANNER.detail);

      // Wall time far past the hold window clears nothing.
      act(() => {
        vi.advanceTimersByTime(LIVE_ANNOUNCEMENT_HOLD_MS * 2);
      });
      expect(liveRegionText(container, "assertive")).toBe(REFUSAL_BANNER.detail);

      // The hold is measured against the scenario's clock.
      act(() => {
        scenarioEngine.advance(LIVE_ANNOUNCEMENT_HOLD_MS + 1);
      });
      expect(liveRegionText(container, "assertive")).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("negative control: a live window's announcement clears on wall time", () => {
    // The other arm, over the real live bridge (`createStubBridge` is what the preload exposes):
    // without it the case above passes for an announcer that never clears.
    vi.useFakeTimers();
    try {
      const { container } = render(
        <AppFrame {...frameProps(SESSIONS_ROUTE, [REFUSAL_BANNER])}>
          <CalmScreen />
        </AppFrame>,
        { wrapper: liveBridgeWrapper() },
      );
      expect(liveRegionText(container, "assertive")).toBe(REFUSAL_BANNER.detail);

      act(() => {
        vi.advanceTimersByTime(LIVE_ANNOUNCEMENT_HOLD_MS + 1);
      });
      expect(liveRegionText(container, "assertive")).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});
