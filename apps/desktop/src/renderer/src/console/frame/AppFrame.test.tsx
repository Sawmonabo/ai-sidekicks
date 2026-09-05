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
//
// The frame's third claim — that the window has one live announcer, and that a
// raised banner reaches it — is its own subject and has its own file,
// `AppFrame.announcer.test.tsx`.

import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { consoleTripwires } from "../core/tripwires.js";
import { CommandRegistry, PaletteOverlay } from "../palette/index.js";
import type { ConsoleRoute } from "../routing/index.js";
import { AppFrame } from "./AppFrame.js";
import {
  CalmSurface,
  SESSIONS_ROUTE,
  backgroundOf,
  frameProps,
  liveBridgeWrapper,
} from "./AppFrame.test-support.js";

const RENDER_FAILURE_MESSAGE = "the sessions list could not render this row";

const SETTINGS_ROUTE: ConsoleRoute = { kind: "settings", page: undefined };

function ExplodingSurface(): React.JSX.Element {
  throw new Error(RENDER_FAILURE_MESSAGE);
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
