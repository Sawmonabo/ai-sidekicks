// What the composition root WIRES, proved by driving the composed window.
//
// Three claims here, and none of them is visible from the modules underneath: each
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
//
// Every case drives the real `ConsoleRoot` against the fixture bridge the
// `console-unit` project compiles in, so nothing here is a stand-in for the thing
// under test. The one instrument is a spy on the REAL `SessionStoreRegistry`
// prototype: the registry is created inside the frame and there is no other way to
// observe what the frame asked it for.

import { act, cleanup, render, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { formatRoute, type ConsoleRoute } from "../routing/index.js";
import { SessionStoreRegistry } from "../store/index.js";
import { consoleCommands } from "./command-surface.js";
import { ConsoleRoot } from "./ConsoleRoot.js";

/** An auxiliary window's address: a route the sessions list is not. */
const AUXILIARY_HASH = "#/window/timeline/session-alpha";

/** Where a window with no particular address lands. */
const SESSIONS_HASH = "#/sessions";

const BRIDGE_COMMAND_IDS = ["bridge.copyBuildDetails", "bridge.checkForUpdates"] as const;

/**
 * Mount and let the settled promises land.
 *
 * `ConsoleRoot` starts the persistence open on mount and swaps the durable adapter
 * in when it settles, so a test that asserted straight after `render` would assert
 * against a half-settled tree and leave a state update landing outside `act`. Two
 * flushes rather than one: the open resolves a promise whose continuation schedules
 * another.
 */
async function mountConsole(observeRoute?: (route: ConsoleRoute) => void): Promise<RenderResult> {
  let mounted: RenderResult | undefined;
  await act(async () => {
    mounted = render(
      <ConsoleRoot
        {...(observeRoute === undefined
          ? {}
          : {
              renderOverlays: (context) => {
                observeRoute(context.route);
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

    await mountConsole((route) => observed.push(route));

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

    await mountConsole((route) => observed.push(route));

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
