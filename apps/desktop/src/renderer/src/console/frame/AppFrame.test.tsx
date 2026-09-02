// Two claims the frame alone can make, because both are about the SLOT rather
// than about what is put in it.
//
//   • **A modal overlay makes the background inert.** `Spec-023 §Console
//     Libraries` adopts the dialog family under `modal="trap-focus"`, which traps
//     focus and deliberately does not lock scroll — and leaves inerting the app
//     root to the shell. Nothing was doing it, so the rail and the whole surface
//     stayed in the accessibility tree underneath an open dialog, reachable by
//     every assistive-technology reader that does not follow focus. The overlays
//     slot has to sit OUTSIDE whatever carries the attribute, or the palette
//     would inert itself.
//   • **A failed surface does not follow a person to the next route.** The
//     boundary's error is its own state, and its identity used to be constant
//     across routes: one route's render crash therefore hid the next route's
//     surface behind the previous one's failure card until "Try again" was
//     clicked. Keying the boundary by the route it is holding makes navigating
//     away the retry.
//   • **The window has one live announcer, and a raised banner reaches it.** The
//     regions are the frame's because they have to outlive every surface in it and
//     sit outside the `inert` wrapper; the banner is their first consumer because a
//     refusal that changes what the whole room can do is the frame's own event.

import { createTier1Bridge } from "@ai-sidekicks/contracts";
import { act, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SidekicksBridgeProvider,
  createFixtureBridge,
  type ConsoleBridge,
} from "../bridge/index.js";
import { createLiveBridge } from "../bridge/live-bridge.js";
import { FLAGSHIP_SCENARIO } from "../bridge/scenarios/flagship.js";
import { LIVE_ANNOUNCEMENT_HOLD_MS, consoleTripwires } from "../core/index.js";
import { CommandRegistry, PaletteOverlay } from "../palette/index.js";
import type { ConsoleRoute } from "../routing/index.js";
import type { FrameBanner } from "../store/index.js";
import { AppFrame } from "./AppFrame.js";
import { RAIL_ENTRY_TEMPLATES, type RailEntry } from "./IconRail.js";

const RAIL_ENTRIES: readonly RailEntry[] = [
  { destination: "sessions", ...RAIL_ENTRY_TEMPLATES.sessions },
];

const RENDER_FAILURE_MESSAGE = "the sessions list could not render this row";

const SESSIONS_ROUTE: ConsoleRoute = { kind: "sessions" };
const SETTINGS_ROUTE: ConsoleRoute = { kind: "settings", page: undefined };

/** A refusal wide enough for a banner: what the whole room can do has changed. */
const REFUSAL_BANNER: FrameBanner = {
  id: "banner-node-detached",
  code: "runtimenode.permission_denied",
  detail: "That runtime node is no longer attached, so no run can start here.",
  dismissible: false,
};

function ExplodingSurface(): React.JSX.Element {
  throw new Error(RENDER_FAILURE_MESSAGE);
}

function CalmSurface(): React.JSX.Element {
  return <p>the settings surface rendered</p>;
}

/** Everything `AppFrame` needs that a case is not making a claim about. */
function frameProps(
  route: ConsoleRoute,
  banners: readonly FrameBanner[] = [],
): {
  route: ConsoleRoute;
  railEntries: readonly RailEntry[];
  railDestination: undefined;
  onSelectDestination: () => void;
  banners: readonly FrameBanner[];
  onDismissBanner: () => void;
} {
  return {
    route,
    railEntries: RAIL_ENTRIES,
    railDestination: undefined,
    onSelectDestination: () => undefined,
    banners,
    onDismissBanner: () => undefined,
  };
}

/**
 * A bridge host for the frame, because the frame now resolves the window's clock.
 *
 * `AppFrame` mounts the live announcer, and the announcer arms the one timeout the
 * console's idle budget counts — so which clock it runs on is a property of the
 * WINDOW rather than of the primitive, and the frame reads it from the bridge. Both
 * arms are the real thing: `createTier1Bridge()` is the object the preload exposes
 * to a shipped window, and `createFixtureBridge` builds the real engine over the
 * real flagship scenario.
 */
function bridgeWrapper(
  bridge: ConsoleBridge,
): (props: { readonly children: ReactNode }) => React.JSX.Element {
  return function BridgeHost(props: { readonly children: ReactNode }): React.JSX.Element {
    return <SidekicksBridgeProvider bridge={bridge}>{props.children}</SidekicksBridgeProvider>;
  };
}

/** The wall-clock arm: what a shipped window resolves. */
function liveBridgeWrapper(): (props: { readonly children: ReactNode }) => React.JSX.Element {
  return bridgeWrapper(createLiveBridge(createTier1Bridge()));
}

/** The running engine, or a failure that names what was missing rather than `undefined`. */
function scenarioEngineOf(bridge: ConsoleBridge): NonNullable<ConsoleBridge["scenarioEngine"]> {
  const engine = bridge.scenarioEngine;
  if (engine === undefined) {
    throw new Error("the fixture bridge exposed no scenario engine");
  }
  return engine;
}

function backgroundOf(container: HTMLElement): HTMLElement {
  const background = container.querySelector<HTMLElement>(".meridian-frame__background");
  if (background === null) {
    throw new Error("the frame rendered no background wrapper to inert");
  }
  return background;
}

/**
 * The boundary's failure card, addressed through the surface it replaced.
 *
 * `screen.getByRole("alert")` used to be unambiguous and is not any more: the frame
 * mounts the announcer's assertive region, which is a permanent `role="alert"` node
 * by design. Scoping to the surface asks the question these cases were always
 * asking — did the ROUTE's slot render a failure — rather than "is there an alert
 * anywhere in this window".
 */
function surfaceAlert(container: HTMLElement): HTMLElement | null {
  const surface = container.querySelector<HTMLElement>(".meridian-frame__surface");
  if (surface === null) {
    throw new Error("the frame rendered no surface slot");
  }
  return within(surface).queryByRole("alert");
}

function liveRegion(container: HTMLElement, politeness: "polite" | "assertive"): HTMLElement {
  const region = container.querySelector<HTMLElement>(`[data-live-region="${politeness}"]`);
  if (region === null) {
    throw new Error(`the frame mounted no ${politeness} live region`);
  }
  return region;
}

describe("AppFrame — a modal overlay inerts the background and nothing else", () => {
  it("carries inert only while a modal overlay is open, and never over the overlay itself", () => {
    const registry = new CommandRegistry();
    const palette = (openState: boolean): React.JSX.Element => (
      <PaletteOverlay
        registry={registry}
        context={{}}
        open={openState}
        onOpenChange={() => undefined}
        platform="darwin"
      />
    );

    const { container, rerender } = render(
      <AppFrame {...frameProps(SESSIONS_ROUTE)} overlays={palette(false)}>
        <CalmSurface />
      </AppFrame>,
      { wrapper: liveBridgeWrapper() },
    );
    const background = backgroundOf(container);
    expect(background.hasAttribute("inert")).toBe(false);

    rerender(
      <AppFrame {...frameProps(SESSIONS_ROUTE)} modalOverlayOpen overlays={palette(true)}>
        <CalmSurface />
      </AppFrame>,
    );
    expect(background.hasAttribute("inert")).toBe(true);

    // The rail and the surface are inside it; the palette's own input is not, and
    // is focusable. An `inert` that covered the dialog would trap a person in a
    // window with nothing they can reach.
    expect(background.querySelector(".meridian-rail")).not.toBeNull();
    expect(background.querySelector(".meridian-frame__surface")).not.toBeNull();
    const paletteInput = screen.getByRole("combobox", { name: "Search commands" });
    expect(background.contains(paletteInput)).toBe(false);
    paletteInput.focus();
    expect(document.activeElement).toBe(paletteInput);

    rerender(
      <AppFrame {...frameProps(SESSIONS_ROUTE)} overlays={palette(false)}>
        <CalmSurface />
      </AppFrame>,
    );
    expect(background.hasAttribute("inert")).toBe(false);
  });
});

describe("AppFrame — a failed surface does not survive a route change", () => {
  let restoreThrowOnReport = false;

  beforeEach(() => {
    // The boundary reports its catch through the tripwire registry, which throws
    // in a development build — inside React's own error handling, which is not
    // what these cases are about.
    restoreThrowOnReport = import.meta.env.DEV;
    consoleTripwires.setThrowOnReport(false);
    consoleTripwires.reset();
  });

  afterEach(() => {
    consoleTripwires.setThrowOnReport(restoreThrowOnReport);
    consoleTripwires.reset();
  });

  it("renders the newly selected surface instead of the previous route's failure card", () => {
    const { container, rerender } = render(
      <AppFrame {...frameProps(SESSIONS_ROUTE)}>
        <ExplodingSurface />
      </AppFrame>,
      { wrapper: liveBridgeWrapper() },
    );
    expect(surfaceAlert(container)?.textContent).toContain(RENDER_FAILURE_MESSAGE);

    rerender(
      <AppFrame {...frameProps(SETTINGS_ROUTE)}>
        <CalmSurface />
      </AppFrame>,
    );

    expect(surfaceAlert(container)).toBeNull();
    expect(screen.getByText("the settings surface rendered")).not.toBeNull();
  });

  it("negative control: a failure is still held while the route stays put", () => {
    // Without this, a boundary that simply never retained an error would satisfy
    // the case above and take the failure card — the only record a person gets —
    // with it.
    const { container, rerender } = render(
      <AppFrame {...frameProps(SESSIONS_ROUTE)}>
        <ExplodingSurface />
      </AppFrame>,
      { wrapper: liveBridgeWrapper() },
    );
    expect(surfaceAlert(container)?.textContent).toContain(RENDER_FAILURE_MESSAGE);

    rerender(
      <AppFrame {...frameProps(SESSIONS_ROUTE)}>
        <CalmSurface />
      </AppFrame>,
    );

    expect(surfaceAlert(container)?.textContent).toContain(RENDER_FAILURE_MESSAGE);
    expect(screen.queryByText("the settings surface rendered")).toBeNull();
  });
});

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
