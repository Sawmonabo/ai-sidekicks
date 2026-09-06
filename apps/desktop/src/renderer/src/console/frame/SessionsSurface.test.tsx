// Visiting the sessions list creates nothing; pressing its control creates one.
//
// The surface is reached through the REAL registration — `registerLegacySurfaces`
// then the `sessions` descriptor — because the claim is about what that slot
// mounts, and a test that rendered the component directly would still have passed
// while the slot mounted the create-on-mount probe. What is observed is the bridge
// call itself: `session.create` is the act, and counting it is the only assertion
// that cannot be satisfied by a surface that merely looks right.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SidekicksBridge } from "@ai-sidekicks/contracts";

import { FrameStore, SessionStoreRegistry } from "../store/index.js";
import { createFixtureBridge, type GrowthPort } from "../bridge/index.js";
import type { ConsoleBridgeSource } from "../bridge/console-bridge.js";
import { createRefusingGrowthPort } from "../bridge/growth-port/growth-port.js";
import { FLAGSHIP_SCENARIO } from "../bridge/scenarios/flagship.js";
import { settleReactWork } from "../primitives/act-settlement.test-support.js";
import { registerLegacySurfaces } from "./legacy-surfaces.js";
import { ConsoleSurfaceRegistry, type ConsoleSurfaceContext } from "../seats/index.js";

/**
 * The one bridge member the shipped probe touches.
 *
 * It reads `window.sidekicks` directly rather than taking a bridge from context —
 * that is why the console guards its mount on the bridge SOURCE — so the installed
 * global is where a create becomes observable. Cast through `unknown` because the
 * partial shape is not assignable to the full contract, which is the same posture
 * the probe's own suite takes.
 */
function installBridgeSpy(): ReturnType<typeof vi.fn> {
  const daemonCall = vi.fn(() => Promise.resolve({ sessionId: "session-created" }));
  (window as unknown as { sidekicks: SidekicksBridge }).sidekicks = {
    daemon: { call: daemonCall },
  } as unknown as SidekicksBridge;
  return daemonCall;
}

function sessionsSurfaceFor(
  source: ConsoleBridgeSource,
  growth: GrowthPort = createRefusingGrowthPort(),
): {
  element: React.JSX.Element;
  frameStore: FrameStore;
  sessionStoreRegistry: SessionStoreRegistry;
} {
  const registry = new ConsoleSurfaceRegistry();
  registerLegacySurfaces(registry);
  const descriptor = registry.descriptorFor("sessions");
  if (descriptor === undefined) {
    throw new Error("no family claimed the sessions slot");
  }
  const frameStore = new FrameStore({ initialRoute: { kind: "sessions" } });
  const sessionStoreRegistry = new SessionStoreRegistry({
    read: () => Promise.resolve(undefined),
  });
  // The four fields this slot reads. The persistence stores are cast away for the
  // reason `legacy-surfaces.test.ts` gives: constructing them opens a database to
  // hand a surface that never touches them. The growth port is REAL and defaults to
  // the refusing one, so a case that says nothing about the directory gets the live
  // bridge's answer rather than a convenient one.
  const context = {
    route: { kind: "sessions" },
    bridge: { source, growth },
    frameStore,
    sessionStore: undefined,
    sessionStoreRegistry,
  } as unknown as ConsoleSurfaceContext;
  return { element: <>{descriptor.render(context)}</>, frameStore, sessionStoreRegistry };
}

/** The fixture's port, which serves the directory read the live bridge refuses. */
function fixtureGrowthPort(): GrowthPort {
  return createFixtureBridge({ scenario: FLAGSHIP_SCENARIO }).growth;
}

/**
 * Press a control and let React finish reacting.
 *
 * The press flips this surface's own state and the mount that follows starts the
 * probe's bridge call, so an unwrapped click would assert against a tree one
 * render behind and leave a promise settling outside `act`.
 */
async function press(name: string): Promise<void> {
  await act(async () => {
    screen.getByRole("button", { name }).click();
    await Promise.resolve();
  });
}

describe("the sessions destination — a session is created by an act, not by a visit", () => {
  afterEach(() => {
    cleanup();
    delete (window as unknown as { sidekicks?: SidekicksBridge }).sidekicks;
    vi.clearAllMocks();
  });

  it("creates nothing when the surface is visited, left, and visited again", () => {
    // Navigating to Settings and back remounts the slot. Under the mount-effect
    // probe that second mount was a second session, created by looking at a page.
    const daemonCall = installBridgeSpy();

    const firstVisit = render(sessionsSurfaceFor("live").element);
    firstVisit.unmount();
    render(sessionsSurfaceFor("live").element);

    expect(daemonCall).not.toHaveBeenCalled();
  });

  it("creates exactly one session when the control is pressed", async () => {
    const daemonCall = installBridgeSpy();

    render(sessionsSurfaceFor("live").element);
    // The surface reads its session directory on mount and shows a skeleton while
    // it is in flight — which carries no control, by the primitive's own rule — so
    // the act this case is about is only reachable once the read has settled.
    await settleReactWork();
    await press("Start a session");

    expect(daemonCall).toHaveBeenCalledTimes(1);
    expect(daemonCall).toHaveBeenCalledWith("session.create", {});
  });

  it("negative control: a second press is a second act and creates a second session", async () => {
    // Without this, a control that had become inert after its first use — or one
    // wired to nothing at all — would satisfy both cases above.
    const daemonCall = installBridgeSpy();

    render(sessionsSurfaceFor("live").element);
    await settleReactWork();
    await press("Start a session");
    await press("Start a session");

    expect(daemonCall).toHaveBeenCalledTimes(2);
  });

  it("asks nothing under the fixture, and says the question was not put", async () => {
    // The probe reads the installed bridge, so the console declines to ask on its
    // behalf rather than answering from the live daemon beside fixture data.
    const daemonCall = installBridgeSpy();

    const { container } = render(sessionsSurfaceFor("fixture").element);
    await settleReactWork();
    await press("Start a session");

    expect(daemonCall).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Nothing was asked of the daemon here.");
  });
});

describe("the sessions destination — what it can honestly list", () => {
  afterEach(() => {
    cleanup();
    delete (window as unknown as { sidekicks?: SidekicksBridge }).sidekicks;
  });

  it("lists this window's open sessions and opens the one that was chosen", async () => {
    installBridgeSpy();
    const { element, frameStore, sessionStoreRegistry } = sessionsSurfaceFor("live");
    sessionStoreRegistry.open("session-alpha");

    render(element);
    await settleReactWork();
    await press("session-alpha");

    expect(frameStore.getState().route).toStrictEqual({
      kind: "workspace",
      sessionId: "session-alpha",
    });
  });

  it("lists the node's sessions when the bridge serves the directory read", async () => {
    // The window has none open, so every row on screen came from the directory.
    // Before the read had a producer this surface could only ever show what this
    // window happened to have opened — a node with sessions on it rendered as an
    // absence.
    installBridgeSpy();

    const { container } = render(sessionsSurfaceFor("fixture", fixtureGrowthPort()).element);
    await settleReactWork();

    expect(screen.getByRole("button", { name: FLAGSHIP_SCENARIO.sessionId })).toBeDefined();
    // The heading follows the source: a list of the node's sessions must not still
    // be titled as this window's.
    expect(container.textContent).toContain("Sessions on this node");
  });

  it("negative control: with none open and a refused directory it reports an unasked question", async () => {
    // "There are none" would be a claim about every session on the node, and a
    // refused directory read means the console never asked.
    installBridgeSpy();

    const { container } = render(sessionsSurfaceFor("live").element);
    await settleReactWork();

    expect(container.textContent).toContain("No session is open in this window.");
    expect(container.textContent).toContain("it has not asked the daemon for the rest");
    expect(container.textContent).not.toContain("Sessions on this node");
  });
});
