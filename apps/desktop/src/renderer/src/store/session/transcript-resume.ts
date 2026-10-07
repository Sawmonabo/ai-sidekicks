// Where a store's next read of a session's stream starts: the acknowledged position, else the
// log's floor, `earliest`. Pure: `store/session/open/entry.ts` acts on the decision and recovers
// when the daemon refuses the position it submitted.
//
// The cursors are opaque to the app, so nothing here orders two of them: a position is relayed
// verbatim, and the only comparison is whether two strings the daemon issued are the same one. A
// lost row reaches the store as the sequence gap it already reconciles.

import { EVENT_CURSOR_UNRESOLVABLE_CODE } from "@ai-sidekicks/contracts/error";

import { readWireErrorEnvelopeWithCode } from "#renderer/lib/wire/errors.js";

/**
 * What a read said about where the stream picks up next. A union rather than a cursor plus a
 * flag, so a caller cannot read a cursor that does not exist.
 */
export type TranscriptResumeDecision =
  | {
      /** A position was acknowledged above the floor, so rows may sit before it. */
      readonly outcome: "resume-acknowledged";
      /** The acknowledged position. Submitted on the next read of this session. */
      readonly fromCursor: string;
    }
  | {
      /** Nothing acknowledged above the floor: no surviving row sits before this position. */
      readonly outcome: "resume-earliest";
      /** The daemon's `earliest`. Submitted on the next read of this session. */
      readonly fromCursor: string;
    }
  | {
      /** No readable cursor block: submit no cursor, which the daemon reads from the start. */
      readonly outcome: "restart";
    };

/**
 * Decide where one read's cursor block says the next read starts: `acknowledged ?? earliest`.
 *
 * Takes `unknown` because the block crosses a boundary the compiler does not see. Only a missing
 * or malformed block answers `restart`, since it names no position at all.
 */
export function resolveTranscriptResume(cursors: unknown): TranscriptResumeDecision {
  const block = readCursorBlock(cursors);
  if (block === undefined) {
    return { outcome: "restart" };
  }
  // An acknowledged position equal to the floor has nothing before it either.
  return block.acknowledged === undefined || block.acknowledged === block.earliest
    ? { outcome: "resume-earliest", fromCursor: block.earliest }
    : { outcome: "resume-acknowledged", fromCursor: block.acknowledged };
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

/** The two positions a readable cursor block carries for the resume rule. */
interface ResumeCursorBlock {
  readonly earliest: string;
  readonly acknowledged: string | undefined;
}

// The block, or nothing when it is not one: `earliest` and `latest` are required cursors, and an
// `acknowledged` that is present must be a cursor too.
function readCursorBlock(cursors: unknown): ResumeCursorBlock | undefined {
  if (typeof cursors !== "object" || cursors === null || Array.isArray(cursors)) {
    return undefined;
  }
  const candidate = cursors as Record<string, unknown>;
  const earliest = candidate["earliest"];
  const acknowledged = candidate["acknowledged"];
  if (!isCursor(earliest) || !isCursor(candidate["latest"])) {
    return undefined;
  }
  if (acknowledged !== undefined && !isCursor(acknowledged)) {
    return undefined;
  }
  return { earliest, acknowledged };
}

/** One cursor member: a non-empty string, or not a cursor at all. */
function isCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
