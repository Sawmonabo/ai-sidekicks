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

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { consoleTripwires } from "../core/index.js";
import { CommandRegistry, PaletteOverlay } from "../palette/index.js";
import type { ConsoleRoute } from "../routing/index.js";
import { AppFrame } from "./AppFrame.js";
import { RAIL_ENTRY_TEMPLATES, type RailEntry } from "./IconRail.js";

const RAIL_ENTRIES: readonly RailEntry[] = [
  { destination: "sessions", ...RAIL_ENTRY_TEMPLATES.sessions },
];

const RENDER_FAILURE_MESSAGE = "the sessions list could not render this row";

const SESSIONS_ROUTE: ConsoleRoute = { kind: "sessions" };
const SETTINGS_ROUTE: ConsoleRoute = { kind: "settings", page: undefined };

function ExplodingSurface(): React.JSX.Element {
  throw new Error(RENDER_FAILURE_MESSAGE);
}

function CalmSurface(): React.JSX.Element {
  return <p>the settings surface rendered</p>;
}

/** Everything `AppFrame` needs that neither case is making a claim about. */
function frameProps(route: ConsoleRoute): {
  route: ConsoleRoute;
  railEntries: readonly RailEntry[];
  railDestination: undefined;
  onSelectDestination: () => void;
  banners: readonly [];
  onDismissBanner: () => void;
} {
  return {
    route,
    railEntries: RAIL_ENTRIES,
    railDestination: undefined,
    onSelectDestination: () => undefined,
    banners: [],
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
    const { rerender } = render(
      <AppFrame {...frameProps(SESSIONS_ROUTE)}>
        <ExplodingSurface />
      </AppFrame>,
    );
    expect(screen.getByRole("alert").textContent).toContain(RENDER_FAILURE_MESSAGE);

    rerender(
      <AppFrame {...frameProps(SETTINGS_ROUTE)}>
        <CalmSurface />
      </AppFrame>,
    );

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("the settings surface rendered")).not.toBeNull();
  });

  it("negative control: a failure is still held while the route stays put", () => {
    // Without this, a boundary that simply never retained an error would satisfy
    // the case above and take the failure card — the only record a person gets —
    // with it.
    const { rerender } = render(
      <AppFrame {...frameProps(SESSIONS_ROUTE)}>
        <ExplodingSurface />
      </AppFrame>,
    );
    expect(screen.getByRole("alert").textContent).toContain(RENDER_FAILURE_MESSAGE);

    rerender(
      <AppFrame {...frameProps(SESSIONS_ROUTE)}>
        <CalmSurface />
      </AppFrame>,
    );

    expect(screen.getByRole("alert").textContent).toContain(RENDER_FAILURE_MESSAGE);
    expect(screen.queryByText("the settings surface rendered")).toBeNull();
  });
});
