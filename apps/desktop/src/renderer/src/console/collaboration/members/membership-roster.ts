// The read that carries a membership identifier, and the merge that decides which
// of the two sources a row's facts come from.
//
// WHY A READ AT ALL, WHEN THE LOG CARRIES `membership.created`
//
// The fold beside this one reads that beat and writes the identifier onto the
// participant it names, which covers every membership this window WATCHED being
// created. It cannot cover the rest, and the rest is most of them: the session's
// opener is admitted by `session.created` and gets no membership beat at all, and a
// window that joined an old session projects only the events still in its window.
// So the fold is the log's answer and this is the wire's, and the ledger needs both.
//
// WHICH SOURCE WINS, AND WHY IT IS NOT THE LOG
//
// The READ wins for role and state; the log fills what the read did not carry.
// That looks backwards for a console whose ledger is the event log, and it is not:
// of the five `membership.*` kinds, exactly one — `membership.created` — has a
// registered payload variant, so a role change, a suspension, a revocation, and a
// reactivation all reach the timeline carrying nothing the fold can read. The log's
// role is therefore the ADMISSION role and stays that way however many times it
// changes afterwards, while the read is a statement about now. The identifier itself
// is immutable, so the two can only agree about it.
//
// AND A ROW THE LOG NEVER SAW IS STILL A ROW. The read is the membership list; the
// participant partition is what this window happened to project. A person the read
// names and the log does not is a membership, and dropping them would hide exactly
// the rows this read exists to reach.

import type {
  ConsoleBridge,
  GrowthMembershipRosterEntry,
  GrowthOutcome,
  GrowthReading,
} from "../../bridge/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import { useGrowthReadOnMount } from "../../seats/index.js";

/** Names this read in a refusal the call itself did not name. */
export const MEMBERSHIP_ROSTER_ORIGIN = "membership-roster";

/** What one `membershipRosterRead` call answers. */
export type MembershipRosterOutcome = GrowthOutcome<readonly GrowthMembershipRosterEntry[]>;

/** What the ledger holds for one roster call. The console's one reading union. */
export type MembershipRosterReading = GrowthReading<MembershipRosterOutcome>;

/**
 * Read the membership roster once, for one session, and hold it against that session.
 *
 * Through the seat every growth read in this console goes through, so the ask-once
 * discipline, the subject scoping, and the two refusal arms are the same ones the
 * channel roster and the presence detail obey rather than a fourth copy of them.
 */
export function useMembershipRoster(
  bridge: ConsoleBridge,
  sessionId: string | undefined,
): MembershipRosterReading | undefined {
  return useGrowthReadOnMount({
    bridge,
    subject: sessionId,
    request: sessionId === undefined ? undefined : { sessionId },
    origin: MEMBERSHIP_ROSTER_ORIGIN,
    ask: (readBridge, request) => readBridge.growth.membershipRosterRead(request),
  });
}

/**
 * The entries, keyed by participant.
 *
 * Empty on every arm that is not a served answer — still coming, refused, or a call
 * that produced no outcome at all — which is what makes "the row renders what the log
 * gave it" the single unbranched behaviour at every consuming site.
 */
export function membershipEntriesByParticipantId(
  reading: MembershipRosterReading | undefined,
): ReadonlyMap<string, GrowthMembershipRosterEntry> {
  if (reading?.kind !== "answered" || reading.outcome.status !== "served") {
    return new Map();
  }
  return new Map(reading.outcome.value.map((entry) => [entry.participantId, entry]));
}

/**
 * Why the roster is not here, or `undefined` where it is or is still coming.
 *
 * A refusing outcome and a call that produced none answer the same way, deliberately:
 * both are the read declining, and the only facts a person needs from either are the
 * code and the sentence. A read in flight is neither and says nothing — the ledger's
 * log-derived rows are already on screen.
 */
export function membershipRosterRefusal(
  reading: MembershipRosterReading | undefined,
): ConsoleRefusal | undefined {
  if (reading === undefined) {
    return undefined;
  }
  if (reading.kind === "unreadable") {
    return reading.refusal;
  }
  return reading.outcome.status === "served" ? undefined : reading.outcome;
}
