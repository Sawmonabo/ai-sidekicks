// What the cast bar shows about each participant, derived and never invented.
//
// `Spec-023 §The surface set` fixes what one chip carries — "hue ring, name, presence
// glyph, terminal-lease glyph where held, and a present-tense verb derived client-side
// from that participant's newest timeline row and liveness alone" — and this module is
// the derivation half of that sentence.
//
// THE TWO RULES THIS MODULE EXISTS FOR, both of them prohibitions:
//
//   • **Never invent a verb.** A participant with no newest row shows the presence
//     glyph alone. Every verb below is keyed by a REGISTERED `SessionEventType`;
//     an unmapped kind produces no verb rather than a guess derived from the string.
//     The co-located test asserts each key against the contracts census, so a verb
//     for a kind the wire does not have cannot ship.
//   • **Never sum or estimate the spend figure.** It is the receipt's own value or
//     it is absent. This module carries no arithmetic over cost at all, which is
//     the strongest form of that guarantee.
//
// WHAT IS NOT HERE, AND WHY. Presence, typing, and the terminal lease are absent
// from `@ai-sidekicks/contracts`: `presence.ts` registers exactly four states and a
// read whose participants carry `{participantId, state, lastSeen}`, and no
// `activity.typing`, `activity.runs`, or `controlHolder` member is registered
// anywhere in the package. Wire truth beats a design wish, so a member's liveness
// is `undefined` — the "not checked" kind of nothing — until a presence read reaches
// the console, and the chip renders that rather than a green dot nobody measured.
//
// A pure module. It derives; it holds nothing. The order it walks is the hue
// allocator's join-log order, which is the order rule 2 fixes and the order a
// screenshot baseline depends on.

import type { ConsoleSessionEvent } from "../store/index.js";
import type { ParticipantHueAssignment } from "../tokens/index.js";
import { foldOutstandingAsks } from "./outstanding-asks.js";

/**
 * The verb each registered event kind puts on a chip, in present tense.
 *
 * A table rather than a switch because the keys are the claim: every one of them is
 * a `SessionEventType` the contracts package registers, and the co-located test
 * checks them against that census. A switch would hide the key set inside control
 * flow where nothing could walk it.
 *
 * Terminal run kinds are deliberately ABSENT. A finished run is not something the
 * participant is doing, and a chip reading "completed" would keep saying so for the
 * rest of the session.
 */
export const CAST_VERB_BY_EVENT_KIND: Readonly<Record<string, string>> = {
  "run.queued": "queued",
  "run.starting": "starting",
  "run.running": "working",
  "run.turn_started": "working",
  "run.waiting_for_approval": "waiting on approval",
  "run.waiting_for_input": "waiting on an answer",
  "run.paused": "paused",
  "assistant.thinking_update": "thinking",
  "assistant.message": "answering",
  "tool.invoked": "running a tool",
  "tool.result": "working",
  "user.message": "just spoke",
  "agent.attached": "just joined",
  "membership.created": "just joined",
  "driver_ask.requested": "waiting on an answer",
  "approval.requested": "waiting on approval",
};

/**
 * Where a chip's visible NAME comes from, keyed by registered event kind.
 *
 * The same discipline as the verb table above, for the same reason: the keys are
 * the claim, and the co-located test checks each one against the contracts census.
 *
 * Both members are read off the PAYLOAD and never off the envelope actor. An agent
 * does not attach itself — `agent.attached` is authored by the person who did — so
 * the actor names the wrong participant for the name the payload carries. And a
 * label is never derived from an id: participant ids are branded UUIDs minted at one
 * instant, so a bar full of them is a bar of one repeated fifteen-character prefix.
 *
 * `agent.config_updated` carries the rename: its `name` is optional and present only
 * when that field changed, which is exactly what a last-writer-wins forward pass
 * needs to land a rename over the attach-time name.
 */
export interface CastLabelSource {
  /** The payload member naming the participant this label belongs to. */
  readonly participantIdMember: string;
  /** The payload member carrying the label itself. */
  readonly labelMember: string;
}

export const CAST_LABEL_SOURCE_BY_EVENT_KIND: Readonly<Record<string, CastLabelSource>> = {
  "membership.created": { participantIdMember: "participantId", labelMember: "identityHandle" },
  "agent.attached": { participantIdMember: "agentId", labelMember: "name" },
  "agent.config_updated": { participantIdMember: "agentId", labelMember: "name" },
};

/**
 * The clause a frozen chip adds to its own accessible name.
 *
 * The same sentence the bar has always spoken for a stale verb, re-cast as a clause
 * because the name is now composed rather than concatenated out of the chip's
 * children — a visually-hidden sentence inside a labelled control is never read.
 */
const CAST_STALE_CLAUSE = "the connection dropped, so this may be out of date";

/**
 * The clause a blocked chip adds to its own accessible name.
 *
 * The exact negation of the bar's own all-clear line, because the two answer one
 * question: while "Nothing needs you." is absent, this is what says WHO. It is a
 * clause and not a colour, so the state survives the amber treatment being
 * unreadable — which for a screen reader it always is.
 */
const CAST_ATTENTION_CLAUSE = "needs you";

/** One chip. */
export interface CastMember {
  readonly participantId: string;
  /**
   * The name the wire gave this participant, or `undefined` where it named none.
   *
   * Folded from the label table above, so it is a value some registered payload
   * actually carried. A participant the log never named keeps its id on screen: the
   * chip shows what the console knows, and inventing a name would be worse than a
   * UUID because a reader could not tell the invention from a reading.
   */
  readonly label: string | undefined;
  /** The participant's place on the twelve-step wheel — identity, never state. */
  readonly hue: ParticipantHueAssignment;
  /** The present-tense verb, or `undefined` where the newest row implies none. */
  readonly verb: string | undefined;
  /** True while the projection is known-incomplete: the verb is frozen, and says so. */
  readonly isVerbStale: boolean;
  /** The newest event kind attributed to this participant, wire-verbatim. */
  readonly newestEventKind: string | undefined;
  /** ISO-8601, wire-verbatim. Formatted at render time, never re-parsed. */
  readonly newestOccurredAt: string | undefined;
  /**
   * True while an ask this participant opened is still outstanding.
   *
   * Folded by each ask's own lifecycle rather than read off the newest row: an agent
   * blocked on an approval in one run and busy in another has a newest row that is
   * not amber, and the run is still blocked.
   */
  readonly needsAttention: boolean;
}

/** Everything the bar renders, derived in one pass. */
export interface CastBarModel {
  readonly members: readonly CastMember[];
  /** Participants past the chip cap, folded into "+N". */
  readonly foldedMemberCount: number;
  /**
   * True when nothing in the session is amber or red AND the projection is whole.
   *
   * The degraded conjunct is the honest half: a store with a sequence gap cannot
   * know whether something needs a person, and "Nothing needs you." over an
   * incomplete projection is a claim the console has no standing to make.
   */
  readonly isAllClear: boolean;
}

export interface CastBarInput {
  /** Participants in join-log order — the hue allocator's own output. */
  readonly assignments: readonly ParticipantHueAssignment[];
  /** The session's ordered event log, oldest first. */
  readonly timeline: readonly ConsoleSessionEvent[];
  /** True while the store is degraded; freezes every verb with a stale mark. */
  readonly isDegraded: boolean;
  /** Chips shown before folding to "+N". */
  readonly chipCap: number;
}

/**
 * Build the bar.
 *
 * One backwards pass over the timeline rather than one pass per participant: the
 * newest row per actor is what every chip needs, and an N-participant bar over an
 * M-row log should cost M and not N×M — this runs on every applied batch in a
 * four-lane session.
 */
export function deriveCastBar(input: CastBarInput): CastBarModel {
  // Two passes over the log answering two different questions. The backwards one
  // below finds each actor's newest row, which is the VERB. This one folds every ask
  // by its own lifecycle, which is ATTENTION. Collapsing them — reading attention off
  // the newest row — is what let a newer ordinary event clear an approval that was
  // still blocking a parallel run.
  const outstanding = foldOutstandingAsks(input.timeline);
  const labelByParticipantId = foldParticipantLabels(input.timeline);
  const newestByParticipantId = new Map<string, ConsoleSessionEvent>();
  for (let position = input.timeline.length - 1; position >= 0; position -= 1) {
    const event = input.timeline[position];
    const actor = event?.actorId;
    if (event === undefined || actor === undefined || newestByParticipantId.has(actor)) {
      continue;
    }
    newestByParticipantId.set(actor, event);
  }

  const allMembers: CastMember[] = input.assignments.map((hue) => {
    const newest = newestByParticipantId.get(hue.participantId);
    const kind = newest?.kind;
    return {
      participantId: hue.participantId,
      label: labelByParticipantId.get(hue.participantId),
      hue,
      verb: kind === undefined ? undefined : verbFor(kind),
      isVerbStale: input.isDegraded,
      newestEventKind: kind,
      newestOccurredAt: newest?.occurredAt,
      needsAttention: outstanding.participantIds.has(hue.participantId),
    };
  });

  const shown = allMembers.slice(0, Math.max(0, input.chipCap));
  return {
    members: shown,
    foldedMemberCount: allMembers.length - shown.length,
    // Read off the outstanding COUNT and not off the members, which is stronger than
    // "every member, shown or folded": an ask the wire attributed to nobody puts no
    // chip in amber and still means something in the session needs a person.
    isAllClear: !input.isDegraded && outstanding.count === 0,
  };
}

/**
 * Fold the log into the name each participant was given.
 *
 * One FORWARD pass, and the direction is the point: last writer wins, so a rename
 * carried by a later `agent.config_updated` lands over the name the attach beat set.
 * The backwards pass beside this one answers a different question — the NEWEST row —
 * and the first writer would win there, which is the wrong rule for a rename.
 *
 * Guarded the way the outstanding-asks fold guards its correlation ids: a member
 * that is not a non-empty string is skipped rather than coerced, so an empty handle
 * leaves the id on screen instead of blanking the chip.
 */
function foldParticipantLabels(
  timeline: readonly ConsoleSessionEvent[],
): ReadonlyMap<string, string> {
  const labelByParticipantId = new Map<string, string>();
  for (const event of timeline) {
    if (!Object.hasOwn(CAST_LABEL_SOURCE_BY_EVENT_KIND, event.kind)) {
      continue;
    }
    const source = CAST_LABEL_SOURCE_BY_EVENT_KIND[event.kind];
    if (source === undefined) {
      continue;
    }
    const participantId = event.payload?.[source.participantIdMember];
    const label = event.payload?.[source.labelMember];
    if (typeof participantId !== "string" || participantId.length === 0) {
      continue;
    }
    if (typeof label !== "string" || label.length === 0) {
      continue;
    }
    labelByParticipantId.set(participantId, label);
  }
  return labelByParticipantId;
}

/**
 * What a screen reader hears for one chip.
 *
 * Composed here rather than left to the browser's own name computation over the
 * chip's children, because the presence glyph is an image carrying a name of its
 * own: concatenated, every chip in the bar would open with "Presence has not been
 * read" before the person it is about. The composition is this module's own: the
 * identifier and the verb, in the order `Spec-023 §The surface set` names them on the
 * chip itself, with each further state added as its own clause, so
 * a chip that is only itself reads exactly "priya, waiting on approval".
 *
 * Every clause is a value this model already derived. Nothing is invented here.
 */
export function castChipAccessibleName(member: CastMember): string {
  const clauses: string[] = [member.label ?? member.participantId];
  if (member.verb !== undefined) {
    clauses.push(member.verb);
  }
  // Beside the verb rather than instead of it, and never suppressed as redundant
  // when the verb happens to be a waiting one: the two are folded from different
  // questions, and a rule that dropped this clause whenever the newest row looked
  // like an ask would be the second attention vocabulary this module deleted.
  if (member.needsAttention) {
    clauses.push(CAST_ATTENTION_CLAUSE);
  }
  if (member.isVerbStale) {
    clauses.push(CAST_STALE_CLAUSE);
  }
  return clauses.join(", ");
}

/**
 * The verb for one registered kind, or `undefined`.
 *
 * `Object.hasOwn` rather than a truthiness check, so a kind whose verb was
 * deliberately set to the empty string would still be a mapped kind — and so a
 * prototype key like `"constructor"` arriving as an event kind cannot resolve to a
 * function.
 */
function verbFor(kind: string): string | undefined {
  return Object.hasOwn(CAST_VERB_BY_EVENT_KIND, kind) ? CAST_VERB_BY_EVENT_KIND[kind] : undefined;
}
