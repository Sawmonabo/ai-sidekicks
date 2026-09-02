// What the cast bar shows about each participant, derived and never invented.
//
// `Spec-023 §Console Design (Meridian)` §4.1: "One chip per participant: hue ring,
// name, presence glyph …, the terminal-lease glyph when this participant is
// `controlHolder`, and a verb. The verb is derived on the client from the
// participant's newest timeline row and liveness only."
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
 * The kinds that make a session amber or red.
 *
 * `Spec-023 §Console Design (Meridian)` §4.1 puts the all-clear line on screen "when
 * nothing in the session is amber or red", so the line needs a definition of amber
 * and red that is not a colour lookup. These are the kinds that mean somebody is
 * blocked on a person: an approval, an answer, or a failure. Every one is
 * registered; the test checks them the same way it checks the verb table.
 */
export const CAST_ATTENTION_EVENT_KINDS: readonly string[] = [
  "run.waiting_for_approval",
  "run.waiting_for_input",
  "run.failed",
  "approval.requested",
  "driver_ask.requested",
  "intervention.requested",
];

/** One chip. */
export interface CastMember {
  readonly participantId: string;
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
  /** True where this participant's newest row is one the session needs a person for. */
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
  const newestByParticipantId = new Map<string, ConsoleSessionEvent>();
  for (let position = input.timeline.length - 1; position >= 0; position -= 1) {
    const event = input.timeline[position];
    const actor = event?.actorParticipantId;
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
      hue,
      verb: kind === undefined ? undefined : verbFor(kind),
      isVerbStale: input.isDegraded,
      newestEventKind: kind,
      newestOccurredAt: newest?.occurredAt,
      needsAttention: kind !== undefined && CAST_ATTENTION_EVENT_KINDS.includes(kind),
    };
  });

  const shown = allMembers.slice(0, Math.max(0, input.chipCap));
  return {
    members: shown,
    foldedMemberCount: allMembers.length - shown.length,
    // Computed over EVERY member and not just the shown ones: folding a chip into
    // "+N" hides the person, not the fact that they are blocked.
    isAllClear: !input.isDegraded && !allMembers.some((member) => member.needsAttention),
  };
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
