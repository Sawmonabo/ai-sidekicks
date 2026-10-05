// The paged transcript reads (`transcript.read`, the reasoning read, the child-run expansion) and
// the page budget they share. A row count alone is not a bound, since one valid row can run to tens
// of KB, so each page is measured in bytes against a budget well inside the transport's message
// limit. The reasoning read names no principal: the caller is the authenticated connection.
import { z } from "zod";

import { jsonUtf8ByteLength } from "../jsonrpc/jsonrpc.js";
import { RunIdSchema, type RunId } from "../provider/driver/driver.js";
import { RunStateSchema, type RunState } from "../run/state.js";
import {
  EventCursorSchema,
  SessionIdSchema,
  wireFreeFormString,
  type EventCursor,
  type SessionId,
} from "../session/session.js";

import { refuseSelfParentingRun } from "./child-run-summary.js";
import { TranscriptEventRowSchema, type TranscriptEventRow } from "./row/row.js";
import { countSchema, isoDateTimeSchema } from "../internal/wire-scalars.js";

// Page budget shared by every paged reply

/**
 * The byte ceiling on one paged member (`entries` or `reasoningEntries`), measured as
 * {@link jsonUtf8ByteLength} of the array itself. It is a 1,000,000-byte reply less 8,192 bytes
 * for the envelope, the echoed id and a continuation cursor, sized apart from the message limit.
 */
export const TRANSCRIPT_PAGE_MAX_BYTES = 991_808;

/**
 * How many leading entries of `candidates`, at most `maxCount`, fit
 * {@link TRANSCRIPT_PAGE_MAX_BYTES} exactly, so a page built from the count passes the schema. A
 * non-empty list yields at least one, since a zero would stall the cursor; an over-budget lone
 * entry is then refused by the schema.
 */
export function countEntriesFittingOneFrame(
  candidates: readonly unknown[],
  maxCount: number,
): number {
  // The two brackets are charged up front; every element past the first also charges a comma.
  let usedBytes = 2;
  let fittedCount = 0;
  const ceiling = Math.min(maxCount, candidates.length);
  for (let index = 0; index < ceiling; index += 1) {
    const entryBytes = jsonUtf8ByteLength(candidates[index]);
    const separatorBytes = fittedCount === 0 ? 0 : 1;
    if (usedBytes + separatorBytes + entryBytes > TRANSCRIPT_PAGE_MAX_BYTES) {
      // The first candidate alone is over budget: deliver it alone rather than an empty page
      // beside an unconsumed cursor.
      if (fittedCount === 0) {
        return 1;
      }
      break;
    }
    usedBytes += separatorBytes + entryBytes;
    fittedCount += 1;
  }
  return fittedCount;
}

/**
 * Refuse a paged member over the page budget. The issue path names the member, so a client
 * learns which array overflowed.
 */
export function requirePageToRideOneFrame(
  pagedMember: readonly unknown[],
  memberName: string,
  issueContext: z.RefinementCtx,
): void {
  const measuredBytes = jsonUtf8ByteLength(pagedMember);
  if (measuredBytes > TRANSCRIPT_PAGE_MAX_BYTES) {
    issueContext.addIssue({
      code: "custom",
      path: [memberName],
      message:
        `${memberName} measures ${String(measuredBytes)} JSON bytes, over the ` +
        `${String(TRANSCRIPT_PAGE_MAX_BYTES)}-byte page budget: the producer must page instead, ` +
        "stopping at whichever of the row limit and the byte budget trips first",
    });
  }
}

/**
 * Adjacent entries must not go backwards in sequence: nondecreasing, not strictly increasing.
 * Transcript rows and reasoning entries are both held to it.
 */
const requireNondecreasingSequence = (
  entries: readonly { sequence: number }[],
  memberName: string,
  issueContext: z.RefinementCtx,
): void => {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    if (current.sequence < previous.sequence) {
      issueContext.addIssue({
        code: "custom",
        path: [memberName, index, "sequence"],
        message:
          `${memberName} run oldest-to-newest: sequence ${String(current.sequence)} follows ` +
          `${String(previous.sequence)}, so this page is out of order`,
      });
    }
  }
};

// transcript.read

/**
 * Ceiling on a single `transcript.read` window, matching the package's other capped-count wire
 * members. It is a count ceiling, not a size one: {@link TRANSCRIPT_PAGE_MAX_BYTES} typically
 * trips first, since this many worst-case rows do not fit one frame.
 */
export const TRANSCRIPT_READ_LIMIT_MAX = 256;

/**
 * A bounded read window over one session's transcript. `afterCursor` and `beforeCursor` are
 * independently optional, spanning forward paging, backward paging and a bounded range.
 */
export interface TranscriptReadRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor | undefined;
  beforeCursor?: EventCursor | undefined;
  limit?: number | undefined;
}

/** Parses a {@link TranscriptReadRequest}. */
export const TranscriptReadRequestSchema: z.ZodType<TranscriptReadRequest, TranscriptReadRequest> =
  z
    .object({
      sessionId: SessionIdSchema,
      afterCursor: EventCursorSchema.optional(),
      beforeCursor: EventCursorSchema.optional(),
      limit: z.number().int().positive().max(TRANSCRIPT_READ_LIMIT_MAX).optional(),
    })
    .strict();

/**
 * One read window, discriminated on `hasMore`. The continuing arm requires `nextCursor`, so a
 * consumer that narrows on `hasMore` reaches a present cursor with no assertion. The terminal
 * arm may still carry one: it says where the window ended, which a client needs to open the
 * live stream (`session.subscribe` with `afterCursor`) from exactly there.
 */
export type TranscriptReadResponse =
  | { entries: TranscriptEventRow[]; hasMore: true; nextCursor: EventCursor }
  | { entries: TranscriptEventRow[]; hasMore: false; nextCursor?: EventCursor | undefined };

// A continuing page carries at least one row: `hasMore: true` with no entries would make a
// client re-ask the same cursor forever. A terminal page may be empty, the honest answer to a
// read that matched nothing. Both arms share the request's limit constant.
const continuingTranscriptEntriesSchema = z
  .array(TranscriptEventRowSchema)
  .min(1)
  .max(TRANSCRIPT_READ_LIMIT_MAX);

const terminalTranscriptEntriesSchema = z
  .array(TranscriptEventRowSchema)
  .max(TRANSCRIPT_READ_LIMIT_MAX);

/** Parses a {@link TranscriptReadResponse}; entries also fit one frame and run oldest to newest. */
export const TranscriptReadResponseSchema: z.ZodType<TranscriptReadResponse> = z
  .discriminatedUnion("hasMore", [
    z
      .object({
        entries: continuingTranscriptEntriesSchema,
        hasMore: z.literal(true),
        nextCursor: EventCursorSchema,
      })
      .strict(),
    z
      .object({
        entries: terminalTranscriptEntriesSchema,
        hasMore: z.literal(false),
        nextCursor: EventCursorSchema.optional(),
      })
      .strict(),
  ])
  .superRefine((response, issueContext) => {
    requirePageToRideOneFrame(response.entries, "entries", issueContext);
    requireNondecreasingSequence(response.entries, "entries", issueContext);
  });

// transcript.reasoningSurfaceRead

/**
 * Cap on `reasoningEntries`. Durable reasoning is summary-first, so a reply needing more than
 * this many normalized entries has stopped being a summary.
 */
export const REASONING_SURFACE_ENTRIES_MAX = 256;

/** Cap on one normalized reasoning entry's `content`. */
export const REASONING_ENTRY_CONTENT_MAX_LEN = 16384;

/**
 * The read is run-scoped, with the same cursor continuation the transcript window carries.
 * `afterCursor` is an event position, not a `sequence` offset, because a reasoning entry is
 * projected from the run's events.
 */
export interface ReasoningSurfaceReadRequest {
  runId: RunId;
  afterCursor?: EventCursor | undefined;
}

/** Parses a {@link ReasoningSurfaceReadRequest}. */
export const ReasoningSurfaceReadRequestSchema: z.ZodType<
  ReasoningSurfaceReadRequest,
  ReasoningSurfaceReadRequest
> = z.object({ runId: RunIdSchema, afterCursor: EventCursorSchema.optional() }).strict();

/** One normalized reasoning entry, ordered by its originating `sequence`. */
export interface ReasoningEntry {
  sequence: number;
  content: string;
  timestamp: string;
}

/** Parses a {@link ReasoningEntry}. */
export const ReasoningEntrySchema: z.ZodType<ReasoningEntry> = z
  .object({
    sequence: countSchema,
    content: wireFreeFormString(REASONING_ENTRY_CONTENT_MAX_LEN, "ReasoningEntry.content"),
    timestamp: isoDateTimeSchema,
  })
  .strict();

/**
 * The two-state reasoning reply, each state its own `.strict()` arm so a state-inconsistent
 * field set fails to parse. `available` requires `reasoningEntries`, carries `hasMore` and, on
 * its continuing arm, `nextCursor`; `unavailable` carries neither. The union nests, outer on
 * `availability` and inner on `hasMore`, so the two states stay two.
 */
export type ReasoningSurfaceReadResponse =
  | {
      availability: "available";
      reasoningEntries: ReasoningEntry[];
      hasMore: true;
      nextCursor: EventCursor;
    }
  | {
      availability: "available";
      reasoningEntries: ReasoningEntry[];
      hasMore: false;
      nextCursor?: EventCursor | undefined;
    }
  | { availability: "unavailable" };

// Non-empty on the continuing arm only, because only a continuing page can loop on a repeated
// cursor. A terminal page may be empty: a caller re-asking from the end of the surface has
// reached the end of something that exists, which is not `unavailable`. The schema cannot tell
// a first page from a continuation, so the daemon's binder (`registerTranscriptMethod`) refuses
// a first `available` page with no entries.
const continuingReasoningEntriesSchema = z
  .array(ReasoningEntrySchema)
  .min(1)
  .max(REASONING_SURFACE_ENTRIES_MAX);

const terminalReasoningEntriesSchema = z
  .array(ReasoningEntrySchema)
  .max(REASONING_SURFACE_ENTRIES_MAX);

const reasoningAvailableArmSchema = z
  .discriminatedUnion("hasMore", [
    z
      .object({
        availability: z.literal("available"),
        reasoningEntries: continuingReasoningEntriesSchema,
        hasMore: z.literal(true),
        nextCursor: EventCursorSchema,
      })
      .strict(),
    z
      .object({
        availability: z.literal("available"),
        reasoningEntries: terminalReasoningEntriesSchema,
        hasMore: z.literal(false),
        nextCursor: EventCursorSchema.optional(),
      })
      .strict(),
  ])
  .superRefine((availableResponse, issueContext) => {
    requirePageToRideOneFrame(availableResponse.reasoningEntries, "reasoningEntries", issueContext);
    requireNondecreasingSequence(
      availableResponse.reasoningEntries,
      "reasoningEntries",
      issueContext,
    );
  });

/** Parses a {@link ReasoningSurfaceReadResponse}. */
export const ReasoningSurfaceReadResponseSchema: z.ZodType<ReasoningSurfaceReadResponse> =
  z.discriminatedUnion("availability", [
    reasoningAvailableArmSchema,
    z.object({ availability: z.literal("unavailable") }).strict(),
  ]);

// transcript.childRunExpand

/**
 * Expand one summarized child-run row into its own transcript rows, continuing from `afterCursor`
 * when the previous expansion did not reach the end.
 */
export interface ChildRunExpandRequest {
  runId: RunId;
  afterCursor?: EventCursor | undefined;
}

/** Parses a {@link ChildRunExpandRequest}. */
export const ChildRunExpandRequestSchema: z.ZodType<ChildRunExpandRequest, ChildRunExpandRequest> =
  z.object({ runId: RunIdSchema, afterCursor: EventCursorSchema.optional() }).strict();

/** The members every expansion carries, whichever continuation arm it takes. */
export interface ChildRunExpandResponseBase {
  runId: RunId;
  parentRunId: RunId;
  state: RunState;
  /** The same `TranscriptEventRow` union the read window carries. */
  entries: TranscriptEventRow[];
}

/**
 * The expansion, discriminated on `hasMore` like the read window: a long-running subagent can
 * produce more rows than fit one frame, so it needs the same continuation and cursor rule.
 */
export type ChildRunExpandResponse =
  | (ChildRunExpandResponseBase & { hasMore: true; nextCursor: EventCursor })
  | (ChildRunExpandResponseBase & { hasMore: false; nextCursor?: EventCursor | undefined });

// `entries` is not in the shared shape: each arm declares its own, from the read window's pair.
const childRunExpandCommonShape = () => ({
  runId: RunIdSchema,
  parentRunId: RunIdSchema,
  state: RunStateSchema,
});

/**
 * Every expanded row that carries a run identity must carry this run's; a row attributed to
 * another run would render as this run's activity. The `general` arm carries no `runId` and is
 * exempt: a session-scoped row inside the window is context.
 */
const requireEntriesToBelongToRun = (
  expandedRunId: RunId,
  entries: readonly TranscriptEventRow[],
  issueContext: z.RefinementCtx,
): void => {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.kind === "general") {
      continue;
    }
    if (entry.runId !== expandedRunId) {
      issueContext.addIssue({
        code: "custom",
        path: ["entries", index, "runId"],
        message:
          "a child-run expansion carries only that run's rows: this entry is attributed to a " +
          "different run, so rendering it inside this expansion would report another run's " +
          "activity as this one's",
      });
    }
  }
};

/** Parses a {@link ChildRunExpandResponse}. */
export const ChildRunExpandResponseSchema: z.ZodType<ChildRunExpandResponse> = z
  .discriminatedUnion("hasMore", [
    z
      .object({
        ...childRunExpandCommonShape(),
        entries: continuingTranscriptEntriesSchema,
        hasMore: z.literal(true),
        nextCursor: EventCursorSchema,
      })
      .strict(),
    z
      .object({
        ...childRunExpandCommonShape(),
        entries: terminalTranscriptEntriesSchema,
        hasMore: z.literal(false),
        nextCursor: EventCursorSchema.optional(),
      })
      .strict(),
  ])
  .superRefine((response, issueContext) => {
    requirePageToRideOneFrame(response.entries, "entries", issueContext);
    requireNondecreasingSequence(response.entries, "entries", issueContext);
    requireEntriesToBelongToRun(response.runId, response.entries, issueContext);
    refuseSelfParentingRun(response, issueContext);
  });
