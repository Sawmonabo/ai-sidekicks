// The resume position the window's read actually submits.
//
// A SUITE OF ITS OWN rather than another case in `session-lifecycle.bridge-swap.
// test.tsx`, whose claim is which BRIDGE a committed frame's plumbing was built from.
// This one is about what the composed adapter puts on the request it makes through
// that plumbing — a different subject, its own recording bridge, and its own way of
// driving the scheduler — and folding the two into one file took it past the length
// `apps/desktop/AGENTS.md` allows.
//
// WHY IT IS DRIVEN AND NOT TYPED. `SessionSnapshotReader` declares three parameters
// and TypeScript accepts an adapter that names one: a function of fewer parameters is
// assignable to a function type with more. So the shipped composition root took the
// entry's resume decision and dropped it on the floor, every read opened wherever it
// opened before, and no compiler, lint rule, or type test said a word. Only the
// REQUEST can report that, which is what this case reads.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";

import { createFixture } from "../bridge/fixture/fixture-bridge.test-support.js";
import { SidekicksBridgeProvider, type ConsoleBridge, type GrowthPort } from "../bridge/index.js";
import { REFRESH_DEBOUNCE_MS } from "../core/index.js";
import { type SessionStoreRegistry } from "../store/index.js";
import {
  SessionProbe,
  lastObservation,
  type Observation,
} from "./session-lifecycle.test-support.js";

/** The position the recording bridge's read acknowledges, and the entry then submits. */
const ACKNOWLEDGED_CURSOR = "bridge-swap-cursor-7";

/**
 * The request shape, taken from the port's own door rather than restated.
 *
 * `GrowthPort` is what `bridge/index.ts` publishes, and the signature table behind it
 * is not — so the request is read off the method this case actually calls, and a
 * member added or renamed there moves this type with it.
 */
type SessionReadRequest = Parameters<GrowthPort["sessionRead"]>[0];

/** The scenario engine a fixture bridge carries, without the absent arm. */
type BridgeScenarioEngine = NonNullable<ConsoleBridge["scenarioEngine"]>;

/** Every session read one composed adapter put, in the order it put them. */
interface RecordedSessionReads {
  readonly requests: readonly SessionReadRequest[];
  readonly bridge: ConsoleBridge;
}

/**
 * A bridge that records what the composed adapter asks it for.
 *
 * Only `growth.sessionRead` is replaced, so the window is still built from a fixture
 * bridge and still runs on the scenario's frozen clock — which is what makes the
 * refreshes below fire on an `advance` rather than on how fast the runner is. The
 * answer carries an ACKNOWLEDGED position, because a reply naming only `latest` leaves
 * the entry with nothing to submit and would let this case pass against an adapter
 * that forwarded nothing.
 */
function bridgeRecordingSessionReads(): RecordedSessionReads {
  const requests: SessionReadRequest[] = [];
  const fixtureBridge = createFixture().bridge;
  return {
    requests,
    bridge: {
      ...fixtureBridge,
      growth: {
        ...fixtureBridge.growth,
        sessionRead: async (request) => {
          requests.push(request);
          return {
            status: "served",
            value: {
              cursor: 0,
              entities: [],
              participantJoinLog: [],
              timelineCursors: {
                latest: "bridge-swap-cursor-9",
                acknowledged: ACKNOWLEDGED_CURSOR,
              },
            },
          };
        },
      },
    },
  };
}

/** The running engine, or a failure that names what was missing rather than `undefined`. */
function scenarioEngineOf(bridge: ConsoleBridge): BridgeScenarioEngine {
  const engine = bridge.scenarioEngine;
  if (engine === undefined) {
    throw new Error("the recording bridge carried no scenario engine, so its clock cannot move");
  }
  return engine;
}

/** The provider around one already-built bridge, which is the bridge under test. */
function providerFor(
  bridge: ConsoleBridge,
): (props: { readonly children: ReactNode }) => React.JSX.Element {
  return function RecordingBridgeHost(props: { readonly children: ReactNode }): React.JSX.Element {
    return <SidekicksBridgeProvider bridge={bridge}>{props.children}</SidekicksBridgeProvider>;
  };
}

/**
 * Ask for one re-read and let it land.
 *
 * The advance is what fires the scheduler's debounce on the scenario's frozen clock,
 * and the awaits inside `act` are what let the read's own promise settle before the
 * next assertion — the request is recorded synchronously, but the decision it feeds
 * is not.
 */
async function settleRefresh(
  registry: SessionStoreRegistry,
  sessionId: string,
  engine: BridgeScenarioEngine,
): Promise<void> {
  await act(async () => {
    registry.requestRefresh(sessionId, "reconnect");
    engine.advance(REFRESH_DEBOUNCE_MS);
    for (let tick = 0; tick < 8; tick += 1) {
      await Promise.resolve();
    }
  });
}

describe("useSessionStoreRegistry — the resume position reaches the wire", () => {
  it("submits the position the previous read acknowledged, and submits none before one", async () => {
    // THE GATE THAT ARITY CANNOT BE. `SessionSnapshotReader` declares three
    // parameters and TypeScript accepts an adapter that names one, so the shipped
    // composition root took the entry's decision and dropped it: every read opened
    // wherever it opened before, and no compiler, lint rule, or type test said a
    // word. The claim is therefore about what reaches the REQUEST, driven through
    // the real hook, the real registry, and the real adapter.
    const recording = bridgeRecordingSessionReads();
    const engine = scenarioEngineOf(recording.bridge);
    const sessionId = "session-resume-forwarding";
    const observed: Observation[] = [];
    render(
      <SessionProbe
        sessionId={sessionId}
        onObserve={(observation) => {
          observed.push(observation);
        }}
      />,
      { wrapper: providerFor(recording.bridge) },
    );
    const { registry } = lastObservation(observed);

    await settleRefresh(registry, sessionId, engine);
    const firstRequest = recording.requests.at(0);

    // The negative half, and it is half the claim: the first read of a session has
    // no acknowledged position, so a member on it would name a cursor nothing
    // established — and an adapter that always sent one would satisfy the assertion
    // below while being just as wrong.
    expect(firstRequest).toBeDefined();
    expect(firstRequest === undefined ? true : "fromCursor" in firstRequest).toBe(false);

    await settleRefresh(registry, sessionId, engine);

    expect(recording.requests.length).toBeGreaterThan(1);
    expect(recording.requests.at(-1)?.fromCursor).toBe(ACKNOWLEDGED_CURSOR);
  });
});
