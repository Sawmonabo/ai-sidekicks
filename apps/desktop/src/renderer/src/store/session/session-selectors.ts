// The narrow reads a surface is allowed to make of a session store's state.
//
// A store is read through its selector and never by reaching into its state. These are
// those selectors, and they are narrow on purpose — a whole-partition or single-entity
// pick, never a composed whole-pane object, so `useSyncExternalStore`'s equality check
// bails on `Object.is` for every kind the last transition did not touch.
//
// AND NO SELECTOR HERE NAMES A WIRE SHAPE. `store/entities/entities.ts` frames
// `ProjectedSessionEvent` as a renderer-local projection contract so this family
// holds no wire knowledge. A body read that names a wire shape is a validating read,
// and a validating read needs the canonical shape; the family that owns the wire's
// shapes is the family that may hold them. A store hook that wants one takes it as an
// injected reader.

import type { StoredEntity } from "./entities/entities.js";
import type { EntityKind, EntityRef } from "@renderer/lib/entity-kinds.js";
import type { SessionStoreState } from "./session-state.js";

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
