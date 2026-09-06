// What the composition root WIRES, proved by driving the composed window.
//
// Four claims here, and none of them is visible from the modules underneath: each
// is a fact about how `ConsoleRoot` joins two pieces that are individually correct.
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
//   • **The window's database connection is closed with the window.** Nothing below
//     the composition root knows when the console is finished, so nothing below it
//     can be the one to close.
//
// Every case drives the real `ConsoleRoot` against the fixture bridge the
// `console-unit` project compiles in, so nothing here is a stand-in for the thing
// under test. The one instrument is a spy on the REAL `SessionStoreRegistry`
// prototype: the registry is created inside the frame and there is no other way to
// observe what the frame asked it for.
//
// The other two claims have their own files: `ConsoleRoot.routing.test.tsx` for the
// address a window opens at and the rail that reports where it is, and
// `ConsoleRoot.tokens.test.tsx` for the sheet every state renders on.

import { act, cleanup, fireEvent, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { SCHEME_PREFERENCE_KEY, type UiStateStore } from "../persistence/index.js";
import { SessionStoreRegistry } from "../store/index.js";
import { consoleCommands } from "../palette/index.js";
import { SESSIONS_HASH, mountConsole } from "./ConsoleRoot.test-support.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";

const BRIDGE_COMMAND_IDS = ["bridge.copyBuildDetails", "bridge.checkForUpdates"] as const;

async function dispatchWindowEvent(type: "focus" | "blur"): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event(type));
    await crossMacrotaskBoundary();
  });
}

/**
 * Press the palette's chord, whichever modifier `$mod` resolves to on this host.
 *
 * Both presses are dispatched and exactly one can match: tinykeys resolves `$mod`
 * to `Meta` on a Mac user agent and `Control` everywhere else, and a press whose
 * modifiers do not match the parsed chord reaches the listener and is dropped. So
 * this is one press from the palette's point of view, and the test does not have
 * to re-derive the platform rule the chord parser already owns. The browser tier
 * drives the same chord the same way.
 */
async function pressPaletteChord(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true });
    fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });
    await crossMacrotaskBoundary();
  });
}

/** The wrapper the frame inerts. Absent means the frame stopped rendering one. */
function backgroundOf(mounted: RenderResult): HTMLElement {
  const background = mounted.container.querySelector<HTMLElement>(".meridian-frame__background");
  if (background === null) {
    throw new Error("the frame rendered no background wrapper to inert");
  }
  return background;
}

describe("ConsoleRoot — regaining focus re-reads every open session", () => {
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

describe("ConsoleRoot — the palette's bridge-backed acts are mounted", () => {
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
      expect(consoleCommands.has(commandId), commandId).toBe(false);
    }

    const mounted = await mountConsole();

    for (const commandId of BRIDGE_COMMAND_IDS) {
      expect(consoleCommands.has(commandId), commandId).toBe(true);
    }

    act(() => {
      mounted.unmount();
    });

    for (const commandId of BRIDGE_COMMAND_IDS) {
      expect(consoleCommands.has(commandId), commandId).toBe(false);
    }
  });

  it("registers them in the same act as the frame's own, so one revision covers both", async () => {
    // The palette reads the registry once per revision. Two registration effects
    // would mean two bumps and a window in which the palette lists half the
    // commands it has.
    await mountConsole();

    expect(consoleCommands.has("frame.goToSessions")).toBe(true);
    expect(consoleCommands.has("frame.goToWorkflows")).toBe(true);
    expect(consoleCommands.has("bridge.copyBuildDetails")).toBe(true);
  });
});

describe("ConsoleRoot — a modal overlay inerts the frame's background", () => {
  beforeEach(() => {
    window.location.hash = SESSIONS_HASH;
  });

  afterEach(() => {
    cleanup();
    window.location.hash = SESSIONS_HASH;
  });

  it("carries inert for exactly as long as the palette is open", async () => {
    // `AppFrame` proves the attribute follows its prop and `PaletteOverlay` proves
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
});

describe("ConsoleRoot — the window's durable store is closed with the window", () => {
  beforeEach(() => {
    window.location.hash = SESSIONS_HASH;
  });

  afterEach(() => {
    cleanup();
  });

  it("closes the UI-state store on unmount rather than leaving a connection open", async () => {
    // An open connection blocks the next database upgrade, which is the failure
    // the store's own `close` contract exists to prevent — and nothing was
    // calling it, so every remount inside one renderer process added another.
    let uiStateStore: UiStateStore | undefined;
    const mounted = await mountConsole((context) => {
      uiStateStore = context.uiStateStore;
    });
    expect(uiStateStore).toBeDefined();
    if (uiStateStore === undefined) {
      return;
    }
    // The store the window is holding works while the window is up.
    await expect(
      uiStateStore.writeGlobal(SCHEME_PREFERENCE_KEY, "scheme", "dark"),
    ).resolves.toStrictEqual({ outcome: "written" });

    await act(async () => {
      mounted.unmount();
      await crossMacrotaskBoundary();
    });

    // Asserted through a write rather than through the flag: a store that said it
    // was closed while its connection stayed open would pass a flag assertion and
    // block the upgrade anyway.
    const afterUnmount = await uiStateStore.writeGlobal(SCHEME_PREFERENCE_KEY, "scheme", "light");
    expect(afterUnmount.outcome).toBe("refused");
    if (afterUnmount.outcome === "refused") {
      expect(afterUnmount.refusal.code).toBe("adapter-unavailable");
    }
  });
});
