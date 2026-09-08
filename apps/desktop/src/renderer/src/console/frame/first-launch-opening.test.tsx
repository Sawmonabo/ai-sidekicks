// The act: what actually happens on the first launch of an install.
//
// `first-launch.test.ts` beside this covers the RULE, so nothing here re-asserts the
// four conjuncts. What is tested here is everything the rule cannot see — that the
// mark is really read from the durable store, that the navigation really reaches the
// route the frame publishes, that the mark is really written back in a shape the
// store admits, and above all that the second launch is quiet.
//
// The two-launch case is the one this module exists for. Every other assertion here
// would pass over a hook that opened the demo every single time.
//
// The second describe is the other one: the read is asynchronous and the frame is
// interactive while it is in flight, so a launch and a person can both be deciding
// where this window goes at once. Those cases deliberately do NOT settle before
// acting — settling first would move the read past the only window in which the race
// exists, and every one of them would pass over a hook with no guard at all.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MemoryPersistenceAdapter, UiStateStore } from "../persistence/index.js";
import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { settle } from "../core/settle.test-support.js";
import { FrameStore } from "../store/index.js";
import { FIRST_RUN_SCENARIO } from "../bridge/scenarios/first-run.js";
import { LEDGER_FIRST_SIXTY_SCENARIO } from "../bridge/scenarios/ledger/ledger-first-sixty.js";
import { FIRST_LAUNCH_SEEN_KEY } from "./first-launch.js";
import { useFirstLaunchOpening } from "./first-launch-opening.js";

/** One durable store over memory, so a case can launch twice against one install. */
function installStore(): UiStateStore {
  return new UiStateStore({ adapter: new MemoryPersistenceAdapter() });
}

/** A bridge playing the demo — what a fixture build resolves. */
function fixtureBridgePlayingTheDemo(): ConsoleBridge {
  return createFixtureBridge({ scenario: LEDGER_FIRST_SIXTY_SCENARIO });
}

/**
 * Launch one window against a given install, and answer where it ended up.
 *
 * The frame store is fresh per launch and the ui-state store is not, which is exactly
 * the shape of two launches of one installed console.
 */
async function launch(
  uiStateStore: UiStateStore,
  bridge: ConsoleBridge,
  openedAtHash = "",
): Promise<FrameStore> {
  const frameStore = openWindow(uiStateStore, bridge, openedAtHash);
  await settle();
  return frameStore;
}

/**
 * Launch a window and hand it back with the mark read still in flight.
 *
 * The moment the race lives in. `readGlobal` is asynchronous, so the effect has
 * issued its read and yielded by the time this returns, and a caller's navigation
 * lands while the redirect is still being computed — which is the whole situation
 * the guard is about, and is unreachable from `launch`, whose settle has already
 * carried the read to its end.
 */
function openWindow(
  uiStateStore: UiStateStore,
  bridge: ConsoleBridge,
  openedAtHash = "",
): FrameStore {
  const frameStore = new FrameStore({ initialRoute: { kind: "sessions" } });
  renderHook(() => {
    useFirstLaunchOpening({ bridge, frameStore, uiStateStore, openedAtHash });
  });
  return frameStore;
}

describe("the first launch of an install", () => {
  it("opens into the scripted session rather than the sessions list", async () => {
    const frameStore = await launch(installStore(), fixtureBridgePlayingTheDemo());

    expect(frameStore.getState().route).toStrictEqual({
      kind: "workspace",
      sessionId: LEDGER_FIRST_SIXTY_SCENARIO.sessionId,
    });
  });

  it("marks the install, in a shape the durable store admits", async () => {
    // Read back through the store rather than asserted against the constant: a value
    // the chokepoint refuses is written nowhere, and the demo would then play on
    // every launch forever — invisible to every assertion that checks the value it
    // MEANT to write.
    const uiStateStore = installStore();
    await launch(uiStateStore, fixtureBridgePlayingTheDemo());

    expect(await uiStateStore.readGlobal(FIRST_LAUNCH_SEEN_KEY)).toBeDefined();
  });

  it("is quiet on the second launch of the same install", async () => {
    // The case this module exists for. One install, two windows in sequence — the
    // second stays where it opened.
    const uiStateStore = installStore();
    await launch(uiStateStore, fixtureBridgePlayingTheDemo());
    const second = await launch(uiStateStore, fixtureBridgePlayingTheDemo());

    expect(second.getState().route).toStrictEqual({ kind: "sessions" });
  });

  it("negative control: a window that asked for a route keeps it, even on a first launch", async () => {
    // A reload and an auxiliary window both arrive with a hash. Overriding one would
    // take somebody back into a demo they had already left.
    const frameStore = await launch(installStore(), fixtureBridgePlayingTheDemo(), "#/settings");

    expect(frameStore.getState().route).toStrictEqual({ kind: "sessions" });
  });

  it("negative control: a window playing a NAMED scenario is left where it opened", async () => {
    // The shape that reached the end-to-end tier: a suite launching the empty
    // first-run composition on purpose. That scenario scripts a session like every
    // other, so a hook reading "a session exists" as "the demo is playing" would open
    // a workspace over the surface the suite came to look at.
    const frameStore = await launch(
      installStore(),
      createFixtureBridge({ scenario: FIRST_RUN_SCENARIO }),
    );

    expect(frameStore.getState().route).toStrictEqual({ kind: "sessions" });
  });

  it("negative control: it writes no mark where it opened nothing", async () => {
    // Navigate-then-mark, and never mark-then-navigate: a launch that did not show
    // the demo must not record that it did, or the demo is lost for the install.
    const uiStateStore = installStore();
    await launch(uiStateStore, fixtureBridgePlayingTheDemo(), "#/settings");

    expect(await uiStateStore.readGlobal(FIRST_LAUNCH_SEEN_KEY)).toBeUndefined();
  });
});

describe("a person deciding where this window goes while the mark is still being read", () => {
  it("leaves the route they navigated to, and does not replace it with the demo", async () => {
    // The defect this guard closes. Nothing about the read is fast, and the rest of
    // the frame is live throughout it — so somebody reaches Settings, and a redirect
    // computed from the hash the window was BORN at then takes the window off the
    // page they are reading.
    const frameStore = openWindow(installStore(), fixtureBridgePlayingTheDemo());
    frameStore.navigate({ kind: "settings", page: "appearance" });

    await settle();

    expect(frameStore.getState().route).toStrictEqual({
      kind: "settings",
      page: "appearance",
    });
  });

  it("writes no mark for a demo that navigation retired", async () => {
    // Navigate-then-mark holds on this arm too: the demo was never shown, so an
    // install that recorded it as seen would lose it for good on one unlucky launch.
    const uiStateStore = installStore();
    const frameStore = openWindow(uiStateStore, fixtureBridgePlayingTheDemo());
    frameStore.navigate({ kind: "settings", page: "appearance" });

    await settle();

    expect(await uiStateStore.readGlobal(FIRST_LAUNCH_SEEN_KEY)).toBeUndefined();
  });

  it("still opens the demo for a launch nobody touched", async () => {
    // The positive half of the pair, taken through the SAME in-flight path so the two
    // cases differ by exactly one act: the navigation. A guard that simply stopped
    // redirecting would pass the case above and fail this one.
    const frameStore = openWindow(installStore(), fixtureBridgePlayingTheDemo());

    await settle();

    expect(frameStore.getState().route).toStrictEqual({
      kind: "workspace",
      sessionId: LEDGER_FIRST_SIXTY_SCENARIO.sessionId,
    });
  });

  it("negative control: coming back to the opening route does not re-arm the redirect", async () => {
    // Why the guard latches instead of comparing routes when the read settles. A
    // person who left and returned has met the frame; the route they are standing on
    // being equal to the one they opened at does not make it a route they did not
    // choose, and a comparison at settlement would throw them into the demo anyway.
    const frameStore = openWindow(installStore(), fixtureBridgePlayingTheDemo());
    frameStore.navigate({ kind: "settings", page: "appearance" });
    frameStore.navigate({ kind: "sessions" });

    await settle();

    expect(frameStore.getState().route).toStrictEqual({ kind: "sessions" });
  });
});
