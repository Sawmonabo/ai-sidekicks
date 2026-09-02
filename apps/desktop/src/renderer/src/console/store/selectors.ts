// The narrow reads a surface is allowed to make of a session store's state.
//
// `Spec-023 §Console Design (Meridian)` §The eight rules, rule 6: a store is read
// through its selector and never by reaching into its state. These are those
// selectors, and they are narrow on purpose — a whole-partition or single-entity
// pick, never a composed whole-pane object, so `useSyncExternalStore`'s equality
// check bails on `Object.is` for every kind the last transition did not touch.

import type { ConsoleEntity, ConsoleEntityKind, ConsoleEntityRef } from "./entities.js";
import type { SessionStoreState } from "./session-state.js";

/** Every entity of one kind. A narrow pick, never a whole-pane object. */
export function selectPartition(
  state: SessionStoreState,
  kind: ConsoleEntityKind,
): Readonly<Record<string, ConsoleEntity>> {
  return state.partitions[kind];
}

/** One entity, or `undefined` when the store has never seen it. */
export function selectEntity(
  state: SessionStoreState,
  ref: ConsoleEntityRef,
): ConsoleEntity | undefined {
  return state.partitions[ref.kind][ref.id];
}
