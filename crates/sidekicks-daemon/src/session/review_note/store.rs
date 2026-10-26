//! The review notes a session holds on its diff's lines, one `session_review_notes` row per note,
//! kept with the session beside its draft so a half-written review reaches the person's other
//! devices. The client mints a note's id, so a resent add answers the note already held.
//!
//! A note quotes its line from that side's file at its comparison when it was added. Whether it is
//! stranded is never stored: each read looks its line up again in that file as it reads now, and a
//! note whose line is gone, or no longer says what it quoted, is stranded. A session working in no
//! repository's folder has no diff, so its notes read stranded.
//!
//! A follower gets the whole set at once, then again after each note change and each change to the
//! folder the session works in. Each follower reads on a task of its own, one read at a time, and a
//! burst of changes during a read costs one more read, never one per change.

use std::borrow::Cow;
use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures::future::BoxFuture;
use rusqlite::types::{Type, Value};
use rusqlite::{Connection, OptionalExtension as _, Row, named_params};
use serde_json::json;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_contracts::review_note::{
    CommittedReviewNoteComparison, ReviewNote, ReviewNoteComparison, ReviewNoteId, ReviewNoteSet,
    ReviewNoteSide, SessionReviewNoteAddRequest, SessionReviewNoteDeleteRequest,
    SessionReviewNoteDeleteResponse, SessionReviewNoteResponse, SessionReviewNoteUpdateRequest,
    WorkingTreeReviewNoteComparison,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use tokio::sync::Notify;

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::statement::{
    StatementBindings, StatementResult, WriteStatement, nullable_text_binding, text_binding,
};
use crate::database::stored_column::{
    closed_word, optional_text_column, safe_int_column, text_column,
};
use crate::database::writer::{DatabaseWriter, WriteError};
use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::HandlerError;
use crate::ipc::stream::latest_value::LatestValueOutlet;
use crate::session::directory::lookups::{
    SessionWriteError, session_exists, write_while_session_exists,
};
use crate::session::not_found::session_not_found;
use crate::session::review_note::diff_line::{NoteLocation, NotedLineError, NotedLineReader};

/// The statements the store's reads prepare on a read connection: the session's notes, one note,
/// and whether the session has a row.
pub(crate) const REVIEW_NOTE_STORE_STATEMENT_CAPACITY: usize = 3;

// The note columns every read takes, in the order `stored_note_of` reads them.
macro_rules! select_notes {
    ($rest:literal) => {
        concat!(
            "SELECT note_id, scope, base, head_commit_id, working_tree_blob_id, request_number,
                    path, old_path, side, line, start_line, quote, body, created_at, updated_at
               FROM session_review_notes ",
            $rest
        )
    };
}

const SELECT_NOTES_SQL: &str =
    select_notes!("WHERE session_id = @sessionId ORDER BY created_at, note_id");

const SELECT_NOTE_SQL: &str = select_notes!("WHERE session_id = @sessionId AND note_id = @noteId");

// A note added again under its id is kept as held.
const INSERT_NOTE_SQL: &str = "INSERT INTO session_review_notes (session_id, note_id, scope, base,
    head_commit_id, working_tree_blob_id, request_number, path, old_path, side, line, start_line,
    quote, body, created_at, updated_at)
  VALUES (@sessionId, @noteId, @scope, @base, @headCommitId, @workingTreeBlobId, @requestNumber,
    @path, @oldPath, @side, @line, @startLine, @quote, @body, @createdAt, @createdAt)
  ON CONFLICT (session_id, note_id) DO NOTHING";

const UPDATE_BODY_SQL: &str =
    "UPDATE session_review_notes SET body = @body, updated_at = @updatedAt
  WHERE session_id = @sessionId AND note_id = @noteId";

const DELETE_NOTES_SQL: &str = "DELETE FROM session_review_notes
  WHERE session_id = @sessionId AND note_id IN (SELECT value FROM json_each(@noteIds))
  RETURNING note_id";

// The change statement's place in a write behind the session's existence check.
const CHANGE_STATEMENT_INDEX: usize = 1;

/// Stops following a session's working folder when called.
pub(crate) type WorkingFolderDetach = Box<dyn FnOnce() + Send>;

/// Why the session's working folder could not be read or followed for its notes; the
/// implementation's own failure is kept as the cause.
#[derive(Debug, thiserror::Error)]
#[error("the session's working folder could not be read or followed for its review notes")]
pub(crate) struct ReviewNoteFolderError(#[source] pub(crate) Box<dyn Error + Send + Sync>);

/// The folder reads the note store needs from the session's live working folder.
///
/// `open_line_reader` answers `None` when the session works in no repository's folder, and also
/// when its root's `real_path` fails with `NotFound` or `NotADirectory`: the folder is gone, so the
/// session's notes read stranded and a follow goes on until the folder is back. Any other failure
/// is an error.
pub(crate) trait ReviewNoteFolders: Send + Sync {
    /// A reader of notes' lines in the folder `session_id` works in now, made fresh for one read
    /// of its notes; `None` as the trait's rule says. Fails with the folder's read failure.
    fn open_line_reader(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Option<NotedLineReader>, ReviewNoteFolderError>>;

    /// Calls `on_change` on each change to the folder `session_id` works in until the returned
    /// detach runs; `None` when the session works in no folder, so there is nothing to follow.
    /// Fails when the folder cannot be followed.
    fn follow_working_folder(
        &self,
        session_id: SessionId,
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> BoxFuture<'_, Result<Option<WorkingFolderDetach>, ReviewNoteFolderError>>;
}

/// Why a review note call was refused or failed; a refused change keeps nothing.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ReviewNoteStoreError {
    /// The session holds no such note (`session.reviewNote.notFound`), or the session is unknown
    /// (`session.notFound`).
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The session is unknown (`session.notFound`), or the write was not kept.
    #[error(transparent)]
    Write(#[from] SessionWriteError),
    /// SQLite refused a read, or a stored note did not read.
    #[error("a read of the session's review notes failed")]
    Read(#[from] rusqlite::Error),
    /// No read connection could be had.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The session's working folder could not be read or followed.
    #[error(transparent)]
    Folder(#[from] ReviewNoteFolderError),
    /// A note's line could not be read.
    #[error("a review note's line could not be read")]
    Line(#[from] NotedLineError),
}

impl From<ReviewNoteStoreError> for HandlerError {
    /// A refusal answers by its code; any other failure is a fault in the daemon.
    fn from(error: ReviewNoteStoreError) -> Self {
        match error {
            ReviewNoteStoreError::Refused(refusal) => Self::Refused(refusal),
            ReviewNoteStoreError::Write(write) => write.into(),
            fault @ (ReviewNoteStoreError::Read(_)
            | ReviewNoteStoreError::Pool(_)
            | ReviewNoteStoreError::Folder(_)
            | ReviewNoteStoreError::Line(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// One stored note, its line not yet looked up.
struct StoredNote {
    note_id: ReviewNoteId,
    comparison: ReviewNoteComparison,
    path: FilesystemPath,
    old_path: Option<FilesystemPath>,
    side: ReviewNoteSide,
    line: SafeInt<1>,
    start_line: Option<SafeInt<1>>,
    quote: String,
    body: NonEmptyText,
    created_at: WireInstant,
    updated_at: WireInstant,
}

impl StoredNote {
    // Where the note sits, as the line reader names a line.
    fn location(&self) -> NoteLocation<'_> {
        NoteLocation {
            comparison: &self.comparison,
            path: &self.path,
            old_path: self.old_path.as_ref(),
            side: self.side,
            line: self.line,
        }
    }
}

/// One follower's wake: raised on each note change and folder change, read by its task.
type FollowerWake = Arc<Notify>;

/// Holds each session's review notes and answers them with their stranded marks read fresh.
pub(crate) struct SessionReviewNoteStore {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
    folders: Arc<dyn ReviewNoteFolders>,
    /// Each followed session's followers, woken after each of its note changes.
    followers: Mutex<HashMap<SessionId, Vec<FollowerWake>>>,
}

impl SessionReviewNoteStore {
    /// The store reading through `pool`, writing through `writer`, and reading and following each
    /// session's working folder through `folders`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the worktree's live session folders build the store with their folder reads"
        )
    )]
    pub(crate) fn new(
        pool: Arc<DatabaseReadPool>,
        writer: Arc<DatabaseWriter>,
        folders: Arc<dyn ReviewNoteFolders>,
    ) -> Self {
        Self {
            pool,
            writer,
            folders,
            followers: Mutex::new(HashMap::new()),
        }
    }

    /// Holds a new note, quoting its line from that side's file at its comparison, and answers it;
    /// a note already held under its id is answered as held. Refused `session.notFound` for an
    /// unknown session and `session.reviewNote.notFound` when the note is deleted elsewhere before
    /// it is answered; fails as a read, a write or a line read fails.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the `session.reviewNote.add` handler holds a person's note through it"
        )
    )]
    pub(crate) async fn add(
        &self,
        request: SessionReviewNoteAddRequest,
    ) -> Result<SessionReviewNoteResponse, ReviewNoteStoreError> {
        let session_id = request.session_id;
        let note_id = request.note_id;
        let mut line_reader = self.folders.open_line_reader(session_id).await?;
        if let Some(held) = self.read_note(session_id, note_id).await? {
            return Ok(SessionReviewNoteResponse {
                note: note_of(held, line_reader.as_mut()).await?,
            });
        }
        let location = NoteLocation {
            comparison: &request.comparison,
            path: &request.path,
            old_path: request.old_path.as_ref(),
            side: request.side,
            line: request.line,
        };
        let quote = match line_reader.as_mut() {
            Some(reader) => reader.read(&location).await?.unwrap_or_default(),
            None => String::new(),
        };
        self.write(session_id, insert_statement(&request, quote))
            .await?;
        let held = self
            .read_note(session_id, note_id)
            .await?
            .ok_or_else(|| review_note_not_found(note_id))?;
        Ok(SessionReviewNoteResponse {
            note: note_of(held, line_reader.as_mut()).await?,
        })
    }

    /// Replaces a held note's words and answers the note. Refused `session.notFound` for an
    /// unknown session and `session.reviewNote.notFound` for a note it does not hold; fails as a
    /// read, a write or a line read fails.
    #[expect(
        dead_code,
        reason = "the `session.reviewNote.update` handler replaces a note's words through it"
    )]
    pub(crate) async fn update(
        &self,
        request: SessionReviewNoteUpdateRequest,
    ) -> Result<SessionReviewNoteResponse, ReviewNoteStoreError> {
        let SessionReviewNoteUpdateRequest {
            session_id,
            note_id,
            body,
        } = request;
        let updated_at = WireInstant::now();
        let change = WriteStatement {
            sql: Cow::Borrowed(UPDATE_BODY_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@sessionId", session_id.text().as_str()),
                text_binding("@noteId", note_id.text().as_str()),
                (Cow::Borrowed("@body"), Value::Text(body.into_string())),
                text_binding("@updatedAt", updated_at.as_str()),
            ]),
            expected_row_count: Some(1),
        };
        match self.write(session_id, change).await {
            Ok(_updated) => {}
            Err(SessionWriteError::Write(WriteError::Refused {
                statement_index: CHANGE_STATEMENT_INDEX,
                ..
            })) => return Err(review_note_not_found(note_id).into()),
            Err(error) => return Err(error.into()),
        }
        let mut line_reader = self.folders.open_line_reader(session_id).await?;
        let held = self
            .read_note(session_id, note_id)
            .await?
            .ok_or_else(|| review_note_not_found(note_id))?;
        Ok(SessionReviewNoteResponse {
            note: note_of(held, line_reader.as_mut()).await?,
        })
    }

    /// Discards the named notes in one write and answers the ids it discarded; an id the session
    /// does not hold is passed over. Refused `session.notFound` for an unknown session; fails when
    /// the write is not kept or a discarded id does not read.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the `session.reviewNote.delete` handler discards a person's notes through it"
        )
    )]
    pub(crate) async fn delete(
        &self,
        request: SessionReviewNoteDeleteRequest,
    ) -> Result<SessionReviewNoteDeleteResponse, ReviewNoteStoreError> {
        let session_id = request.session_id;
        let note_ids: Vec<String> = request
            .note_ids
            .as_slice()
            .iter()
            .map(|note_id| note_id.text().as_str().to_owned())
            .collect();
        let change = WriteStatement {
            sql: Cow::Borrowed(DELETE_NOTES_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@sessionId", session_id.text().as_str()),
                (
                    Cow::Borrowed("@noteIds"),
                    Value::Text(json!(note_ids).to_string()),
                ),
            ]),
            expected_row_count: None,
        };
        let deleted = self.write(session_id, change).await?;
        let removed_note_ids = deleted
            .rows
            .iter()
            .map(|row| deleted_note_id(row.as_slice()))
            .collect::<rusqlite::Result<_>>()?;
        Ok(SessionReviewNoteDeleteResponse { removed_note_ids })
    }

    /// Sends the session's notes through `outlet` now, then again after each note change and each
    /// change to the folder it works in, until the returned detach runs; a later read that fails
    /// ends the stream with that failure, and the read pool closing at the daemon's stop ends it
    /// finished. Refused `session.notFound` for an unknown session, following nothing; fails when
    /// the folder cannot be followed.
    #[expect(
        dead_code,
        reason = "the `session.reviewNote.subscribe` handler follows a session's notes through it"
    )]
    pub(crate) async fn follow(
        self: &Arc<Self>,
        session_id: SessionId,
        outlet: LatestValueOutlet<ReviewNoteSet>,
    ) -> Result<Box<dyn FnOnce() + Send>, ReviewNoteStoreError> {
        let is_known = self
            .pool
            .read(ReadLength::Short, move |connection| {
                Ok::<_, ReviewNoteStoreError>(session_exists(connection, &session_id)?)
            })
            .await?;
        if !is_known {
            return Err(session_not_found(&session_id).into());
        }
        let wake: FollowerWake = Arc::new(Notify::new());
        self.lock_followers()
            .entry(session_id)
            .or_default()
            .push(Arc::clone(&wake));
        let folder_wake = Arc::clone(&wake);
        let folder_detach = match self
            .folders
            .follow_working_folder(session_id, Arc::new(move || folder_wake.notify_one()))
            .await
        {
            Ok(detach) => detach,
            Err(error) => {
                self.stop_waking(session_id, &wake);
                return Err(error.into());
            }
        };
        // The first read: the whole set at once.
        wake.notify_one();
        let reading = tokio::spawn(read_until_detached(
            Arc::clone(self),
            session_id,
            Arc::clone(&wake),
            outlet,
        ));
        let store = Arc::clone(self);
        Ok(Box::new(move || {
            reading.abort();
            store.stop_waking(session_id, &wake);
            if let Some(folder_detach) = folder_detach {
                folder_detach();
            }
        }))
    }

    // The session's notes, oldest first, each with its stranded mark read now. One note at a time,
    // so a session's notes start one git process at a time.
    async fn read_notes(
        &self,
        session_id: SessionId,
    ) -> Result<ReviewNoteSet, ReviewNoteStoreError> {
        let stored = self
            .pool
            .read(ReadLength::Long, move |connection| {
                Ok::<_, ReviewNoteStoreError>(read_stored_notes(connection, &session_id)?)
            })
            .await?;
        if stored.is_empty() {
            return Ok(ReviewNoteSet { notes: Vec::new() });
        }
        let mut line_reader = self.folders.open_line_reader(session_id).await?;
        let mut notes = Vec::with_capacity(stored.len());
        for note in stored {
            notes.push(note_of(note, line_reader.as_mut()).await?);
        }
        Ok(ReviewNoteSet { notes })
    }

    // The note `note_id` of the session, `None` when it holds none.
    async fn read_note(
        &self,
        session_id: SessionId,
        note_id: ReviewNoteId,
    ) -> Result<Option<StoredNote>, ReviewNoteStoreError> {
        self.pool
            .read(ReadLength::Short, move |connection| {
                Ok::<_, ReviewNoteStoreError>(
                    connection
                        .prepare_cached(SELECT_NOTE_SQL)?
                        .query_row(
                            named_params! {
                                "@sessionId": session_id.text().as_str(),
                                "@noteId": note_id.text().as_str(),
                            },
                            stored_note_of,
                        )
                        .optional()?,
                )
            })
            .await
    }

    // Runs `change` behind the session's existence check, then wakes the session's followers.
    async fn write(
        &self,
        session_id: SessionId,
        change: WriteStatement,
    ) -> Result<StatementResult, SessionWriteError> {
        let result = write_while_session_exists(&self.writer, &session_id, change).await?;
        if let Some(wakes) = self.lock_followers().get(&session_id) {
            for wake in wakes {
                wake.notify_one();
            }
        }
        Ok(result)
    }

    fn stop_waking(&self, session_id: SessionId, wake: &FollowerWake) {
        let mut followers = self.lock_followers();
        if let Some(wakes) = followers.get_mut(&session_id) {
            wakes.retain(|held| !Arc::ptr_eq(held, wake));
            if wakes.is_empty() {
                followers.remove(&session_id);
            }
        }
    }

    fn lock_followers(&self) -> MutexGuard<'_, HashMap<SessionId, Vec<FollowerWake>>> {
        // The map holds no invariant a panicking holder could break.
        self.followers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

// Reads the session's notes each time `wake` is raised and sends each set, until the follow is
// detached or a read fails. A raise during a read leaves one permit, so a burst of changes costs
// one more read.
async fn read_until_detached(
    store: Arc<SessionReviewNoteStore>,
    session_id: SessionId,
    wake: FollowerWake,
    outlet: LatestValueOutlet<ReviewNoteSet>,
) {
    loop {
        wake.notified().await;
        match store.read_notes(session_id).await {
            Ok(notes) => outlet.send(notes),
            Err(ReviewNoteStoreError::Pool(DatabaseReadError::Closed)) => return,
            Err(failure) => {
                outlet.fail(failure.into());
                return;
            }
        }
    }
}

// The note as answered: its stored members and whether its line still reads as it quoted.
async fn note_of(
    stored: StoredNote,
    line_reader: Option<&mut NotedLineReader>,
) -> Result<ReviewNote, NotedLineError> {
    let line_text = match line_reader {
        Some(reader) => reader.read(&stored.location()).await?,
        None => None,
    };
    let stranded = line_text.as_deref() != Some(stored.quote.as_str());
    Ok(ReviewNote {
        comparison: stored.comparison,
        path: stored.path,
        old_path: stored.old_path,
        side: stored.side,
        line: stored.line,
        start_line: stored.start_line,
        note_id: stored.note_id,
        quote: stored.quote,
        body: stored.body,
        stranded,
        created_at: stored.created_at,
        updated_at: stored.updated_at,
    })
}

/// The refusal of `note_id`, which the session does not hold: it was sent, posted or deleted,
/// perhaps on another device.
fn review_note_not_found(note_id: ReviewNoteId) -> DomainError {
    DomainError::new(
        "This session holds no such review note.",
        RefusalCode::SessionReviewNoteNotFound,
    )
    .with_detail(json!({ "noteId": note_id }))
}

// The insert of the note `request` adds, quoting `quote`, made now.
fn insert_statement(request: &SessionReviewNoteAddRequest, quote: String) -> WriteStatement {
    let (scope, base, head_commit_id, working_tree_blob_id, request_number) =
        match &request.comparison {
            ReviewNoteComparison::Committed(committed) => (
                committed.scope,
                &committed.base,
                Some(committed.head_commit_id.as_str()),
                None,
                committed.request_number,
            ),
            ReviewNoteComparison::WorkingTree(working_tree) => (
                working_tree.scope,
                &working_tree.base,
                None,
                Some(working_tree.working_tree_blob_id.as_str()),
                working_tree.request_number,
            ),
        };
    let created_at = WireInstant::now();
    WriteStatement {
        sql: Cow::Borrowed(INSERT_NOTE_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", request.session_id.text().as_str()),
            text_binding("@noteId", request.note_id.text().as_str()),
            text_binding("@scope", <&'static str>::from(scope)),
            text_binding("@base", base.as_str()),
            nullable_text_binding("@headCommitId", head_commit_id),
            nullable_text_binding("@workingTreeBlobId", working_tree_blob_id),
            optional_integer_binding("@requestNumber", request_number),
            text_binding("@path", request.path.as_str()),
            nullable_text_binding(
                "@oldPath",
                request.old_path.as_ref().map(FilesystemPath::as_str),
            ),
            text_binding("@side", <&'static str>::from(request.side)),
            (
                Cow::Borrowed("@line"),
                Value::Integer(i64::from(request.line)),
            ),
            optional_integer_binding("@startLine", request.start_line),
            (Cow::Borrowed("@quote"), Value::Text(quote)),
            text_binding("@body", request.body.as_str()),
            text_binding("@createdAt", created_at.as_str()),
        ]),
        expected_row_count: None,
    }
}

// A named binding of `number`, `NULL` when it is `None`.
fn optional_integer_binding(
    name: &'static str,
    number: Option<SafeInt<1>>,
) -> (Cow<'static, str>, Value) {
    (
        Cow::Borrowed(name),
        number.map_or(Value::Null, |number| Value::Integer(i64::from(number))),
    )
}

fn read_stored_notes(
    connection: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<Vec<StoredNote>> {
    connection
        .prepare_cached(SELECT_NOTES_SQL)?
        .query_map(
            named_params! { "@sessionId": session_id.text().as_str() },
            stored_note_of,
        )?
        .collect()
}

/// A stored note's member that does not read as its type; it names the member only.
#[derive(Debug, thiserror::Error)]
#[error("the stored review note's {0} does not read")]
struct StoredNoteMemberInvalid(&'static str);

// Reads the columns `select_notes!` takes, in its order.
fn stored_note_of(row: &Row<'_>) -> rusqlite::Result<StoredNote> {
    let scope = text_column(row, 1, closed_word)?;
    let base = text_column(row, 2, |text| {
        NonEmptyText::new(text).ok_or(StoredNoteMemberInvalid("base"))
    })?;
    let head_commit_id = optional_text_column(row, 3, git_object_id)?;
    let working_tree_blob_id = optional_text_column(row, 4, git_object_id)?;
    let request_number = optional_safe_int_column(row, 5)?;
    // The table holds exactly one of the head commit and the working file's blob.
    let comparison = match (head_commit_id, working_tree_blob_id) {
        (Some(head_commit_id), _) => {
            ReviewNoteComparison::Committed(CommittedReviewNoteComparison {
                scope,
                base,
                head_commit_id,
                request_number,
            })
        }
        (None, Some(working_tree_blob_id)) => {
            ReviewNoteComparison::WorkingTree(WorkingTreeReviewNoteComparison {
                scope,
                base,
                working_tree_blob_id,
                request_number,
            })
        }
        (None, None) => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                3,
                Type::Null,
                Box::new(StoredNoteMemberInvalid("comparison")),
            ));
        }
    };
    Ok(StoredNote {
        note_id: text_column(row, 0, |text| ReviewNoteId::new(&text))?,
        comparison,
        path: text_column(row, 6, FilesystemPath::new)?,
        old_path: optional_text_column(row, 7, FilesystemPath::new)?,
        side: text_column(row, 8, closed_word)?,
        line: safe_int_column(row, 9)?,
        start_line: optional_safe_int_column(row, 10)?,
        quote: row.get(11)?,
        body: text_column(row, 12, |text| {
            NonEmptyText::new(text).ok_or(StoredNoteMemberInvalid("body"))
        })?,
        created_at: text_column(row, 13, WireInstant::try_from)?,
        updated_at: text_column(row, 14, WireInstant::try_from)?,
    })
}

fn git_object_id(text: String) -> Result<GitObjectId, StoredNoteMemberInvalid> {
    GitObjectId::new(text).ok_or(StoredNoteMemberInvalid("commit or blob id"))
}

// The nullable INTEGER column at `index` as a safe integer from 1, `None` for `NULL`.
fn optional_safe_int_column(row: &Row<'_>, index: usize) -> rusqlite::Result<Option<SafeInt<1>>> {
    row.get::<_, Option<i64>>(index)?
        .map(|_| safe_int_column(row, index))
        .transpose()
}

// The id a delete's `RETURNING note_id` row names.
fn deleted_note_id(row: &[Value]) -> rusqlite::Result<ReviewNoteId> {
    match row.first() {
        Some(Value::Text(text)) => ReviewNoteId::new(text).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(0, Type::Text, Box::new(error))
        }),
        Some(Value::Null | Value::Integer(_) | Value::Real(_) | Value::Blob(_)) | None => {
            Err(rusqlite::Error::FromSqlConversionFailure(
                0,
                Type::Null,
                Box::new(StoredNoteMemberInvalid("note id")),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures::FutureExt as _;
    use futures::future::BoxFuture;
    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::review_note::{
        ReviewNoteId, SessionReviewNoteAddRequest, SessionReviewNoteDeleteRequest,
    };
    use sidekicks_contracts::session::id::SessionId;

    use super::{
        REVIEW_NOTE_STORE_STATEMENT_CAPACITY, ReviewNoteFolderError, ReviewNoteFolders,
        SessionReviewNoteStore, WorkingFolderDetach,
    };
    use crate::database::connection::read_pool::DatabaseReadPool;
    use crate::database::writer::test_file::{TestDatabase, test_session_id};
    use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
    use crate::ipc::registry::HandlerError;
    use crate::session::directory::test_rows::insert_session_row;
    use crate::session::review_note::diff_line::NotedLineReader;
    use sidekicks_contracts::wire::id::mint_uuid_v7;

    /// A session that works in no repository's folder.
    struct NoWorkingFolder;

    impl ReviewNoteFolders for NoWorkingFolder {
        fn open_line_reader(
            &self,
            _session_id: SessionId,
        ) -> BoxFuture<'_, Result<Option<NotedLineReader>, ReviewNoteFolderError>> {
            async { Ok(None) }.boxed()
        }

        fn follow_working_folder(
            &self,
            _session_id: SessionId,
            _on_change: Arc<dyn Fn() + Send + Sync>,
        ) -> BoxFuture<'_, Result<Option<WorkingFolderDetach>, ReviewNoteFolderError>> {
            async { Ok(None) }.boxed()
        }
    }

    fn note_id() -> ReviewNoteId {
        serde_json::from_value(json!(mint_uuid_v7().to_string())).expect("a UUID is a note id")
    }

    // Killed by the delete answering the session's existence check in place of its own deleted
    // rows, which reads no note id, and by a gone session's delete answering anything but
    // `session.notFound`.
    #[rstest]
    #[case::a_held_note_and_one_never_held(true)]
    #[case::a_note_of_a_session_that_is_gone(false)]
    #[tokio::test]
    async fn review_note_delete_answers_only_the_notes_it_discarded(#[case] is_live: bool) {
        let database = TestDatabase::new();
        // Opening the writer creates the file with the daemon's schema.
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        let store = SessionReviewNoteStore::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                REVIEW_NOTE_STORE_STATEMENT_CAPACITY,
            )),
            Arc::new(writer),
            Arc::new(NoWorkingFolder),
        );
        let session_id = test_session_id();
        let (held, never_held) = (note_id(), note_id());
        if is_live {
            insert_session_row(&database.reader(), session_id.text().as_str(), None, None);
            let add: SessionReviewNoteAddRequest = serde_json::from_value(json!({
                "sessionId": session_id,
                "noteId": held,
                "body": "this name reads wrong",
                "comparison": {
                    "scope": "changes",
                    "base": "main",
                    "workingTreeBlobId": "1111111111111111111111111111111111111111",
                },
                "path": "src/main.rs",
                "side": "added",
                "line": 3,
            }))
            .expect("a note to add");
            store.add(add).await.expect("the note is held");
        }

        let deleted = store
            .delete(SessionReviewNoteDeleteRequest {
                session_id,
                note_ids: serde_json::from_value(json!([held, never_held])).expect("two note ids"),
            })
            .await;

        if is_live {
            assert_eq!(
                deleted.expect("the delete is kept").removed_note_ids,
                [held]
            );
        } else {
            let refused = deleted.map_err(HandlerError::from);
            let Err(HandlerError::Refused(refusal)) = refused else {
                panic!("a gone session's delete is refused: {refused:?}");
            };
            assert_eq!(refusal.code, RefusalCode::SessionNotFound);
        }
    }
}
