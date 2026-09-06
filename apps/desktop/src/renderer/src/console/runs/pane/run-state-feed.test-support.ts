// The run-state suites' shared scaffolding: wire-shaped frames and a mounted feed.
//
// Both suites need frames the registered schemas accept, because the fold's whole
// rule is that a frame parsing as neither arm is refused rather than sniffed. Written
// once so the fold's cases and the subscription's cases cannot drift into disagreeing
// about what a valid frame looks like.

import { createElement, useEffect } from "react";
import {
  createFixture,
  drainMicrotasks,
} from "../../bridge/fixture/fixture-bridge.test-support.js";
import { withRecordedStreamLifecycle } from "../../bridge/daemon-streams.test-support.js";
import { act, render } from "@testing-library/react";
import type { ConsoleBridge } from "../../bridge/index.js";
import { SessionStore } from "../../store/index.js";
import { useRunFeed, type RunStateFeed } from "./run-state-feed.js";
import { RUN_ID } from "./runs-pane.test-support.js";

/** A canonical UUID: the registered session schema brands its id and refuses anything else. */
export const SESSION_ID = "0a1b2c3d-4e5f-4061-8273-9a4b5c6d7e8f";

/** A transition, exactly as `RunStateChangeEventSchema` registers it. */
export const STATE_CHANGE_DELIVERY: Readonly<Record<string, unknown>> = {
  runId: RUN_ID,
  runVersion: 3,
  previousState: "starting",
  currentState: "running",
  timestamp: "2026-09-02T09:00:00.000Z",
};

/** A rewind, exactly as `RunRolledBackEventSchema` registers it. */
export const ROLLED_BACK_DELIVERY: Readonly<Record<string, unknown>> = {
  sessionId: SESSION_ID,
  runId: RUN_ID,
  runVersion: 4,
  targetPosition: 12,
};

/**
 * The whole-session envelope, wrapping the very same transition.
 *
 * The wrapper is the only difference from `STATE_CHANGE_DELIVERY`, which is what
 * makes the negative control below decisive: if the fold accepted this it would be
 * accepting the wrapper, not recovering the payload.
 */
export interface EnvelopeShapedDelivery {
  readonly sessionId: string;
  readonly sequence: number;
  readonly kind: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export const ENVELOPE_SHAPED_DELIVERY: EnvelopeShapedDelivery = {
  sessionId: SESSION_ID,
  sequence: 9,
  kind: "run.running",
  occurredAt: "2026-09-02T09:00:00.000Z",
  payload: STATE_CHANGE_DELIVERY,
};

/**
 * Mount the feed against one bridge and one store, and report what it answered.
 *
 * Composed with `createElement` rather than JSX so the module's own tests stay in
 * one file: everything else here drives the fold directly and needs no tree. Every
 * case that needs a tree goes through this one mount, so a bridge that fails at a
 * different point is a different ARGUMENT rather than a second probe.
 */
export async function mountStateFeed(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
): Promise<() => RunStateFeed> {
  let held: RunStateFeed | undefined;
  function StateFeedProbe(): null {
    const feed = useRunFeed(bridge, sessionStore);
    useEffect(() => {
      held = feed;
    }, [feed]);
    return null;
  }
  render(createElement(StateFeedProbe));
  await act(async () => {
    await drainMicrotasks();
  });
  return () => {
    if (held === undefined) {
      throw new Error("the run-state feed reported nothing, so there is no reading to assert");
    }
    return held;
  };
}

/** Open the feed for one session over the shipped fixture, recording what it opened. */
export async function openStateFeed(
  sessionId: string,
  seed?: (store: SessionStore) => void,
): Promise<{
  readonly openedStreams: readonly string[];
  readonly feed: RunStateFeed;
}> {
  const { bridge, openedStreams } = withRecordedStreamLifecycle(createFixture().bridge);
  const sessionStore = new SessionStore({ sessionId });
  seed?.(sessionStore);
  const readFeed = await mountStateFeed(bridge, sessionStore);
  return { openedStreams, feed: readFeed() };
}
