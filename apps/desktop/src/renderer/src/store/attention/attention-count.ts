// How many sessions the projection reported as needing a person, read off the summary's
// grouping; the renderer never decides that a session needs somebody. It never shows a zero,
// because a "0" badge on the rail would be permanent furniture reporting no news.

import type { AttentionReading } from "./attention-summary.js";

/**
 * How many sessions the projection reported as needing a person.
 *
 * `undefined` until the read has answered, and when the count is zero, so the rail says
 * nothing rather than a stale or zero number.
 */
export function attentionCountOf(reading: AttentionReading): number | undefined {
  if (reading.phase !== "read") {
    return undefined;
  }
  const actionableSessions = reading.summary.groups.filter(
    (group) => group.actionable.length > 0,
  ).length;
  return actionableSessions === 0 ? undefined : actionableSessions;
}
