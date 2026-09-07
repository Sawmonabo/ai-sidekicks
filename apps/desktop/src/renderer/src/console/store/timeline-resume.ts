// The resume rule: where a store's next read of a session's stream starts, and what
// the console does when the position it remembered is refused.
//
// A PURE MODULE. It decides; it holds nothing and it calls nothing. `open-session-
// entry.ts` is what ACTS on the decision — it submits the cursor on its next read,
// beside the gap re-pull it already performs — because that entry is the one object
// holding a store, its queue, and its scheduler together, and a decision acted on
// anywhere else would be a second writer of a store whose whole design is one.
//
// WHICH SHAPE THIS IS DECIDED AGAINST, AND WHY IT IS THE SHIPPED ONE
//
// `packages/contracts/src/session.ts` is the shape on the wire: `SessionReadResponse`
// carries `timelineCursors` as a `.strict()` object over `{ latest, acknowledged? }`
// and carries NO `earliest` member. Strict is the load-bearing word — a responder
// that sent one would be refused at the parse, so `earliest` is not a member a newer
// daemon might grow into this reply; it is a member this reply cannot have.
//
// The canonical architecture doc states the rule differently. Its gap-detection
// sentence resumes from `acknowledged ?? earliest` and compares the two to decide
// whether events were lost, which describes a decode of a member the shipped schema
// forbids. THE CONSOLE READS THE SHIPPED SCHEMA. This module used to read the doc
// instead and refused the whole resume cycle whenever `earliest` was absent — which
// is every read, from every responder, forever: a permanent version-skew band above
// every workspace, reporting a skew nothing was skewed by. That refusal is deleted
// rather than relaxed, and the two facts the shipped reply does carry are what is
// decided from.
//
// THE VOCABULARY, RE-DERIVED FROM WHAT A READ CAN ACTUALLY SAY
//
//   • `resume` — the reply carried an `acknowledged` position. That is where this
//     participant has been read up to, so the next read starts there.
//   • `restart` — it carried none. Nothing has been acknowledged, so the beginning of
//     the window IS the resume position and no cursor is submitted. This is a first
//     read and it is the ordinary case; it is NOT a refusal, and rendering it as one
//     was the second half of the same defect.
//   • `refused` — the daemon could not resolve a cursor this console SUBMITTED. The
//     only refusal left, and the only one that was ever about a real failure: the
//     others described the responder's shape, and this one describes an answer.
//
// WHY THE REFUSED ARM IS A VALUE AND NOT A THROW. It carries the console's refusal
// grammar so a surface renders it beside the feed rather than in place of it: the
// stream is fine, the projection is fine, and what was lost is one remembered
// position. A throw would turn that into a rejected read the scheduler records as a
// degradation of the store, which is a different and worse claim.
//
// WHY THERE IS NO LOST-EVENT ARM, AND WHAT WOULD RE-ARM ONE
//
// The canonical sentence's third clause — `decode(acknowledged) < decode(earliest)`
// means events were lost — names `decode` as the inverse of an `encode` Plan-006 owns
// and PUBLISHES NEITHER. `packages/contracts/src/session.ts` says the cursor is
// opaque in as many words: "its internal structure (sequence + monotonic_ns) is owned
// by Plan-006", the schema is a bounded non-empty string, and "any non-empty bounded
// string is accepted" until that format is published. So this console has no ordering
// to take, and reading one out of a cursor's leading characters is not a narrow
// reading of the contract — it is an ordering invented for bytes the contract calls
// opaque. It also mis-fires on the cursor that is on the wire TODAY: the client SDK
// synthesizes every cursor from an event's UUID, and a leading-integer scan orders two
// UUIDs by whichever hex digits they happen to start with — then discards a live
// projection on a loss nothing established. And the comparison needs a floor the
// shipped reply does not carry at all, which is the paragraph above.
//
// WHAT RE-ARMS IT. Either half is enough, and neither is a renderer's to invent:
//
//   • an ordering published by the cursor's OWNER — a `compareEventCursors` exported
//     from `@ai-sidekicks/contracts` beside `EventCursorSchema`, or the structural
//     cursor format that schema's own comment says would tighten its regex; or
//   • a divergence the DAEMON reports, on a member of the session read or the
//     subscribe reply. None is registered.
//
// Until then a lost row reaches the store as the sequence gap it already reconciles,
// and the one cursor refusal the corpus does register — the submitted-cursor refusal
// below — is the only arm that declines a cycle.

import { readWireErrorEnvelopeWithCode, refuse, type NarrowedRefusal } from "../core/index.js";

/** The origin every refusal this module raises names. */
export const TIMELINE_RESUME_ORIGIN = "timeline-resume";

/**
 * The wire code a daemon answers with when a SUBMITTED cursor cannot be resolved.
 *
 * Registered at 400 in `docs/architecture/contracts/error-contracts.md`, and the
 * distinction that makes it usable here is in its own registration: it refuses a
 * request that carried a cursor. So it can only ever be the answer to a read this
 * console submitted a position on, which is why the entry tests the cursor it sent
 * before it believes the code — a console that classified on the code alone would
 * take a refusal raised for some other caller's request as its own lost position.
 *
 * Spelled once, here, beside the decision it produces. The daemon's spelling and the
 * console's have to be the same string or the arm is unreachable, and two homes for
 * one wire string is how they stop being.
 */
export const RESUME_CURSOR_UNRESOLVABLE_CODE = "event.cursor_unresolvable";

/**
 * Why a resume cycle was refused. Closed, and closed at ONE member.
 *
 * It held two before, and both described the SHAPE of a responder's reply rather than
 * an answer: one for a reply with no cursor block, one for a block missing a floor the
 * shipped schema has no member for. Neither was actionable and neither was rare — the
 * second fired on every read ever taken. What is left is the one refusal that reports
 * a failure: a position this console sent, that the daemon could not resolve.
 *
 * A single-member enumeration rather than a bare literal, because the shape of the
 * claim has not changed: the code a refusal carries is a closed set this module owns,
 * a code outside it is a compile error at the site that raises it, and the co-located
 * test compares what is raised against what is declared.
 */
export const TIMELINE_RESUME_REFUSAL_CODES = ["resume-cursor-unresolvable"] as const;

/** One refusal code, derived from the enumeration above. */
export type TimelineResumeRefusalCode = (typeof TIMELINE_RESUME_REFUSAL_CODES)[number];

/** The refusal this module raises, held to its own closed code union. */
export type TimelineResumeRefusal = NarrowedRefusal<TimelineResumeRefusalCode>;

/**
 * What a read said about where this session's stream picks up next.
 *
 * A discriminated union rather than a cursor plus a boolean: "resume here" and "there
 * is no position to resume from" are two different acts, and a caller that had to read
 * a flag beside a possibly-absent cursor would eventually read the cursor without the
 * flag — which is the one direction that resumes from a position nothing established.
 */
export type TimelineResumeDecision =
  | {
      readonly outcome: "resume";
      /** The acknowledged position. Submitted on the next read of this session. */
      readonly fromCursor: string;
    }
  | {
      /** Nothing acknowledged: the window's beginning is the position, and no
       * cursor is submitted. The ordinary first read, and not a failure. */
      readonly outcome: "restart";
    }
  | {
      readonly outcome: "refused";
      readonly refusal: TimelineResumeRefusal;
    };

/**
 * Decide where one read's cursor block says the next read starts.
 *
 * Takes `unknown` rather than `TimelineCursors`, because the block arrives from a
 * boundary the compiler does not see and a typed parameter would assert away exactly
 * the absences this has to answer for.
 *
 * A block that is missing, malformed, or carries no `acknowledged` all answer
 * `restart`, and they answer it for one reason rather than three: none of them names a
 * position, and the beginning of the window is where a reader with no position starts.
 * Reporting the three apart would be reporting a difference no caller can act on.
 */
export function resolveTimelineResume(cursors: unknown): TimelineResumeDecision {
  const acknowledged = readAcknowledgedCursor(cursors);
  return acknowledged === undefined
    ? { outcome: "restart" }
    : { outcome: "resume", fromCursor: acknowledged };
}

/**
 * The refusal a caller records when the daemon could not resolve the cursor it sent.
 *
 * Built here rather than at the read path, so the one refusal this module owns is
 * raised through the module that declares its code — the property that makes
 * {@link TIMELINE_RESUME_REFUSAL_CODES} a closed set rather than a comment.
 *
 * The detail says what the console DID about it, because that is the part a person can
 * act on: the position is gone, the feed was re-read from the beginning of the window,
 * and nothing about the session's stream is otherwise affected. It names no cursor —
 * `core/refusal.ts`' rule is that a detail never carries the refused value.
 */
export function refuseUnresolvableResume(): TimelineResumeDecision {
  return {
    outcome: "refused",
    refusal: refuse(
      TIMELINE_RESUME_ORIGIN,
      "resume-cursor-unresolvable",
      "the position this session was last read up to could not be resolved, so the log was re-read from the beginning of its window instead. Nothing was lost from the stream; the remembered position was. The next read takes whatever position the daemon acknowledges.",
    ),
  };
}

/**
 * Whether a rejected read is the daemon refusing a cursor it could not resolve.
 *
 * Total, and total by construction: `readWireErrorEnvelopeWithCode` reads through the
 * cross-process leaf's guarded property reads, so a rejection whose own `code` getter
 * throws answers `false` rather than propagating out of the `catch` that called this.
 *
 * The reader rather than a bare `rejection.code === …` comparison for that reason, and
 * because it takes ONE access per member: a value that answers one thing on the first
 * read and another on the second cannot make this arm disagree with itself.
 */
export function isUnresolvableCursorRejection(rejection: unknown): boolean {
  return readWireErrorEnvelopeWithCode(rejection, RESUME_CURSOR_UNRESOLVABLE_CODE) !== undefined;
}

/**
 * The acknowledged position a cursor block carries, or nothing.
 *
 * THE BLOCK IS NOT DECLARED AS A TYPE, and that is a decision rather than an
 * omission. The shipped `SessionReadResponseSchema` puts exactly two members on it —
 * `latest`, required, and `acknowledged`, optional — and only one of them decides
 * anything here, so a two-member interface would be a second declaration of a shape
 * `@ai-sidekicks/contracts` already owns, kept in step by hand, read for one field.
 * The block still arrives as `unknown`, because it crosses a boundary the compiler
 * does not see and this family sits below `bridge/` and narrows nothing on its own.
 *
 * `latest` is nevertheless REQUIRED to be present and a cursor: it is what makes a
 * block a block, so a record without it is not a cursor block that lost its
 * acknowledged member — it is some other object, and nothing is read out of it.
 */
function readAcknowledgedCursor(cursors: unknown): string | undefined {
  if (typeof cursors !== "object" || cursors === null || Array.isArray(cursors)) {
    return undefined;
  }
  const candidate = cursors as Record<string, unknown>;
  if (!isCursor(candidate["latest"])) {
    return undefined;
  }
  const acknowledged = candidate["acknowledged"];
  return isCursor(acknowledged) ? acknowledged : undefined;
}

/** One cursor member: a non-empty string, or not a cursor at all. */
function isCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
