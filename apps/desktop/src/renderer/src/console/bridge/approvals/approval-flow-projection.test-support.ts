// The approval-flow suites' shared scaffolding: wire-shaped approval events.
//
// Both suites fold events the registered schemas accept, because the whole point of
// the fold is that it reads a payload through a member table rather than by sniffing
// — so an event built two ways in two files would let one suite assert against a
// shape the other could not produce.

import { APPROVAL_FLOW_PROJECTORS } from "./approval-flow-projection.js";
import { APPROVALS_SCENARIO } from "../scenarios/approvals.js";
import {
  SessionStore,
  type ConsoleSessionEvent,
  type EntityProjectorRegistry,
} from "../../store/index.js";

export const SESSION_ID: string = APPROVALS_SCENARIO.sessionId;

/** One store, opened with exactly what the composer family registers. */
export function storeDrivenByScenario(): SessionStore {
  return storeOver(APPROVAL_FLOW_PROJECTORS);
}

/**
 * One store fed the scenario's whole log, folding with whatever it was opened with.
 *
 * `extraEvents` is appended after the scenario's own beats, for the cases whose
 * subject is a payload no scenario has a reason to play. Defaulted, so the ordinary
 * caller reads as it did — and a parameter rather than a second copy of this
 * function, which is what the approvals pane's provider-ask suite had: the cursor
 * arithmetic and the join-log seeding are the STORE's contract, and a suite holding
 * its own copy of them is a suite that will disagree with the store about a gap.
 */
export function storeOver(
  projectors: EntityProjectorRegistry | undefined,
  extraEvents: readonly ConsoleSessionEvent[] = [],
): SessionStore {
  const sequences = APPROVALS_SCENARIO.beats.map((beat) => beat.event.sequence);
  const store = new SessionStore({
    sessionId: SESSION_ID,
    ...(projectors === undefined ? {} : { projectors }),
  });
  // A base state current as of the beat just before the scenario's first: a store
  // treats the distance from its cursor to an event as a gap, so a cursor of `-1`
  // would degrade a store for a hole the scenario never had.
  store.initialise({
    cursor: Math.min(...sequences) - 1,
    entities: [],
    participantJoinLog: [...APPROVALS_SCENARIO.participantIdsInJoinOrder],
  });
  store.applyBatch([
    ...APPROVALS_SCENARIO.beats.map((beat) => beat.event as ConsoleSessionEvent),
    ...extraEvents,
  ]);
  return store;
}

/** One hand-built beat, for the payload shapes no scenario has a reason to play. */
export function approvalEvent(options: {
  readonly kind: string;
  readonly sequence: number;
  readonly payload: Readonly<Record<string, unknown>> | undefined;
  readonly actorId?: string;
}): ConsoleSessionEvent {
  return {
    id: `event-${String(options.sequence)}`,
    sessionId: SESSION_ID,
    sequence: options.sequence,
    kind: options.kind,
    occurredAt: "2026-01-01T13:30:00.000Z",
    ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  };
}
