//! The checkpoint store's tests: the version an undo puts back per path, each kind of version as
//! recorded, a window's repository and ignored folders, the newest checkpoint and one checkpoint's
//! paths, the open windows and the failed edits, a path's one current shadow and the shadows a
//! window stands on, the delete of an unused shadow, a session's volume folders, and an undo's
//! outcome saved once under its key.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use rusqlite::ffi;
use sidekicks_contracts::event::envelope::{SourceEpoch, SourcePosition};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::release_manifest::Sha256Hex;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::restore::{
    SessionRestoreFileOutcome, SessionRestoreOutcome, SessionRestoreScope, SessionRestoredScope,
    SnapshotId,
};
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_platforms::{EntryIdentity, FileFacts, VolumeId};
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions, WriteError};

use super::shadows::{
    Shadow, ShadowContent, ShadowId, VolumeFolder, current_shadows, delete_unused_shadow_statement,
    every_volume_folder, insert_current_shadow_statement, insert_volume_folder_statement,
    link_window_shadow_statement, retire_current_shadow_statement, unlink_window_shadows_statement,
    unused_shadows, volume_folders, window_shadows,
};
use super::{
    Checkpoint, CheckpointVersion, CommandWindowClosing, CommandWindowId, CommandWindowOpening,
    FailedEdit, close_command_window_statement, failed_edits, insert_checkpoint_statement,
    insert_restore_statement, insert_version_statement, newest_checkpoint,
    open_command_window_statement, open_windows, read_restore, recorded_paths, versions_after,
};
use crate::checkpoints::schema::{
    CheckpointVersionContent, CheckpointVersionLeg, CopyMode, NotKeptReason, schema_parts,
};

/// A database on the checkpoint schema, the writer every write of the test goes through, which
/// holds the schema's references, and the session and run its checkpoints name.
pub(crate) struct Fixture {
    /// The database file.
    pub(crate) database: TestDatabase,
    /// The writer of every write.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The session the checkpoints name.
    pub(crate) session_id: SessionId,
    run_id: RunId,
}

impl Fixture {
    /// A fresh database with its writer open, and a session and run of its own.
    pub(crate) async fn new() -> Self {
        let database = TestDatabase::new(schema_parts());
        let writer = Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens its database"),
        );
        let session_id = test_session_id();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        Self {
            database,
            writer,
            session_id,
            run_id,
        }
    }

    /// A checkpoint of the fixture's run before the prompt at `message_sequence`.
    pub(crate) fn checkpoint(&self, message_sequence: u64) -> Checkpoint {
        Checkpoint {
            checkpoint_id: SnapshotId::new(mint_uuid_v7().to_string()).expect("a snapshot id"),
            session_id: self.session_id,
            message_sequence: sequence(message_sequence),
            run_id: self.run_id,
            turn_number: SafeInt::new(1).expect("a turn number"),
            turn: EpochPosition {
                epoch: SourceEpoch(SafeInt::ZERO),
                position: SourcePosition(sequence(message_sequence)),
            },
        }
    }

    /// Writes a checkpoint before the prompt at `message_sequence` holding `versions`, in order,
    /// and returns its id.
    pub(crate) async fn record(
        &self,
        message_sequence: u64,
        versions: &[CheckpointVersion],
    ) -> SnapshotId {
        self.record_after(Vec::new(), message_sequence, versions)
            .await
    }

    /// Writes `first`, then a checkpoint as [`Fixture::record`] does, in one write.
    async fn record_after(
        &self,
        first: Vec<WriteStatement>,
        message_sequence: u64,
        versions: &[CheckpointVersion],
    ) -> SnapshotId {
        let checkpoint = self.checkpoint(message_sequence);
        let mut statements = first;
        statements.push(insert_checkpoint_statement(&checkpoint));
        statements.extend(
            versions
                .iter()
                .map(|version| insert_version_statement(&checkpoint.checkpoint_id, version)),
        );
        self.writer
            .write(statements)
            .await
            .expect("the checkpoint is written");
        checkpoint.checkpoint_id
    }
}

fn sequence(value: u64) -> SafeInt<0> {
    SafeInt::new(value).expect("a test sequence is a safe integer")
}

/// An edit's version of `path` with `content`.
fn version(path: &str, content: CheckpointVersionContent) -> CheckpointVersion {
    CheckpointVersion {
        path: FilesystemPath::new(path.to_owned()).expect("a test path"),
        leg: CheckpointVersionLeg::Edit,
        content,
        parent_real_path: FilesystemPath::new("/repo".to_owned()).expect("a test path"),
        window_id: None,
        tool_call_id: None,
    }
}

/// A command window of `checkpoint_id` whose before-capture failed.
fn uncaptured_window(
    window_id: CommandWindowId,
    checkpoint_id: &SnapshotId,
) -> CommandWindowOpening {
    CommandWindowOpening {
        window_id,
        checkpoint_id: checkpoint_id.clone(),
        tree_before: None,
        head_before: None,
        commit_before: None,
        git_common_dir: None,
        ignored_folders: Vec::new(),
        command: "make".to_owned(),
        tool_call_id: None,
    }
}

fn test_path(path: &str) -> FilesystemPath {
    FilesystemPath::new(path.to_owned()).expect("a test path")
}

fn tool_call(id: &str) -> ToolCallId {
    ToolCallId::new(id.to_owned()).expect("a test tool call id")
}

/// A current shadow of `path` in `session_id` holding `content` and `facts`.
fn shadow(
    session_id: SessionId,
    path: &str,
    content: ShadowContent,
    facts: Option<FileFacts>,
) -> Shadow {
    Shadow {
        shadow_id: ShadowId::mint(),
        session_id,
        path: FilesystemPath::new(path.to_owned()).expect("a test path"),
        content,
        facts,
        taken_at: jiff::Timestamp::from_nanosecond(1_790_000_000_123_456_789)
            .expect("a test instant"),
        time_precision: Duration::from_nanos(1_000),
    }
}

/// A shadow kept without a clone because its read failed.
fn failed() -> ShadowContent {
    ShadowContent::NotKept {
        reason: NotKeptReason::Failed,
    }
}

/// A copy whose hash is `digit` repeated, put back with `mode`.
fn copy(digit: char, mode: CopyMode) -> CheckpointVersionContent {
    CheckpointVersionContent::Copy {
        hash: Sha256Hex::new(digit.to_string().repeat(64)).expect("a test hash"),
        mode,
    }
}

/// The SQLite extended code a write SQLite failed at a statement carries.
fn extended_code(error: &WriteError) -> Option<i32> {
    error
        .failed_statement()
        .and_then(|(_, failure)| failure.sqlite_error())
        .map(|failure| failure.extended_code)
}

#[tokio::test]
async fn an_undo_puts_back_the_earliest_version_after_the_point() {
    let fixture = Fixture::new().await;
    fixture
        .record(
            2,
            &[version(
                "/repo/a.txt",
                copy('a', CopyMode::Executable(false)),
            )],
        )
        .await;
    let second = fixture
        .record(
            6,
            &[version(
                "/repo/a.txt",
                copy('b', CopyMode::Executable(false)),
            )],
        )
        .await;
    fixture
        .record(
            10,
            &[version(
                "/repo/a.txt",
                copy('c', CopyMode::Executable(false)),
            )],
        )
        .await;
    let reader = fixture.database.reader();

    // A point inside the first prompt's turn, and a point just before the second prompt.
    for before_sequence in [3, 6] {
        let versions = versions_after(
            &reader,
            fixture.session_id,
            &fixture.checkpoint(before_sequence),
        )
        .expect("the versions read");
        assert_eq!(versions.len(), 1, "one version per path");
        assert_eq!(versions[0].checkpoint_id, second);
        assert_eq!(
            versions[0].version.content,
            copy('b', CopyMode::Executable(false))
        );
    }
}

// Kills: a reason or kind word mapped to another, the shadow id, either mode column or the tool
// call dropped on write or read, and the CHECK that keeps a tool call off a command's version.
#[tokio::test]
async fn each_kind_of_version_comes_back_as_recorded() {
    let fixture = Fixture::new().await;
    let large = shadow(fixture.session_id, "/repo/large.bin", failed(), None);
    let not_kept = |reason| CheckpointVersionContent::NotKept { reason };
    let recorded = [
        ("/repo/executable.sh", copy('a', CopyMode::Executable(true))),
        ("/repo/failed.bin", not_kept(NotKeptReason::Failed)),
        (
            "/repo/large.bin",
            CheckpointVersionContent::Shadow {
                shadow_id: large.shadow_id,
            },
        ),
        ("/repo/link", not_kept(NotKeptReason::SymbolicLink)),
        ("/repo/new.txt", CheckpointVersionContent::Created),
        (
            "/repo/no-place.bin",
            not_kept(NotKeptReason::NoPlaceOnVolume),
        ),
        ("/repo/pipe", not_kept(NotKeptReason::NotARegularFile)),
        ("/repo/private.txt", copy('b', CopyMode::Permissions(0o640))),
        ("/repo/too-large.bin", not_kept(NotKeptReason::TooLarge)),
    ];
    let mut versions: Vec<_> = recorded
        .iter()
        .map(|(path, content)| version(path, content.clone()))
        .collect();
    // The edit whose copy failed names its tool call.
    versions[1].tool_call_id = Some(tool_call("call-failed"));
    fixture
        .record_after(vec![insert_current_shadow_statement(&large)], 2, &versions)
        .await;

    let read = versions_after(
        &fixture.database.reader(),
        fixture.session_id,
        &fixture.checkpoint(0),
    )
    .expect("the versions read");
    let read: Vec<_> = read.into_iter().map(|stored| stored.version).collect();
    assert_eq!(read, versions);

    let window_id = CommandWindowId::mint();
    let checkpoint = fixture.checkpoint(4);
    let command_version = CheckpointVersion {
        leg: CheckpointVersionLeg::Command,
        window_id: Some(window_id),
        tool_call_id: Some(tool_call("call-command")),
        ..version("/repo/built.txt", CheckpointVersionContent::Created)
    };
    let refusal = fixture
        .writer
        .write(vec![
            insert_checkpoint_statement(&checkpoint),
            open_command_window_statement(&uncaptured_window(window_id, &checkpoint.checkpoint_id)),
            insert_version_statement(&checkpoint.checkpoint_id, &command_version),
        ])
        .await
        .expect_err("a command's version naming a tool call is refused");
    assert_eq!(refusal.failed_statement().map(|(index, _)| index), Some(2));
    assert_eq!(extended_code(&refusal), Some(ffi::SQLITE_CONSTRAINT_CHECK));
}

// Kills: the CHECK that ties the repository and the ignored folders to the before-capture dropped,
// and the folders not bound or bound as anything but their JSON array.
#[tokio::test]
async fn a_window_names_its_repository_exactly_when_its_before_capture_was_taken() {
    let fixture = Fixture::new().await;
    let checkpoint = fixture.checkpoint(2);
    let object = |digit: &str| GitObjectId::new(digit.repeat(40)).expect("a test object id");
    let captured_id = CommandWindowId::mint();
    let uncaptured_id = CommandWindowId::mint();
    let captured = CommandWindowOpening {
        tree_before: Some(object("a")),
        commit_before: Some(object("b")),
        git_common_dir: Some(test_path("/repo/.git")),
        ignored_folders: vec![test_path("/repo/node_modules"), test_path("/repo/target")],
        ..uncaptured_window(captured_id, &checkpoint.checkpoint_id)
    };
    fixture
        .writer
        .write(vec![
            insert_checkpoint_statement(&checkpoint),
            open_command_window_statement(&captured),
            open_command_window_statement(&uncaptured_window(
                uncaptured_id,
                &checkpoint.checkpoint_id,
            )),
        ])
        .await
        .expect("both windows are written");

    let reader = fixture.database.reader();
    let read = |window_id: CommandWindowId| -> (Option<String>, Option<String>) {
        reader
            .query_row(
                "SELECT git_common_dir, ignored_folders FROM checkpoint_commands
                  WHERE window_id = ?1",
                [window_id.text().as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the window reads")
    };
    assert_eq!(
        read(captured_id),
        (
            Some("/repo/.git".to_owned()),
            Some(r#"["/repo/node_modules","/repo/target"]"#.to_owned())
        )
    );
    assert_eq!(read(uncaptured_id), (None, None));

    let half = CommandWindowOpening {
        git_common_dir: Some(test_path("/repo/.git")),
        ..uncaptured_window(CommandWindowId::mint(), &checkpoint.checkpoint_id)
    };
    let refusal = fixture
        .writer
        .write(vec![open_command_window_statement(&half)])
        .await
        .expect_err("a repository without the before-capture's tree is refused");
    assert_eq!(extended_code(&refusal), Some(ffi::SQLITE_CONSTRAINT_CHECK));
}

// Kills: the partial unique index dropped, the retire matching another session, facts that are
// `None` stored as zeros (a failed read compared as unchanged), the volume id or time precision
// dropped, and an unlink that removes nothing.
#[tokio::test]
async fn a_path_keeps_one_current_shadow_and_an_open_window_the_one_it_linked() {
    let fixture = Fixture::new().await;
    let other_session = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    let path = "/repo/large.bin";
    let first = shadow(
        fixture.session_id,
        path,
        ShadowContent::Cloned {
            clone_path: FilesystemPath::new("/volume/.ai-sidekicks-501/session/clone".to_owned())
                .expect("a test path"),
            volume_id: Some("0A1B2C3D-volume".parse::<VolumeId>().expect("a volume id")),
        },
        Some(FileFacts {
            identity: "16777232:4242"
                .parse::<EntryIdentity>()
                .expect("an identity"),
            size: 11 * 1024 * 1024,
            link_count: 1,
            modified: 1_789_999_999_000_000_001,
            changed: 1_789_999_999_500_000_002,
        }),
    );
    let others = shadow(other_session, path, failed(), None);
    let window_id = CommandWindowId::mint();
    let checkpoint = fixture.checkpoint(2);
    fixture
        .writer
        .write(vec![
            insert_checkpoint_statement(&checkpoint),
            open_command_window_statement(&CommandWindowOpening {
                command: "make large.bin".to_owned(),
                ..uncaptured_window(window_id, &checkpoint.checkpoint_id)
            }),
            insert_current_shadow_statement(&first),
            insert_current_shadow_statement(&others),
            link_window_shadow_statement(window_id, first.shadow_id),
        ])
        .await
        .expect("the window and its shadows are written");

    let second_current = shadow(fixture.session_id, path, failed(), None);
    let refusal = fixture
        .writer
        .write(vec![insert_current_shadow_statement(&second_current)])
        .await
        .expect_err("a second current shadow of the path is refused");
    assert_eq!(extended_code(&refusal), Some(ffi::SQLITE_CONSTRAINT_UNIQUE));

    let second = shadow(fixture.session_id, path, failed(), None);
    fixture
        .writer
        .write(vec![
            retire_current_shadow_statement(fixture.session_id, &first.path),
            insert_current_shadow_statement(&second),
        ])
        .await
        .expect("the retire lets a new shadow be current");

    let reader = fixture.database.reader();
    assert_eq!(
        current_shadows(&reader, fixture.session_id).expect("the shadows read"),
        [second]
    );
    assert_eq!(
        current_shadows(&reader, other_session).expect("the shadows read"),
        [others],
        "another session's shadow of the path stays current"
    );
    assert_eq!(
        window_shadows(&reader, window_id).expect("the window's shadows read"),
        [first],
        "the window keeps the shadow it stood on, as recorded"
    );

    fixture
        .writer
        .write(vec![unlink_window_shadows_statement(window_id)])
        .await
        .expect("the window's links are removed");
    assert!(
        window_shadows(&reader, window_id)
            .expect("the window's shadows read")
            .is_empty(),
        "the window's links are gone"
    );
}

// Kills: the oldest checkpoint answered for the newest, another session's answered, and a path set
// read across the session rather than from the one checkpoint.
#[tokio::test]
async fn the_newest_checkpoint_and_one_checkpoints_paths() {
    let fixture = Fixture::new().await;
    let created = |path| version(path, CheckpointVersionContent::Created);
    fixture.record(2, &[created("/repo/a.txt")]).await;
    fixture.record(6, &[created("/repo/b.txt")]).await;
    let newest = fixture
        .record(
            10,
            &[
                created("/repo/a.txt"),
                created("/repo/c.txt"),
                created("/repo/c.txt"),
            ],
        )
        .await;
    let other_session = Checkpoint {
        session_id: SessionId::try_from(mint_uuid_v7()).expect("a session id"),
        ..fixture.checkpoint(20)
    };
    fixture
        .writer
        .write(vec![insert_checkpoint_statement(&other_session)])
        .await
        .expect("another session's checkpoint is written");

    let reader = fixture.database.reader();
    let read = newest_checkpoint(&reader, fixture.session_id)
        .expect("the newest checkpoint reads")
        .expect("the session holds checkpoints");
    assert_eq!(read.checkpoint.checkpoint_id, newest);
    assert_eq!(
        recorded_paths(&reader, &newest).expect("the paths read"),
        HashSet::from([test_path("/repo/a.txt"), test_path("/repo/c.txt")])
    );
}

// Kills: any of the delete's three guards or the read's dropped, and the retire left writing
// nothing when the path has no current shadow.
#[tokio::test]
async fn a_retired_shadow_is_deleted_only_while_nothing_uses_it() {
    let fixture = Fixture::new().await;
    let checkpoint = fixture.checkpoint(2);
    let window_id = CommandWindowId::mint();
    let current = shadow(fixture.session_id, "/repo/current.bin", failed(), None);
    let linked = shadow(fixture.session_id, "/repo/linked.bin", failed(), None);
    let versioned = shadow(fixture.session_id, "/repo/versioned.bin", failed(), None);
    let unused = shadow(fixture.session_id, "/repo/unused.bin", failed(), None);
    let versioned_version = version(
        "/repo/versioned.bin",
        CheckpointVersionContent::Shadow {
            shadow_id: versioned.shadow_id,
        },
    );
    let mut statements = vec![
        insert_checkpoint_statement(&checkpoint),
        open_command_window_statement(&uncaptured_window(window_id, &checkpoint.checkpoint_id)),
    ];
    statements.extend(
        [&current, &linked, &versioned, &unused]
            .into_iter()
            .map(insert_current_shadow_statement),
    );
    statements.push(link_window_shadow_statement(window_id, linked.shadow_id));
    statements.push(insert_version_statement(
        &checkpoint.checkpoint_id,
        &versioned_version,
    ));
    statements.extend(
        [&linked, &versioned, &unused]
            .into_iter()
            .map(|retired| retire_current_shadow_statement(fixture.session_id, &retired.path)),
    );
    fixture
        .writer
        .write(statements)
        .await
        .expect("the shadows are written and three retired");

    let reader = fixture.database.reader();
    assert_eq!(
        unused_shadows(&reader, fixture.session_id).expect("the unused shadows read"),
        std::slice::from_ref(&unused)
    );
    for used in [&current, &linked, &versioned] {
        let refusal = fixture
            .writer
            .write(vec![delete_unused_shadow_statement(used.shadow_id)])
            .await
            .expect_err("a shadow still in use is not deleted");
        assert_eq!(
            refusal.refused_statement_index(),
            Some(0),
            "{}",
            used.path.as_str()
        );
    }
    fixture
        .writer
        .write(vec![delete_unused_shadow_statement(unused.shadow_id)])
        .await
        .expect("the unused shadow is deleted");
    assert_eq!(
        unused_shadows(&reader, fixture.session_id).expect("the unused shadows read"),
        Vec::<Shadow>::new()
    );

    let refusal = fixture
        .writer
        .write(vec![retire_current_shadow_statement(
            fixture.session_id,
            &test_path("/repo/never-shadowed.bin"),
        )])
        .await
        .expect_err("a retire with no current shadow is refused");
    assert_eq!(refusal.refused_statement_index(), Some(0));
}

// Kills: a closed window listed as open, and a command's version, another kind or reason, an edit
// with no tool call or a checkpoint before the point listed among the failed edits.
#[tokio::test]
async fn open_windows_and_failed_edits_read_what_they_name() {
    let fixture = Fixture::new().await;
    let failed_edit = |path, id| CheckpointVersion {
        tool_call_id: Some(tool_call(id)),
        ..version(
            path,
            CheckpointVersionContent::NotKept {
                reason: NotKeptReason::Failed,
            },
        )
    };
    fixture
        .record(2, &[failed_edit("/repo/early.txt", "call-early")])
        .await;

    let checkpoint = fixture.checkpoint(6);
    let open_id = CommandWindowId::mint();
    let closed_id = CommandWindowId::mint();
    let versions = [
        failed_edit("/repo/late.txt", "call-late"),
        CheckpointVersion {
            leg: CheckpointVersionLeg::Command,
            window_id: Some(closed_id),
            ..version(
                "/repo/built.txt",
                CheckpointVersionContent::NotKept {
                    reason: NotKeptReason::Failed,
                },
            )
        },
        CheckpointVersion {
            content: CheckpointVersionContent::NotKept {
                reason: NotKeptReason::TooLarge,
            },
            ..failed_edit("/repo/large.bin", "call-large")
        },
        CheckpointVersion {
            content: CheckpointVersionContent::Created,
            ..failed_edit("/repo/new.txt", "call-new")
        },
        version(
            "/repo/unnamed.txt",
            CheckpointVersionContent::NotKept {
                reason: NotKeptReason::Failed,
            },
        ),
    ];
    let mut statements = vec![
        insert_checkpoint_statement(&checkpoint),
        open_command_window_statement(&uncaptured_window(open_id, &checkpoint.checkpoint_id)),
        open_command_window_statement(&uncaptured_window(closed_id, &checkpoint.checkpoint_id)),
        close_command_window_statement(&CommandWindowClosing {
            window_id: closed_id,
            tree_after: None,
            head_after: None,
            commit_after: None,
            is_covered: false,
        }),
    ];
    statements.extend(
        versions
            .iter()
            .map(|version| insert_version_statement(&checkpoint.checkpoint_id, version)),
    );
    fixture
        .writer
        .write(statements)
        .await
        .expect("the windows and versions are written");

    let reader = fixture.database.reader();
    assert_eq!(
        open_windows(&reader).expect("the open windows read"),
        [(open_id, fixture.session_id)]
    );
    assert_eq!(
        failed_edits(&reader, fixture.session_id, &fixture.checkpoint(3))
            .expect("the failed edits read"),
        [FailedEdit {
            path: test_path("/repo/late.txt"),
            tool_call_id: tool_call("call-late"),
        }]
    );
}

// Kills: a missing `ON CONFLICT`, the session filter dropped, and every session's read filtered to
// one session.
#[tokio::test]
async fn a_volume_folder_is_kept_once_per_session() {
    let fixture = Fixture::new().await;
    let other_session = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    let folder = |name: &str| VolumeFolder {
        volume_id: "0A1B2C3D-volume".parse::<VolumeId>().expect("a volume id"),
        folder: FilesystemPath::new(format!("/volume/.ai-sidekicks-501/{name}"))
            .expect("a test path"),
    };
    let own = folder("own");
    let other = folder("other");
    for _ in 0..2 {
        fixture
            .writer
            .write(vec![insert_volume_folder_statement(
                fixture.session_id,
                &own,
            )])
            .await
            .expect("a folder already kept writes nothing and is no error");
    }
    fixture
        .writer
        .write(vec![insert_volume_folder_statement(other_session, &other)])
        .await
        .expect("another session's folder is written");

    let reader = fixture.database.reader();
    assert_eq!(
        volume_folders(&reader, fixture.session_id).expect("the folders read"),
        std::slice::from_ref(&own)
    );
    let mut every = vec![(fixture.session_id, own), (other_session, other)];
    every.sort_by(|left, right| left.0.text().as_str().cmp(right.0.text().as_str()));
    assert_eq!(
        every_volume_folder(&reader).expect("every session's folders read"),
        every
    );
}

// Kills a second outcome under a key overwriting the first, the read by key alone, which hands
// one session the outcome another session's undo saved, and the table keyed on the key alone, which
// refuses another session's outcome under the same key.
#[tokio::test]
async fn an_undo_outcome_is_saved_once_under_its_key() {
    let fixture = Fixture::new().await;
    let key = ClientUuid::new(mint_uuid_v7().to_string()).expect("a client key");
    let first = SessionRestoreOutcome::RestoreFinished {
        requested: SessionRestoreScope::Files,
        restored: SessionRestoredScope::Files,
        files: Some(SessionRestoreFileOutcome {
            restored_file_count: sequence(2),
            restored_line_count: sequence(14),
            skipped: Vec::new(),
        }),
        failures: None,
    };
    let second = SessionRestoreOutcome::RestoreFinished {
        requested: SessionRestoreScope::Conversation,
        restored: SessionRestoredScope::Conversation,
        files: None,
        failures: None,
    };
    fixture
        .writer
        .write(vec![insert_restore_statement(
            &key,
            fixture.session_id,
            &first,
        )])
        .await
        .expect("the first outcome is saved");

    let refusal = fixture
        .writer
        .write(vec![insert_restore_statement(
            &key,
            fixture.session_id,
            &second,
        )])
        .await
        .expect_err("a second outcome under the key is refused");
    assert_eq!(
        extended_code(&refusal),
        Some(ffi::SQLITE_CONSTRAINT_PRIMARYKEY)
    );
    let reader = fixture.database.reader();
    let other_session = test_session_id();
    assert_eq!(
        read_restore(&reader, fixture.session_id, &key).expect("the outcome reads"),
        Some(first.clone())
    );
    assert_eq!(
        read_restore(&reader, other_session, &key).expect("the outcome reads"),
        None
    );

    fixture
        .writer
        .write(vec![insert_restore_statement(&key, other_session, &second)])
        .await
        .expect("another session's outcome under the same key is saved");
    assert_eq!(
        read_restore(&reader, other_session, &key).expect("the outcome reads"),
        Some(second)
    );
    assert_eq!(
        read_restore(&reader, fixture.session_id, &key).expect("the outcome reads"),
        Some(first)
    );
}
