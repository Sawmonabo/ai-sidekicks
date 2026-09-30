// Every state the console can render sits on the Meridian tokens: the sheet is installed above
// the bridge gate, so the missing-preload card is styled, and the frame below installs no second
// copy. Both cases drive the real `AppProviders`. The bridge resolution hook is spied, not
// replaced, because this tier compiles fixtures in and the `unavailable` branch is otherwise
// unreachable.

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBridgeResolution } from "@renderer/services/platform/hooks/useBridgeResolution.js";
import { SESSIONS_HASH, mountApp } from "@test/helpers/mount-app.js";
import { MERIDIAN_STYLE_ELEMENT_ID } from "./token-installation.js";

// Spied, not replaced: only the case that needs the missing-preload resolution overrides it.
vi.mock(import("@renderer/services/platform/hooks/useBridgeResolution.js"), { spy: true });

describe("AppProviders — every state it can render sits on the Meridian tokens", () => {
  // The sheet lives on the document and outlives `cleanup()`; removing it makes each case
  // assert about its own render.
  beforeEach(() => {
    window.location.hash = SESSIONS_HASH;
    document.getElementById(MERIDIAN_STYLE_ELEMENT_ID)?.remove();
  });

  afterEach(() => {
    cleanup();
    // `restoreAllMocks` leaves a `mockReturnValue` standing on a module spy, which would leak
    // the missing-preload resolution into the next case.
    vi.mocked(useBridgeResolution).mockRestore();
    window.location.hash = SESSIONS_HASH;
  });

  it("installs the sheet for the missing-preload card, which mounts no frame at all", async () => {
    // The fixture build always resolves a bridge, so the state that skips the frame is
    // unreachable without the spy. Without the sheet this card has no custom properties and none
    // of the `html, body { height: 100% }` rules it is centered against.
    vi.mocked(useBridgeResolution).mockReturnValue({
      status: "unavailable",
      unavailable: {
        reason: "preload-did-not-run",
        detail: "This window loaded without its preload bridge.",
      },
    });
    // Non-vacuity: the sheet is absent going in, so it was written by this render.
    expect(document.getElementById(MERIDIAN_STYLE_ELEMENT_ID)).toBeNull();

    const mounted = await mountApp();

    expect(mounted.container.textContent).toContain("This window cannot reach the app.");
    // The frame really did not mount: no rail, so nothing below the gate ran.
    expect(mounted.container.querySelector(".meridian-rail")).toBeNull();
    const styleElement = document.getElementById(MERIDIAN_STYLE_ELEMENT_ID);
    expect(styleElement).not.toBeNull();
    expect(styleElement?.textContent ?? "").toContain("--meridian-ground");
    expect(styleElement?.textContent ?? "").toContain("height: 100%");
    // Prepended, so later stylesheets cascade after these definitions.
    expect(document.head.firstElementChild?.id).toBe(MERIDIAN_STYLE_ELEMENT_ID);
  });

  it("installs it exactly once on the ready path, and no second time for the frame", async () => {
    // Hoisting the install above the gate must not leave the frame installing a second copy.
    expect(document.getElementById(MERIDIAN_STYLE_ELEMENT_ID)).toBeNull();

    const mounted = await mountApp();

    expect(mounted.container.querySelector(".meridian-rail")).not.toBeNull();
    expect(document.querySelectorAll(`#${MERIDIAN_STYLE_ELEMENT_ID}`)).toHaveLength(1);
  });
});
