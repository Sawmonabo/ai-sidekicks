// The immutable partition operations one entity mutation performs.
//
// `entities.ts` owns the vocabulary — what an entity IS and what a projector may
// ask for. This module owns what happens to the partition maps when one of those
// asks is honoured, which is a different job with a different rule: every merge
// replaces the identity of exactly the partition it touched and leaves every other
// partition's identity alone, because that identity is what a row selector's
// `Object.is` bail depends on (`store/entities.ts`, the entity-keyed rule).
//
// Both functions are total on well-formed input and deliberately NOT defensive
// against a kind outside the closed set: a projector naming a kind that does not
// exist is a defect in the view family that registered it, and the projection
// runner's all-or-nothing boundary is where that defect is caught and named. A
// guard here would swallow it into a silently missing entity instead.

import type { ConsoleEntity, ConsoleEntityKind, ConsoleEntityRef } from "./entities.js";

/**
 * The entity maps a store holds, one per kind.
 *
 * Named once rather than spelled out at each of its several appearances: the shape
 * is three types deep, and two hand-written copies of it drift into two subtly
 * different degrees of readonly-ness that the compiler then reconciles by widening.
 */
export type SessionPartitions = Readonly<
  Record<ConsoleEntityKind, Readonly<Record<string, ConsoleEntity>>>
>;

/**
 * Merge one entity into its partition, shallow-merging over any existing row.
 *
 * Shallow rather than replacing: a projector answers for the members its event
 * carries, and an event that names a state and no `touchedAt` must not erase the
 * timestamp an earlier event established.
 */
export function mergeUpsert(
  partitions: SessionPartitions,
  entity: ConsoleEntity,
): Record<ConsoleEntityKind, Readonly<Record<string, ConsoleEntity>>> {
  const partition = partitions[entity.kind];
  const existing = partition[entity.id];
  const merged: ConsoleEntity = existing === undefined ? entity : { ...existing, ...entity };
  return {
    ...partitions,
    [entity.kind]: { ...partition, [entity.id]: merged },
  };
}

/**
 * Drop one entity from its partition.
 *
 * A removal of a row the store never saw still answers a fresh object: the caller
 * is mid-transition over a scratch value, and answering the same reference would
 * make "nothing changed" and "this step changed nothing" indistinguishable.
 */
export function mergeRemoval(
  partitions: SessionPartitions,
  ref: ConsoleEntityRef,
): Record<ConsoleEntityKind, Readonly<Record<string, ConsoleEntity>>> {
  const partition = partitions[ref.kind];
  if (!Object.hasOwn(partition, ref.id)) {
    return { ...partitions };
  }
  const next: Record<string, ConsoleEntity> = { ...partition };
  delete next[ref.id];
  return { ...partitions, [ref.kind]: next };
}
