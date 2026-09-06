// How every agent-console suite lets a scheduled read land.
//
// FOUR IDENTICAL COPIES BEFORE THIS MODULE. The body suites, the binding-column
// suites, and `AgentConsoleBody.peer-invocation.test.tsx` each
// declared the same eight-line `settleReads`, and `session-projection.test.ts`
// declared the same body without the `act` wrapper it has no tree for. They agreed
// only because nobody had touched one of them: a change to the refresh chokepoint
// would have had to be made four times, and a suite left behind would have gone green
// on a timing its subject no longer has.
//
// THE ADVANCE IS DERIVED, NOT TYPED OUT. Every copy advanced a bare `500`, which says
// nothing about which bound it is clearing. What the settle has to do is pass the
// refresh scheduler's TRAILING debounce, and what it must not do is reach the absolute
// deadline — a settle that crossed `REFRESH_MAX_WAIT_MS` would fire the starvation arm
// and a case counting reads would be counting the harness. Both bounds are asserted in
// `session-projection.test.ts`, so a constant that stopped satisfying either fails a
// run rather than a case somewhere downstream.

import { act } from "@testing-library/react";

import {
  fixtureBridgeWithGrowth,
  unscriptedScenario,
} from "../../bridge/fixture-bridge.test-support.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import type { ConsoleEntity, SessionSnapshot } from "../../store/index.js";

/**
 * How far a settle moves the scenario clock.
 *
 * Comfortably past {@link REFRESH_DEBOUNCE_MS} so a requested read actually fires, and
 * well short of the absolute deadline so the settle never fires the starvation arm
 * itself. Four debounce windows rather than a round number, because the multiple is
 * the claim: the headroom is measured in the bound it is clearing.
 */
export const SETTLE_ADVANCE_MS: number = REFRESH_DEBOUNCE_MS * 4;

/**
 * Move the scenario clock past the debounce and let every settled reply land.
 *
 * The microtask passes drain the read's own `await` chain — the call, the parse, and
 * the store apply — which is why a single `await Promise.resolve()` is not enough and
 * why the count lives here rather than being rediscovered per suite.
 */
export async function drainScheduledReads(bridge: ConsoleBridge): Promise<void> {
  bridge.scenarioEngine?.advance(SETTLE_ADVANCE_MS);
  for (let pass = 0; pass < 4; pass += 1) {
    await Promise.resolve();
  }
}

/** {@link drainScheduledReads} inside `act`, for a suite that has a mounted tree. */
export async function settleReads(bridge: ConsoleBridge): Promise<void> {
  await act(async () => {
    await drainScheduledReads(bridge);
  });
}

/** The session both projection suites read, so neither invents an id of its own. */
export const PROJECTION_SESSION_ID = "session-9";

/** One projected session row, under the id above. */
export function sessionEntity(body: Readonly<Record<string, unknown>>): ConsoleEntity {
  return { kind: "session", id: PROJECTION_SESSION_ID, body };
}

/** A read response whose one session reports the peer-invocation grant either way. */
export function snapshotEnabling(enabled: boolean): SessionSnapshot {
  return {
    cursor: 4,
    entities: [sessionEntity({ peerInvocationEnabled: enabled })],
    participantJoinLog: [],
  };
}

/**
 * The real fixture bridge with the one operation the projection model reads replaced.
 *
 * The fixture bridge rather than a hand-built object, so a case is driven through the
 * same port surface the pane holds — including the scenario clock every settle above
 * advances, which a bare stub would not carry.
 */
export function bridgeReadingProjection(
  sessionRead: ConsoleBridge["growth"]["sessionRead"],
  alsoServing: Partial<ConsoleBridge["growth"]> = {},
): ConsoleBridge {
  return fixtureBridgeWithGrowth(unscriptedScenario("agent-console-projection"), {
    sessionRead,
    ...alsoServing,
  });
}
