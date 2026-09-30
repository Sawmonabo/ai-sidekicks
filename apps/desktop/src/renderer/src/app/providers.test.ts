// What the composition root wires, proved by driving the composed window. Each claim joins two
// pieces that are individually correct: regaining focus re-reads sessions; the palette's
// bridge-backed acts are mounted; a modal overlay makes the frame's background inert (the palette's
// open state lives in the root, so only the root can hand it to the frame); and the tripwire route
// is armed, on the window's own clock (armed before a bridge exists, so only a mounted window can
// show its records use the clock it ended up on).
//
// Cases drive the real `AppProviders` against the fixture bridge the `console-unit` project
// compiles in. The one instrument is a spy on the real `SessionStoreRegistry` prototype, since the
// frame creates the registry. The address and rail claims are `providers.routing.test.ts`; the
// token sheet is `AppBootstrap.tokens.test.ts`.

import { act, cleanup, fireEvent, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { windowDiagnosticCapture } from "@renderer/lib/diagnostic-capture/diagnostic-capture.js";
import { parseInstant } from "@renderer/lib/instant.js";
import { windowTripwires } from "@renderer/lib/tripwires.js";
import { SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import { SESSIONS_HASH, mountApp } from "@test/helpers/mount-app.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";

const BRIDGE_COMMAND_IDS = ["bridge.copyBuildDetails", "bridge.checkForUpdates"] as const;

/** The fixture's frozen clock sits months from wall time, so a day apart is unmistakable. */
const ONE_DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

async function dispatchWindowEvent(type: "focus" | "blur"): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event(type));
    await crossMacrotaskBoundary();
  });
}

/**
 * Press a key with the platform modifier, whichever `$mod` resolves to on this host.
 *
 * Both presses are dispatched and exactly one can match: tinykeys resolves `$mod` to `Meta` on a
 * Mac user agent and `Control` elsewhere, and a press with the wrong modifiers is dropped, so the
 * test need not re-derive the platform rule.
 */
async function pressWithModifier(key: {
  readonly key: string;
  readonly code: string;
  readonly shiftKey?: boolean;
}): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(window, { ...key, ctrlKey: true });
    fireEvent.keyDown(window, { ...key, metaKey: true });
    await crossMacrotaskBoundary();
  });
}

/** Press the palette's chord: the platform modifier, Shift and P. */
async function pressPaletteChord(): Promise<void> {
  await pressWithModifier({ key: "P", code: "KeyP", shiftKey: true });
}

/** The wrapper the frame inerts; throws when the frame renders none. */
function backgroundOf(mounted: RenderResult): HTMLElement {
  const background = mounted.container.querySelector<HTMLElement>(".meridian-frame__background");
  if (background === null) {
    throw new Error("the frame rendered no background wrapper to inert");
  }
  return background;
}

describe("AppProviders — regaining focus re-reads every open session", () => {
  let requestRefreshOfEverySession: MockInstance<
    SessionStoreRegistry["requestRefreshOfEverySession"]
  >;

  beforeEach(() => {
    window.location.hash = SESSIONS_HASH;
    // The registry is constructed inside the frame, so a spy on the real prototype method is
    // the one seam that observes what the frame asked it for.
    requestRefreshOfEverySession = vi.spyOn(
      SessionStoreRegistry.prototype,
      "requestRefreshOfEverySession",
    );
  });

  afterEach(() => {
    cleanup();
    requestRefreshOfEverySession.mockRestore();
  });

  it("asks for one refresh when a blurred window comes back", async () => {
    await mountApp();

    await dispatchWindowEvent("blur");
    await dispatchWindowEvent("focus");

    expect(requestRefreshOfEverySession).toHaveBeenCalledTimes(1);
    expect(requestRefreshOfEverySession).toHaveBeenCalledWith("window-focus");
  });

  it("negative control: a focus event on a window that never lost focus asks for nothing", async () => {
    // A window never blurred missed nothing; re-reading on every focus event would be a poll.
    await mountApp();

    await dispatchWindowEvent("focus");

    expect(requestRefreshOfEverySession).not.toHaveBeenCalled();
  });
});

describe("AppProviders — the palette's bridge-backed acts are mounted", () => {
  beforeEach(() => {
    window.location.hash = SESSIONS_HASH;
  });

  afterEach(() => {
    cleanup();
  });

  it("registers them for as long as the window is up, and removes them with it", async () => {
    // Asserted absent first: the registry is module-scoped, so a leftover from another mount
    // would satisfy a presence check.
    for (const commandId of BRIDGE_COMMAND_IDS) {
      expect(commandRegistry.has(commandId), commandId).toBe(false);
    }

    const mounted = await mountApp();

    for (const commandId of BRIDGE_COMMAND_IDS) {
      expect(commandRegistry.has(commandId), commandId).toBe(true);
    }

    act(() => {
      mounted.unmount();
    });

    for (const commandId of BRIDGE_COMMAND_IDS) {
      expect(commandRegistry.has(commandId), commandId).toBe(false);
    }
  });

  it("registers them in the same act as the frame's own, so one revision covers both", async () => {
    // The palette reads the registry once per revision; two registration effects would leave a
    // window where it lists half the commands.
    await mountApp();

    expect(commandRegistry.has("frame.goToSessions")).toBe(true);
    expect(commandRegistry.has("frame.goToWorkflows")).toBe(true);
    expect(commandRegistry.has("bridge.copyBuildDetails")).toBe(true);
  });
});

describe("AppProviders — a modal overlay inerts the frame's background", () => {
  beforeEach(() => {
    window.location.hash = SESSIONS_HASH;
  });

  afterEach(() => {
    cleanup();
    window.location.hash = SESSIONS_HASH;
  });

  it("carries inert for exactly as long as the palette is open", async () => {
    // `AppFrame` proves the attribute follows its prop and `CommandPalette` proves the chord
    // toggles the state; only this file proves they are joined.
    const mounted = await mountApp();
    expect(backgroundOf(mounted).hasAttribute("inert")).toBe(false);

    await pressPaletteChord();
    expect(backgroundOf(mounted).hasAttribute("inert")).toBe(true);

    // Negative control: a frame that inerted on any keystroke, or never cleared, fails here.
    await pressPaletteChord();
    expect(backgroundOf(mounted).hasAttribute("inert")).toBe(false);
  });

  it("negative control: the platform modifier and K does not open the palette", async () => {
    // The palette's chord is Shift and P; a window that also opened on K would pass the case
    // above while binding the wrong keys.
    const mounted = await mountApp();

    await pressWithModifier({ key: "k", code: "KeyK" });

    expect(backgroundOf(mounted).hasAttribute("inert")).toBe(false);
  });
});

describe("AppProviders — every tripwire this process reports reaches the capture", () => {
  afterEach(() => {
    cleanup();
  });

  it("carries a report into the diagnostic capture, armed by importing the root", () => {
    // Importing `AppProviders` arms the route, so no mount is needed; a report made against the
    // process registry must arrive at the process capture.
    windowTripwires.setThrowOnReport(false);

    const batches: string[] = [];
    const detachForwarder = windowDiagnosticCapture.installForwarder((jsonLines) => {
      batches.push(jsonLines);
    });
    try {
      windowTripwires.report({
        kind: "bridge-shape-drift",
        site: "AppProviders.test",
        detail: "a report made to prove the route is armed",
      });
      windowDiagnosticCapture.flush();

      expect(
        batches.join("\n"),
        "a tripwire report reached no diagnostic record, so the composition root is not arming the route",
      ).toContain("a report made to prove the route is armed");
    } finally {
      detachForwarder();
      windowTripwires.setThrowOnReport(true);
      windowTripwires.reset();
    }
  });

  it("stamps the record with the clock the mounted window runs on, not wall time", async () => {
    // The route is armed before any bridge exists, on a real clock. Under a fixture the window
    // runs on the scenario's frozen clock, and a record stamped off wall time would disagree with
    // every other timestamp the window produced.
    windowTripwires.setThrowOnReport(false);

    const batches: string[] = [];
    const detachForwarder = windowDiagnosticCapture.installForwarder((jsonLines) => {
      batches.push(jsonLines);
    });
    try {
      await mountApp();

      const detail = "a report made to prove the route reads the window's clock";
      windowTripwires.report({ kind: "bridge-shape-drift", site: "AppProviders.test", detail });
      windowDiagnosticCapture.flush();

      const routed = batches
        .flatMap((batch) => batch.split("\n"))
        .map((line) => JSON.parse(line) as { readonly at: string; readonly detail: string })
        .find((record) => record.detail.includes(detail));
      expect(routed, "the tripwire report reached no diagnostic record").toBeDefined();
      const recordedAt = parseInstant(routed?.at ?? "").epochMilliseconds;
      expect(recordedAt, "the record carries no readable timestamp").toBeDefined();
      expect(
        Math.abs((recordedAt ?? Date.now()) - Date.now()),
        "the record was stamped off wall time, not the scenario's frozen clock",
      ).toBeGreaterThan(ONE_DAY_IN_MILLISECONDS);
    } finally {
      detachForwarder();
      windowTripwires.setThrowOnReport(true);
      windowTripwires.reset();
    }
  });
});
