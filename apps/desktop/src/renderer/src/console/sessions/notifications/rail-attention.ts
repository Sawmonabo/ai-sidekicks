// The rail's attention count, published from the one read that knows it.
//
// `Spec-023 §The surface set` puts a COUNT on the sessions destination, and the count
// is how many sessions need a person — the session-scoped aggregate the daemon's own
// projection carries, read off the plane's grouping rather than recomputed. The
// renderer counts sessions that were reported as needing somebody; it never decides
// that a session needs somebody.
//
// WHY IT IS PUBLISHED RATHER THAN READ. The rail is frame chrome and the attention
// read is this family's, and the console's family DAG runs one way: `frame/` sits
// below every view family, so the frame cannot reach up here for a value. The frame
// store is the seam both can touch, and this hook is the writer.
//
// WHAT IT DOES NOT CLAIM. The count stands for exactly as long as this read is
// mounted, and clears when it unmounts — which is the whole of its guarantee, and the
// reason WHERE it is mounted decides how much the badge is worth. It used to be
// mounted by the sessions destination, so the count went to nothing whenever somebody
// navigated: a suppressed rail on a machine that was answering, which is the stale-
// versus-absent distinction `Spec-023 §The surface set` is built on, answered wrongly.
// It is mounted by the window's frame-lifetime binding now, so what clears the count
// is the window losing its bridge rather than a person changing screens — and a number
// left standing after the read that produced it went away is still the stale count
// that rule refuses, which is why this hook keeps clearing on its own unmount.
//
// AND IT NEVER SHOWS A ZERO. Zero sessions needing a person is the ordinary state of
// a healthy console, and a badge reading "0" on the most-seen surface in the product
// would be permanent furniture reporting the absence of news.

import { useEffect } from "react";

import type { FrameStore } from "../../store/index.js";
import type { AttentionReading } from "./attention-plane.js";

/**
 * Publish this window's rail attention count for as long as the read is mounted.
 *
 * Takes the reading rather than performing one: the projection is read once, by
 * `useAttentionProjection`, and a second read here would be a second answer to the
 * same question — and a second subscription's worth of work for a number.
 */
export function useRailAttentionPublisher(frameStore: FrameStore, reading: AttentionReading): void {
  const count = railAttentionCountOf(reading);
  useEffect(() => {
    frameStore.publishRailAttentionCount(count);
    return () => {
      frameStore.publishRailAttentionCount(undefined);
    };
  }, [frameStore, count]);
}

/**
 * How many sessions the projection reported as needing a person.
 *
 * `undefined` on every arm but the answered one, and that is the suppression rule
 * `Spec-023 §The surface set` states: while the projection is unreachable — not asked,
 * reading, or refused — the rail says nothing rather than a number from before.
 */
export function railAttentionCountOf(reading: AttentionReading): number | undefined {
  if (reading.phase !== "read") {
    return undefined;
  }
  const actionableSessions = reading.plane.groups.filter(
    (group) => group.actionable.length > 0,
  ).length;
  return actionableSessions === 0 ? undefined : actionableSessions;
}
