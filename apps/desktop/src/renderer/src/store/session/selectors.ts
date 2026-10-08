// The narrow reads a view may make of a session store's state: the transcript, the standing
// events, a whole partition or one entity, never a composed whole-pane object, so
// `useSyncExternalStore` bails on `Object.is` for every kind the last transition did not touch.
//
// No selector names a wire shape. `entities/vocabulary.ts` keeps the store free of wire knowledge,
// and a validating body read needs the canonical shape, which only the daemon service owns. A
// store hook that wants one takes it as an injected reader.

import type { ProjectedSessionEvent, StoredEntity } from "./entities/vocabulary.js";
import type { EntityKind, EntityRef } from "#renderer/lib/entity-kinds.js";
import type { SessionStoreState } from "./state.js";

/**
 * The session's transcript: the stored array itself, so the store's `Object.is` check is a pointer
 * check; a mapped array would re-render the reader on every event.
 */
export function selectTranscript(state: SessionStoreState): readonly ProjectedSessionEvent[] {
  return state.transcript;
}

/** The events the newest batch admitted, the transcript's tail held or not. */
export function selectLastAdmittedEvents(
  state: SessionStoreState,
): readonly ProjectedSessionEvent[] {
  return state.lastAdmittedEvents;
}

/**
 * The newest event of each kind and subject a standing fact is read from, whatever rows the window
 * holds: the stored array itself, so a reader folds again only when one of them changed.
 */
export function selectStandingEvents(state: SessionStoreState): readonly ProjectedSessionEvent[] {
  return state.standingEvents;
}

/** Every entity of one kind. A narrow pick, never a whole-pane object. */
export function selectPartition(
  state: SessionStoreState,
  kind: EntityKind,
): Readonly<Record<string, StoredEntity>> {
  return state.partitions[kind];
}

/** One entity, or `undefined` when the store has never seen it. */
export function selectEntity(state: SessionStoreState, ref: EntityRef): StoredEntity | undefined {
  return state.partitions[ref.kind][ref.id];
}
