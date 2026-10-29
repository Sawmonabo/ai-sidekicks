//! The session directory's part of the daemon's schema. `sessions` is a projection: its
//! event-derived columns are written in each event's own write and equal a rebuild from the log,
//! while its group, working-folder move and permission level are written by their services and
//! never rebuilt. The rest is row-canonical state no event history holds: the composer's draft and
//! review notes, a project's groups, the links, tags and computed related lists, the create and
//! convert requests a retry resumes from, and the console state the spawn path reads.

use rusqlite::{Connection, OptionalExtension};
use sidekicks_contracts::repo::mount::ExecutionMode;
use sidekicks_contracts::review_note::{ReviewNoteScope, ReviewNoteSide};
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::session::convert::SessionConvertSkipReason;
use sidekicks_contracts::session::directory::SessionActivity;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::links::SessionLinkKind;
use sidekicks_contracts::session::methods::{SessionShape, SessionState};
use strum::{IntoStaticStr, VariantArray};

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::sql_list::{sql_list_of, sql_list_of_every};
use crate::database::stored_column::{closed_word, text_column};

/// A converted file's outcome once its copy lands, as the `session_convert_files.outcome` column
/// holds it; every other outcome the column holds is the [`SessionConvertSkipReason`] it was not
/// copied for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, VariantArray, IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub enum ConvertedFileOutcome {
    /// The file was copied into the repository.
    Copied,
}

/// The session directory's tables and indexes, in foreign-key order.
pub(super) fn session_directory_schema_sql() -> String {
    let review_note_scopes = sql_list_of_every::<ReviewNoteScope>();
    let review_note_sides = sql_list_of_every::<ReviewNoteSide>();
    let shapes = sql_list_of_every::<SessionShape>();
    let states = sql_list_of_every::<SessionState>();
    let last_run_outcomes = sql_list_of(
        [
            SessionActivity::Done,
            SessionActivity::Failed,
            SessionActivity::Idle,
        ]
        .map(<&'static str>::from),
    );
    let idle = <&'static str>::from(SessionActivity::Idle);
    let permission_levels = sql_list_of_every::<PermissionLevel>();
    let yolo = <&'static str>::from(PermissionLevel::Yolo);
    let execution_modes = sql_list_of_every::<ExecutionMode>();
    let convert_outcomes = format!(
        "{}, {}",
        sql_list_of_every::<ConvertedFileOutcome>(),
        sql_list_of_every::<SessionConvertSkipReason>()
    );
    let session_modes = sql_list_of_every::<SessionMode>();
    let build = <&'static str>::from(SessionMode::Build);
    let link_kinds = sql_list_of_every::<SessionLinkKind>();
    format!(
        "
-- ---------------------------------------------------------------------------
-- The composer's unsent draft and the review notes on a session's diff.
-- ---------------------------------------------------------------------------
-- One row per session, so a half-typed message survives a restart and reaches
-- the person's other devices. An empty draft is no row: Send deletes it.
CREATE TABLE session_drafts (
  session_id  TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  updated_at  TEXT NOT NULL                     -- RFC 3339 UTC, ms precision
) STRICT;

-- Each note is held until it is sent as a steer, posted with a review or
-- discarded. The client mints its id, so a resent add is one note. Whether its
-- line is still in that side's file is read from git on each read, never stored.
CREATE TABLE session_review_notes (
  session_id            TEXT NOT NULL,
  note_id               TEXT NOT NULL,
  scope                 TEXT NOT NULL
                        CHECK (scope IN ({review_note_scopes})),
  base                  TEXT NOT NULL,
  head_commit_id        TEXT,
  working_tree_blob_id  TEXT,
  request_number        INTEGER CHECK (request_number IS NULL OR request_number >= 1),
  path                  TEXT NOT NULL,
  old_path              TEXT,                   -- the file's earlier path when it was renamed
  side                  TEXT NOT NULL CHECK (side IN ({review_note_sides})),
  line                  INTEGER NOT NULL CHECK (line >= 1),
  start_line            INTEGER CHECK (start_line IS NULL OR start_line BETWEEN 1 AND line),
  quote                 TEXT NOT NULL,          -- the line's text when the note was added
  body                  TEXT NOT NULL,
  created_at            TEXT NOT NULL,          -- RFC 3339 UTC, ms precision
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (session_id, note_id),
  CHECK ((head_commit_id IS NULL) <> (working_tree_blob_id IS NULL))
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- The session directory: one row per session this daemon hosts, its groups,
-- links, tags and related lists.
-- ---------------------------------------------------------------------------
-- A project's named groups. A chat has none.
CREATE TABLE session_groups (
  -- The rowid, declared so a VACUUM keeps it: the search index keys its rows on it.
  rowid        INTEGER PRIMARY KEY,
  id           TEXT NOT NULL UNIQUE,
  project_id   TEXT NOT NULL,                   -- the project record the group belongs to
  name         TEXT NOT NULL,                   -- the person's own casing, for display
  -- The full-Unicode case fold of name, written by the store on every insert and rename.
  name_folded  TEXT NOT NULL,
  created_at   TEXT NOT NULL
) STRICT;

-- A group's name is unique in its project ignoring case, compared on its fold.
CREATE UNIQUE INDEX idx_session_groups_name_folded ON session_groups(project_id, name_folded);

CREATE TABLE sessions (
  -- The rowid, declared so a VACUUM keeps it: the search index keys its rows on it.
  rowid                      INTEGER PRIMARY KEY,
  id                         TEXT NOT NULL UNIQUE,
  -- Set at creation; changes only when a chat is converted to a project.
  shape                      TEXT NOT NULL CHECK(shape IN ({shapes})),
  state                      TEXT NOT NULL CHECK(state IN ({states})),
  name                       TEXT,              -- NULL while unnamed
  -- The first user message's opening, cut to the session name's bound.
  first_message_preview      TEXT,
  branch                     TEXT,
  pinned_at                  TEXT,              -- NULL while not pinned; pinned rows sort by it
  muted_at                   TEXT,              -- NULL while not muted
  scratch_for_definition_id  TEXT,              -- the definition a scratch session tries
  parent_session_id          TEXT,              -- the session a fork was taken from
  -- Where the session runs on a Windows computer, as the place's wire JSON; NULL elsewhere.
  -- Written at creation and never changed.
  place                      TEXT,
  -- How the session's most recent run to end its working time left it. The session reads waiting
  -- while any of its runs waits, else running while any works, else this.
  last_run_outcome           TEXT NOT NULL DEFAULT '{idle}'
                             CHECK(last_run_outcome IN ({last_run_outcomes})),
  created_at                 TEXT NOT NULL,     -- RFC 3339 UTC, ms precision
  updated_at                 TEXT NOT NULL,
  last_activity_at           TEXT NOT NULL,
  -- The one group of its project the session sits in; NULL for none and for every chat.
  group_id                   TEXT REFERENCES session_groups(id),
  -- The folder a requested working-folder move goes to, applied at the active run's next
  -- boundary; NULL while no move waits.
  pending_working_folder     TEXT,
  -- The workspace the waiting move was asked for, set and cleared with the folder; a move whose
  -- session works in another workspace by then is dropped.
  pending_working_folder_workspace_id TEXT
                             CHECK((pending_working_folder IS NULL)
                                   = (pending_working_folder_workspace_id IS NULL)),
  -- The level every process the session opens or resumes starts at, which the run queue's
  -- admission reads.
  permission_level           TEXT NOT NULL DEFAULT '{yolo}'
                             CHECK(permission_level IN ({permission_levels}))
) STRICT;

CREATE INDEX idx_sessions_group ON sessions(group_id);
-- The list's shape grouping and the chats count.
CREATE INDEX idx_sessions_shape_state ON sessions(shape, state);
-- A search by tag and words reads each tagged session's rowid and last activity from here alone.
CREATE INDEX idx_sessions_activity ON sessions(id, last_activity_at);

-- Each session.create's idempotency key, the session it made and where that session works: its
-- project (NULL for a chat), its execution mode and the group it asked for (NULL for none, and for
-- every chat). Written in the session.created write, so a retry with the key, or the daemon's
-- start, finishes a session left provisioning.
CREATE TABLE session_create_requests (
  client_idempotency_key  TEXT NOT NULL PRIMARY KEY,
  session_id              TEXT NOT NULL UNIQUE,
  project_id              TEXT,
  execution_mode          TEXT NOT NULL CHECK(execution_mode IN ({execution_modes})),
  group_id                TEXT
) STRICT;

-- A project's sessions, which its rules reach, found by the project they were made in.
CREATE INDEX idx_session_create_requests_project ON session_create_requests(project_id);

-- A chat's conversion: the session.convert key it runs under, the project mount it attached and
-- the working tree it copies into, written as soon as the mount is, so a retry resumes there. One
-- per chat.
CREATE TABLE session_convert_requests (
  client_idempotency_key  TEXT NOT NULL PRIMARY KEY,
  session_id              TEXT NOT NULL UNIQUE,
  repo_mount_id           TEXT NOT NULL,
  working_tree            TEXT NOT NULL
) STRICT;

-- Each workspace file a conversion has dealt with, recorded as its copy lands: copied, or not
-- copied with the reason. A file is keyed by its path's stable bytes, the system's own form of each
-- name, and shown by its path as text, a name that is not Unicode written lossily. A resumed
-- conversion skips every key here and counts from these rows.
CREATE TABLE session_convert_files (
  session_id  TEXT NOT NULL,
  path_key    BLOB NOT NULL,
  path        TEXT NOT NULL,
  outcome     TEXT NOT NULL CHECK(outcome IN ({convert_outcomes})),
  PRIMARY KEY (session_id, path_key)
) STRICT, WITHOUT ROWID;

-- What a session holds outside its event log that the spawn path reads: configuration the person
-- set, never rebuilt from events.
CREATE TABLE session_console_state (
  session_id          TEXT NOT NULL PRIMARY KEY,
  -- This session's own bound on the steps of one turn; NULL falls back to the machine's value.
  -- Zero would forbid the turn it bounds.
  max_steps_per_turn  INTEGER
                      CHECK (max_steps_per_turn IS NULL OR max_steps_per_turn >= 1),
  advisor_model       TEXT,                     -- the session's own advisor model; NULL when off
  -- Whether the session's advisor was ever set, so a row another column made reads as unset.
  advisor_set         INTEGER NOT NULL DEFAULT 0 CHECK (advisor_set IN (0, 1)),
  -- The composer's mode the provider last took; a restart resumes in it.
  session_mode        TEXT NOT NULL DEFAULT '{build}'
                      CHECK (session_mode IN ({session_modes})),
  updated_at          TEXT NOT NULL
) STRICT;

-- One row per pair of sessions and kind, written or bumped when the event that makes it is
-- recorded. Only a related row is ever deleted.
CREATE TABLE session_links (
  source_session_id  TEXT NOT NULL,
  target_session_id  TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ({link_kinds})),
  use_count          INTEGER NOT NULL DEFAULT 1 CHECK (use_count >= 1),
  first_at           TEXT NOT NULL,
  last_at            TEXT NOT NULL,             -- a link's weight halves every 30 days from here
  PRIMARY KEY (source_session_id, target_session_id, kind)
) STRICT;

CREATE INDEX idx_session_links_target ON session_links(target_session_id, source_session_id);

-- Any number of tags per session, nested with '/'; a prefix match on the fold finds a parent's
-- children.
CREATE TABLE session_tags (
  -- The rowid, declared so a VACUUM keeps it: the search index keys its rows on it.
  rowid       INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL,
  tag         TEXT NOT NULL,                    -- as written, for display
  tag_folded  TEXT NOT NULL,
  UNIQUE (session_id, tag_folded)
) STRICT;

-- Covers the tags-in-use read, which takes one spelling per fold from the index alone.
CREATE INDEX idx_session_tags_tag ON session_tags(tag_folded, tag);

-- Each session's ranked related list, computed ahead so a read is one lookup.
CREATE TABLE session_related (
  session_id          TEXT NOT NULL,
  related_session_id  TEXT NOT NULL,
  score               REAL NOT NULL,
  PRIMARY KEY (session_id, related_session_id)
) STRICT;

CREATE INDEX idx_session_related_score ON session_related(session_id, score DESC);
-- A purge deletes the entries naming the purged session from every other session's list.
CREATE INDEX idx_session_related_related ON session_related(related_session_id);
"
    )
}

/// When every test session was made and last active.
#[cfg(any(test, feature = "test-support"))]
const TEST_SESSION_ROW_AT: &str = "2026-10-18T09:00:00.000Z";

/// Stores the session `session_id`, an active chat named `name` running in `place` (the place's
/// wire JSON), each `None` left unset, as the directory stores one, for other tables' tests.
#[cfg(any(test, feature = "test-support"))]
pub fn insert_session_row(
    connection: &rusqlite::Connection,
    session_id: &str,
    name: Option<&str>,
    place: Option<&str>,
) {
    // Cached, so a test storing many sessions compiles the statement and its triggers once.
    connection
        .prepare_cached(
            "INSERT INTO sessions (id, shape, state, name, place, created_at, updated_at, \
             last_activity_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6)",
        )
        .expect("the test's insert prepares")
        .execute(rusqlite::params![
            session_id,
            <&'static str>::from(SessionShape::Chat),
            <&'static str>::from(SessionState::Active),
            name,
            place,
            TEST_SESSION_ROW_AT
        ])
        .expect("the test stores a session");
}

const SESSION_STATE_SQL: &str = "SELECT state FROM sessions WHERE id = ?";

/// A session's state from its directory row, or `None` for a session with no row.
pub fn read_session_state(
    reader: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<Option<SessionState>> {
    reader
        .prepare_cached(SESSION_STATE_SQL)?
        .query_row([session_id.text().as_str()], |row| {
            text_column(row, 0, closed_word)
        })
        .optional()
}

/// [`read_session_state`] as one short read on `pool`.
pub async fn read_session_state_through<Failure>(
    pool: &DatabaseReadPool,
    session_id: SessionId,
) -> Result<Option<SessionState>, Failure>
where
    Failure: From<DatabaseReadError> + From<rusqlite::Error> + Send + 'static,
{
    pool.read(ReadLength::Short, move |reader| -> Result<_, Failure> {
        Ok(read_session_state(reader, &session_id)?)
    })
    .await
}
