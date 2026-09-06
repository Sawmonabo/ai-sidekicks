// The resume rule: where a reconnecting store picks the stream back up, and when it
// has to throw its projection away first.
//
// `docs/architecture/contracts/api-payload-contracts.md` states the rule on the
// member itself, and it is the consumer's to obey rather than the daemon's:
//
//   • resume from `acknowledged ?? earliest`;
//   • `decode(acknowledged) < decode(earliest)` means events were lost, so the
//     projection resets and resumes from `earliest`;
//   • an absent `earliest` means the responder predates the whole read surface, and
//     the resume cycle is refused SDK-locally — before any projection reset and
//     before any replay or subscribe call.
//
// A PURE MODULE. It decides; it holds nothing and it calls nothing. `open-session-
// entry.ts` is what acts on the decision, beside the gap re-pull it already performs,
// because that entry is the one object holding a store, its queue, and its scheduler
// together — and a reset that landed anywhere else would be a second writer of a
// store whose whole design is one.
//
// WHY THE REFUSAL IS A VALUE AND NOT A THROW. The refused arm is the state a console
// talking to an older daemon is PERMANENTLY in, not an incident: every read answers
// the same way, and a throw would turn an ordinary version skew into a rejected read
// the scheduler records as a degradation. It carries the console's refusal grammar so
// a surface renders it as the `not-checked` kind of nothing.
//
// WHY THE COMPARISON IS THREE-VALUED
//
// The cursor is OPAQUE. `packages/contracts/src/session.ts` says so in as many
// words — "its internal structure (sequence + monotonic_ns) is owned by Plan-006",
// and the schema is a bounded non-empty string — so the console cannot claim to
// decode one. What the corpus does state is that the cursors are ORDERED and that
// `earliest` is `encode(-1)` in V1, which is an integer position. So the decoder here
// reads exactly the part of a cursor the corpus commits to — a leading, optionally
// negative integer run — and answers `undefined` for anything else rather than
// inventing an ordering over strings.
//
// An undecidable comparison then REFUSES THE CYCLE, on exactly the terms the absent
// floor does: the console cannot place the resume, so it declines to run it rather
// than guessing. Both of the other arms would be a guess. Resuming from an
// unverifiable `acknowledged` would silently skip every row between the two
// positions; resetting would destroy a live projection to record a loss nothing
// established. Refusing leaves the store exactly as it is — which is a stream the
// subscription still replays and tails — and names why, so the console never claims
// to have decided what it could not read.

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
 * Two version skews and one unreadable pair. They are separate codes rather than one
 * because the remedies differ: the first two are answered by a newer daemon, and the
 * third is answered by this console learning an encoding the corpus has not published.
 */
export const TIMELINE_RESUME_REFUSAL_CODES = [
  "cursors-absent",
  "earliest-cursor-absent",
  "cursor-order-undecidable",
] as const;

/** One refusal code, derived from the enumeration above. */
export type TimelineResumeRefusalCode = (typeof TIMELINE_RESUME_REFUSAL_CODES)[number];

/**
 * What a read's cursor block says a store should do next.
 *
 * A discriminated union rather than a cursor plus a pair of booleans: "resume here",
 * "throw the projection away and resume here", and "there is no resume cycle to run"
 * are three different acts, and a caller that had to combine two flags to tell them
 * apart would eventually combine them wrongly in the one direction that loses rows.
 */
export type TimelineResumeDecision =
  | {
      readonly outcome: "resume";
      /** The cursor to resume from — `acknowledged`, or `earliest` where none. */
      readonly fromCursor: string;
    }
  | {
      readonly outcome: "reset";
      /** Always `earliest`: the loss arm resumes from the floor and nowhere else. */
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
  if (acknowledged === undefined) {
    // Nothing has been acknowledged for this participant, so the floor IS the resume
    // position. Not a loss and not a reset: a first read is exactly this.
    return { outcome: "resume", fromCursor: earliest };
  }
  const order = compareCursors(acknowledged, earliest);
  if (order === undefined) {
    return refuseResume(
      "cursor-order-undecidable",
      "this session read's cursors carry no position this console can order, so whether events were lost cannot be established. The cursor is opaque by contract and only its leading position is committed to; the console refuses the resume cycle here rather than resuming past rows it cannot account for or discarding a projection on a loss nothing established.",
    );
  }
  if (order < 0) {
    return { outcome: "reset", fromCursor: earliest };
  }
  return { outcome: "resume", fromCursor: acknowledged };
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

/**
 * Order two cursors, or `undefined` where this console cannot.
 *
 * The only part of a cursor the corpus commits to is its leading integer position —
 * `earliest` is `encode(-1)` in V1, and both members of one reply come from one
 * daemon under one encoding. Everything past that leading run is Plan-006's and is
 * deliberately not read: a lexicographic tie-break over the remainder would be an
 * ordering this console invented for bytes it was told are opaque.
 */
function compareCursors(left: string, right: string): number | undefined {
  const leftPosition = decodeCursorPosition(left);
  const rightPosition = decodeCursorPosition(right);
  if (leftPosition === undefined || rightPosition === undefined) {
    return undefined;
  }
  return leftPosition - rightPosition;
}

/**
 * The integer position at the head of a cursor, or `undefined` for a cursor whose
 * head is not one.
 *
 * The expression anchors at the start and takes the whole leading digit run, so a
 * cursor that does not BEGIN with a position is undecidable rather than half-read —
 * which is the case this module has to be able to report. `Number.parseInt` would
 * answer for a cursor whose head is not a position at all only by accident of where
 * it happens to stop, and reading a position out of an unanchored scan is exactly the
 * invented ordering the header rules out.
 */
function decodeCursorPosition(cursor: string): number | undefined {
  const match = /^(-?\d+)/.exec(cursor);
  const digits = match?.[1];
  if (digits === undefined) {
    return undefined;
  }
  const position = Number(digits);
  return Number.isSafeInteger(position) ? position : undefined;
}
