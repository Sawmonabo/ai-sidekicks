// When a transcript window is derived again from a whole log, a row read anew, from an event the
// store replaced, that equals the one the last window published under its id is published as that
// same object, so unchanged rows keep the identity the memos below the feed key on and the
// derivation redraws only the rows that moved. A held event's row is reused without a compare.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

/**
 * Whether two projections of one row are equal member for member, by identity. Compares the
 * candidate's own keys, not a list written here, so a member added to `TranscriptEventRow` cannot
 * be forgotten and make a changed row compare equal (a stale card). `payload` is the delivered
 * envelope's own object, held by the store across revisions. A row whose envelope has no payload
 * gets a fresh `{}` each projection, so it takes a new identity and redraws; that is correct, and
 * it costs one row.
 */
export function hasSameMembers(
  previous: TranscriptEventRow,
  candidate: TranscriptEventRow,
): boolean {
  // Walked in place rather than through `Object.entries`: a whole log is compared row by row.
  let candidateMemberCount = 0;
  for (const memberName in candidate) {
    if (!Object.hasOwn(candidate, memberName)) {
      continue;
    }
    candidateMemberCount += 1;
    if (
      !Object.hasOwn(previous, memberName) ||
      !Object.is(Reflect.get(previous, memberName), Reflect.get(candidate, memberName))
    ) {
      return false;
    }
  }
  let previousMemberCount = 0;
  for (const memberName in previous) {
    if (Object.hasOwn(previous, memberName)) {
      previousMemberCount += 1;
    }
  }
  return previousMemberCount === candidateMemberCount;
}
