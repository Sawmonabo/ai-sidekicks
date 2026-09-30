// The approval-flow suites' shared scaffolding: wire-shaped approval events the contract's
// payload schemas accept, so two suites never assert against different shapes.

import { APPROVAL_FLOW_PROJECTORS } from "./approval-flow-projection.js";
import { APPROVAL_REQUEST_SCENARIO } from "../../../../../fixtures/scenarios/approval-request.js";
import { SessionStore } from "../session/session-store.js";
import {
  type ProjectedSessionEvent,
  type EntityProjectorTable,
} from "../session/entities/entities.js";

/** The session id the scenario's events carry. */
export const SESSION_ID: string = APPROVAL_REQUEST_SCENARIO.sessionId;

/** One store, opened with exactly what the composer feature registers. */
export function storeDrivenByScenario(): SessionStore {
  return storeOver(APPROVAL_FLOW_PROJECTORS);
}

/**
 * One store fed the scenario's whole log, folding with the projectors it is given.
 * `extraEvents` follow the scenario's beats, for payloads no scenario plays. The cursor and
 * join-log seeding stay here so suites cannot disagree with the store about a gap.
 */
export function storeOver(
  projectors: EntityProjectorTable | undefined,
  extraEvents: readonly ProjectedSessionEvent[] = [],
): SessionStore {
  const sequences = APPROVAL_REQUEST_SCENARIO.beats.map((beat) => beat.event.sequence);
  const store = new SessionStore({
    sessionId: SESSION_ID,
    ...(projectors === undefined ? {} : { projectors }),
  });
  // Current as of the beat before the first, so a `-1` cursor does not read as a gap.
  store.initialize({
    cursor: Math.min(...sequences) - 1,
    entities: [],
  });
  store.applyBatch([
    ...APPROVAL_REQUEST_SCENARIO.beats.map((beat) => beat.event as ProjectedSessionEvent),
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
}): ProjectedSessionEvent {
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
