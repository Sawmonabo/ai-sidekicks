// Each moment a held roster goes stale, and the one signal it costs.
//
// A sibling of `node-roster-seam.test.tsx` rather than a block inside it: that suite is
// about what a read ANSWERED and this one is about when the absorbed view is asked to
// read AGAIN. Driven through the seam and the trigger hook themselves rather than
// through a page, because a page in the middle would prove the page's wiring and leave
// any of the four moments free to be wrong.
//
// Every case asserts the SCHEDULED shape rather than an immediate raise: a reason lands
// in `store/scheduling.ts` and the frozen clock is advanced past the coalescing window
// on purpose, so a trigger that re-read straight off its signal — the burst this seam
// was built to stop costing three reads — fails here rather than passing quietly.

import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { unscriptedScenario } from "../bridge/fixture/fixture-bridge.test-support.js";
import { SETTINGS_SCENARIO } from "../bridge/scenarios/settings.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import { PAST_REFRESH_DEBOUNCE_MS, settle } from "../core/settle.test-support.js";
import type { ConsoleSessionEvent, SessionStore } from "../store/index.js";
import { eventOfKind } from "../store/session-event.test-support.js";
import { initialisedStore } from "../store/session-store-registry.test-support.js";
import { nodeRosterReadsFor } from "./node-roster-seam.js";
import { useNodeRosterReReadTriggers } from "./node-roster-triggers.js";
import { bridgeWithRoster, sessionIdOf } from "./node-roster.test-support.js";

/** The tick an ad-hoc scenario's single beat is scripted at. */
const BEAT_AT_MS = 10;

/** A private probe: the trigger set, with nothing rendered from it. */
function ReReadTriggerProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  readonly sessionStore: SessionStore | undefined;
}): ReactNode {
  useNodeRosterReReadTriggers(props.bridge, props.sessionId, props.sessionStore);
  return null;
}

/**
 * A fixture bridge whose scenario plays exactly one beat, of the caller's kind.
 *
 * An ad-hoc scenario rather than a shipped one, because what each refresh case is
 * about is ONE delivered frame and the shipped decks script bursts — a case reading a
 * raise count over the settings deck would be counting that deck's authoring rather
 * than this seam's routing.
 */
function bridgePlayingOneBeat(
  scenarioId: string,
  kind: ConsoleSessionEvent["kind"],
): { readonly bridge: ConsoleBridge; readonly sessionId: SessionId } {
  const scenario = unscriptedScenario(scenarioId);
  const bridge = createFixtureBridge({
    scenario: {
      ...scenario,
      beats: [{ atMs: BEAT_AT_MS, event: eventOfKind(scenario.sessionId, kind, 1) }],
    },
  });
  return { bridge, sessionId: sessionIdOf(scenario.sessionId) };
}

/**
 * Regaining focus, as the window reports it.
 *
 * The wait is a BOUNDARY and not a count of microtask turns: the trigger fires an
 * effect that raises a handler, and a fixed number of `await`s is tuned against
 * whatever that chain happens to be today.
 */
async function refocusWindow(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await crossMacrotaskBoundary();
  });
}

/** Carry the seam's refresh schedule past its debounce window on the frozen clock. */
async function crossRefreshWindow(bridge: ConsoleBridge): Promise<void> {
  await act(async () => {
    bridge.scenarioEngine?.advance(PAST_REFRESH_DEBOUNCE_MS);
    await crossMacrotaskBoundary();
  });
}

describe("the moments the absorbed roster is asked to read again", () => {
  it("raises the roster's own change signal on focus, and raises none on mount", async () => {
    // The signal the absorbed view's contract already takes — a push says WHEN to
    // re-read — rather than a fresh seam, which would return a live roster to its
    // loading shape. Nothing fires on mount: that arm is the view's own initial read.
    const bridge = bridgeWithRoster();
    const reads = nodeRosterReadsFor(bridge);
    let signalCount = 0;
    const release = reads.subscribePresence(sessionIdOf(SETTINGS_SCENARIO.sessionId), () => {
      signalCount += 1;
    });

    render(
      <ReReadTriggerProbe
        bridge={bridge}
        sessionId={SETTINGS_SCENARIO.sessionId}
        sessionStore={undefined}
      />,
    );
    await settle();
    expect(signalCount).toBe(0);

    await refocusWindow();
    await crossRefreshWindow(bridge);
    expect(signalCount).toBe(1);

    release();
  });

  it("negative control: a released subscription is never signalled again", async () => {
    // A handler outliving the mount that registered it would re-read through a seam
    // nobody is rendering — and the case above would pass anyway.
    const bridge = bridgeWithRoster();
    const reads = nodeRosterReadsFor(bridge);
    let signalCount = 0;
    const release = reads.subscribePresence(sessionIdOf(SETTINGS_SCENARIO.sessionId), () => {
      signalCount += 1;
    });
    release();

    render(
      <ReReadTriggerProbe
        bridge={bridge}
        sessionId={SETTINGS_SCENARIO.sessionId}
        sessionStore={undefined}
      />,
    );
    await refocusWindow();
    await crossRefreshWindow(bridge);

    expect(signalCount).toBe(0);
  });

  it("negative control: a burst of focuses inside one window costs one signal", async () => {
    // What routing every reason through `store/scheduling.ts` buys, asserted rather
    // than assumed: without the scheduler each raiser re-read on its own, and a node
    // registering, declaring a capability and coming online inside one advance cost
    // three reads of an answer only the last of them was going to render.
    const bridge = bridgeWithRoster();
    const reads = nodeRosterReadsFor(bridge);
    let signalCount = 0;
    const release = reads.subscribePresence(sessionIdOf(SETTINGS_SCENARIO.sessionId), () => {
      signalCount += 1;
    });

    render(
      <ReReadTriggerProbe
        bridge={bridge}
        sessionId={SETTINGS_SCENARIO.sessionId}
        sessionStore={undefined}
      />,
    );
    await settle();
    await refocusWindow();
    await refocusWindow();
    await refocusWindow();
    expect(signalCount).toBe(0);

    await crossRefreshWindow(bridge);
    expect(signalCount).toBe(1);

    release();
  });
});

describe("a capability declaration reaching the presence channel", () => {
  it("schedules exactly one re-read of the roster", async () => {
    // `capabilities` rides the roster entry and the settings page renders one block
    // from it, so a node re-declaring a capability changes the answer. The presence
    // set once carried the five state-transition names only, and that block stood on
    // a stale reading until an unrelated transition, a focus, or a reconnect.
    const { bridge, sessionId } = bridgePlayingOneBeat(
      "seam-capability-beat",
      "runtime_node.capability_updated",
    );
    const reads = nodeRosterReadsFor(bridge);
    let signalCount = 0;
    const release = reads.subscribePresence(sessionId, () => {
      signalCount += 1;
    });

    await act(async () => {
      bridge.scenarioEngine?.advance(BEAT_AT_MS);
      await crossMacrotaskBoundary();
    });
    expect(signalCount).toBe(0);

    await crossRefreshWindow(bridge);
    expect(signalCount).toBe(1);

    release();
  });

  it("negative control: a kind the presence subscription does not carry raises nothing", async () => {
    // Without this the case above would hold for a subscription that delivered every
    // scripted beat to every handler, which proves nothing about which names it took.
    const { bridge, sessionId } = bridgePlayingOneBeat("seam-unwatched-beat", "session.created");
    const reads = nodeRosterReadsFor(bridge);
    let signalCount = 0;
    const release = reads.subscribePresence(sessionId, () => {
      signalCount += 1;
    });

    await act(async () => {
      bridge.scenarioEngine?.advance(BEAT_AT_MS);
      await crossMacrotaskBoundary();
    });
    await crossRefreshWindow(bridge);

    expect(signalCount).toBe(0);
    release();
  });
});

describe("a lease change in the session's own timeline", () => {
  it("schedules exactly one re-read of the roster", async () => {
    // `controlHolder` rides the roster RESPONSE and nothing on the presence channel
    // announces it, so without this trigger the terminal-control line stood on
    // whatever the last node transition happened to have read.
    const bridge = bridgeWithRoster();
    const reads = nodeRosterReadsFor(bridge);
    const sessionStore = initialisedStore(SETTINGS_SCENARIO.sessionId);
    let signalCount = 0;
    const release = reads.subscribePresence(sessionIdOf(SETTINGS_SCENARIO.sessionId), () => {
      signalCount += 1;
    });

    render(
      <ReReadTriggerProbe
        bridge={bridge}
        sessionId={SETTINGS_SCENARIO.sessionId}
        sessionStore={sessionStore}
      />,
    );
    await settle();

    await act(async () => {
      sessionStore.apply(eventOfKind(sessionStore.sessionId, "pty.control_changed", 1));
      await crossMacrotaskBoundary();
    });
    expect(signalCount).toBe(0);

    await crossRefreshWindow(bridge);
    expect(signalCount).toBe(1);

    release();
  });

  it("negative control: another kind on the same timeline raises nothing", async () => {
    // Without this the case above would hold for a trigger that re-read on every
    // store transition — the poll this console refuses, wearing another name.
    const bridge = bridgeWithRoster();
    const reads = nodeRosterReadsFor(bridge);
    const sessionStore = initialisedStore(SETTINGS_SCENARIO.sessionId);
    let signalCount = 0;
    const release = reads.subscribePresence(sessionIdOf(SETTINGS_SCENARIO.sessionId), () => {
      signalCount += 1;
    });

    render(
      <ReReadTriggerProbe
        bridge={bridge}
        sessionId={SETTINGS_SCENARIO.sessionId}
        sessionStore={sessionStore}
      />,
    );
    await settle();

    await act(async () => {
      sessionStore.apply(eventOfKind(sessionStore.sessionId, "run.completed", 1));
      await crossMacrotaskBoundary();
    });
    await crossRefreshWindow(bridge);

    expect(signalCount).toBe(0);
    release();
  });

  it("negative control: the same frame raises nothing when the window holds no store", async () => {
    // Without this the case above would pass over a trigger set that re-read on any
    // render, and would prove nothing about which signal reached the seam.
    const bridge = bridgeWithRoster();
    const reads = nodeRosterReadsFor(bridge);
    const sessionStore = initialisedStore(SETTINGS_SCENARIO.sessionId);
    let signalCount = 0;
    const release = reads.subscribePresence(sessionIdOf(SETTINGS_SCENARIO.sessionId), () => {
      signalCount += 1;
    });

    render(
      <ReReadTriggerProbe
        bridge={bridge}
        sessionId={SETTINGS_SCENARIO.sessionId}
        sessionStore={undefined}
      />,
    );
    await settle();

    await act(async () => {
      sessionStore.apply(eventOfKind(sessionStore.sessionId, "pty.control_changed", 1));
      await crossMacrotaskBoundary();
    });
    await crossRefreshWindow(bridge);

    expect(signalCount).toBe(0);
    release();
  });
});
