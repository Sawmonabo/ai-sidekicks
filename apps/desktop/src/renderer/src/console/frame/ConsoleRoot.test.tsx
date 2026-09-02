// What the composition root WIRES, proved by driving the composed window.
//
// Five claims here, and none of them is visible from the modules underneath: each
// is a fact about how this file joins two pieces that are individually correct.
//
//   • **A window opens at the address it was given.** The Window menu opens an
//     auxiliary window by URL, so the route the store starts on and the hash the
//     window was loaded with have to be the same fact. They were not: the store
//     began on the default route and adopted the hash one commit later, which left
//     the route-to-hash direction closing over `#/sessions` for that commit.
//   • **Regaining focus re-reads.** The scheduler names `window-focus` a refresh
//     reason; only this file can say when it happened.
//   • **The palette's bridge-backed acts are mounted.** They are built by the
//     palette and registered by nobody, which reads exactly like a palette whose
//     Help group is simply empty.
//   • **A workspace stays reachable after a person leaves it.** The registry keeps
//     the session open; the rail and the router are what had stopped being able to
//     name it, and only a driven window shows the two disagreeing.
//   • **The window's database connection is closed with the window.** Nothing below
//     this file knows when the console is finished, so nothing below it can be the
//     one to close.
//
// Every case drives the real `ConsoleRoot` against the fixture bridge the
// `console-unit` project compiles in, so nothing here is a stand-in for the thing
// under test. The one instrument is a spy on the REAL `SessionStoreRegistry`
// prototype: the registry is created inside the frame and there is no other way to
// observe what the frame asked it for.

import { act, cleanup, fireEvent, render, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { SCHEME_PREFERENCE_KEY, type UiStateStore } from "../persistence/index.js";
import { formatRoute, type ConsoleRoute } from "../routing/index.js";
import { SessionStoreRegistry } from "../store/index.js";
import { consoleCommands } from "./command-surface.js";
import { ConsoleRoot } from "./ConsoleRoot.js";
import { type ConsoleSurfaceContext } from "./surface-registry.js";

/** An auxiliary window's address: a route the sessions list is not. */
const AUXILIARY_HASH = "#/window/timeline/session-alpha";

/** Where a window with no particular address lands. */
const SESSIONS_HASH = "#/sessions";

/** A window opened straight into a session, the way a saved link does. */
const WORKSPACE_HASH = "#/session/session-alpha";

const SETTINGS_HASH = "#/settings";

const BRIDGE_COMMAND_IDS = ["bridge.copyBuildDetails", "bridge.checkForUpdates"] as const;

/**
 * Mount and let the settled promises land.
 *
 * `ConsoleRoot` starts the persistence open on mount and swaps the durable adapter
 * in when it settles, so a test that asserted straight after `render` would assert
 * against a half-settled tree and leave a state update landing outside `act`. Two
 * flushes rather than one: the open resolves a promise whose continuation schedules
 * another.
 *
 * The observer is handed the whole surface context rather than the route alone.
 * That context is what the frame builds and hands to every surface, so it is the
 * one seam that reports what this file wired without replacing any of it — and a
 * second observer beside it would be a second such seam.
 */
async function mountConsole(
  observe?: (context: ConsoleSurfaceContext) => void,
): Promise<RenderResult> {
  let mounted: RenderResult | undefined;
  await act(async () => {
    mounted = render(
      <ConsoleRoot
        {...(observe === undefined
          ? {}
          : {
              renderOverlays: (context) => {
                observe(context);
                return null;
              },
            })}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  if (mounted === undefined) {
    throw new Error("the console never mounted");
  }
  return mounted;
}

async function dispatchWindowEvent(type: "focus" | "blur"): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event(type));
    await Promise.resolve();
  });
}

/** Click a rail destination by the label a person reads on it. */
async function clickRailDestination(mounted: RenderResult, label: string): Promise<void> {
  const button = mounted.getByLabelText(label);
  await act(async () => {
    fireEvent.click(button);
    await Promise.resolve();
  });
}

describe("ConsoleRoot — the window opens at the address it was given", () => {
  beforeEach(() => {
    window.location.hash = SESSIONS_HASH;
  });

  afterEach(() => {
    cleanup();
    window.location.hash = SESSIONS_HASH;
  });

  it("starts on the route parsed from the opening hash, and never passes through the default", async () => {
    window.location.hash = AUXILIARY_HASH;
    const observed: ConsoleRoute[] = [];

    await mountConsole((context) => observed.push(context.route));

    // The FIRST render already carries the auxiliary route. A store that adopted
    // the hash from an effect would render the sessions route once before it, and
    // that one commit is all the route-to-hash direction needs to overwrite the
    // address the window was opened at.
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.map(formatRoute)).not.toContain(SESSIONS_HASH);
    expect(observed[0]).toStrictEqual({
      kind: "auxiliary",
      route: "timeline",
      sessionId: "session-alpha",
    });
    expect(window.location.hash).toBe(AUXILIARY_HASH);
  });

  it("negative control: a window opened with no address still lands on the sessions route", async () => {
    // Without this, a frame that ignored the hash entirely and simply never
    // navigated would satisfy the case above.
    const observed: ConsoleRoute[] = [];

    await mountConsole((context) => observed.push(context.route));

    expect(observed[0]).toStrictEqual({ kind: "sessions" });
    expect(window.location.hash).toBe(SESSIONS_HASH);
  });
});

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
    expect(consoleCommands.has("bridge.copyBuildDetails")).toBe(true);
  });
});

describe("ConsoleRoot — a workspace stays reachable after leaving it", () => {
  beforeEach(() => {
    window.location.hash = WORKSPACE_HASH;
  });

  afterEach(() => {
    cleanup();
    window.location.hash = SESSIONS_HASH;
  });

  it("keeps the Workspace rail entry after the route moves to Settings, and goes back to the same session", async () => {
    // The defect: the entry was built from the CURRENT route, so leaving the
    // workspace hid the destination while `SessionStoreRegistry` still held that
    // session open — a live session with no control that reaches it.
    const mounted = await mountConsole();
    expect(mounted.getByLabelText("Workspace")).toBeDefined();

    await clickRailDestination(mounted, "Settings");
    expect(window.location.hash).toBe(SETTINGS_HASH);

    expect(mounted.queryByLabelText("Workspace")).not.toBeNull();

    await clickRailDestination(mounted, "Workspace");
    expect(window.location.hash).toBe(WORKSPACE_HASH);
  });

  it("negative control: a window that has opened no session offers no Workspace entry", async () => {
    // Without this, a rail that showed the destination unconditionally would
    // satisfy the case above while offering a control that routes nowhere.
    window.location.hash = SESSIONS_HASH;
    const mounted = await mountConsole();

    expect(mounted.queryByLabelText("Workspace")).toBeNull();
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
      await Promise.resolve();
      await Promise.resolve();
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
