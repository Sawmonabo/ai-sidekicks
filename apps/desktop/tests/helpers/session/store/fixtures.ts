// The dependencies every session-store-registry suite constructs a registry with: the reader,
// the projector, the event and base-state builders, the microtask settle, and an initialized store.
//
// Shared because suites in several features build their initialized store through it. It is the
// surrounding cast and not a stand-in for the registry, and one builder for the store keeps every
// suite in step when `SessionStore.initialize` grows a required member.

import type {
  ProjectedSessionEvent,
  EntityProjectorTable,
} from "#renderer/store/session/entities/vocabulary.js";
import type { SessionBaseStateReader } from "#renderer/store/session/open/entry.js";
import { eventOfKind } from "../events.js";
import type { SessionBaseState } from "#renderer/store/session/state.js";
import { SessionStore } from "#renderer/store/session/store.js";

/** A reader that establishes nothing: the honest "no wire is registered" answer. */
export const readsNothing: SessionBaseStateReader = () => Promise.resolve(undefined);

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
export function emptyBaseState(cursor: number): SessionBaseState {
  return { cursor, entities: [] };
}

/**
 * An initialized store, so an appended event is admitted rather than buffered.
 *
 * Built from {@link emptyBaseState} so the shape a store is opened with is written once.
 */
export function initializedStore(sessionId: string): SessionStore {
  const sessionStore = new SessionStore({ sessionId });
  sessionStore.initialize(emptyBaseState(0));
  return sessionStore;
}
