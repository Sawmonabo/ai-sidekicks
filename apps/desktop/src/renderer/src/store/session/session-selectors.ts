// The narrow reads a view may make of a session store's state: a whole partition or one entity,
// never a composed whole-pane object, so `useSyncExternalStore` bails on `Object.is` for every
// kind the last transition did not touch.
//
// No selector names a wire shape. `entities/entities.ts` keeps the store free of wire knowledge,
// and a validating body read needs the canonical shape, which only the daemon service owns. A
// store hook that wants one takes it as an injected reader.

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
