// How many sessions the projection reported as needing a person.
//
// The count is read off the summary's grouping rather than recomputed: the renderer counts
// sessions that were reported as needing somebody, and never decides that a session
// needs somebody.
//
// AND IT NEVER SHOWS A ZERO. Zero sessions needing a person is the ordinary state of
// a healthy console, and a badge reading "0" on the rail, the part of the window a
// person sees most, would be permanent furniture reporting the absence of news.

import type { AttentionReading } from "./attention-summary.js";

/**
 * How many sessions the projection reported as needing a person.
 *
 * `undefined` until the read has answered, and that is the suppression rule: while the
 * projection is still being read the rail says nothing rather than a number from
 * before.
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
