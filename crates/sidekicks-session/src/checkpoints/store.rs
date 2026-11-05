//! The checkpoint rows' writes, each a statement built from plain values for the caller's own
//! write, and the reads an undo and its dry run take: a checkpoint by the point a request names, a
//! session's checkpoints, per path the version an undo puts back, the commands no capture covered,
//! and a saved undo outcome by its key. The shadow rows of files over 10 MiB are in [`shadows`].
//! A checkpoint whose turn a later undo cut away stands in history that no longer exists, so the
//! list leaves it out and a read of it refuses.
//!
//! A point is a place in the session's log: an undo goes back to before the event at
//! `before_sequence`, so every checkpoint whose prompt sits at or past it lies after the point.

use std::borrow::Cow;
use std::collections::HashMap;
use std::collections::hash_map::Entry;
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
use sidekicks_contracts::transcript::turn_attribution::{
    EpochPosition, SupersededTurns, transcript_run_stamp_at,
};
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
    CheckpointVersionContent, CheckpointVersionKind, CheckpointVersionLeg, CopyMode,
};
use crate::checkpoints::store::shadows::ShadowId;
use crate::run::superseded::{
    StoredRollbackMismatchError, SupersededTurnsReadError, read_superseded_turns,
};

// A prompt already kept keeps its first checkpoint: a second turn its message opens writes nothing.
static INSERT_CHECKPOINT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO session_checkpoints
  (checkpoint_id, session_id, message_sequence, run_id, epoch, position, created_at)
  VALUES (@checkpointId, @sessionId, @messageSequence, @runId, @epoch, @position,
          {DATABASE_NOW_SQL})
  ON CONFLICT (session_id, message_sequence) DO NOTHING"
    )
});

// The version takes the checkpoint's next sequence, so the order recorded is the order kept.
const INSERT_VERSION_SQL: &str = "INSERT INTO checkpoint_versions
  (checkpoint_id, sequence, path, leg, kind, copy_hash, is_executable, permissions,
   not_kept_reason, parent_real_path, window_id, shadow_id, tool_call_id)
  VALUES (@checkpointId,
          (SELECT COALESCE(MAX(sequence) + 1, 0) FROM checkpoint_versions
            WHERE checkpoint_id = @checkpointId),
          @path, @leg, @kind, @copyHash, @isExecutable, @permissions, @notKeptReason,
          @parentRealPath, @windowId, @shadowId, @toolCallId)";

static OPEN_WINDOW_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO checkpoint_commands
  (window_id, checkpoint_id, tree_before, head_before, commit_before, git_common_dir,
   ignored_folders, command, tool_call_id, started_at)
  VALUES (@windowId, @checkpointId, @treeBefore, @headBefore, @commitBefore, @gitCommonDir,
          @ignoredFolders, @command, @toolCallId, {DATABASE_NOW_SQL})"
    )
});

// Closes an open window; refused for a window unknown or already closed.
static CLOSE_WINDOW_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE checkpoint_commands
  SET tree_after = @treeAfter, head_after = @headAfter, commit_after = @commitAfter,
      covered = @covered,
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
            "SELECT checkpoint_id, session_id, message_sequence, run_id, epoch, position, created_at
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
       not_kept_reason, parent_real_path, window_id, shadow_id, is_executable, permissions,
       tool_call_id
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

const RESTORE_SQL: &str = "SELECT outcome FROM session_restores
  WHERE client_idempotency_key = @key AND session_id = @sessionId";

/// The daemon-minted id of one command window, which its open and its close name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CommandWindowId(UuidTextForm);

impl CommandWindowId {
    /// A fresh window id.
    pub fn mint() -> Self {
        Self(UuidTextForm::from(mint_uuid_v7()))
    }

    /// Its lowercase UUID text, as the rows keep it.
    pub fn text(&self) -> UuidText {
        self.0.text()
    }

    /// Reads a stored window id back; refuses anything but the UUID text form.
    pub fn parse(text: &str) -> Result<Self, IdError> {
        UuidTextForm::new(text).map(Self)
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
    /// The provider's tool call that made an edit version, `None` on a command's, whose window
    /// names its tool call; SQLite refuses one beside a window.
    pub tool_call_id: Option<ToolCallId>,
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
    /// The before-capture's commit, `None` when it failed.
    pub commit_before: Option<GitObjectId>,
    /// The repository's common git folder the before-capture went into, `None` when it failed.
    pub git_common_dir: Option<FilesystemPath>,
    /// The folders the project ignored at the before-capture, each an absolute path; kept only
    /// when the before-capture's tree is.
    pub ignored_folders: Vec<FilesystemPath>,
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
    /// The after-capture's commit, `None` when it failed.
    pub commit_after: Option<GitObjectId>,
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
    /// A later undo cut the conversation back past the checkpoint's turn, so the history it
    /// stands in no longer exists.
    #[error("checkpoint {} lies in history a later undo cut away", .checkpoint_id.as_str())]
    Superseded {
        /// The checkpoint.
        checkpoint_id: SnapshotId,
    },
    /// SQLite failed the read, or a stored column did not read as its type.
    #[error("the checkpoint could not be read")]
    Database(#[from] rusqlite::Error),
    /// A stored rollback of the checkpoint's run does not match its contract.
    #[error(transparent)]
    Rollback(#[from] StoredRollbackMismatchError),
}

impl From<SupersededTurnsReadError> for CheckpointReadError {
    fn from(error: SupersededTurnsReadError) -> Self {
        match error {
            SupersededTurnsReadError::Database(error) => Self::Database(error),
            SupersededTurnsReadError::Rollback(error) => Self::Rollback(error),
        }
    }
}

/// A stored checkpoint member that does not read as its type; it names the member only.
#[derive(Debug, thiserror::Error)]
#[error("the stored checkpoint's {0} does not read")]
struct StoredCheckpointMemberInvalid(&'static str);

/// The checkpoint row `checkpoint` writes at its turn's start. A prompt already kept writes
/// nothing; an id already kept is refused by SQLite.
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
        ]),
        expected_row_count: None,
    }
}

/// The row of `version`, recorded in `checkpoint_id` after every version it already holds.
/// Refused by SQLite when the checkpoint, the window or the shadow has no row, or when a version
/// names both a window and a tool call.
pub fn insert_version_statement(
    checkpoint_id: &SnapshotId,
    version: &CheckpointVersion,
) -> WriteStatement {
    let (copy, not_kept_reason, shadow_id) = match &version.content {
        CheckpointVersionContent::Copy { hash, mode } => (Some((hash.as_str(), *mode)), None, None),
        CheckpointVersionContent::Created => (None, None, None),
        CheckpointVersionContent::NotKept { reason } => {
            (None, Some(<&'static str>::from(*reason)), None)
        }
        CheckpointVersionContent::Shadow { shadow_id } => (None, None, Some(shadow_id.text())),
    };
    let kind = CheckpointVersionKind::from(&version.content);
    let window_id = version.window_id.as_ref().map(CommandWindowId::text);
    let (is_executable, permissions) = match copy.map(|(_, mode)| mode) {
        Some(CopyMode::Executable(is_executable)) => (Some(i64::from(is_executable)), None),
        Some(CopyMode::Permissions(permissions)) => (None, Some(i64::from(permissions))),
        None => (None, None),
    };
    WriteStatement {
        sql: Cow::Borrowed(INSERT_VERSION_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@checkpointId", checkpoint_id.as_str()),
            text_binding("@path", version.path.as_str()),
            text_binding("@leg", version.leg.into()),
            text_binding("@kind", kind.into()),
            nullable_text_binding("@copyHash", copy.map(|(hash, _)| hash)),
            (
                Cow::Borrowed("@isExecutable"),
                SqlValue::from(is_executable),
            ),
            (Cow::Borrowed("@permissions"), SqlValue::from(permissions)),
            nullable_text_binding("@notKeptReason", not_kept_reason),
            text_binding("@parentRealPath", version.parent_real_path.as_str()),
            nullable_text_binding("@windowId", window_id.as_ref().map(UuidText::as_str)),
            nullable_text_binding("@shadowId", shadow_id.as_ref().map(UuidText::as_str)),
            nullable_text_binding(
                "@toolCallId",
                version.tool_call_id.as_ref().map(ToolCallId::as_str),
            ),
        ]),
        expected_row_count: Some(1),
    }
}

/// The open of a command window, before its command runs, its ignored folders kept as a JSON array
/// beside the before-capture's tree. Refused by SQLite when the window is already kept, its
/// checkpoint has no row, or the before-capture's tree, commit and common git folder are not all
/// present or all absent.
pub fn open_command_window_statement(opening: &CommandWindowOpening) -> WriteStatement {
    let ignored_folders = opening.tree_before.is_some().then(|| {
        serde_json::to_string(&opening.ignored_folders).expect("a list of paths writes as JSON")
    });
    WriteStatement {
        sql: Cow::Borrowed(OPEN_WINDOW_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@windowId", opening.window_id.text().as_str()),
            text_binding("@checkpointId", opening.checkpoint_id.as_str()),
            nullable_text_binding(
                "@treeBefore",
                opening.tree_before.as_ref().map(GitObjectId::as_str),
            ),
            nullable_text_binding(
                "@headBefore",
                opening.head_before.as_ref().map(GitObjectId::as_str),
            ),
            nullable_text_binding(
                "@commitBefore",
                opening.commit_before.as_ref().map(GitObjectId::as_str),
            ),
            nullable_text_binding(
                "@gitCommonDir",
                opening.git_common_dir.as_ref().map(FilesystemPath::as_str),
            ),
            nullable_text_binding("@ignoredFolders", ignored_folders.as_deref()),
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
            text_binding("@windowId", closing.window_id.text().as_str()),
            nullable_text_binding(
                "@treeAfter",
                closing.tree_after.as_ref().map(GitObjectId::as_str),
            ),
            nullable_text_binding(
                "@headAfter",
                closing.head_after.as_ref().map(GitObjectId::as_str),
            ),
            nullable_text_binding(
                "@commitAfter",
                closing.commit_after.as_ref().map(GitObjectId::as_str),
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
/// places, or the snapshot it names. `None` when the session holds no such checkpoint. The undos
/// that superseded it are read from the log as far as `read_damaged_from_sequence` lets it read.
/// Fails with [`CheckpointReadError::CursorUnresolvable`] for a cursor that names no place in the
/// log, [`CheckpointReadError::Superseded`] for a checkpoint a later undo cut away, and as SQLite
/// does or when a stored column or rollback does not read.
pub fn read_checkpoint(
    connection: &Connection,
    read_damaged_from_sequence: impl Fn(&SessionId) -> Option<i64>,
    session_id: SessionId,
    target: &SessionRestoreTarget,
) -> Result<Option<StoredCheckpoint>, CheckpointReadError> {
    let session = session_id.text();
    let checkpoint = match target {
        SessionRestoreTarget::Message { anchor_cursor } => {
            // The start of the log is no message, so no checkpoint stands there.
            let Ok(sequence) = u64::try_from(decode_event_cursor(anchor_cursor)?) else {
                return Ok(None);
            };
            let sequence =
                SafeInt::<0>::new(sequence).expect("a decoded cursor's position is a safe integer");
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
    if let Some(stored) = &checkpoint {
        let turns = read_superseded_turns(
            connection,
            read_damaged_from_sequence,
            &session_id,
            &stored.checkpoint.run_id,
        )?;
        if is_superseded(&turns, &stored.checkpoint) {
            return Err(CheckpointReadError::Superseded {
                checkpoint_id: stored.checkpoint.checkpoint_id.clone(),
            });
        }
    }
    Ok(checkpoint)
}

/// `session_id`'s checkpoints, oldest prompt first, but those a later undo cut away, read from the
/// log as far as `read_damaged_from_sequence` lets it read. Fails with the rollbacks' read error,
/// which also carries this list's own: [`SupersededTurnsReadError::Database`] when SQLite refuses
/// the checkpoints' read or a run's rollbacks' read, or a stored column does not read, and
/// [`SupersededTurnsReadError::Rollback`] when a stored rollback does not.
pub fn list_checkpoints(
    connection: &Connection,
    read_damaged_from_sequence: impl Fn(&SessionId) -> Option<i64>,
    session_id: SessionId,
) -> Result<Vec<StoredCheckpoint>, SupersededTurnsReadError> {
    let checkpoints = connection
        .prepare_cached(CHECKPOINTS_OF_SESSION_SQL)?
        .query_map(
            named_params! { "@sessionId": session_id.text().as_str() },
            stored_checkpoint_of,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut turns_by_run: HashMap<RunId, SupersededTurns> = HashMap::new();
    let mut kept = Vec::with_capacity(checkpoints.len());
    for stored in checkpoints {
        let run_id = stored.checkpoint.run_id;
        let turns = match turns_by_run.entry(run_id) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => entry.insert(read_superseded_turns(
                connection,
                &read_damaged_from_sequence,
                &session_id,
                &run_id,
            )?),
        };
        if !is_superseded(turns, &stored.checkpoint) {
            kept.push(stored);
        }
    }
    Ok(kept)
}

// Whether a rollback of the checkpoint's run cut its turn away.
fn is_superseded(turns: &SupersededTurns, checkpoint: &Checkpoint) -> bool {
    transcript_run_stamp_at(turns, checkpoint.turn)
        .superseded
        .is_some()
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
                    window_id: text_column(row, 0, |text| CommandWindowId::parse(&text))?,
                    command: row.get(1)?,
                    tool_call_id: optional_text_column(row, 2, ToolCallId::new)?,
                    started_at: text_column(row, 3, WireInstant::try_from)?,
                })
            },
        )?
        .collect()
}

/// The outcome the undo of `session_id` under `key` saved, `None` when no undo of the session used
/// it. Fails as SQLite does, or when the stored outcome does not read.
pub fn read_restore(
    connection: &Connection,
    session_id: SessionId,
    key: &ClientUuid,
) -> rusqlite::Result<Option<SessionRestoreOutcome>> {
    connection
        .prepare_cached(RESTORE_SQL)?
        .query_row(
            named_params! {
                "@key": key.as_str(),
                "@sessionId": session_id.text().as_str(),
            },
            |row| text_column(row, 0, |text| serde_json::from_str(&text)),
        )
        .optional()
}

fn integer_binding(name: &'static str, value: SafeInt<0>) -> (Cow<'static, str>, SqlValue) {
    (Cow::Borrowed(name), SqlValue::Integer(i64::from(value)))
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
        },
        created_at: text_column(row, 6, WireInstant::try_from)?,
    })
}

// Reads the columns `VERSIONS_AFTER_SQL` selects, in its order.
fn stored_version_of(row: &Row<'_>) -> rusqlite::Result<StoredCheckpointVersion> {
    let content = match text_column(row, 4, closed_word::<CheckpointVersionKind>)? {
        CheckpointVersionKind::Copy => CheckpointVersionContent::Copy {
            hash: text_column(row, 5, |text| {
                Sha256Hex::new(text).ok_or(StoredCheckpointMemberInvalid("copy hash"))
            })?,
            mode: match row.get::<_, Option<bool>>(10)? {
                Some(is_executable) => CopyMode::Executable(is_executable),
                None => CopyMode::Permissions(row.get(11)?),
            },
        },
        CheckpointVersionKind::Created => CheckpointVersionContent::Created,
        CheckpointVersionKind::NotKept => CheckpointVersionContent::NotKept {
            reason: text_column(row, 6, closed_word)?,
        },
        CheckpointVersionKind::Shadow => CheckpointVersionContent::Shadow {
            shadow_id: text_column(row, 9, |text| ShadowId::parse(&text))?,
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
            window_id: optional_text_column(row, 8, |text| CommandWindowId::parse(&text))?,
            tool_call_id: optional_text_column(row, 12, ToolCallId::new)?,
        },
    })
}

pub mod shadows;
#[cfg(test)]
mod tests;
