// The immutable partition operations one entity mutation performs. Every merge replaces the
// identity of exactly the partition it touched, because a row selector's `Object.is` bail
// depends on the rest staying put (`vocabulary.ts`, the entity-keyed rule).
//
// Both functions are total on well-formed input and deliberately not defensive against a kind
// outside the closed set: that is a defect in the registering feature, caught and named at the
// projection runner's boundary, and a guard here would hide it as a missing entity.

import type { StoredEntity } from "./vocabulary.js";
import type { EntityKind, EntityRef } from "#renderer/lib/entity-kinds.js";

/**
 * The entity maps a store holds, one per kind. Named once because hand-written copies of the
 * nested shape drift into different degrees of readonly-ness.
 */
export type SessionPartitions = Readonly<
  Record<EntityKind, Readonly<Record<string, StoredEntity>>>
>;

/**
 * Merge one entity into its partition, over any existing row rather than replacing it: an event
 * naming a state and no `touchedAt` must not erase the timestamp an earlier event set. See
 * `mergeOnto` for the body's terms.
 */
export function mergeUpsert(
  partitions: SessionPartitions,
  entity: StoredEntity,
): Record<EntityKind, Readonly<Record<string, StoredEntity>>> {
  const partition = partitions[entity.kind];
  const existing = partition[entity.id];
  const merged: StoredEntity = existing === undefined ? entity : mergeOnto(existing, entity);
  return {
    ...partitions,
    [entity.kind]: { ...partition, [entity.id]: merged },
  };
}

/**
 * Drop one entity from its partition. Removing a row the store never saw still answers a fresh
 * object, so "nothing changed" and "this step changed nothing" stay distinguishable.
 */
export function mergeRemoval(
  partitions: SessionPartitions,
  ref: EntityRef,
): Record<EntityKind, Readonly<Record<string, StoredEntity>>> {
  const partition = partitions[ref.kind];
  if (!Object.hasOwn(partition, ref.id)) {
    return { ...partitions };
  }
  const next: Record<string, StoredEntity> = { ...partition };
  delete next[ref.id];
  return { ...partitions, [ref.kind]: next };
}

/**
 * One upsert onto the entity already stored, one level deep through `body`.
 *
 * The top-level spread lets an upsert naming only `touchedAt` keep the `state` the last
 * transition set. The body merges on the same terms because a pure projector cannot read the
 * stored entity: replacing it would lose a run's agent on its next transition. A projector that
 * means to clear a member removes the entity and upserts it fresh.
 */
function mergeOnto(existing: StoredEntity, upsert: StoredEntity): StoredEntity {
  const mergedBody =
    existing.body === undefined || upsert.body === undefined
      ? undefined
      : { ...existing.body, ...upsert.body };
  return {
    ...existing,
    ...upsert,
    ...(mergedBody === undefined ? {} : { body: mergedBody }),
  };
}
