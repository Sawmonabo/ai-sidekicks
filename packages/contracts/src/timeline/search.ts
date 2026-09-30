// `timeline.search`: one session's own search over every row it holds, loaded on screen or not.
// The find box's `N of M` speaks for the whole session, and stepping to a match in unloaded
// history loads that history then. The count and each hit's position come from the daemon.
import { z } from "zod";

import { EVENT_FIELD_MAX_LEN } from "../event.js";
import {
  EventCursorSchema,
  SessionIdSchema,
  wireFreeFormString,
  type EventCursor,
  type SessionId,
} from "../session.js";

import { TIMELINE_READ_LIMIT_MAX, requirePageToRideOneFrame } from "./operations.js";
import { TIMELINE_ROW_SUMMARY_MAX_LEN } from "./row.js";

/**
 * The longest query, and the longest snippet a hit carries: each is one line of
 * a row's text, the same measure as a row's one-line summary.
 */
export const TIMELINE_SEARCH_TEXT_MAX_LEN: number = TIMELINE_ROW_SUMMARY_MAX_LEN;

/**
 * Search one session. Hits come newest first; `beforeCursor` continues from the
 * previous page's `nextCursor`.
 */
export interface TimelineSearchRequest {
  sessionId: SessionId;
  query: string;
  beforeCursor?: EventCursor | undefined;
  limit?: number | undefined;
}

/** Parses a {@link TimelineSearchRequest}. */
export const TimelineSearchRequestSchema: z.ZodType<TimelineSearchRequest, TimelineSearchRequest> =
  z
    .object({
      sessionId: SessionIdSchema,
      query: wireFreeFormString(TIMELINE_SEARCH_TEXT_MAX_LEN, "TimelineSearchRequest.query"),
      beforeCursor: EventCursorSchema.optional(),
      limit: z.number().int().positive().max(TIMELINE_READ_LIMIT_MAX).optional(),
    })
    .strict();

/** Where one match sits inside a hit's snippet, in UTF-16 code units. */
export interface TimelineSearchMatchRange {
  offset: number;
  length: number;
}

/** One row holding a match: where it is in the session, and the line the match sits in. */
export interface TimelineSearchHit {
  rowId: string;
  /** The row's position, which a `timeline.read` around it loads from. */
  cursor: EventCursor;
  snippet: string;
  matchRanges: TimelineSearchMatchRange[];
}

/**
 * One page of hits and the session's whole match count. A continuing page
 * carries at least one hit and the cursor to continue from.
 */
export type TimelineSearchResponse =
  | { matchCount: number; hits: TimelineSearchHit[]; hasMore: true; nextCursor: EventCursor }
  | { matchCount: number; hits: TimelineSearchHit[]; hasMore: false };

const TimelineSearchHitSchema: z.ZodType<TimelineSearchHit> = z
  .object({
    rowId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "TimelineSearchHit.rowId"),
    cursor: EventCursorSchema,
    snippet: z.string().min(1).max(TIMELINE_SEARCH_TEXT_MAX_LEN),
    matchRanges: z
      .array(
        z
          .object({ offset: z.number().int().nonnegative(), length: z.number().int().positive() })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((hit, issueContext) => {
    let previousEnd = 0;
    hit.matchRanges.forEach((range, index) => {
      if (range.offset < previousEnd || range.offset + range.length > hit.snippet.length) {
        issueContext.addIssue({
          code: "custom",
          path: ["matchRanges", index],
          message: "match ranges run in order, never overlap, and sit inside the snippet",
        });
      }
      previousEnd = range.offset + range.length;
    });
  });

const hitsSchema = z.array(TimelineSearchHitSchema).max(TIMELINE_READ_LIMIT_MAX);

/** Parses a {@link TimelineSearchResponse}. */
export const TimelineSearchResponseSchema: z.ZodType<TimelineSearchResponse> = z
  .discriminatedUnion("hasMore", [
    z
      .object({
        matchCount: z.number().int().nonnegative(),
        hits: hitsSchema.min(1),
        hasMore: z.literal(true),
        nextCursor: EventCursorSchema,
      })
      .strict(),
    z
      .object({
        matchCount: z.number().int().nonnegative(),
        hits: hitsSchema,
        hasMore: z.literal(false),
      })
      .strict(),
  ])
  .superRefine((response, issueContext) => {
    requirePageToRideOneFrame(response.hits, "hits", issueContext);
    const pageMatchCount = response.hits.reduce((total, hit) => total + hit.matchRanges.length, 0);
    if (pageMatchCount > response.matchCount) {
      issueContext.addIssue({
        code: "custom",
        path: ["matchCount"],
        message: `matchCount counts the whole session, so it is at least the ${String(pageMatchCount)} matches this page carries`,
      });
    }
  });
