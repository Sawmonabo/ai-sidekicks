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
//   • **The rail names the three destinations and highlights where the window is.**
//     The destination set is the routing family's and the highlight is the rail's;
//     only a driven window shows them agreeing, and only a driven window shows a
//     session workspace sitting under the sessions destination rather than under
//     an icon that is not drawn.
//   • **A modal overlay makes the frame's background inert.** The palette's open
//     state lives in this file, so this file is the only one that can hand it to
//     the frame — `AppFrame` proves the attribute follows the prop, and nothing
//     below proves the prop is ever passed.
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

import { useBridgeResolution } from "../bridge/index.js";
import { SCHEME_PREFERENCE_KEY, type UiStateStore } from "../persistence/index.js";
import { formatRoute, type ConsoleRoute } from "../routing/index.js";
import { SessionStoreRegistry } from "../store/index.js";
import { consoleCommands } from "./command-surface.js";
import { ConsoleRoot } from "./ConsoleRoot.js";
import { MERIDIAN_STYLE_ELEMENT_ID } from "./token-installation.js";
import { type ConsoleSurfaceContext } from "./surface-registry.js";

// Spied, never replaced: every export of the bridge door keeps its real
// implementation and is merely observable, so the one case that needs the
// missing-preload resolution can state it for that case alone. `resolveBridge`
// answers `unavailable` only when no bridge is supplied AND fixtures are compiled
// out, and this tier compiles them in — so without this the branch that renders
// the recovery card is unreachable, which is how it came to be untested.
vi.mock(import("../bridge/index.js"), { spy: true });

/** An auxiliary window's address: a route the sessions list is not. */
const AUXILIARY_HASH = "#/window/timeline/session-alpha";

/** Where a window with no particular address lands. */
const SESSIONS_HASH = "#/sessions";

/** A window opened straight into a session, the way a saved link does. */
const WORKSPACE_HASH = "#/session/session-alpha";

const SETTINGS_HASH = "#/settings";

const WORKFLOWS_HASH = "#/workflows";

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
    await Promise.resolve();
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

/** Which destination the rail is showing as current, by its accessible name. */
function currentRailDestination(mounted: RenderResult): string | null {
  const current = mounted.container.querySelector("[aria-current='page']");
  return current === null ? null : current.getAttribute("aria-label");
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
    expect(consoleCommands.has("frame.goToWorkflows")).toBe(true);
    expect(consoleCommands.has("bridge.copyBuildDetails")).toBe(true);
  });
});

describe("ConsoleRoot — the rail's three destinations, and where the window is", () => {
  beforeEach(() => {
    window.location.hash = WORKSPACE_HASH;
  });

  afterEach(() => {
    cleanup();
    window.location.hash = SESSIONS_HASH;
  });

  it("offers sessions, workflows, and settings, and nothing else", async () => {
    // The defect: the rail shipped a Workspace destination where `Spec-023
    // §Console Design (Meridian)` §The surface set names Workflows, so the
    // destination that opens the workflow builder could not be reached at all and
    // one that has no address of its own carried an icon.
    const mounted = await mountConsole();

    const labels = [...mounted.container.querySelectorAll(".meridian-rail__button")].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels).toStrictEqual(["Sessions", "Workflows", "Settings"]);
  });

  it("puts a session workspace under the sessions destination", async () => {
    // A window opened straight into a session is INSIDE the sessions destination,
    // which is where a person got there from. Highlighting nothing — the answer a
    // rail gives when the route names a destination it does not draw — reads as
    // the console losing track of where it is.
    const mounted = await mountConsole();

    expect(currentRailDestination(mounted)).toBe("Sessions");
  });

  it("navigates to the workflows destination and highlights it", async () => {
    const mounted = await mountConsole();

    await clickRailDestination(mounted, "Workflows");

    expect(window.location.hash).toBe(WORKFLOWS_HASH);
    expect(currentRailDestination(mounted)).toBe("Workflows");
    // Reserved, not stubbed: T-023p-1C-6 claims this slot on its own branch, so
    // the frame says the surface has not been built rather than rendering blank.
    expect(mounted.container.querySelector(".meridian-frame__absence")).not.toBeNull();
  });

  it("keeps the session this window opened after the route leaves it", async () => {
    // `SessionStoreRegistry` does not close a session when the route moves on, so
    // the way back has to survive the move. It is read from the frame store rather
    // than from the route, which is the distinction the retained id exists for.
    let observed: string | undefined;
    const mounted = await mountConsole((context) => {
      observed = context.frameStore.lastOpenedSessionId;
    });

    await clickRailDestination(mounted, "Settings");
    expect(window.location.hash).toBe(SETTINGS_HASH);

    expect(observed).toBe("session-alpha");
  });

  it("negative control: a window that has opened no session retains none", async () => {
    // Without this, a store that returned a constant id would satisfy the case
    // above and offer a way back into a session this window was never in.
    window.location.hash = SESSIONS_HASH;
    let observed: string | undefined = "not-read";
    await mountConsole((context) => {
      observed = context.frameStore.lastOpenedSessionId;
    });

    expect(observed).toBeUndefined();
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
