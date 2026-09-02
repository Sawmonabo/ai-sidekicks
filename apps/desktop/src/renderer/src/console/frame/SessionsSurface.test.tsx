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
import type { ConsoleBridgeSource } from "../bridge/index.js";
import { registerLegacySurfaces } from "./legacy-surfaces.js";
import { ConsoleSurfaceRegistry, type ConsoleSurfaceContext } from "./surface-registry.js";

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

function sessionsSurfaceFor(source: ConsoleBridgeSource): {
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
  // The three fields this slot reads. The persistence stores are cast away for the
  // reason `legacy-surfaces.test.ts` gives: constructing them opens a database to
  // hand a surface that never touches them.
  const context = {
    route: { kind: "sessions" },
    bridge: { source },
    frameStore,
    sessionStore: undefined,
    sessionStoreRegistry,
  } as unknown as ConsoleSurfaceContext;
  return { element: <>{descriptor.render(context)}</>, frameStore, sessionStoreRegistry };
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
    await press("Start a session");

    expect(daemonCall).toHaveBeenCalledTimes(1);
    expect(daemonCall).toHaveBeenCalledWith("session.create", {});
  });

  it("negative control: a second press is a second act and creates a second session", async () => {
    // Without this, a control that had become inert after its first use — or one
    // wired to nothing at all — would satisfy both cases above.
    const daemonCall = installBridgeSpy();

    render(sessionsSurfaceFor("live").element);
    await press("Start a session");
    await press("Start a session");

    expect(daemonCall).toHaveBeenCalledTimes(2);
  });

  it("asks nothing under the fixture, and says the question was not put", async () => {
    // The probe reads the installed bridge, so the console declines to ask on its
    // behalf rather than answering from the live daemon beside fixture data.
    const daemonCall = installBridgeSpy();

    const { container } = render(sessionsSurfaceFor("fixture").element);
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
    await press("session-alpha");

    expect(frameStore.getState().route).toStrictEqual({
      kind: "workspace",
      sessionId: "session-alpha",
    });
  });

  it("negative control: with none open it reports an unasked question, not an empty answer", () => {
    // "There are none" would be a claim about every session on the node, and the
    // console never asked — no session-directory read is registered.
    installBridgeSpy();

    const { container } = render(sessionsSurfaceFor("live").element);

    expect(container.textContent).toContain("No session is open in this window.");
    expect(container.textContent).toContain("it has not asked the daemon for the rest");
  });
});
