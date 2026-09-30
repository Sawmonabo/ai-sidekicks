// The collaborators every session-store-registry suite constructs a registry with: the reader,
// the projector, the event and snapshot builders, the microtask settle, and an initialized store.
//
// Shared because suites in several features build their initialized store through it. It is the
// surrounding cast and not a stand-in for the registry, and one builder for the store keeps every
// suite in step when `SessionStore.initialize` grows a required member.

import type {
  ProjectedSessionEvent,
  EntityProjectorTable,
} from "@renderer/store/session/entities/entities.js";
import type { SessionSnapshotReader } from "@renderer/store/session/open-session-entry.js";
import { eventOfKind } from "./session-events.js";
import { SessionStore, type SessionSnapshot } from "@renderer/store/session/session-store.js";

/** A reader that establishes nothing: the honest "no wire is registered" answer. */
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
 * Built from {@link emptySnapshot} so the shape a store is opened with is written once.
 */
export function initializedStore(sessionId: string): SessionStore {
  const sessionStore = new SessionStore({ sessionId });
  sessionStore.initialize(emptySnapshot(0));
  return sessionStore;
}
