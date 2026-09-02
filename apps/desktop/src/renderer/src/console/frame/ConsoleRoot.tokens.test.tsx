// Every state the console can render sits on the Meridian tokens.
//
// The claim is about the two ends of one hoist: the sheet is installed ABOVE the
// bridge gate, so the missing-preload card — the state a person is most likely to
// be reading when something has gone wrong, and the one that mounts no frame at
// all — is on the tokens, and the frame below the gate does not install a second
// copy for every window that works.
//
// Both cases drive the real `ConsoleRoot`. The one instrument is a spy on the REAL
// bridge barrel, and it is a spy rather than a replacement: `resolveBridge` answers
// `unavailable` only when no bridge is supplied AND fixtures are compiled out, and
// this tier compiles them in — so without it the branch that renders the recovery
// card is unreachable, which is how it came to be untested.
//
// What the composition root wires is `ConsoleRoot.test.tsx`; the address it opens
// at is `ConsoleRoot.routing.test.tsx`.

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBridgeResolution } from "../bridge/index.js";
import { SESSIONS_HASH, mountConsole } from "./ConsoleRoot.test-support.js";
import { MERIDIAN_STYLE_ELEMENT_ID } from "./token-installation.js";

// Spied, never replaced: every export of the bridge door keeps its real
// implementation and is merely observable, so the one case that needs the
// missing-preload resolution can state it for that case alone.
vi.mock(import("../bridge/index.js"), { spy: true });

describe("ConsoleRoot — every state it can render sits on the Meridian tokens", () => {
  // The tokens are installed on the DOCUMENT, so they outlive `cleanup()` and
  // every case here would otherwise read a sheet an earlier one left behind.
  // Removing it first is what makes the assertions about THIS render.
  beforeEach(() => {
    window.location.hash = SESSIONS_HASH;
    document.getElementById(MERIDIAN_STYLE_ELEMENT_ID)?.remove();
  });

  afterEach(() => {
    cleanup();
    // The spy's own restore, by name. `restoreAllMocks` puts the original
    // implementation back but leaves a `mockReturnValue` standing on a module
    // spy, so the next case would have gone on reading the missing-preload
    // resolution this one stated.
    vi.mocked(useBridgeResolution).mockRestore();
    window.location.hash = SESSIONS_HASH;
  });

  it("installs the sheet for the missing-preload card, which mounts no frame at all", async () => {
    // The resolution is spied on the REAL barrel — every other export still calls
    // through — because the fixture build this tier compiles always resolves a
    // bridge, so the one state that skips the frame entirely is unreachable
    // otherwise. It is also the state a person is most likely to be reading when
    // something has gone wrong, and it used to arrive in browser defaults: no
    // custom properties, and none of the `html, body { height: 100% }` rules the
    // card is centred against.
    vi.mocked(useBridgeResolution).mockReturnValue({
      status: "unavailable",
      unavailable: {
        reason: "preload-did-not-run",
        detail: "This window loaded without its preload bridge.",
      },
    });
    // Non-vacuity: the sheet is genuinely absent going in, so what is asserted
    // below was written by this render and not by an earlier file.
    expect(document.getElementById(MERIDIAN_STYLE_ELEMENT_ID)).toBeNull();

    const mounted = await mountConsole();

    expect(mounted.container.textContent).toContain("This window cannot reach the app.");
    // The frame really did not mount: no rail, so nothing below the gate ran.
    expect(mounted.container.querySelector(".meridian-rail")).toBeNull();
    const styleElement = document.getElementById(MERIDIAN_STYLE_ELEMENT_ID);
    expect(styleElement).not.toBeNull();
    expect(styleElement?.textContent ?? "").toContain("--meridian-ground");
    expect(styleElement?.textContent ?? "").toContain("height: 100%");
    // Prepended, so the frame's own sheet cascades after the definitions it reads.
    expect(document.head.firstElementChild?.id).toBe(MERIDIAN_STYLE_ELEMENT_ID);
  });

  it("installs it exactly once on the ready path, and no second time for the frame", async () => {
    // The other half of "one installer, one call site": hoisting it above the gate
    // must not leave the frame installing a second copy, which would double the
    // cascade for every window that works.
    expect(document.getElementById(MERIDIAN_STYLE_ELEMENT_ID)).toBeNull();

    const mounted = await mountConsole();

    expect(mounted.container.querySelector(".meridian-rail")).not.toBeNull();
    expect(document.querySelectorAll(`#${MERIDIAN_STYLE_ELEMENT_ID}`)).toHaveLength(1);
  });
});
