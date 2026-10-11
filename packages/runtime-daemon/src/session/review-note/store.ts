// The review notes a session holds on its diff's lines, one `session_review_notes` row per note,
// kept with the session beside its draft so a half-written review reaches the person's other
// devices. The client mints a note's id, so a resent add answers the note already held.
//
// A note quotes its line as the diff read when it was added. Whether it is stranded is never
// stored: each read looks its line up again in the diff its comparison names, as that diff reads
// now, and a note whose line is no longer a changed line there, or no longer says what it quoted,
// is stranded. A session working in no repository's folder has no diff, so its notes read
// stranded.
//
// A follower gets the whole set at once, then again after each note change and each change to the
// folder the session works in. Reads for one follower run one at a time and only the newest is
// sent, so a burst of changes costs one read in flight and one waiting.

import type { Statement } from "better-sqlite3";

import type {
  ReviewNote,
  ReviewNoteAddRequest,
  ReviewNoteId,
  ReviewNoteRemoveRequest,
  ReviewNoteRemoveResponse,
  ReviewNoteResponse,
  ReviewNoteScope,
  ReviewNoteSet,
  ReviewNoteSide,
  ReviewNoteUpdateRequest,
} from "@ai-sidekicks/contracts/review-note";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { DatabaseConnections } from "../../database/connection/lifecycle.js";
import type { StatementResult, WriteStatement } from "../../database/statement.js";
import { WriteRefusedError, type DatabaseWriter } from "../../database/writer.js";
import { DaemonDomainError } from "../../ipc/domain-error.js";
import { SessionNotFoundError } from "../../ipc/session-errors.js";
import { SESSION_EXISTS_SQL, sessionExistsStatement } from "../directory/lookups.js";
import { sessionNotFound } from "../not-found.js";
import type { NoteLocation, NotedLineReader } from "./diff-line.js";

const NOTE_COLUMNS = `note_id, scope, base, head_commit_id, working_tree_blob_id, request_number,
  path, old_path, side, line, start_line, quote, body, created_at, updated_at`;
const SELECT_NOTES_SQL = `SELECT ${NOTE_COLUMNS} FROM session_review_notes
  WHERE session_id = @sessionId ORDER BY created_at, note_id`;
const SELECT_NOTE_SQL = `SELECT ${NOTE_COLUMNS} FROM session_review_notes
  WHERE session_id = @sessionId AND note_id = @noteId`;
const INSERT_NOTE_SQL = `INSERT INTO session_review_notes (session_id, ${NOTE_COLUMNS})
  VALUES (@sessionId, @noteId, @scope, @base, @headCommitId, @workingTreeBlobId, @requestNumber,
          @path, @oldPath, @side, @line, @startLine, @quote, @body, @createdAt, @createdAt)
  ON CONFLICT (session_id, note_id) DO NOTHING`;
const UPDATE_BODY_SQL = `UPDATE session_review_notes SET body = @body, updated_at = @updatedAt
  WHERE session_id = @sessionId AND note_id = @noteId`;
const DELETE_NOTES_SQL = `DELETE FROM session_review_notes
  WHERE session_id = @sessionId AND note_id IN (SELECT value FROM json_each(@noteIds))
  RETURNING note_id AS noteId`;

/**
 * One `session_review_notes` row as the store reads it; the table holds exactly one of the head
 * commit and the working file's blob.
 */
type ReviewNoteRow = ReviewNoteRowFields &
  (
    | { readonly head_commit_id: string; readonly working_tree_blob_id: null }
    | { readonly head_commit_id: null; readonly working_tree_blob_id: string }
  );

interface ReviewNoteRowFields {
  readonly note_id: string;
  readonly scope: string;
  readonly base: string;
  readonly request_number: number | null;
  readonly path: string;
  readonly old_path: string | null;
  readonly side: string;
  readonly line: number;
  readonly start_line: number | null;
  readonly quote: string;
  readonly body: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** How the live set is handed to a follower and how its failure ends it. */
export interface ReviewNoteSetOutlet {
  readonly send: (notes: ReviewNoteSet) => void;
  readonly fail: (error: unknown) => void;
}

/**
 * `session.review_note_not_found`: the session holds no note under the id, since it was sent,
 * posted or discarded, perhaps on another device.
 */
class ReviewNoteNotFoundError extends DaemonDomainError {
  constructor(noteId: ReviewNoteId) {
    super("This session holds no such review note", {
      code: "session.review_note_not_found",
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      detail: { noteId },
    });
  }
}

/** What the note store reads, writes and follows. */
export interface SessionReviewNoteStoreDeps {
  readonly database: DatabaseConnections;
  /**
   * A reader of notes' lines in the folder the session works in now, or `undefined` when it works
   * in no repository's folder.
   */
  readonly openLineReader: (
    sessionId: SessionId,
  ) => Promise<Pick<NotedLineReader, "read"> | undefined>;
  /**
   * Calls `onChange` on each change to the folder the session works in, until the returned detach
   * runs. Rejects with `SessionNotFoundError` when the session works in no folder.
   */
  readonly followWorkingFolder: (sessionId: SessionId, onChange: () => void) => Promise<() => void>;
  /** Wall clock; defaults to `new Date()`. */
  readonly now?: () => Date;
}

/** Holds each session's review notes and answers them with their stranded marks read fresh. */
export class SessionReviewNoteStore {
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #selectSessionExists: Statement<{ sessionId: string }, unknown>;
  readonly #selectNotes: Statement<{ sessionId: string }, ReviewNoteRow>;
  readonly #selectNote: Statement<{ sessionId: string; noteId: string }, ReviewNoteRow>;
  readonly #openLineReader: SessionReviewNoteStoreDeps["openLineReader"];
  readonly #followWorkingFolder: SessionReviewNoteStoreDeps["followWorkingFolder"];
  readonly #now: () => Date;
  readonly #changeListeners = new Map<SessionId, Set<() => void>>();

  constructor(deps: SessionReviewNoteStoreDeps) {
    this.#writer = deps.database.writer;
    this.#selectSessionExists = deps.database.reader.prepare(SESSION_EXISTS_SQL);
    this.#selectNotes = deps.database.reader.prepare(SELECT_NOTES_SQL);
    this.#selectNote = deps.database.reader.prepare(SELECT_NOTE_SQL);
    this.#openLineReader = deps.openLineReader;
    this.#followWorkingFolder = deps.followWorkingFolder;
    this.#now = deps.now ?? (() => new Date());
  }

  /**
   * Holds a new note, quoting its line as the diff reads now, and answers it; a note already held
   * under its id is answered as held. Rejects with `session.not_found` for an unknown session.
   */
  async add(request: ReviewNoteAddRequest): Promise<ReviewNoteResponse> {
    const { sessionId, noteId, comparison } = request;
    const lineReader = await this.#openLineReader(sessionId);
    const held = this.#selectNote.get({ sessionId, noteId });
    if (held !== undefined) {
      return { note: await noteOf(held, lineReader) };
    }
    const createdAt = this.#now().toISOString();
    await this.#write(sessionId, {
      sql: INSERT_NOTE_SQL,
      bindings: {
        sessionId,
        noteId,
        scope: comparison.scope,
        base: comparison.base,
        headCommitId: "headCommitId" in comparison ? comparison.headCommitId : null,
        workingTreeBlobId: "workingTreeBlobId" in comparison ? comparison.workingTreeBlobId : null,
        requestNumber: comparison.requestNumber ?? null,
        path: request.path,
        oldPath: request.oldPath ?? null,
        side: request.side,
        line: request.line,
        startLine: request.startLine ?? null,
        quote: (await lineReader?.read(request)) ?? "",
        body: request.body,
        createdAt,
      },
    });
    return { note: await noteOf(this.#heldNote(sessionId, noteId), lineReader) };
  }

  /**
   * Replaces a held note's words and answers the note. Rejects with `session.not_found` for an
   * unknown session and `session.review_note_not_found` for a note it does not hold.
   */
  async update(request: ReviewNoteUpdateRequest): Promise<ReviewNoteResponse> {
    const { sessionId, noteId } = request;
    try {
      await this.#write(sessionId, {
        sql: UPDATE_BODY_SQL,
        bindings: { sessionId, noteId, body: request.body, updatedAt: this.#now().toISOString() },
        expectedRowCount: 1,
      });
    } catch (error) {
      if (error instanceof WriteRefusedError) {
        throw new ReviewNoteNotFoundError(noteId);
      }
      throw error;
    }
    const lineReader = await this.#openLineReader(sessionId);
    return { note: await noteOf(this.#heldNote(sessionId, noteId), lineReader) };
  }

  /**
   * Discards the named notes in one write and answers the ids it discarded; an id the session does
   * not hold is passed over. Rejects with `session.not_found` for an unknown session.
   */
  async remove(request: ReviewNoteRemoveRequest): Promise<ReviewNoteRemoveResponse> {
    const deleted = await this.#write(request.sessionId, {
      sql: DELETE_NOTES_SQL,
      bindings: { sessionId: request.sessionId, noteIds: JSON.stringify(request.noteIds) },
    });
    const rows = deleted.rows as readonly { noteId: ReviewNoteId }[];
    return { removedNoteIds: rows.map((row) => row.noteId) };
  }

  /** The session's notes, oldest first, each with its stranded mark read now. */
  async list(sessionId: SessionId): Promise<ReviewNoteSet> {
    const rows = this.#selectNotes.all({ sessionId });
    const lineReader = rows.length === 0 ? undefined : await this.#openLineReader(sessionId);
    const notes: ReviewNote[] = [];
    // One at a time, so a session's notes start one git process at a time.
    for (const row of rows) {
      notes.push(await noteOf(row, lineReader));
    }
    return { notes };
  }

  /**
   * Sends the session's notes to `outlet` now, then after each note change and each change to the
   * folder it works in, until the returned detach runs; a failed read ends the follow through
   * `outlet.fail`. Rejects with `session.not_found` for an unknown session, following nothing.
   */
  async follow(sessionId: SessionId, outlet: ReviewNoteSetOutlet): Promise<() => void> {
    if (this.#selectSessionExists.get({ sessionId }) === undefined) {
      throw sessionNotFound(sessionId);
    }
    let isFollowing = true;
    let isStale = false;
    let isReading = false;
    const readUntilFresh = async (): Promise<void> => {
      isReading = true;
      try {
        while (isStale && isFollowing) {
          isStale = false;
          const notes = await this.list(sessionId);
          // A change during the read makes it stale: the next turn reads again and sends that.
          if (!isStale && isFollowing) {
            outlet.send(notes);
          }
        }
      } catch (error) {
        outlet.fail(error);
      } finally {
        isReading = false;
      }
    };
    const refresh = (): void => {
      isStale = true;
      if (!isReading) {
        void readUntilFresh();
      }
    };

    const listeners = this.#changeListeners.get(sessionId) ?? new Set<() => void>();
    this.#changeListeners.set(sessionId, listeners);
    listeners.add(refresh);
    const stopListening = (): void => {
      listeners.delete(refresh);
      if (listeners.size === 0) {
        this.#changeListeners.delete(sessionId);
      }
    };
    let stopFollowingFolder: (() => void) | undefined;
    try {
      stopFollowingFolder = await this.#followWorkingFolder(sessionId, refresh);
    } catch (error) {
      // A session working in no folder has no diff to follow; its notes change only by its calls.
      if (!(error instanceof SessionNotFoundError)) {
        stopListening();
        throw error;
      }
    }
    refresh();
    return () => {
      isFollowing = false;
      stopListening();
      stopFollowingFolder?.();
    };
  }

  // Runs `change` behind the session's existence check, then tells the session's followers.
  async #write(sessionId: SessionId, change: WriteStatement): Promise<StatementResult> {
    let results: readonly StatementResult[];
    try {
      results = await this.#writer.write([sessionExistsStatement(sessionId), change]);
    } catch (error) {
      if (error instanceof WriteRefusedError && error.statementIndex === 0) {
        throw sessionNotFound(sessionId);
      }
      throw error;
    }
    for (const listener of this.#changeListeners.get(sessionId) ?? []) {
      listener();
    }
    return results[1] as StatementResult;
  }

  // The note just written, unless a remove from another device landed between the two.
  #heldNote(sessionId: SessionId, noteId: ReviewNoteId): ReviewNoteRow {
    const row = this.#selectNote.get({ sessionId, noteId });
    if (row === undefined) {
      throw new ReviewNoteNotFoundError(noteId);
    }
    return row;
  }
}

async function noteOf(
  row: ReviewNoteRow,
  lineReader: Pick<NotedLineReader, "read"> | undefined,
): Promise<ReviewNote> {
  const location = locationOf(row);
  const lineText = await lineReader?.read(location);
  return {
    ...location,
    noteId: row.note_id as ReviewNoteId,
    quote: row.quote,
    body: row.body,
    stranded: lineText === undefined || lineText !== row.quote,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function locationOf(row: ReviewNoteRow): NoteLocation {
  const comparisonBase = {
    scope: row.scope as ReviewNoteScope,
    base: row.base,
    ...(row.request_number === null ? {} : { requestNumber: row.request_number }),
  };
  return {
    comparison:
      row.head_commit_id === null
        ? { ...comparisonBase, workingTreeBlobId: row.working_tree_blob_id }
        : { ...comparisonBase, headCommitId: row.head_commit_id },
    path: row.path,
    ...(row.old_path === null ? {} : { oldPath: row.old_path }),
    side: row.side as ReviewNoteSide,
    line: row.line,
    ...(row.start_line === null ? {} : { startLine: row.start_line }),
  };
}
