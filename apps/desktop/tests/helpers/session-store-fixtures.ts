// The collaborators every session-store-registry suite constructs a registry with.
//
// IN `tests/helpers/` AND NOT BESIDE THE SESSION STORE: suites in several features build
// their initialized store through it, and the read scheduler suites settle microtasks
// through it, so it is shared scaffolding rather than one module's.
//
// One home for the reader, the projector, the event and snapshot builders, the
// microtask settle, and the initialized store the sibling suites share. Nothing here
// is a stand-in for the registry: it is the surrounding cast, and a second copy of the
// projector would let two suites disagree about what an applied event looks like.
//
// AND IT IS THE HOME FOR THE STORE ITSELF, which is what `initializedStore` is doing
// at the bottom of this file. One builder, because
// copies in several suites agree only until `SessionStore.initialize` grows a required
// member: it would have to move in every copy, and the one left behind would go green
// over a store the others no longer build.

import type {
  ProjectedSessionEvent,
  EntityProjectorTable,
} from "@renderer/store/session/entities/entities.js";
import type { SessionSnapshotReader } from "@renderer/store/session/open-session-entry.js";
import { eventOfKind } from "./session-events.js";
import { SessionStore, type SessionSnapshot } from "@renderer/store/session/session-store.js";

/** A reader that establishes nothing. The honest "no wire is registered" answer. */
export const readsNothing: SessionSnapshotReader = () => Promise.resolve(undefined);

function runIdOf(event: ProjectedSessionEvent): string {
  const raw = event.payload?.["runId"];
  return typeof raw === "string" ? raw : "unknown-run";
}

/** One projector, so an applied event is observable as an entity rather than a count. */
export const projectors: EntityProjectorTable = {
  "run.starting": (event) => [
    {
      operation: "upsert",
      entity: { kind: "run", id: runIdOf(event), state: "running" },
    },
  ],
};

/** One event at `sequence`, carrying the run id the projector reads. */
export function runEventAt(sequence: number, runId: string): ProjectedSessionEvent {
  return eventOfKind("session-1", "run.starting", sequence, { runId });
}

/** A base state at `cursor` holding nothing, which the read answers with. */
export function emptySnapshot(cursor: number): SessionSnapshot {
  return { cursor, entities: [] };
}

/** Let every queued continuation run. The registry settles across microtasks. */
export async function settleMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await Promise.resolve();
  }
}

/**
 * An initialized store, so an appended event is admitted rather than buffered.
 *
 * Built from {@link emptySnapshot} rather than from a second base-state literal, so
 * the shape a store is opened with is written once in this file too.
 */
export function initializedStore(sessionId: string): SessionStore {
  const sessionStore = new SessionStore({ sessionId });
  sessionStore.initialize(emptySnapshot(0));
  return sessionStore;
}
