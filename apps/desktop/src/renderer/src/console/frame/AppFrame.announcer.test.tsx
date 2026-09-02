// The window has one live announcer, a raised banner reaches it, and it runs on
// the window's own clock.
//
// The regions are the frame's because they have to outlive every surface in it and
// sit outside the `inert` wrapper; the banner is their first consumer because a
// refusal that changes what the whole room can do is the frame's own event. So the
// count is a claim in its own right — a second announcer anywhere in the window is
// a second speaker — and so is where the regions sit relative to the wrapper a
// modal overlay inerts, because a region under `inert` leaves the accessibility
// tree and a refusal raised from inside a dialog would be announced to nobody.
//
// Which CLOCK the announcer holds its message on belongs here rather than beside
// the primitive: `Spec-023 §Console Design (Meridian)` §The fixture bridge makes the
// fixture clock the only clock the renderer reads in fixture mode, the announcer
// arms the one timeout the idle-CPU budget counts, and the frame is what resolves
// the clock for the window. Both arms are cases and each is the other's control.

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { FLAGSHIP_SCENARIO } from "../bridge/scenarios/flagship.js";
import { LIVE_ANNOUNCEMENT_HOLD_MS } from "../core/index.js";
import type { FrameBanner } from "../store/index.js";
import { AppFrame } from "./AppFrame.js";
import {
  CalmSurface,
  SESSIONS_ROUTE,
  backgroundOf,
  bridgeWrapper,
  frameProps,
  liveBridgeWrapper,
} from "./AppFrame.test-support.js";

/** A refusal wide enough for a banner: what the whole room can do has changed. */
const REFUSAL_BANNER: FrameBanner = {
  id: "banner-node-detached",
  code: "runtimenode.permission_denied",
  detail: "That runtime node is no longer attached, so no run can start here.",
  dismissible: false,
};

/** The running engine, or a failure that names what was missing rather than `undefined`. */
function scenarioEngineOf(bridge: ConsoleBridge): NonNullable<ConsoleBridge["scenarioEngine"]> {
  const engine = bridge.scenarioEngine;
  if (engine === undefined) {
    throw new Error("the fixture bridge exposed no scenario engine");
  }
  return engine;
}

function liveRegion(container: HTMLElement, politeness: "polite" | "assertive"): HTMLElement {
  const region = container.querySelector<HTMLElement>(`[data-live-region="${politeness}"]`);
  if (region === null) {
    throw new Error(`the frame mounted no ${politeness} live region`);
  }
  return region;
}

describe("AppFrame — the window has one live announcer, and the banner reaches it", () => {
  it("mounts exactly one region pair, empty, before anything is announced", () => {
    const { container } = render(
      <AppFrame {...frameProps(SESSIONS_ROUTE)}>
        <CalmSurface />
      </AppFrame>,
      { wrapper: liveBridgeWrapper() },
    );

    // One PAIR, not one per surface: the count is the claim, because a second
    // announcer anywhere in the window is a second speaker.
    expect(container.querySelectorAll("[data-live-region]")).toHaveLength(2);
    expect(liveRegion(container, "polite").textContent).toBe("");
    expect(liveRegion(container, "assertive").textContent).toBe("");
  });

  it("keeps the regions outside the wrapper a modal overlay makes inert", () => {
    const { container } = render(
      <AppFrame {...frameProps(SESSIONS_ROUTE)} modalOverlayOpen>
        <CalmSurface />
      </AppFrame>,
      { wrapper: liveBridgeWrapper() },
    );

    // A region under `inert` leaves the accessibility tree, so a refusal raised
    // from inside a dialog would be announced to nobody.
    const background = backgroundOf(container);
    expect(background.hasAttribute("inert")).toBe(true);
    expect(background.contains(liveRegion(container, "assertive"))).toBe(false);
  });

  it("announces a raised banner in the assertive region, and only when it is raised", () => {
    const { container, rerender } = render(
      <AppFrame {...frameProps(SESSIONS_ROUTE)}>
        <CalmSurface />
      </AppFrame>,
      { wrapper: liveBridgeWrapper() },
    );
    expect(liveRegion(container, "assertive").textContent).toBe("");

    rerender(
      <AppFrame {...frameProps(SESSIONS_ROUTE, [REFUSAL_BANNER])}>
        <CalmSurface />
      </AppFrame>,
    );

    expect(liveRegion(container, "assertive").textContent).toBe(REFUSAL_BANNER.detail);
    // The banner keeps rendering exactly as it did; the announcer is beside it and
    // not a replacement for it.
    expect(container.querySelector(".meridian-refusal--banner")?.textContent).toContain(
      REFUSAL_BANNER.code,
    );
    // Polite stays silent: a banner is a refusal, which is what the assertive lane
    // is reserved for.
    expect(liveRegion(container, "polite").textContent).toBe("");
  });

  it("negative control: a banner that is merely still standing is not announced again", () => {
    // Without this, a frame that announced its whole banner list on every render
    // would repeat every standing refusal on every keystroke — worse than saying
    // nothing, because the reader never gets back to what the person is doing.
    //
    // The clock has to be moved PAST the hold window first. Inside it the
    // announcer's own coalescing swallows a repeat, so a re-render there passes
    // whether the frame diffs or not: the control would be vacuous. Once the region
    // has cleared, a second announcement of the same banner is visible.
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(
        <AppFrame {...frameProps(SESSIONS_ROUTE, [REFUSAL_BANNER])}>
          <CalmSurface />
        </AppFrame>,
        { wrapper: liveBridgeWrapper() },
      );
      expect(liveRegion(container, "assertive").textContent).toBe(REFUSAL_BANNER.detail);

      act(() => {
        vi.advanceTimersByTime(LIVE_ANNOUNCEMENT_HOLD_MS + 1);
      });
      expect(liveRegion(container, "assertive").textContent).toBe("");

      rerender(
        <AppFrame {...frameProps(SESSIONS_ROUTE, [REFUSAL_BANNER])} modalOverlayOpen>
          <CalmSurface />
        </AppFrame>,
      );

      expect(liveRegion(container, "assertive").textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AppFrame — the announcer runs on the window's clock", () => {
  it("holds a fixture window's announcement until the scenario's own clock moves", () => {
    // `Spec-023 §Console Design (Meridian)` §The fixture bridge: "the fixture clock
    // is the only clock the renderer reads in fixture mode". The announcer arms the
    // one timeout the idle-CPU budget counts, so on the wall clock it was a
    // subsystem reaching past the frozen one — the assertive region cleared on how
    // fast the runner happened to be, which makes an accessibility assertion and a
    // screenshot of a standing refusal both depend on the host rather than on the
    // beat that advanced time.
    //
    // The engine, the scenario, and the announcer are all the real ones: the only
    // instrument is fake timers, which stand in for wall time and for nothing under
    // test.
    vi.useFakeTimers();
    try {
      const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
      const { container } = render(
        <AppFrame {...frameProps(SESSIONS_ROUTE, [REFUSAL_BANNER])}>
          <CalmSurface />
        </AppFrame>,
        { wrapper: bridgeWrapper(bridge) },
      );
      expect(liveRegion(container, "assertive").textContent).toBe(REFUSAL_BANNER.detail);

      // Wall time well past the hold window, twice over. Nothing clears, because
      // nothing in this window is reading it.
      act(() => {
        vi.advanceTimersByTime(LIVE_ANNOUNCEMENT_HOLD_MS * 2);
      });
      expect(liveRegion(container, "assertive").textContent).toBe(REFUSAL_BANNER.detail);

      // The scenario's own clock is what the hold was measured against.
      act(() => {
        scenarioEngineOf(bridge).advance(LIVE_ANNOUNCEMENT_HOLD_MS + 1);
      });
      expect(liveRegion(container, "assertive").textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("negative control: a live window's announcement clears on wall time", () => {
    // The other arm of the same seam, over the REAL live bridge — `createTier1Bridge`
    // is the object the preload exposes. Without this the case above would be
    // satisfied by an announcer that had simply stopped clearing at all, and the
    // frozen-clock claim would say nothing about which clock is read.
    vi.useFakeTimers();
    try {
      const { container } = render(
        <AppFrame {...frameProps(SESSIONS_ROUTE, [REFUSAL_BANNER])}>
          <CalmSurface />
        </AppFrame>,
        { wrapper: liveBridgeWrapper() },
      );
      expect(liveRegion(container, "assertive").textContent).toBe(REFUSAL_BANNER.detail);

      act(() => {
        vi.advanceTimersByTime(LIVE_ANNOUNCEMENT_HOLD_MS + 1);
      });
      expect(liveRegion(container, "assertive").textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});
