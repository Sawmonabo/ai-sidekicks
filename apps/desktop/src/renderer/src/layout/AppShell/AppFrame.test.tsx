// Layout claims only the frame can make: a modal overlay inerts the background but neither the
// overlays nor the announcer's regions (a region under `inert` leaves the accessibility tree, so a
// refusal raised in a dialog would reach nobody), keying the error boundary by route makes
// navigating away from a crash the retry, and a raised banner is drawn and announced with its
// code and reason as words.

import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { windowTripwires } from "#renderer/lib/tripwires/registry.js";
import { CommandRegistry } from "#renderer/registries/commands/registry.js";
import { CommandPalette } from "../CommandPalette/CommandPalette.js";
import type { AppRoute } from "#renderer/routing/routes.js";
import { WindowStore, type WindowBanner } from "#renderer/store/window/store.js";
import { refuse } from "#renderer/lib/refusal/contract.js";
import { liveRegionOf, liveRegionText } from "#test/helpers/live-region.js";
import { AppFrame } from "./AppFrame.js";
import {
  CalmScreen,
  SESSIONS_ROUTE,
  backgroundOf,
  frameProps,
  liveBridgeWrapper,
} from "#test/helpers/app/frame-fixtures.js";

const RENDER_FAILURE_MESSAGE = "the sessions list could not render this row";

const SETTINGS_ROUTE: AppRoute = { kind: "settings", page: undefined };

/** The words the banner and its announcement read for `REFUSAL_BANNER`'s code and reason. */
const REFUSAL_BANNER_WORDS = "Sidekick resolution refused · Account unavailable";

/**
 * A refusal wide enough for a banner, raised the way a producer raises one, so the listed reason
 * travels from the refusal through the store to the frame.
 */
const REFUSAL_BANNER: WindowBanner = bannerRaisedFrom({
  ...refuse(
    "sessions",
    "agent.resolution_refused",
    "The account this sidekick runs on is not on this machine, so no run can start here.",
  ),
  reason: "account_unavailable",
});

function ExplodingScreen(): React.JSX.Element {
  throw new Error(RENDER_FAILURE_MESSAGE);
}

/**
 * The boundary's failure card, scoped to the screen region; the frame's assertive announcer region
 * is a permanent `role="alert"` node, so an unscoped query is ambiguous.
 */
function screenAlert(container: HTMLElement): HTMLElement | null {
  const screenRegion = container.querySelector<HTMLElement>(".meridian-frame__screen");
  if (screenRegion === null) {
    throw new Error("the frame rendered no screen region");
  }
  return within(screenRegion).queryByRole("alert");
}

describe("AppFrame — a modal overlay inerts the background and nothing else", () => {
  it("carries inert only while a modal overlay is open, and never over the overlay itself", () => {
    const registry = new CommandRegistry();
    const palette = (openState: boolean): React.JSX.Element => (
      <CommandPalette
        registry={registry}
        context={{}}
        open={openState}
        onOpenChange={() => undefined}
        platform="darwin"
      />
    );

    const { container, rerender } = render(
      <AppFrame {...frameProps(SESSIONS_ROUTE)} overlays={palette(false)}>
        <CalmScreen />
      </AppFrame>,
      { wrapper: liveBridgeWrapper() },
    );
    const background = backgroundOf(container);
    expect(background.hasAttribute("inert")).toBe(false);

    rerender(
      <AppFrame {...frameProps(SESSIONS_ROUTE)} modalOverlayOpen overlays={palette(true)}>
        <CalmScreen />
      </AppFrame>,
    );
    expect(background.hasAttribute("inert")).toBe(true);

    // The rail and screen are inert; the palette input is outside and focusable.
    expect(background.querySelector(".meridian-rail")).not.toBeNull();
    expect(background.querySelector(".meridian-frame__screen")).not.toBeNull();
    const paletteInput = screen.getByRole("combobox", { name: "Search commands" });
    expect(background.contains(paletteInput)).toBe(false);
    paletteInput.focus();
    expect(document.activeElement).toBe(paletteInput);

    rerender(
      <AppFrame {...frameProps(SESSIONS_ROUTE)} overlays={palette(false)}>
        <CalmScreen />
      </AppFrame>,
    );
    expect(background.hasAttribute("inert")).toBe(false);
  });
});

describe("AppFrame — a failed screen does not survive a route change", () => {
  let restoreThrowOnReport = false;

  beforeEach(() => {
    // The boundary reports its catch through the tripwire registry, which throws in development.
    restoreThrowOnReport = import.meta.env.DEV;
    windowTripwires.setThrowOnReport(false);
    windowTripwires.reset();
  });

  afterEach(() => {
    windowTripwires.setThrowOnReport(restoreThrowOnReport);
    windowTripwires.reset();
  });

  it("renders the newly selected screen instead of the previous route's failure card", () => {
    const { container, rerender } = render(
      <AppFrame {...frameProps(SESSIONS_ROUTE)}>
        <ExplodingScreen />
      </AppFrame>,
      { wrapper: liveBridgeWrapper() },
    );
    expect(screenAlert(container)?.textContent).toContain("stopped rendering.");

    rerender(
      <AppFrame {...frameProps(SETTINGS_ROUTE)}>
        <CalmScreen />
      </AppFrame>,
    );

    expect(screenAlert(container)).toBeNull();
    expect(screen.getByText("the settings screen rendered")).not.toBeNull();
  });
});

describe("AppFrame — the banner reaches the window's one live announcer", () => {
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

    expect(liveRegionText(container, "assertive")).toBe(
      `${REFUSAL_BANNER_WORDS}. ${REFUSAL_BANNER.detail}`,
    );
    // The banner still renders, its words over the daemon's message and no wire spelling of the
    // code or reason; the announcer sits beside it.
    const bannerText = container.querySelector(".meridian-refusal--banner")?.textContent;
    expect(bannerText).toContain(REFUSAL_BANNER_WORDS);
    expect(bannerText).toContain(REFUSAL_BANNER.detail);
    expect(bannerText).not.toContain("agent.resolution_refused");
    expect(bannerText).not.toContain("account_unavailable");
    // Polite stays silent: the assertive lane is reserved for refusals.
    expect(liveRegionText(container, "polite")).toBe("");
  });
});

function bannerRaisedFrom(refusal: Parameters<WindowStore["raiseRefusalBanner"]>[0]): WindowBanner {
  const store = new WindowStore();
  store.raiseRefusalBanner(refusal);
  const [banner] = store.getState().banners;
  if (banner === undefined) {
    throw new Error("raiseRefusalBanner raised no banner");
  }
  return banner;
}
