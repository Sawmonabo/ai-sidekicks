// The collaborators every session-store-registry suite constructs a registry with.
//
// One home for the reader, the projector, the event and snapshot builders, the
// microtask settle, and the initialised store the sibling suites share. Nothing here
// is a stand-in for the registry: it is the surrounding cast, and a second copy of the
// projector would let two suites disagree about what an applied event looks like.
//
// AND IT IS THE HOME FOR THE STORE ITSELF, which is what `initialisedStore` is doing
// at the bottom of this file. Three families had written that builder — the run
// console, the workspace mounts page, and this directory's own event-signal suite —
// byte for byte, in three trees whose authors do not read each other's diffs. They
// agreed only because none of them had been touched: `SessionStore.initialise` growing
// a required member would have had to move in three places, and the one left behind
// would have gone green over a store its siblings no longer build.

import type { ConsoleSessionEvent, EntityProjectorRegistry } from "./entities.js";
import type { SessionSnapshotReader } from "./open-session-entry.js";
import { eventOfKind } from "./session-event.test-support.js";
import { SessionStore, type SessionSnapshot } from "./session-store.js";

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
  return eventOfKind("session-1", "run.starting", sequence, { runId });
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

/**
 * An initialised store, so an appended event is admitted rather than buffered.
 *
 * Built from {@link emptySnapshot} rather than from a second base-state literal, so
 * the shape a store is opened with is written once in this file too.
 */
export function initialisedStore(sessionId: string): SessionStore {
  const sessionStore = new SessionStore({ sessionId });
  sessionStore.initialise(emptySnapshot(0));
  return sessionStore;
}
