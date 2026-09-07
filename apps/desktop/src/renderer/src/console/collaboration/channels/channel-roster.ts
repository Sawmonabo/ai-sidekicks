// The three facts `channel.list` has never carried: what a channel is FOR, which
// kind it is, and — where it is a direct channel — which two humans it is between.
//
// WHY THIS IS A SECOND READ AND NOT A WIDER FIRST ONE. `ChannelListResponseChannel`
// is exactly `{id, name?, state, participantCount}`, and no registered event payload
// names an audience either — `channel.created` is `{channelId, name?}` — so a fold
// over the session log could reach every channel in the room and would still have to
// invent what each one is for. The roster read carries those three and nothing else,
// and the two reads stay separate for the reason the directory's own header gives:
// the DIRECTORY is the list, and this is an ENRICHMENT of it. A row the roster did
// not name renders without a badge; it does not render as an absence, and it does
// not disappear.
//
// SO A REFUSAL HERE IS QUIET. The list is still the list when this read refuses —
// every row is still legible, still openable, still carries its state — so the
// refusal is one line under the rows rather than a card standing where they were.
// A surface that swapped the list for this refusal would have made a missing badge
// into a missing directory.
//
// AN AUDIENCE IS NEVER DERIVED. `participants` means this session's agents read the
// channel and `humans-only` means no agent ever does; that is a daemon obligation and
// never renderer etiquette. Nothing here reads a participant count, a member list, or
// a name to decide it — the wire says it or the row wears no badge, because getting
// it wrong puts an agent in a room that was supposed to have none.
//
// AND THE NON-DISCLOSURE FILTER IS THE DAEMON'S, INVISIBLE HERE ON PURPOSE. A direct
// channel is omitted from this reply for a caller outside its pair — omitted, not
// blanked — so there is no shape here for a hidden row and therefore no way to count
// one. That is also how every "never offer a write on a direct row to somebody
// outside the pair" rule is met: the row is not there to offer anything on.

import type {
  ConsoleBridge,
  GrowthChannelAudience,
  GrowthChannelKind,
  GrowthChannelRosterEntry,
  GrowthOutcome,
  GrowthReading,
} from "../../bridge/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import { useGrowthReadOnMount } from "../../seats/index.js";
import { type ChannelActivityLabels } from "../activity-model.js";

/** Names this read in a refusal the call itself did not name. */
export const CHANNEL_ROSTER_ORIGIN = "channel-roster";

/** What one `channelRosterRead` call answers: the served roster, or the port's refusal. */
export type ChannelRosterOutcome = GrowthOutcome<readonly GrowthChannelRosterEntry[]>;

/**
 * What this surface holds for one roster call.
 *
 * An instantiation of the console's one reading union rather than a second spelling
 * of its two arms — the shape is `bridge/`'s, beside the outcome its answered arm
 * carries, and this name is what the channels surface calls it.
 */
export type ChannelRosterReading = GrowthReading<ChannelRosterOutcome>;

/**
 * Read the roster once, for one session, and hold it against that session.
 *
 * ONE READ ON MOUNT, through the seat every growth read of this shape now takes:
 * four surfaces in two view families hold exactly one growth answer each, and view
 * families are siblings, so the pattern lives at `seats/` where both can reach it.
 * What this module supplies is the three facts that differ — which session is being
 * asked about, which operation answers, and the origin a refusal the call did not
 * name is stamped with.
 *
 * A REPEAT WOULD RE-ASK A QUESTION WITH A STANDING ANSWER. The wire behind this seam
 * refuses on a live build, so there is nothing a second call could learn;
 * `store/scheduling.ts` is where a real re-read goes the day `channel.rosterRead`
 * lands.
 */
export function useChannelRoster(
  bridge: ConsoleBridge,
  sessionId: string | undefined,
): ChannelRosterReading | undefined {
  return useGrowthReadOnMount<{ readonly sessionId: string }, readonly GrowthChannelRosterEntry[]>({
    bridge,
    // The session is both what is asked about and the key the answer is held under,
    // which is what makes it sound to re-ask exactly when it moves — and what stops
    // one session's roster badging another's rows after a move.
    subject: sessionId,
    request: sessionId === undefined ? undefined : { sessionId },
    origin: CHANNEL_ROSTER_ORIGIN,
    ask: async (readBridge, request) => await readBridge.growth.channelRosterRead(request),
  });
}

/**
 * The roster, keyed by the channel id the directory holds.
 *
 * Empty on every arm that is not a served answer — a read in flight, a refused one,
 * a call that produced no outcome at all. That is the whole of the "renders no badge"
 * rule, expressed as an absent entry rather than as a branch at each render site:
 * there is no arm on which this map invents a row the read did not carry.
 */
export function rosterEntriesById(
  reading: ChannelRosterReading | undefined,
): ReadonlyMap<string, GrowthChannelRosterEntry> {
  if (reading?.kind !== "answered" || reading.outcome.status !== "served") {
    return new Map();
  }
  return new Map(reading.outcome.value.map((entry) => [entry.id, entry]));
}

/**
 * Why the roster is not here, or `undefined` where it is or is still coming.
 *
 * A call that produced NO outcome and one that produced a refusing outcome answer the
 * same way, deliberately: both are the port declining to answer, and the only fact a
 * person needs from either is the code and the sentence. A read still in flight is
 * neither, and says nothing — the rows are already on screen.
 */
export function rosterRefusal(
  reading: ChannelRosterReading | undefined,
): ConsoleRefusal | undefined {
  if (reading === undefined) {
    return undefined;
  }
  if (reading.kind === "unreadable") {
    return reading.refusal;
  }
  return reading.outcome.status === "unavailable" ? reading.outcome : undefined;
}

/** Who reads this channel, as the wire said. `undefined` where the roster did not say. */
export function channelAudienceOf(
  entry: GrowthChannelRosterEntry | undefined,
): GrowthChannelAudience | undefined {
  return entry?.config.audience;
}

/** Which kind this channel is, as the wire said. `undefined` where the roster did not say. */
export function channelKindOf(
  entry: GrowthChannelRosterEntry | undefined,
): GrowthChannelKind | undefined {
  return entry?.kind;
}

/**
 * What a `direct` row is called: the other human in the pair, never a channel name.
 *
 * A direct channel's membership is the immutable two-human `memberPair` fixed at
 * creation, so the pair IS the label. `undefined` for every other row, which is what
 * leaves an ordinary channel wearing its own name.
 *
 * WHEN THE VIEWER IS UNKNOWN, BOTH MEMBERS ARE NAMED. The caller's own participant id
 * comes from one read and one read only, and that read can be in flight or refused —
 * so this labels the pair with both of its members rather than picking one, because
 * "the other human" is a claim that needs to know who this window is and inventing a
 * caller identity to make a nicer label would be exactly the wrong trade. The same
 * fallback covers a pair this window is not in at all, which the daemon's own filter
 * makes unreachable and which is not this function's fact to assume.
 */
export function directChannelLabel(
  entry: GrowthChannelRosterEntry | undefined,
  viewerParticipantId: string | undefined,
  labels: ChannelActivityLabels,
): string | undefined {
  if (entry === undefined || entry.kind !== "direct" || entry.memberPair === undefined) {
    return undefined;
  }
  const [firstMember, secondMember] = entry.memberPair;
  const otherMembers = entry.memberPair.filter((member) => member !== viewerParticipantId);
  if (viewerParticipantId !== undefined && otherMembers.length === 1) {
    return labels.participantLabel(otherMembers[0] ?? firstMember);
  }
  return `${labels.participantLabel(firstMember)} and ${labels.participantLabel(secondMember)}`;
}
