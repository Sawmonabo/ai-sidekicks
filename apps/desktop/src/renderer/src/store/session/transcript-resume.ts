// Where a store's next read of a session's stream starts. Pure: `store/session/open/entry.ts` acts
// on the decision and recovers when the daemon refuses the position it submitted.
//
// The decision reads the two members the wire schema carries (`latest` and optional
// `acknowledged`). The cursor is opaque to the app, so there is no lost-event arm: a lost row
// reaches the store as the sequence gap it already reconciles.

import { EVENT_CURSOR_UNRESOLVABLE_CODE } from "@ai-sidekicks/contracts/error";

import { readWireErrorEnvelopeWithCode } from "#renderer/lib/wire/errors.js";

/**
 * What a read said about where the stream picks up next. A union rather than a cursor plus a
 * flag, so a caller cannot read a cursor that does not exist.
 */
export type TranscriptResumeDecision =
  | {
      readonly outcome: "resume";
      /** The acknowledged position. Submitted on the next read of this session. */
      readonly fromCursor: string;
    }
  | {
      /** Nothing acknowledged: start at the window's beginning and submit no cursor. */
      readonly outcome: "restart";
    };

/**
 * Decide where one read's cursor block says the next read starts.
 *
 * Takes `unknown` because the block crosses a boundary the compiler does not see. A missing,
 * malformed or acknowledgment-free block all answer `restart`, since none names a position.
 */
export function resolveTranscriptResume(cursors: unknown): TranscriptResumeDecision {
  const acknowledged = readAcknowledgedCursor(cursors);
  return acknowledged === undefined
    ? { outcome: "restart" }
    : { outcome: "resume", fromCursor: acknowledged };
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
