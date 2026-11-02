//! The checkpoint rows' writes, each a statement built from plain values for the caller's own
//! write, and the reads an undo and its dry run take: a checkpoint by the point a request names, a
//! session's checkpoints, per path the version an undo puts back, the commands no capture covered,
//! and a saved undo outcome by its key.
//!
//! A point is a place in the session's log: an undo goes back to before the event at
//! `before_sequence`, so every checkpoint whose prompt sits at or past it lies after the point.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension as _, Row, named_params};
use sidekicks_contracts::event::envelope::{SourceEpoch, SourcePosition};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::release_manifest::Sha256Hex;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::event_cursor::{
    SessionEventCursorUnresolvable, decode_event_cursor,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::restore::{
    SessionRestoreOutcome, SessionRestoreTarget, SnapshotId,
};
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_contracts::wire::id::{ClientUuid, IdError, UuidText, UuidTextForm, mint_uuid_v7};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_store::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use sidekicks_store::database::stored_column::{
    closed_word, optional_text_column, safe_int_column, text_column,
};

use crate::checkpoints::schema::{
    CheckpointVersionContent, CheckpointVersionKind, CheckpointVersionLeg, skip_reason_word,
};

static INSERT_CHECKPOINT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO session_checkpoints
  (checkpoint_id, session_id, message_sequence, run_id, epoch, position, head, tree, created_at)
  VALUES (@checkpointId, @sessionId, @messageSequence, @runId, @epoch, @position, @head, @tree,
          {DATABASE_NOW_SQL})"
    )
});

// The version takes the checkpoint's next sequence, so the order recorded is the order kept.
const INSERT_VERSION_SQL: &str = "INSERT INTO checkpoint_versions
  (checkpoint_id, sequence, path, leg, kind, copy_hash, not_kept_reason, parent_real_path,
   window_id, volume_id)
  VALUES (@checkpointId,
          (SELECT COALESCE(MAX(sequence) + 1, 0) FROM checkpoint_versions
            WHERE checkpoint_id = @checkpointId),
          @path, @leg, @kind, @copyHash, @notKeptReason, @parentRealPath, @windowId, @volumeId)";

static OPEN_WINDOW_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO checkpoint_commands
  (window_id, checkpoint_id, tree_before, head_before, command, tool_call_id, started_at)
  VALUES (@windowId, @checkpointId, @treeBefore, @headBefore, @command, @toolCallId,
          {DATABASE_NOW_SQL})"
    )
});

// Closes an open window; refused for a window unknown or already closed.
static CLOSE_WINDOW_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE checkpoint_commands
  SET tree_after = @treeAfter, head_after = @headAfter, covered = @covered,
      ended_at = {DATABASE_NOW_SQL}
  WHERE window_id = @windowId AND ended_at IS NULL"
    )
});

// A plain insert, so a second undo under one key is refused by the key and never overwrites.
static INSERT_RESTORE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO session_restores (client_idempotency_key, session_id, outcome, created_at)
  VALUES (@key, @sessionId, @outcome, {DATABASE_NOW_SQL})"
    )
});

/// A select of the checkpoint columns [`stored_checkpoint_of`] reads, in its order, with `$tail`.
macro_rules! select_checkpoints {
    ($tail:literal) => {
        concat!(
            "SELECT checkpoint_id, session_id, message_sequence, run_id, epoch, position, head,
       tree, created_at
  FROM session_checkpoints ",
            $tail
        )
    };
}

const CHECKPOINT_BY_ID_SQL: &str =
    select_checkpoints!("WHERE checkpoint_id = @checkpointId AND session_id = @sessionId");

const CHECKPOINT_BY_MESSAGE_SQL: &str =
    select_checkpoints!("WHERE session_id = @sessionId AND message_sequence = @messageSequence");

const CHECKPOINTS_OF_SESSION_SQL: &str =
    select_checkpoints!("WHERE session_id = @sessionId ORDER BY message_sequence");

// Per path, the earliest version of the checkpoints at or past the point: the earliest checkpoint,
// then the earliest sequence in it. Every kind is kept, so a path with no copy is still named.
const VERSIONS_AFTER_SQL: &str = "SELECT checkpoint_id, sequence, path, leg, kind, copy_hash,
       not_kept_reason, parent_real_path, window_id, volume_id
  FROM (SELECT versions.*,
               ROW_NUMBER() OVER (PARTITION BY versions.path
                                  ORDER BY checkpoints.message_sequence, versions.sequence)
                 AS earliest
          FROM checkpoint_versions AS versions
          JOIN session_checkpoints AS checkpoints
            ON checkpoints.checkpoint_id = versions.checkpoint_id
         WHERE checkpoints.session_id = @sessionId
           AND checkpoints.message_sequence >= @beforeSequence)
 WHERE earliest = 1
 ORDER BY path";

const UNCOVERED_COMMANDS_SQL: &str = "SELECT commands.window_id, commands.command,
       commands.tool_call_id, commands.started_at
  FROM checkpoint_commands AS commands
  JOIN session_checkpoints AS checkpoints ON checkpoints.checkpoint_id = commands.checkpoint_id
 WHERE checkpoints.session_id = @sessionId
   AND checkpoints.message_sequence >= @beforeSequence
   AND commands.covered = 0
 ORDER BY checkpoints.message_sequence, commands.rowid";

const RESTORE_SQL: &str =
    "SELECT outcome FROM session_restores WHERE client_idempotency_key = @key";

/// The daemon-minted id of one command window, which its open and its close name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CommandWindowId(UuidTextForm);

impl CommandWindowId {
    /// A fresh window id.
    pub fn mint() -> Self {
        Self(UuidTextForm::from(mint_uuid_v7()))
    }
}

/// A checkpoint as a turn's start records it: the point before one of the person's prompts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checkpoint {
    /// The checkpoint, by the snapshot id a client names it with.
    pub checkpoint_id: SnapshotId,
    /// Its session.
    pub session_id: SessionId,
    /// The prompt's sequence in the session's log.
    pub message_sequence: SafeInt<0>,
    /// The run the prompt started a turn of.
    pub run_id: RunId,
    /// The run's execution epoch and the turn's position in it.
    pub turn: EpochPosition,
    /// The checkout's HEAD, `None` when it had none.
    pub head: Option<GitObjectId>,
    /// The capture's tree, `None` when none was taken.
    pub tree: Option<GitObjectId>,
}

/// A checkpoint as its row holds it, with when it was recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredCheckpoint {
    /// The checkpoint.
    pub checkpoint: Checkpoint,
    /// When it was recorded.
    pub created_at: WireInstant,
}

/// One change a turn recorded to a path: which leg saw it and what was kept of the path before.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckpointVersion {
    /// The path changed.
    pub path: FilesystemPath,
    /// The leg that recorded it.
    pub leg: CheckpointVersionLeg,
    /// What was kept of the path before the change.
    pub content: CheckpointVersionContent,
    /// The real path of the folder holding it when recorded, which an undo compares.
    pub parent_real_path: FilesystemPath,
    /// The command window it fell in, `None` on an edit.
    pub window_id: Option<CommandWindowId>,
    /// The volume its shadow sits on, `None` when its copy, if any, is under the capture folder.
    pub volume_id: Option<String>,
}

/// A version as its row holds it, with the checkpoint it belongs to and its order there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredCheckpointVersion {
    /// The checkpoint it belongs to.
    pub checkpoint_id: SnapshotId,
    /// Its order in the checkpoint, from 0.
    pub sequence: SafeInt<0>,
    /// The version.
    pub version: CheckpointVersion,
}

/// A command window as it opens, before the command runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandWindowOpening {
    /// The window.
    pub window_id: CommandWindowId,
    /// The checkpoint of the turn the command runs in.
    pub checkpoint_id: SnapshotId,
    /// The before-capture's tree, `None` when it failed.
    pub tree_before: Option<GitObjectId>,
    /// The checkout's HEAD before, `None` when it had none.
    pub head_before: Option<GitObjectId>,
    /// The command's text.
    pub command: String,
    /// The provider's tool call that ran it, `None` when no tool call did.
    pub tool_call_id: Option<ToolCallId>,
}

/// A command window as it closes, after the command ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandWindowClosing {
    /// The window.
    pub window_id: CommandWindowId,
    /// The after-capture's tree, `None` when it failed.
    pub tree_after: Option<GitObjectId>,
    /// The checkout's HEAD after, `None` when it had none.
    pub head_after: Option<GitObjectId>,
    /// Whether the before-capture was taken before the command ran.
    pub is_covered: bool,
}

/// A command no before-capture covered, which a dry run names so the person knows its changes
/// may not all go back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UncoveredCommand {
    /// Its window.
    pub window_id: CommandWindowId,
    /// The command's text.
    pub command: String,
    /// The provider's tool call that ran it, `None` when no tool call did.
    pub tool_call_id: Option<ToolCallId>,
    /// When it started.
    pub started_at: WireInstant,
}

/// Why a checkpoint could not be read for an undo's target.
#[derive(Debug, thiserror::Error)]
pub enum CheckpointReadError {
    /// The target's message cursor names no place in the session's log.
    #[error(transparent)]
    CursorUnresolvable(#[from] SessionEventCursorUnresolvable),
    /// SQLite failed the read, or a stored column did not read as its type.
    #[error("the checkpoint could not be read")]
    Database(#[from] rusqlite::Error),
}

/// A stored checkpoint member that does not read as its type; it names the member only.
#[derive(Debug, thiserror::Error)]
#[error("the stored checkpoint's {0} does not read")]
struct StoredCheckpointMemberInvalid(&'static str);

/// The checkpoint row `checkpoint` writes at its turn's start. Refused by SQLite when its id or
/// its prompt is already kept, or when its run has no row.
pub fn insert_checkpoint_statement(checkpoint: &Checkpoint) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(INSERT_CHECKPOINT_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@checkpointId", checkpoint.checkpoint_id.as_str()),
            text_binding("@sessionId", checkpoint.session_id.text().as_str()),
            integer_binding("@messageSequence", checkpoint.message_sequence),
            text_binding("@runId", checkpoint.run_id.text().as_str()),
            integer_binding("@epoch", checkpoint.turn.epoch.0),
            integer_binding("@position", checkpoint.turn.position.0),
            nullable_text_binding("@head", checkpoint.head.as_ref().map(GitObjectId::as_str)),
            nullable_text_binding("@tree", checkpoint.tree.as_ref().map(GitObjectId::as_str)),
        ]),
        expected_row_count: Some(1),
    }
}

/// The row of `version`, recorded in `checkpoint_id` after every version it already holds.
/// Refused by SQLite when the checkpoint or the window has no row.
pub fn insert_version_statement(
    checkpoint_id: &SnapshotId,
    version: &CheckpointVersion,
) -> WriteStatement {
    let (copy_hash, not_kept_reason) = match &version.content {
        CheckpointVersionContent::Copy { hash } => (Some(hash.as_str().to_owned()), None),
        CheckpointVersionContent::Created => (None, None),
        CheckpointVersionContent::NotKept { reason } => (None, Some(skip_reason_word(*reason))),
    };
    let kind = CheckpointVersionKind::from(&version.content);
    let window_id = version.window_id.map(|window_id| window_id.0.text());
    WriteStatement {
        sql: Cow::Borrowed(INSERT_VERSION_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@checkpointId", checkpoint_id.as_str()),
            text_binding("@path", version.path.as_str()),
            text_binding("@leg", version.leg.into()),
            text_binding("@kind", kind.into()),
            nullable_text_binding("@copyHash", copy_hash.as_deref()),
            nullable_text_binding("@notKeptReason", not_kept_reason.as_deref()),
            text_binding("@parentRealPath", version.parent_real_path.as_str()),
            nullable_text_binding("@windowId", window_id.as_ref().map(UuidText::as_str)),
            nullable_text_binding("@volumeId", version.volume_id.as_deref()),
        ]),
        expected_row_count: Some(1),
    }
}

/// The open of a command window, before its command runs. Refused by SQLite when the window is
/// already kept or its checkpoint has no row.
pub fn open_command_window_statement(opening: &CommandWindowOpening) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(OPEN_WINDOW_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@windowId", opening.window_id.0.text().as_str()),
            text_binding("@checkpointId", opening.checkpoint_id.as_str()),
            nullable_text_binding(
                "@treeBefore",
                opening.tree_before.as_ref().map(GitObjectId::as_str),
            ),
            nullable_text_binding(
                "@headBefore",
                opening.head_before.as_ref().map(GitObjectId::as_str),
            ),
            text_binding("@command", &opening.command),
            nullable_text_binding(
                "@toolCallId",
                opening.tool_call_id.as_ref().map(ToolCallId::as_str),
            ),
        ]),
        expected_row_count: Some(1),
    }
}

/// The close of an open command window, with its after-capture and whether it was covered;
/// refused when the window is unknown or already closed.
pub fn close_command_window_statement(closing: &CommandWindowClosing) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(CLOSE_WINDOW_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@windowId", closing.window_id.0.text().as_str()),
            nullable_text_binding(
                "@treeAfter",
                closing.tree_after.as_ref().map(GitObjectId::as_str),
            ),
            nullable_text_binding(
                "@headAfter",
                closing.head_after.as_ref().map(GitObjectId::as_str),
            ),
            (
                Cow::Borrowed("@covered"),
                SqlValue::Integer(i64::from(closing.is_covered)),
            ),
        ]),
        expected_row_count: Some(1),
    }
}

/// The saved outcome of the undo `session_id` asked for under `key`, written once. Refused by
/// SQLite when the key is already kept, so a repeated undo never overwrites the first's outcome.
pub fn insert_restore_statement(
    key: &ClientUuid,
    session_id: SessionId,
    outcome: &SessionRestoreOutcome,
) -> WriteStatement {
    let outcome = serde_json::to_string(outcome).expect("an undo outcome writes as JSON");
    WriteStatement {
        sql: Cow::Borrowed(INSERT_RESTORE_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@key", key.as_str()),
            text_binding("@sessionId", session_id.text().as_str()),
            text_binding("@outcome", &outcome),
        ]),
        expected_row_count: Some(1),
    }
}

/// The checkpoint of `session_id` that `target` names: the one before the message its cursor
/// places, or the snapshot it names. `None` when the session holds no such checkpoint. Fails with
/// [`CheckpointReadError::CursorUnresolvable`] for a cursor that names no place in the log, and
/// as SQLite does or when a stored column does not read.
pub fn read_checkpoint(
    connection: &Connection,
    session_id: SessionId,
    target: &SessionRestoreTarget,
) -> Result<Option<StoredCheckpoint>, CheckpointReadError> {
    let session = session_id.text();
    let checkpoint = match target {
        SessionRestoreTarget::Message { anchor_cursor } => {
            // The start of the log is no message, so no checkpoint stands there.
            let Some(sequence) = u64::try_from(decode_event_cursor(anchor_cursor)?)
                .ok()
                .and_then(SafeInt::<0>::new)
            else {
                return Ok(None);
            };
            connection
                .prepare_cached(CHECKPOINT_BY_MESSAGE_SQL)?
                .query_row(
                    named_params! {
                        "@sessionId": session.as_str(),
                        "@messageSequence": i64::from(sequence),
                    },
                    stored_checkpoint_of,
                )
                .optional()?
        }
        SessionRestoreTarget::Snapshot { snapshot_id } => connection
            .prepare_cached(CHECKPOINT_BY_ID_SQL)?
            .query_row(
                named_params! {
                    "@checkpointId": snapshot_id.as_str(),
                    "@sessionId": session.as_str(),
                },
                stored_checkpoint_of,
            )
            .optional()?,
    };
    Ok(checkpoint)
}

/// `session_id`'s checkpoints, oldest prompt first. Fails as SQLite does, or when a stored column
/// does not read.
pub fn list_checkpoints(
    connection: &Connection,
    session_id: SessionId,
) -> rusqlite::Result<Vec<StoredCheckpoint>> {
    connection
        .prepare_cached(CHECKPOINTS_OF_SESSION_SQL)?
        .query_map(
            named_params! { "@sessionId": session_id.text().as_str() },
            stored_checkpoint_of,
        )?
        .collect()
}

/// Per path, the version an undo of `session_id` to before the log event at `before_sequence`
/// puts back: the earliest of the checkpoints at or past that point, a version that kept no copy
/// returned as such so the undo names its skip. Ordered by path. Fails as SQLite does, or when a
/// stored column does not read.
pub fn versions_after(
    connection: &Connection,
    session_id: SessionId,
    before_sequence: SafeInt<0>,
) -> rusqlite::Result<Vec<StoredCheckpointVersion>> {
    connection
        .prepare_cached(VERSIONS_AFTER_SQL)?
        .query_map(
            named_params! {
                "@sessionId": session_id.text().as_str(),
                "@beforeSequence": i64::from(before_sequence),
            },
            stored_version_of,
        )?
        .collect()
}

/// Every command of `session_id` in the checkpoints at or past the log event at `before_sequence`
/// that closed without its before-capture, oldest first. Fails as SQLite does, or when a stored
/// column does not read.
pub fn uncovered_commands(
    connection: &Connection,
    session_id: SessionId,
    before_sequence: SafeInt<0>,
) -> rusqlite::Result<Vec<UncoveredCommand>> {
    connection
        .prepare_cached(UNCOVERED_COMMANDS_SQL)?
        .query_map(
            named_params! {
                "@sessionId": session_id.text().as_str(),
                "@beforeSequence": i64::from(before_sequence),
            },
            |row| {
                Ok(UncoveredCommand {
                    window_id: text_column(row, 0, |text| window_id(&text))?,
                    command: row.get(1)?,
                    tool_call_id: optional_text_column(row, 2, ToolCallId::new)?,
                    started_at: text_column(row, 3, WireInstant::try_from)?,
                })
            },
        )?
        .collect()
}

/// The outcome the undo under `key` saved, `None` when no undo used it. Fails as SQLite does, or
/// when the stored outcome does not read.
pub fn read_restore(
    connection: &Connection,
    key: &ClientUuid,
) -> rusqlite::Result<Option<SessionRestoreOutcome>> {
    connection
        .prepare_cached(RESTORE_SQL)?
        .query_row(named_params! { "@key": key.as_str() }, |row| {
            text_column(row, 0, |text| serde_json::from_str(&text))
        })
        .optional()
}

fn integer_binding(name: &'static str, value: SafeInt<0>) -> (Cow<'static, str>, SqlValue) {
    (Cow::Borrowed(name), SqlValue::Integer(i64::from(value)))
}

fn window_id(text: &str) -> Result<CommandWindowId, IdError> {
    UuidTextForm::new(text).map(CommandWindowId)
}

fn git_object_id(text: String) -> Result<GitObjectId, StoredCheckpointMemberInvalid> {
    GitObjectId::new(text).ok_or(StoredCheckpointMemberInvalid("git object id"))
}

fn snapshot_id(text: String) -> Result<SnapshotId, StoredCheckpointMemberInvalid> {
    SnapshotId::new(text).ok_or(StoredCheckpointMemberInvalid("checkpoint id"))
}

// Reads the columns `select_checkpoints!` takes, in its order.
fn stored_checkpoint_of(row: &Row<'_>) -> rusqlite::Result<StoredCheckpoint> {
    Ok(StoredCheckpoint {
        checkpoint: Checkpoint {
            checkpoint_id: text_column(row, 0, snapshot_id)?,
            session_id: text_column(row, 1, |text| SessionId::new(&text))?,
            message_sequence: safe_int_column(row, 2)?,
            run_id: text_column(row, 3, |text| RunId::new(&text))?,
            turn: EpochPosition {
                epoch: SourceEpoch(safe_int_column(row, 4)?),
                position: SourcePosition(safe_int_column(row, 5)?),
            },
            head: optional_text_column(row, 6, git_object_id)?,
            tree: optional_text_column(row, 7, git_object_id)?,
        },
        created_at: text_column(row, 8, WireInstant::try_from)?,
    })
}

// Reads the columns `VERSIONS_AFTER_SQL` selects, in its order.
fn stored_version_of(row: &Row<'_>) -> rusqlite::Result<StoredCheckpointVersion> {
    let content = match text_column(row, 4, closed_word::<CheckpointVersionKind>)? {
        CheckpointVersionKind::Copy => CheckpointVersionContent::Copy {
            hash: text_column(row, 5, |text| {
                Sha256Hex::new(text).ok_or(StoredCheckpointMemberInvalid("copy hash"))
            })?,
        },
        CheckpointVersionKind::Created => CheckpointVersionContent::Created,
        CheckpointVersionKind::NotKept => CheckpointVersionContent::NotKept {
            reason: text_column(row, 6, closed_word)?,
        },
    };
    Ok(StoredCheckpointVersion {
        checkpoint_id: text_column(row, 0, snapshot_id)?,
        sequence: safe_int_column(row, 1)?,
        version: CheckpointVersion {
            path: text_column(row, 2, FilesystemPath::new)?,
            leg: text_column(row, 3, closed_word)?,
            content,
            parent_real_path: text_column(row, 7, FilesystemPath::new)?,
            window_id: optional_text_column(row, 8, |text| window_id(&text))?,
            volume_id: row.get(9)?,
        },
    })
}

#[cfg(test)]
mod tests;
