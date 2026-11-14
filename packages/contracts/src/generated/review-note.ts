// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A held review note: a note the person leaves on a line of Review's diff, held by the daemon and scoped to the session.

import type { WireInstant } from "./internal/wire-scalars.js";
import type { SubscribeAcknowledgmentResponse } from "./jsonrpc/streaming.js";
import type { GitObjectId } from "./repo/git-reads.js";
import type { SessionId } from "./session/id.js";

/**
 * The id of one held note, minted by the client, so adding the same note twice makes one note.
 */
export type ReviewNoteId = string & { readonly __brand: "ReviewNoteId" };
/**
 * The scopes a note can be left in: the uncommitted changes, the branch, or a pull request.
 */
export type ReviewNoteScope = "changes" | "branch" | "changeRequest";
/**
 * Which side of the diff the note's line is on.
 */
export type ReviewNoteSide = "added" | "removed";
/**
 * The comparison a note was left in, so pressing the note takes the reader back to it.
 */
export type ReviewNoteComparison =
  | {
      /**
       * The scope.
       */
      scope: ReviewNoteScope;
      /**
       * The comparison's base.
       */
      base: string;
      /**
       * The head commit.
       */
      headCommitId: GitObjectId;
      /**
       * The pull request, in that scope.
       */
      requestNumber?: number;
    }
  | {
      /**
       * The scope.
       */
      scope: ReviewNoteScope;
      /**
       * The comparison's base.
       */
      base: string;
      /**
       * The working tree's blob.
       */
      workingTreeBlobId: GitObjectId;
      /**
       * The pull request, in that scope.
       */
      requestNumber?: number;
    };

/**
 * One held note as the daemon holds it: where it sits, a one-line quote of its line, the
 * person's words, whether its line still exists in the diff, and when it was made and last
 * edited.
 */
export interface ReviewNote {
  /**
   * The comparison it was left in.
   */
  comparison: ReviewNoteComparison;
  /**
   * The file.
   */
  path: string;
  /**
   * The file's earlier path, when it was renamed.
   */
  oldPath?: string;
  /**
   * The line's side.
   */
  side: ReviewNoteSide;
  /**
   * The line, or the last of several.
   */
  line: number;
  /**
   * The first of several lines, at or before `line`.
   */
  startLine?: number;
  /**
   * The note.
   */
  noteId: ReviewNoteId;
  /**
   * A one-line quote of its line.
   */
  quote: string;
  /**
   * The person's words.
   */
  body: string;
  /**
   * Whether its line is gone from the diff.
   */
  stranded: boolean;
  /**
   * When it was made.
   */
  createdAt: WireInstant;
  /**
   * When it was last edited.
   */
  updatedAt: WireInstant;
}
/**
 * `session.reviewNote.add`: holds a new note.
 */
export interface SessionReviewNoteAddRequest {
  /**
   * The comparison it was left in.
   */
  comparison: ReviewNoteComparison;
  /**
   * The file.
   */
  path: string;
  /**
   * The file's earlier path, when it was renamed.
   */
  oldPath?: string;
  /**
   * The line's side.
   */
  side: ReviewNoteSide;
  /**
   * The line, or the last of several.
   */
  line: number;
  /**
   * The first of several lines, at or before `line`.
   */
  startLine?: number;
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The note.
   */
  noteId: ReviewNoteId;
  /**
   * The person's words.
   */
  body: string;
}
/**
 * The note as the daemon holds it.
 */
export interface SessionReviewNoteResponse {
  /**
   * The note.
   */
  note: ReviewNote;
}
/**
 * `session.reviewNote.update`: replaces a held note's words.
 */
export interface SessionReviewNoteUpdateRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The note.
   */
  noteId: ReviewNoteId;
  /**
   * The new words.
   */
  body: string;
}
/**
 * `session.reviewNote.delete`: discards held notes in one act; the notes chip's `×` discards
 * every note behind one question, and a steer clears every note it carried.
 */
export interface SessionReviewNoteDeleteRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The notes.
   *
   * @minItems 1
   */
  noteIds: [ReviewNoteId, ...ReviewNoteId[]];
}
/**
 * The notes a remove discarded; an id the session did not hold is left out.
 */
export interface SessionReviewNoteDeleteResponse {
  /**
   * The notes discarded.
   */
  removedNoteIds: ReviewNoteId[];
}
/**
 * The session's held notes.
 */
export interface ReviewNoteSet {
  /**
   * The notes.
   */
  notes: ReviewNote[];
}
/**
 * `session.reviewNote.subscribe`: follows a session's held notes, the whole set now and on each
 * change.
 */
export interface SessionReviewNoteSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}

/** The methods of {@link REVIEW_NOTE_METHOD_DESCRIPTORS}, each with its kind. */
export interface ReviewNoteMethodDescriptors {
  readonly "session.reviewNote.add": {
    readonly method: "session.reviewNote.add";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "session.reviewNote.update": {
    readonly method: "session.reviewNote.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "session.reviewNote.delete": {
    readonly method: "session.reviewNote.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "session.reviewNote.subscribe": {
    readonly method: "session.reviewNote.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
}
/** The params, result and emission types of each method of {@link REVIEW_NOTE_METHOD_DESCRIPTORS}. */
export interface ReviewNoteMethodTypes {
  readonly "session.reviewNote.add": {
    readonly params: SessionReviewNoteAddRequest;
    readonly result: SessionReviewNoteResponse;
  };
  readonly "session.reviewNote.update": {
    readonly params: SessionReviewNoteUpdateRequest;
    readonly result: SessionReviewNoteResponse;
  };
  readonly "session.reviewNote.delete": {
    readonly params: SessionReviewNoteDeleteRequest;
    readonly result: SessionReviewNoteDeleteResponse;
  };
  readonly "session.reviewNote.subscribe": {
    readonly params: SessionReviewNoteSubscribeRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: ReviewNoteSet;
  };
}
/** The held-note methods. */
export const REVIEW_NOTE_METHOD_DESCRIPTORS: ReviewNoteMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "session.reviewNote.add": /* @__PURE__ */ Object.freeze({
      method: "session.reviewNote.add",
      procedureType: "mutation",
      mutating: true,
    }),
    "session.reviewNote.update": /* @__PURE__ */ Object.freeze({
      method: "session.reviewNote.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "session.reviewNote.delete": /* @__PURE__ */ Object.freeze({
      method: "session.reviewNote.delete",
      procedureType: "mutation",
      mutating: true,
    }),
    "session.reviewNote.subscribe": /* @__PURE__ */ Object.freeze({
      method: "session.reviewNote.subscribe",
      procedureType: "subscription",
      mutating: false,
    }),
  });
