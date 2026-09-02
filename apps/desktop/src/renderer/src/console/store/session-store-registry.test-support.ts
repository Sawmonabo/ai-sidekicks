// The collaborators every session-store-registry suite constructs a registry with.
//
// One home for the reader, the projector, the event and snapshot builders, and the
// microtask settle the three sibling suites share. Nothing here is a stand-in for
// the registry: it is the surrounding cast, and a second copy of the projector
// would let two suites disagree about what an applied event looks like.

import type { ConsoleSessionEvent, EntityProjectorRegistry } from "./entities.js";
import type { SessionSnapshotReader } from "./open-session-entry.js";
import type { SessionSnapshot } from "./session-store.js";

/** A reader that establishes nothing. The honest "no wire is registered" answer. */
export const readsNothing: SessionSnapshotReader = () => Promise.resolve(undefined);

function runIdOf(event: ConsoleSessionEvent): string {
  const raw = event.payload?.["runId"];
  return typeof raw === "string" ? raw : "unknown-run";
}

/** One projector, so an applied event is observable as an entity rather than a count. */
export const projectors: EntityProjectorRegistry = {
  "run.starting": (event) => [
    {
      operation: "upsert",
      entity: { kind: "run", id: runIdOf(event), state: "running" },
    },
  ],
};

/** One event at `sequence`, carrying the run id the projector reads. */
export function eventAt(sequence: number, runId: string): ConsoleSessionEvent {
  return {
    id: `event-${String(sequence)}`,
    sessionId: "session-1",
    sequence,
    kind: "run.starting",
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    payload: { runId },
  };
}

/** A base state at `cursor` holding nothing, which the read answers with. */
export function emptySnapshot(cursor: number): SessionSnapshot {
  return { cursor, entities: [], participantJoinLog: [] };
}

/** Let every queued continuation run. The registry settles across microtasks. */
export async function settleMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await Promise.resolve();
  }
}
