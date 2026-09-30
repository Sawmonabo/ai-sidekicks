// Layout claims only the frame can make: a modal overlay inerts the background but not the
// overlays, and keying the error boundary by route makes navigating away from a crash the retry.
// The announcer claims are in `AppFrame.announcer.test.tsx`.

import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { windowTripwires } from "@renderer/lib/tripwires.js";
import { CommandRegistry } from "@renderer/registries/commands/command-registry.js";
import { CommandPalette } from "../CommandPalette/CommandPalette.js";
import type { AppRoute } from "@renderer/routing/routes.js";
import { AppFrame } from "./AppFrame.js";
import {
  CalmScreen,
  SESSIONS_ROUTE,
  backgroundOf,
  frameProps,
  liveBridgeWrapper,
} from "@test/helpers/app-frame-fixtures.js";

const RENDER_FAILURE_MESSAGE = "the sessions list could not render this row";

const SETTINGS_ROUTE: AppRoute = { kind: "settings", page: undefined };

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
    expect(screenAlert(container)?.textContent).toContain(RENDER_FAILURE_MESSAGE);

    rerender(
      <AppFrame {...frameProps(SETTINGS_ROUTE)}>
        <CalmScreen />
      </AppFrame>,
    );

    expect(screenAlert(container)).toBeNull();
    expect(screen.getByText("the settings screen rendered")).not.toBeNull();
  });

  it("negative control: a failure is still held while the route stays put", () => {
    // Without this, a boundary that never retained an error would pass the case above.
    const { container, rerender } = render(
      <AppFrame {...frameProps(SESSIONS_ROUTE)}>
        <ExplodingScreen />
      </AppFrame>,
      { wrapper: liveBridgeWrapper() },
    );
    expect(screenAlert(container)?.textContent).toContain(RENDER_FAILURE_MESSAGE);

    rerender(
      <AppFrame {...frameProps(SESSIONS_ROUTE)}>
        <CalmScreen />
      </AppFrame>,
    );

    expect(screenAlert(container)?.textContent).toContain(RENDER_FAILURE_MESSAGE);
    expect(screen.queryByText("the settings screen rendered")).toBeNull();
  });
});
