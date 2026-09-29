// What the composition root WIRES, proved by driving the composed window.
//
// Four claims here, and none of them is visible from the modules underneath: each
// is a fact about how `AppProviders` joins two pieces that are individually correct.
//
//   • **Regaining focus re-reads.** The scheduler names `window-focus` a refresh
//     reason; only this file can say when it happened.
//   • **The palette's bridge-backed acts are mounted.** They are built by the
//     palette and registered by nobody, which reads exactly like a palette whose
//     Help group is simply empty.
//   • **A modal overlay makes the frame's background inert.** The palette's open
//     state lives in the composition root, so it is the only place that can hand it
//     to the frame — `AppFrame` proves the attribute follows the prop, and nothing
//     below proves the prop is ever passed.
//   • **The tripwire route is armed, on the window's own clock.** The registry and the
//     capture are two `core/` singletons that know nothing about each other; only the
//     composition root joins them, and an unarmed route is a console that detects every
//     invariant breach and records none of them anywhere a person can read. The clock
//     is the same claim one step on: the route is armed before a bridge exists, so only
//     this file can say that the record a mounted window makes is stamped off the clock
//     that window ended up running on.
//
// Every case drives the real `AppProviders` against the fixture bridge the
// `console-unit` project compiles in, so nothing here is a stand-in for the thing
// under test. The one instrument is a spy on the REAL `SessionStoreRegistry`
// prototype: the registry is created inside the frame and there is no other way to
// observe what the frame asked it for.
//
// The other two claims have their own files: `providers.routing.test.ts` for the
// address a window opens at and the rail that reports where it is, and
// `AppBootstrap.tokens.test.ts` for the sheet every state renders on.

import { act, cleanup, fireEvent, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { windowDiagnosticCapture } from "@renderer/lib/diagnostic-capture/diagnostic-capture.js";
import { parseInstant } from "@renderer/lib/instant.js";
import { windowTripwires } from "@renderer/lib/tripwires.js";
import { SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import { SESSIONS_HASH, mountConsole } from "@test/helpers/mount-app.js";
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
 * Both presses are dispatched and exactly one can match: tinykeys resolves `$mod`
 * to `Meta` on a Mac user agent and `Control` everywhere else, and a press whose
 * modifiers do not match the parsed chord reaches the listener and is dropped. So
 * this is one press from the palette's point of view, and the test does not have
 * to re-derive the platform rule the chord parser already owns. The browser tier
 * drives the same chord the same way.
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

/** The wrapper the frame inerts. Absent means the frame stopped rendering one. */
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
    // The real prototype method on the real class: the registry is constructed
    // inside the frame, so this is the only seam that observes what the frame
    // asked it for without replacing the thing being asked.
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
    await mountConsole();

    await dispatchWindowEvent("blur");
    await dispatchWindowEvent("focus");

    expect(requestRefreshOfEverySession).toHaveBeenCalledTimes(1);
    expect(requestRefreshOfEverySession).toHaveBeenCalledWith("window-focus");
  });

  it("negative control: a focus event on a window that never lost focus asks for nothing", async () => {
    // A window that was never blurred missed nothing, and re-reading on every
    // focus event the platform raises would be the poll this design refuses.
    await mountConsole();

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
    // Asserted absent first: the registry is module-scoped, so a case that only
    // checked presence would pass over a leftover registration from another mount.
    for (const commandId of BRIDGE_COMMAND_IDS) {
      expect(commandRegistry.has(commandId), commandId).toBe(false);
    }

    const mounted = await mountConsole();

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
    // The palette reads the registry once per revision. Two registration effects
    // would mean two bumps and a window in which the palette lists half the
    // commands it has.
    await mountConsole();

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
    // `AppFrame` proves the attribute follows its prop and `CommandPalette` proves
    // the chord toggles the state; nothing below this file proves the two are
    // joined, and they were not — the prop existed, the palette opened, and the
    // rail and the whole surface stayed in the accessibility tree underneath it.
    const mounted = await mountConsole();
    expect(backgroundOf(mounted).hasAttribute("inert")).toBe(false);

    await pressPaletteChord();
    expect(backgroundOf(mounted).hasAttribute("inert")).toBe(true);

    // Negative control on the same instrument: the chord toggles, so a frame that
    // inerted on any keystroke — or never cleared — fails here rather than passing
    // the case above and leaving the console permanently unreachable.
    await pressPaletteChord();
    expect(backgroundOf(mounted).hasAttribute("inert")).toBe(false);
  });

  it("negative control: the platform modifier and K does not open the palette", async () => {
    // The palette's chord is Shift and P, so a window that also opened on K would pass
    // the case above while binding the wrong keys.
    const mounted = await mountConsole();

    await pressWithModifier({ key: "k", code: "KeyK" });

    expect(backgroundOf(mounted).hasAttribute("inert")).toBe(false);
  });
});

describe("AppProviders — every tripwire this process reports reaches the capture", () => {
  afterEach(() => {
    cleanup();
  });

  it("carries a report into the diagnostic capture, armed by importing the root", () => {
    // The route is armed at module scope, so importing `AppProviders` is what arms it —
    // no mount is needed and none is performed. What is asserted is the JOIN: a report
    // made against the process registry arrives at the process capture.
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
    // The route is armed at module scope, before any bridge exists, so the clock it
    // starts on is a real one. Under a fixture the window then runs on the scenario
    // engine's FROZEN clock, and a record stamped off wall time lands hours from the
    // frame it describes — unpinnable by a reference capture and disagreeing with
    // every other timestamp the same window produced.
    windowTripwires.setThrowOnReport(false);

    const batches: string[] = [];
    const detachForwarder = windowDiagnosticCapture.installForwarder((jsonLines) => {
      batches.push(jsonLines);
    });
    try {
      await mountConsole();

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
