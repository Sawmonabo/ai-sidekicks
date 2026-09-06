// One read, two readers — and the re-read the console raises without editing the view
// that performs it.
//
// Driven through the seam itself rather than through a page, because both claims are
// about the seam: that what a console surface reads is what the absorbed roster's own
// read answered, and that a window regaining focus raises the change signal that view's
// contract already takes. A page in the middle would prove the page's wiring and leave
// either of those free to be wrong.

import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { unscriptedScenario } from "../bridge/fixture/fixture-bridge.test-support.js";
import { SETTINGS_SCENARIO } from "../bridge/scenarios/settings.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import { settle } from "../core/settle.test-support.js";
import {
  nodeRosterReadsFor,
  useNodeRosterFocusReRead,
  useNodeRosterObservation,
  type NodeRosterObservation,
} from "./node-roster-seam.js";

/** The tick this scenario's roster names two machines at. */
const BOTH_MACHINES_ONLINE_MS = 200;

/**
 * A scenario's session id, as the read seam is typed to take it.
 *
 * One cast in one place, matching the shipped mount's own `brandedSessionId`: a
 * scenario declares its session as a string and the registered request types it as a
 * brand, and spelling the cast at each call site would be four claims instead of one.
 */
function sessionIdOf(value: string): SessionId {
  return value as SessionId;
}

/** One line a case can assert on, so an arm change is a text change. */
function readingOf(observation: NodeRosterObservation): string {
  if (observation.kind === "unread") {
    return "unread";
  }
  if (observation.kind === "unreadable") {
    return `unreadable:${observation.refusal.code}`;
  }
  return `read:${observation.response.nodes.length}`;
}

/** A private probe: the hook under test, and nothing else. */
function ObservationProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string | undefined;
}): ReactNode {
  const observation = useNodeRosterObservation(props.bridge, props.sessionId);
  return <span data-testid="observation">{readingOf(observation)}</span>;
}

/** A second private probe: the focus trigger, with nothing rendered from it. */
function FocusReReadProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
}): ReactNode {
  useNodeRosterFocusReRead(props.bridge, props.sessionId);
  return null;
}

function bridgeWithRoster(): ConsoleBridge {
  const bridge = createFixtureBridge({ scenario: SETTINGS_SCENARIO });
  bridge.scenarioEngine?.advance(BOTH_MACHINES_ONLINE_MS);
  return bridge;
}

/**
 * Regaining focus, as the window reports it.
 *
 * The wait is a BOUNDARY and not a count of microtask turns: the trigger fires an
 * effect that raises a handler that starts a read, and a fixed number of `await`s is
 * tuned against whatever that chain happens to be today.
 */
async function refocusWindow(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await crossMacrotaskBoundary();
  });
}

describe("the seam the absorbed roster reads through", () => {
  it("hands one bridge the same read pair every time it is asked", () => {
    // The property the absorbed view's effect depends on: a fresh pair per render
    // would tear its subscription down and re-open it on every render above it.
    const bridge = bridgeWithRoster();
    expect(nodeRosterReadsFor(bridge)).toBe(nodeRosterReadsFor(bridge));
  });

  it("hands a different bridge a different pair, so a transport swap is noticed", () => {
    expect(nodeRosterReadsFor(bridgeWithRoster())).not.toBe(nodeRosterReadsFor(bridgeWithRoster()));
  });
});

describe("what a console surface reads beside the roster", () => {
  it("is the response the roster's own read answered", async () => {
    const bridge = bridgeWithRoster();
    render(<ObservationProbe bridge={bridge} sessionId={SETTINGS_SCENARIO.sessionId} />);
    expect(screen.getByTestId("observation").textContent).toBe("unread");

    await act(async () => {
      await nodeRosterReadsFor(bridge).readRoster({
        sessionId: sessionIdOf(SETTINGS_SCENARIO.sessionId),
      });
    });

    expect(screen.getByTestId("observation").textContent).toBe("read:2");
  });

  it("is the refusal, in the refuser's own code, when the read declined", async () => {
    const scenario = unscriptedScenario("seam-no-roster");
    const bridge = createFixtureBridge({ scenario });
    render(<ObservationProbe bridge={bridge} sessionId={scenario.sessionId} />);

    await act(async () => {
      await nodeRosterReadsFor(bridge)
        .readRoster({ sessionId: sessionIdOf(scenario.sessionId) })
        .catch(() => undefined);
    });

    expect(screen.getByTestId("observation").textContent).toBe("unreadable:roster-unscripted");
  });

  it("negative control: a session nobody read stays unread beside one that was", async () => {
    // Without this, an observation held per BRIDGE rather than per session would pass
    // every case above while answering a new session out of the old session's read.
    const bridge = bridgeWithRoster();
    render(<ObservationProbe bridge={bridge} sessionId="019b7892-1c00-75e5-8510-000000000000" />);

    await act(async () => {
      await nodeRosterReadsFor(bridge).readRoster({
        sessionId: sessionIdOf(SETTINGS_SCENARIO.sessionId),
      });
    });

    expect(screen.getByTestId("observation").textContent).toBe("unread");
  });
});

describe("re-reading when the window comes back", () => {
  it("raises the roster's own change signal, and raises none on mount", async () => {
    // The signal the absorbed view's contract already takes — a push says WHEN to
    // re-read — rather than a fresh seam, which would return a live roster to its
    // loading shape. Nothing fires on mount: that arm is the view's own initial read.
    const bridge = bridgeWithRoster();
    const reads = nodeRosterReadsFor(bridge);
    let signalCount = 0;
    const release = reads.subscribePresence(sessionIdOf(SETTINGS_SCENARIO.sessionId), () => {
      signalCount += 1;
    });

    render(<FocusReReadProbe bridge={bridge} sessionId={SETTINGS_SCENARIO.sessionId} />);
    await settle();
    expect(signalCount).toBe(0);

    await refocusWindow();
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

    render(<FocusReReadProbe bridge={bridge} sessionId={SETTINGS_SCENARIO.sessionId} />);
    await refocusWindow();

    expect(signalCount).toBe(0);
  });
});
