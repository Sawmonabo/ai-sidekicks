// The resume rule: where a reconnecting store picks the stream back up, and when it
// has to throw its projection away first.
//
// `docs/architecture/contracts/api-payload-contracts.md` states the rule on the
// member itself, and it is the consumer's to obey rather than the daemon's:
//
//   • resume from `acknowledged ?? earliest`;
//   • an absent `earliest` means the responder predates the whole read surface, and
//     the resume cycle is refused SDK-locally — before any replay or subscribe call.
//
// A PURE MODULE. It decides; it holds nothing and it calls nothing. `open-session-
// entry.ts` is what acts on the decision, beside the gap re-pull it already performs,
// because that entry is the one object holding a store, its queue, and its scheduler
// together — and a decision acted on anywhere else would be a second writer of a
// store whose whole design is one.
//
// WHY THE REFUSAL IS A VALUE AND NOT A THROW. The refused arm is the state a console
// talking to an older daemon is PERMANENTLY in, not an incident: every read answers
// the same way, and a throw would turn an ordinary version skew into a rejected read
// the scheduler records as a degradation. It carries the console's refusal grammar so
// a surface renders it as the `not-checked` kind of nothing.
//
// WHY THERE IS NO LOST-EVENT ARM, AND WHAT WOULD RE-ARM ONE
//
// The contract's third sentence — `decode(acknowledged) < decode(earliest)` means
// events were lost — names `decode` as the inverse of an `encode` Plan-006 owns and
// PUBLISHES NEITHER. `packages/contracts/src/session.ts` says the cursor is opaque in
// as many words: "its internal structure (sequence + monotonic_ns) is owned by
// Plan-006", the schema is a bounded non-empty string, and "any non-empty bounded
// string is accepted" until that format is published. So this console has no ordering
// to take, and reading one out of a cursor's leading characters is not a narrow
// reading of the contract — it is an ordering invented for bytes the contract calls
// opaque. It also mis-fires on the cursor that is on the wire TODAY: the client SDK
// synthesizes every cursor from an event's UUID, and a leading-integer scan orders two
// UUIDs by whichever hex digits they happen to start with — then discards a live
// projection on a loss nothing established.
//
// The arm is also DORMANT in V1 on the contract's own terms, which is why removing it
// costs nothing rather than deferring a behaviour: `earliest` is the V1-CONSTANT
// `encode(-1)`, the position immediately before the oldest surviving row, and
// compaction stubs rows in place rather than deleting them. Nothing a V1 daemon
// acknowledges can be below a floor that never moves.
//
// WHAT RE-ARMS IT. Either half is enough, and neither is a renderer's to invent:
//
//   • an ordering published by the cursor's OWNER — a `compareEventCursors` exported
//     from `@ai-sidekicks/contracts` beside `EventCursorSchema`, or the structural
//     cursor format that schema's own comment says would tighten its regex; or
//   • a divergence the DAEMON reports. None is registered: the only cursor refusal in
//     `docs/architecture/contracts/error-contracts.md` is `event.cursor_unresolvable`,
//     raised at 400 when a submitted cursor cannot be decoded at all, which is a
//     refusal of a request rather than a report that rows were lost, and no member of
//     the session read or the subscribe reply carries one either.
//
// Until then the store is left exactly as it is — a stream the subscription still
// replays and tails — and the two version-skew refusals below are the only arms that
// decline a cycle, on the one ground the contract does state.

import { refuse, type ConsoleRefusal } from "../core/index.js";

/** The origin every refusal this module raises names. */
export const TIMELINE_RESUME_ORIGIN = "timeline-resume";

/**
 * The cursor block a session read carries.
 *
 * Declared here rather than imported from `@ai-sidekicks/contracts`, and the
 * difference is the whole reason this module exists: the shipped
 * `SessionReadResponseSchema` is `.strict()` over `{latest, acknowledged?}` and
 * carries no `earliest`, while the canonical contract registers all three and puts
 * the resume rule on `earliest`. The console builds against the registered shape and
 * ledgers the gap on the growth slate; a second copy of the shipped one would have
 * been a shape with no resume rule in it at all.
 */
export interface TimelineCursors {
  /**
   * The position immediately BEFORE the oldest surviving row — a directly resumable
   * cursor, and the floor every other decision here is taken against. Optional for
   * version skew, which is exactly the refusal below.
   */
  readonly earliest?: string;
  /** The head of the log at the moment the read answered. */
  readonly latest: string;
  /** How far this participant has been acknowledged. Absent on a first read. */
  readonly acknowledged?: string;
}

/**
 * Why a resume cycle was refused before it started. Closed.
 *
 * Two version skews, and they are separate codes rather than one because a reader
 * acts on the difference: a responder carrying no cursor block at all predates the
 * read surface entirely, while one carrying a block without its floor predates only
 * the member the resume rule is stated on. Both are answered by a newer daemon; only
 * the second says a partial surface is there.
 */
export const TIMELINE_RESUME_REFUSAL_CODES = ["cursors-absent", "earliest-cursor-absent"] as const;

/** One refusal code, derived from the enumeration above. */
export type TimelineResumeRefusalCode = (typeof TIMELINE_RESUME_REFUSAL_CODES)[number];

/**
 * What a read's cursor block says a store should do next.
 *
 * A discriminated union rather than a cursor plus a boolean: "resume here" and "there
 * is no resume cycle to run" are two different acts, and a caller that had to read a
 * flag beside a possibly-absent cursor would eventually read the cursor without the
 * flag — which is the one direction that resumes from a position nothing established.
 */
export type TimelineResumeDecision =
  | {
      readonly outcome: "resume";
      /** The cursor to resume from — `acknowledged`, or `earliest` where none. */
      readonly fromCursor: string;
    }
  | {
      readonly outcome: "refused";
      readonly refusal: ConsoleRefusal;
    };

/**
 * Decide what one read's cursor block means for the store that read it.
 *
 * Takes `unknown` rather than `TimelineCursors`, because the block arrives from a
 * boundary the compiler does not see and the absence it has to detect is exactly the
 * case a typed parameter would have asserted away.
 */
export function resolveTimelineResume(cursors: unknown): TimelineResumeDecision {
  const block = readCursorBlock(cursors);
  if (block === undefined) {
    return refuseResume(
      "cursors-absent",
      "this session read carried no timeline cursors, so there is no position to resume a stream from. The responder predates the read surface that carries them; the console refuses the resume cycle here rather than resetting a projection or opening a subscription it cannot place.",
    );
  }
  if (block.earliest === undefined) {
    return refuseResume(
      "earliest-cursor-absent",
      "this session read carried no earliest cursor, so the floor a resume is taken against is unknown and a lost-event comparison cannot be made. The responder predates the read surface that sets it; the console refuses the resume cycle here rather than resetting a projection or opening a subscription it cannot place.",
    );
  }
  const { earliest, acknowledged } = block;
  // `acknowledged ?? earliest`, and nothing between the two is inspected. Nothing
  // acknowledged means the floor IS the resume position — a first read is exactly
  // this — and an acknowledged cursor is taken as the daemon issued it, because the
  // only thing that could disqualify it is an ordering nobody has published.
  return { outcome: "resume", fromCursor: acknowledged ?? earliest };
}

/**
 * Raise one refusal from the closed set above.
 *
 * Every refusing arm reaches its code through this parameter rather than writing a
 * literal, which is what makes that enumeration a closed set and not a comment: a
 * code outside it is a compile error where it is raised, and a member the module can
 * no longer raise is caught by the test that compares what it raises to what it
 * declares. Written as a helper rather than three inline objects for the same reason
 * the union exists — the refusing arm has exactly one shape, and three copies of it
 * are three chances to build a refusal that names an origin nothing recognizes.
 */
function refuseResume(code: TimelineResumeRefusalCode, detail: string): TimelineResumeDecision {
  return { outcome: "refused", refusal: refuse(TIMELINE_RESUME_ORIGIN, code, detail) };
}

/**
 * The block, narrowed, or `undefined` where the read carried none.
 *
 * `latest` is what makes a block a block: it is the one required member of the
 * registered shape, so a record without it is not a cursor block that lost a member
 * — it is something else entirely, and treating it as a skewed responder would be
 * this module reporting the wrong fact.
 */
function readCursorBlock(cursors: unknown): TimelineCursors | undefined {
  if (typeof cursors !== "object" || cursors === null || Array.isArray(cursors)) {
    return undefined;
  }
  const candidate = cursors as Record<string, unknown>;
  const latest = candidate["latest"];
  if (typeof latest !== "string" || latest.length === 0) {
    return undefined;
  }
  const earliest = readCursor(candidate["earliest"]);
  const acknowledged = readCursor(candidate["acknowledged"]);
  return {
    latest,
    ...(earliest === undefined ? {} : { earliest }),
    ...(acknowledged === undefined ? {} : { acknowledged }),
  };
}

/** One optional cursor member: a non-empty string, or nothing. */
function readCursor(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
