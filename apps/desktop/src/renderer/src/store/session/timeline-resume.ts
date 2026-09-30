// Where a store's next read of a session's stream starts, and what the console does when the
// remembered position is refused. Pure: `open-session-entry.ts` acts on the decision.
//
// The decision reads the two members the wire schema carries (`latest` and optional
// `acknowledged`). The cursor is opaque to the console, so there is no lost-event arm: a lost
// row reaches the store as the sequence gap it already reconciles. Such an arm needs an ordering
// the cursor's owner publishes (an exported cursor comparison in the contracts package) or a
// divergence the daemon reports; neither exists.

import { EVENT_CURSOR_UNRESOLVABLE_CODE } from "@ai-sidekicks/contracts";

import { readWireErrorEnvelopeWithCode } from "@renderer/lib/wire-errors.js";
import { refuse, type NarrowedRefusal } from "@renderer/lib/refusal.js";

/** The origin every refusal this module raises names. */
export const TIMELINE_RESUME_ORIGIN = "timeline-resume";

/**
 * Why a resume cycle was refused. Closed at one member: a reply with no `acknowledged`
 * position describes the reply, not an answer, so it restarts instead of being refused.
 */
export const TIMELINE_RESUME_REFUSAL_CODES = ["resume-cursor-unresolvable"] as const;

/** One refusal code, derived from the enumeration above. */
export type TimelineResumeRefusalCode = (typeof TIMELINE_RESUME_REFUSAL_CODES)[number];

/** The refusal this module raises, held to its own closed code union. */
export type TimelineResumeRefusal = NarrowedRefusal<TimelineResumeRefusalCode>;

/**
 * What a read said about where the stream picks up next. A union rather than a cursor plus a
 * flag, so a caller cannot read a cursor that does not exist.
 */
export type TimelineResumeDecision =
  | {
      readonly outcome: "resume";
      /** The acknowledged position. Submitted on the next read of this session. */
      readonly fromCursor: string;
    }
  | {
      /** Nothing acknowledged: start at the window's beginning and submit no cursor. */
      readonly outcome: "restart";
    }
  | {
      readonly outcome: "refused";
      readonly refusal: TimelineResumeRefusal;
    };

/**
 * Decide where one read's cursor block says the next read starts.
 *
 * Takes `unknown` because the block crosses a boundary the compiler does not see. A missing,
 * malformed or acknowledgment-free block all answer `restart`, since none names a position.
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
 * The detail says what the console did about it and never carries the refused cursor.
 */
export function refuseUnresolvableResume(): TimelineResumeDecision {
  return {
    outcome: "refused",
    refusal: refuse(
      TIMELINE_RESUME_ORIGIN,
      "resume-cursor-unresolvable",
      "the position this session was last read up to could not be resolved, so the log was re-read from the beginning of its window instead. Nothing was lost from the stream; the remembered position was. The next read takes whatever position the background service acknowledges.",
    ),
  };
}

/**
 * Whether a rejected read is the daemon refusing a cursor it could not resolve.
 *
 * Total: a rejection whose `code` getter throws answers `false` instead of propagating out of
 * the caller's `catch`.
 */
export function isUnresolvableCursorRejection(rejection: unknown): boolean {
  // The entry still checks that it sent a cursor before believing the code, because the code
  // refuses only a request that carried one.
  return readWireErrorEnvelopeWithCode(rejection, EVENT_CURSOR_UNRESOLVABLE_CODE) !== undefined;
}

// The acknowledged position a cursor block carries, or nothing. The block stays `unknown` because
// it crosses a boundary; `latest` must be a cursor too, or the object is not a cursor block.
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
