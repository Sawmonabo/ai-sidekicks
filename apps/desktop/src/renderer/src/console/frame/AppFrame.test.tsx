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

import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
