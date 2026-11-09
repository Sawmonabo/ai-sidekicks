//! The checkpoint rows' writes, each a statement built from plain values for the caller's own
//! write, and the reads an undo, its dry run, the command windows and the edits take: a session's
//! newest checkpoint, the paths one checkpoint holds and whether it holds one, per path the version
//! an undo puts back, the commands no capture covered and the edits whose copy failed, the windows
//! a stop left open, and a saved undo outcome by its key. The reads that leave out a checkpoint a
//! later undo cut away are in [`kept`]; the shadow rows of files over 10 MiB are in [`shadows`].
//!
//! A point is a place in the session's log: an undo goes back to before the event at
//! `before_sequence`, so every checkpoint whose prompt sits at or past it lies after the point.

use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::LazyLock;

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension as _, Row, named_params};
use sidekicks_contracts::event::envelope::{SourceEpoch, SourcePosition};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::release_manifest::Sha256Hex;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::restore::{SessionRestoreOutcome, SnapshotId};
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
    CheckpointVersionContent, CheckpointVersionKind, CheckpointVersionLeg, CopyMode, NotKeptReason,
};
use crate::checkpoints::store::shadows::ShadowId;

// A prompt already kept keeps its first checkpoint: a steer that lands again writes nothing.
static INSERT_CHECKPOINT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO session_checkpoints
  (checkpoint_id, session_id, message_sequence, run_id, turn_number, epoch, position, created_at)
  VALUES (@checkpointId, @sessionId, @messageSequence, @runId, @turnNumber, @epoch, @position,
          {DATABASE_NOW_SQL})
  ON CONFLICT (session_id, message_sequence) DO NOTHING"
    )
});

// The checkpoint at the sequence the session's log gives its next event, which is the turn start
// whose append's prelude this statement rides: that append writes no event before the start.
static INSERT_TURN_START_CHECKPOINT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO session_checkpoints
  (checkpoint_id, session_id, message_sequence, run_id, turn_number, turn_opening_id, epoch,
   position, created_at)
  VALUES (@checkpointId, @sessionId,
          COALESCE((SELECT MAX(sequence) FROM session_events WHERE session_id = @sessionId) + 1, 0),
          @runId, @turnNumber, @turnOpeningId, @epoch, @position, {DATABASE_NOW_SQL})"
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
            "SELECT checkpoint_id, session_id, message_sequence, run_id, turn_number, epoch, position,
       created_at, turn_opening_id
  FROM session_checkpoints ",
            $tail
        )
    };
}

const NEWEST_CHECKPOINT_SQL: &str =
    select_checkpoints!("WHERE session_id = @sessionId ORDER BY message_sequence DESC LIMIT 1");

// One probe of the checkpoints' prompt index.
const PROMPT_KEPT_SQL: &str = "SELECT EXISTS (SELECT 1 FROM session_checkpoints
  WHERE session_id = @sessionId AND message_sequence = @messageSequence)";

const RECORDED_PATHS_SQL: &str =
    "SELECT DISTINCT path FROM checkpoint_versions WHERE checkpoint_id = @checkpointId";

// One probe of the checkpoint's versions by path, on their index.
const HOLDS_PATH_SQL: &str = "SELECT EXISTS (SELECT 1 FROM checkpoint_versions
  WHERE checkpoint_id = @checkpointId AND path = @path)";

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

// The edits whose copy failed, named by their tool call, in the order `UNCOVERED_COMMANDS_SQL`
// keeps.
static FAILED_EDITS_SQL: LazyLock<String> = LazyLock::new(|| {
    let edit = <&'static str>::from(CheckpointVersionLeg::Edit);
    let not_kept = <&'static str>::from(CheckpointVersionKind::NotKept);
    let failed = <&'static str>::from(NotKeptReason::Failed);
    format!(
        "SELECT versions.path, versions.tool_call_id
  FROM checkpoint_versions AS versions
  JOIN session_checkpoints AS checkpoints ON checkpoints.checkpoint_id = versions.checkpoint_id
 WHERE checkpoints.session_id = @sessionId
   AND checkpoints.message_sequence >= @beforeSequence
   AND versions.leg = '{edit}' AND versions.kind = '{not_kept}'
   AND versions.not_kept_reason = '{failed}' AND versions.tool_call_id IS NOT NULL
 ORDER BY checkpoints.message_sequence, versions.sequence"
    )
});

const OPEN_WINDOWS_SQL: &str = "SELECT commands.window_id, checkpoints.session_id
  FROM checkpoint_commands AS commands
  JOIN session_checkpoints AS checkpoints ON checkpoints.checkpoint_id = commands.checkpoint_id
 WHERE commands.ended_at IS NULL
 ORDER BY commands.rowid";

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

/// A checkpoint as a turn's start or a steer's landing records it: the point before one of the
/// person's prompts, or before a turn no new message of the person's opened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checkpoint {
    /// The checkpoint, by the snapshot id a client names it with.
    pub checkpoint_id: SnapshotId,
    /// Its session.
    pub session_id: SessionId,
    /// The prompt's sequence in the session's log, or the turn start's own for a turn no new
    /// message of the person's opened.
    pub message_sequence: SafeInt<0>,
    /// The run the prompt opened or steered a turn of.
    pub run_id: RunId,
    /// That turn's number on the run, which never repeats.
    pub turn_number: SafeInt<1>,
    /// The run's execution epoch and the prompt's run position in it.
    pub turn: EpochPosition,
}

/// A checkpoint as its row holds it, with when it was recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredCheckpoint {
    /// The checkpoint.
    pub checkpoint: Checkpoint,
    /// When it was recorded.
    pub created_at: WireInstant,
    /// The queue item the start of a turn no new message of the person's opened was opened with:
    /// a review, or a message an earlier turn already sent. `None` on a prompt's checkpoint, whose
    /// own sent message names its queue item, and on a turn no queue item opened.
    pub turn_opening_id: Option<QueueItemId>,
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
    /// The session's newest checkpoint when the command runs: its turn's opening or a later steer.
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

/// An edit whose copy failed before its write, which a dry run names among the uncovered by its
/// tool call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FailedEdit {
    /// The file the edit wrote.
    pub path: FilesystemPath,
    /// The provider's tool call that made the edit.
    pub tool_call_id: ToolCallId,
}

/// A stored checkpoint member that does not read as its type; it names the member only.
#[derive(Debug, thiserror::Error)]
#[error("the stored checkpoint's {0} does not read")]
struct StoredCheckpointMemberInvalid(&'static str);

/// The checkpoint row `checkpoint` writes at its turn's start or its steer's landing. A prompt
/// already kept writes nothing; an id already kept is refused by SQLite.
pub fn insert_checkpoint_statement(checkpoint: &Checkpoint) -> WriteStatement {
    let mut bindings = checkpoint_bindings(
        &checkpoint.checkpoint_id,
        checkpoint.session_id,
        checkpoint.run_id,
        checkpoint.turn_number,
        checkpoint.turn,
    );
    bindings.push(integer_binding(
        "@messageSequence",
        checkpoint.message_sequence,
    ));
    WriteStatement {
        sql: Cow::Borrowed(INSERT_CHECKPOINT_SQL.as_str()),
        bindings: StatementBindings::Named(bindings),
        expected_row_count: None,
    }
}

/// The checkpoint row the start of `turn_number` of `run_id`, standing at `turn` and opened with
/// the queue item `opening` where one opened it, writes in its own append's prelude where no new
/// message of the person's opened the turn, at the start's own sequence. Only that prelude may
/// carry it: an event written before the start in the same append would take the sequence it
/// names.
pub(crate) fn insert_turn_start_checkpoint_statement(
    checkpoint_id: &SnapshotId,
    session_id: SessionId,
    run_id: RunId,
    turn_number: SafeInt<1>,
    turn: EpochPosition,
    opening: Option<QueueItemId>,
) -> WriteStatement {
    let mut bindings = checkpoint_bindings(checkpoint_id, session_id, run_id, turn_number, turn);
    bindings.push(nullable_text_binding(
        "@turnOpeningId",
        opening.map(|opening| opening.to_string()).as_deref(),
    ));
    WriteStatement {
        sql: Cow::Borrowed(INSERT_TURN_START_CHECKPOINT_SQL.as_str()),
        bindings: StatementBindings::Named(bindings),
        expected_row_count: Some(1),
    }
}

// The bindings every checkpoint row's insert takes but its prompt's sequence.
fn checkpoint_bindings(
    checkpoint_id: &SnapshotId,
    session_id: SessionId,
    run_id: RunId,
    turn_number: SafeInt<1>,
    turn: EpochPosition,
) -> Vec<(Cow<'static, str>, SqlValue)> {
    vec![
        text_binding("@checkpointId", checkpoint_id.as_str()),
        text_binding("@sessionId", session_id.text().as_str()),
        text_binding("@runId", run_id.text().as_str()),
        integer_binding("@turnNumber", turn_number),
        integer_binding("@epoch", turn.epoch.0),
        integer_binding("@position", turn.position.0),
    ]
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

/// The edits of `session_id` in the checkpoints at or past the log event at `before_sequence` whose
/// copy failed, each by its tool call, oldest first. Fails as SQLite does, or when a stored column
/// does not read.
pub fn failed_edits(
    connection: &Connection,
    session_id: SessionId,
    before_sequence: SafeInt<0>,
) -> rusqlite::Result<Vec<FailedEdit>> {
    connection
        .prepare_cached(FAILED_EDITS_SQL.as_str())?
        .query_map(
            named_params! {
                "@sessionId": session_id.text().as_str(),
                "@beforeSequence": i64::from(before_sequence),
            },
            |row| {
                Ok(FailedEdit {
                    path: text_column(row, 0, FilesystemPath::new)?,
                    tool_call_id: text_column(row, 1, ToolCallId::new)?,
                })
            },
        )?
        .collect()
}

/// `session_id`'s checkpoint of its newest prompt, `None` when it holds none. Fails as SQLite does,
/// or when a stored column does not read.
pub fn newest_checkpoint(
    connection: &Connection,
    session_id: SessionId,
) -> rusqlite::Result<Option<StoredCheckpoint>> {
    connection
        .prepare_cached(NEWEST_CHECKPOINT_SQL)?
        .query_row(
            named_params! { "@sessionId": session_id.text().as_str() },
            stored_checkpoint_of,
        )
        .optional()
}

/// Whether a checkpoint of `session_id`, standing or cut away, holds the prompt at
/// `message_sequence`. Fails as SQLite does.
pub(crate) fn is_prompt_kept(
    connection: &Connection,
    session_id: SessionId,
    message_sequence: SafeInt<0>,
) -> rusqlite::Result<bool> {
    connection.prepare_cached(PROMPT_KEPT_SQL)?.query_row(
        named_params! {
            "@sessionId": session_id.text().as_str(),
            "@messageSequence": i64::from(message_sequence),
        },
        |row| row.get(0),
    )
}

/// Every path a version of `checkpoint_id` names. Fails as SQLite does, or when a stored path does
/// not read.
pub fn recorded_paths(
    connection: &Connection,
    checkpoint_id: &SnapshotId,
) -> rusqlite::Result<HashSet<FilesystemPath>> {
    connection
        .prepare_cached(RECORDED_PATHS_SQL)?
        .query_map(
            named_params! { "@checkpointId": checkpoint_id.as_str() },
            |row| text_column(row, 0, FilesystemPath::new),
        )?
        .collect()
}

/// Whether a version of `checkpoint_id` names `path`. Fails as SQLite does.
pub fn holds_path(
    connection: &Connection,
    checkpoint_id: &SnapshotId,
    path: &FilesystemPath,
) -> rusqlite::Result<bool> {
    connection.prepare_cached(HOLDS_PATH_SQL)?.query_row(
        named_params! {
            "@checkpointId": checkpoint_id.as_str(),
            "@path": path.as_str(),
        },
        |row| row.get(0),
    )
}

/// Every command window still open, with its checkpoint's session: the windows a stop left open,
/// which the next start settles. Fails as SQLite does, or when a stored column does not read.
pub fn open_windows(
    connection: &Connection,
) -> rusqlite::Result<Vec<(CommandWindowId, SessionId)>> {
    connection
        .prepare_cached(OPEN_WINDOWS_SQL)?
        .query_map([], |row| {
            Ok((
                text_column(row, 0, |text| CommandWindowId::parse(&text))?,
                text_column(row, 1, |text| SessionId::new(&text))?,
            ))
        })?
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

fn integer_binding<const MIN: u64>(
    name: &'static str,
    value: SafeInt<MIN>,
) -> (Cow<'static, str>, SqlValue) {
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
            turn_number: safe_int_column(row, 4)?,
            turn: EpochPosition {
                epoch: SourceEpoch(safe_int_column(row, 5)?),
                position: SourcePosition(safe_int_column(row, 6)?),
            },
        },
        created_at: text_column(row, 7, WireInstant::try_from)?,
        turn_opening_id: optional_text_column(row, 8, |text| QueueItemId::new(&text))?,
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

pub mod kept;
pub mod shadows;
#[cfg(test)]
pub(crate) mod tests;
