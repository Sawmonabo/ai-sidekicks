// A held review note: a note the person leaves on a line of Review's diff, held by the daemon and
// scoped to the session, so a half-written review reaches the person's other devices.
//
// A note is held until it is composed into the draft as a steer, posted with a review to the
// hosting service, or discarded. A note whose line no longer exists in the diff is stranded: it can
// still be read, edited and deleted, and is left out of a posted review.
import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "./method-descriptor.js";
import { FILE_PATH_MAX_LEN, SessionIdSchema, type SessionId } from "./session.js";
import { isoDateTimeSchema } from "./internal/wire-scalars.js";

/** The id of one held note, minted by the client, so adding the same note twice makes one note. */
export type ReviewNoteId = string & { readonly __brand: "ReviewNoteId" };
/** Parses a {@link ReviewNoteId}. */
export const ReviewNoteIdSchema: z.ZodType<ReviewNoteId, ReviewNoteId> =
  brandedUuidIdSchema<ReviewNoteId>("ReviewNoteId");

const REVIEW_NOTE_SCOPES = ["changes", "branch", "change_request"] as const;

/** The scopes a note can be left in: the uncommitted changes, the branch, or a pull request. */
export type ReviewNoteScope = (typeof REVIEW_NOTE_SCOPES)[number];

/**
 * The comparison a note was left in, so pressing the note takes the reader back to
 * it. A note on committed lines names the head commit; a note on uncommitted lines
 * names the working tree's blob, and such a note is left out of a posted review.
 * `requestNumber` names the pull request in that scope.
 */
export type ReviewNoteComparison =
  | {
      scope: ReviewNoteScope;
      base: string;
      headCommitId: string;
      requestNumber?: number | undefined;
    }
  | {
      scope: ReviewNoteScope;
      base: string;
      workingTreeBlobId: string;
      requestNumber?: number | undefined;
    };
const reviewNoteComparisonShape = {
  scope: z.enum(REVIEW_NOTE_SCOPES),
  base: z.string().min(1),
  requestNumber: z.number().int().positive().optional(),
};
const ReviewNoteComparisonSchema: z.ZodType<ReviewNoteComparison, ReviewNoteComparison> = z.union([
  z.object({ ...reviewNoteComparisonShape, headCommitId: z.string().min(1) }).strict(),
  z.object({ ...reviewNoteComparisonShape, workingTreeBlobId: z.string().min(1) }).strict(),
]);

const REVIEW_NOTE_SIDES = ["added", "removed"] as const;

/** Which side of the diff the note's line is on. */
export type ReviewNoteSide = (typeof REVIEW_NOTE_SIDES)[number];

/**
 * Where a note sits: the file (and the file's earlier path when it was renamed), the
 * side, the line, and for a note on several lines the first of them.
 */
interface ReviewNoteLocation {
  comparison: ReviewNoteComparison;
  path: string;
  oldPath?: string | undefined;
  side: ReviewNoteSide;
  line: number;
  startLine?: number | undefined;
}
const reviewNoteLocationShape = {
  comparison: ReviewNoteComparisonSchema,
  path: z.string().min(1).max(FILE_PATH_MAX_LEN),
  oldPath: z.string().min(1).max(FILE_PATH_MAX_LEN).optional(),
  side: z.enum(REVIEW_NOTE_SIDES),
  line: z.number().int().positive(),
  startLine: z.number().int().positive().optional(),
};
const startsAtOrBeforeItsLine = (location: { line: number; startLine?: number | undefined }) =>
  location.startLine === undefined || location.startLine <= location.line;
const startLineMessage = { message: "A note's first line comes at or before its last line." };

/**
 * One held note as the daemon holds it: where it sits, a one-line quote of its line,
 * the person's words, whether its line still exists in the diff, and when it was made
 * and last edited.
 */
export interface ReviewNote extends ReviewNoteLocation {
  noteId: ReviewNoteId;
  quote: string;
  body: string;
  stranded: boolean;
  createdAt: string;
  updatedAt: string;
}
const ReviewNoteSchema: z.ZodType<ReviewNote> = z
  .object({
    ...reviewNoteLocationShape,
    noteId: ReviewNoteIdSchema,
    quote: z.string(),
    body: z.string().min(1),
    stranded: z.boolean(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict()
  .refine(startsAtOrBeforeItsLine, startLineMessage);

/** Adds a held note. */
export interface ReviewNoteAddRequest extends ReviewNoteLocation {
  sessionId: SessionId;
  noteId: ReviewNoteId;
  body: string;
}
/** Parses a {@link ReviewNoteAddRequest}; a first line after the last line is refused. */
export const ReviewNoteAddRequestSchema: z.ZodType<ReviewNoteAddRequest, ReviewNoteAddRequest> = z
  .object({
    ...reviewNoteLocationShape,
    sessionId: SessionIdSchema,
    noteId: ReviewNoteIdSchema,
    body: z.string().min(1),
  })
  .strict()
  .refine(startsAtOrBeforeItsLine, startLineMessage);

/** The note as the daemon holds it. */
export interface ReviewNoteResponse {
  note: ReviewNote;
}
/** Parses a {@link ReviewNoteResponse}. */
export const ReviewNoteResponseSchema: z.ZodType<ReviewNoteResponse> = z
  .object({ note: ReviewNoteSchema })
  .strict();

/** Replaces a held note's words. */
export interface ReviewNoteUpdateRequest {
  sessionId: SessionId;
  noteId: ReviewNoteId;
  body: string;
}
/** Parses a {@link ReviewNoteUpdateRequest}. */
export const ReviewNoteUpdateRequestSchema: z.ZodType<
  ReviewNoteUpdateRequest,
  ReviewNoteUpdateRequest
> = z
  .object({ sessionId: SessionIdSchema, noteId: ReviewNoteIdSchema, body: z.string().min(1) })
  .strict();

/**
 * Discards held notes in one act: the notes chip's `×` discards every note behind one
 * question, and a steer clears every note it carried.
 */
export interface ReviewNoteRemoveRequest {
  sessionId: SessionId;
  noteIds: ReviewNoteId[];
}
/** Parses a {@link ReviewNoteRemoveRequest}; an empty list is refused. */
export const ReviewNoteRemoveRequestSchema: z.ZodType<
  ReviewNoteRemoveRequest,
  ReviewNoteRemoveRequest
> = z.object({ sessionId: SessionIdSchema, noteIds: z.array(ReviewNoteIdSchema).min(1) }).strict();

/** The session's held notes. */
export interface ReviewNoteSet {
  notes: ReviewNote[];
}
/** Parses a {@link ReviewNoteSet}. */
export const ReviewNoteSetSchema: z.ZodType<ReviewNoteSet> = z
  .object({ notes: z.array(ReviewNoteSchema) })
  .strict();

/** Follows a session's held notes: the whole set now, then the whole set on each change. */
export interface ReviewNoteListRequest {
  sessionId: SessionId;
}
/** Parses a {@link ReviewNoteListRequest}. */
export const ReviewNoteListRequestSchema: z.ZodType<ReviewNoteListRequest, ReviewNoteListRequest> =
  z.object({ sessionId: SessionIdSchema }).strict();

/** The held-note methods. */
export interface ReviewNoteMethodDescriptors {
  readonly "session.reviewNoteAdd": MethodDescriptor<
    "session.reviewNoteAdd",
    ReviewNoteAddRequest,
    ReviewNoteResponse
  >;
  readonly "session.reviewNoteUpdate": MethodDescriptor<
    "session.reviewNoteUpdate",
    ReviewNoteUpdateRequest,
    ReviewNoteResponse
  >;
  readonly "session.reviewNoteRemove": MethodDescriptor<
    "session.reviewNoteRemove",
    ReviewNoteRemoveRequest,
    ReviewNoteSet
  >;
  readonly "session.reviewNoteList": SubscriptionMethodDescriptor<
    "session.reviewNoteList",
    ReviewNoteListRequest,
    SubscribeAckResponse,
    ReviewNoteSet
  >;
}

/** The held-note methods, each with its schemas. */
export const REVIEW_NOTE_METHOD_DESCRIPTORS: ReviewNoteMethodDescriptors = defineMethodDescriptors({
  "session.reviewNoteAdd": {
    method: "session.reviewNoteAdd",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ReviewNoteAddRequestSchema,
    responseSchema: ReviewNoteResponseSchema,
  },
  "session.reviewNoteUpdate": {
    method: "session.reviewNoteUpdate",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ReviewNoteUpdateRequestSchema,
    responseSchema: ReviewNoteResponseSchema,
  },
  "session.reviewNoteRemove": {
    method: "session.reviewNoteRemove",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ReviewNoteRemoveRequestSchema,
    responseSchema: ReviewNoteSetSchema,
  },
  "session.reviewNoteList": {
    method: "session.reviewNoteList",
    procedureType: "subscription",
    mutating: false,
    requestSchema: ReviewNoteListRequestSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: ReviewNoteSetSchema,
  },
});
