// `transcript.search`: one session's own search over every row it holds, loaded on screen or not.
// The find box's `N of M` speaks for the whole session, and stepping to a match in unloaded
// history loads that history then. The count and each hit's position come from the daemon.
import { z } from "zod";

import { EVENT_FIELD_MAX_LEN } from "../event/envelope.js";
import { SearchMatchRangeSchema, type SearchMatchRange } from "../session/methods.js";
import { wireFreeFormString } from "../free-form-string.js";
import { EventCursorSchema, SessionIdSchema, type SessionId } from "../session/id.js";
import { type EventCursor } from "../session/event-cursor.js";

import { requireMemberToRideOneFrame } from "../jsonrpc/page.js";
import { TRANSCRIPT_READ_LIMIT_MAX } from "./limits.js";
import { countSchema } from "../internal/wire-scalars.js";

/**
 * The longest query, and the longest snippet a hit carries, in UTF-16 code units: each is one
 * line of a row's text.
 */
export const TRANSCRIPT_SEARCH_TEXT_MAX_LEN = 4096;

/**
 * Search one session. Hits come newest first; `beforeCursor` continues from the
 * previous page's `nextCursor`.
 */
export interface TranscriptSearchRequest {
  sessionId: SessionId;
  query: string;
  beforeCursor?: EventCursor | undefined;
  limit?: number | undefined;
}

/** Parses a {@link TranscriptSearchRequest}. */
export const TranscriptSearchRequestSchema: z.ZodType<
  TranscriptSearchRequest,
  TranscriptSearchRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    query: wireFreeFormString(TRANSCRIPT_SEARCH_TEXT_MAX_LEN, "TranscriptSearchRequest.query"),
    beforeCursor: EventCursorSchema.optional(),
    limit: z.number().int().positive().max(TRANSCRIPT_READ_LIMIT_MAX).optional(),
  })
  .strict();

/** One row holding a match: where it is in the session, and the line the match sits in. */
export interface TranscriptSearchHit {
  rowId: string;
  /** The row's position, which a `transcript.read` around it loads from. */
  cursor: EventCursor;
  snippet: string;
  matchRanges: SearchMatchRange[];
}

/**
 * One page of hits and the session's whole match count. A continuing page
 * carries at least one hit and the cursor to continue from.
 */
export type TranscriptSearchResponse =
  | { matchCount: number; hits: TranscriptSearchHit[]; hasMore: true; nextCursor: EventCursor }
  | { matchCount: number; hits: TranscriptSearchHit[]; hasMore: false };

const TranscriptSearchHitSchema: z.ZodType<TranscriptSearchHit> = z
  .object({
    rowId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "TranscriptSearchHit.rowId"),
    cursor: EventCursorSchema,
    snippet: z.string().min(1).max(TRANSCRIPT_SEARCH_TEXT_MAX_LEN),
    matchRanges: z.array(SearchMatchRangeSchema).min(1),
  })
  .strict()
  .superRefine((hit, issueContext) => {
    let previousEnd = 0;
    hit.matchRanges.forEach((range, index) => {
      if (range.start < previousEnd || range.end > hit.snippet.length) {
        issueContext.addIssue({
          code: "custom",
          path: ["matchRanges", index],
          message: "match ranges run in order, never overlap, and sit inside the snippet",
        });
      }
      previousEnd = range.end;
    });
  });

const hitsSchema = z.array(TranscriptSearchHitSchema).max(TRANSCRIPT_READ_LIMIT_MAX);

/** Parses a {@link TranscriptSearchResponse}. */
export const TranscriptSearchResponseSchema: z.ZodType<TranscriptSearchResponse> = z
  .discriminatedUnion("hasMore", [
    z
      .object({
        matchCount: countSchema,
        hits: hitsSchema.min(1),
        hasMore: z.literal(true),
        nextCursor: EventCursorSchema,
      })
      .strict(),
    z
      .object({
        matchCount: countSchema,
        hits: hitsSchema,
        hasMore: z.literal(false),
      })
      .strict(),
  ])
  .superRefine((response, issueContext) => {
    requireMemberToRideOneFrame(response.hits, "hits", issueContext);
    const pageMatchCount = response.hits.reduce((total, hit) => total + hit.matchRanges.length, 0);
    if (pageMatchCount > response.matchCount) {
      issueContext.addIssue({
        code: "custom",
        path: ["matchCount"],
        message:
          `matchCount counts the whole session, so it is at least ` +
          `the ${String(pageMatchCount)} matches this page carries`,
      });
    }
  });
