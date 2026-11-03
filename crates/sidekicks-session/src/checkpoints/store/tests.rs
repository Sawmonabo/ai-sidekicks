//! The checkpoint store's tests: the version an undo puts back per path, each kind of version as
//! recorded, a path's one current shadow and the shadows a window stands on, a session's volume
//! folders, and an undo's outcome saved once under its key.

use std::time::Duration;

use rusqlite::ffi;
use sidekicks_contracts::event::envelope::{SourceEpoch, SourcePosition};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::release_manifest::Sha256Hex;
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
    Shadow, ShadowContent, ShadowId, VolumeFolder, current_shadows,
    insert_current_shadow_statement, insert_volume_folder_statement, link_window_shadow_statement,
    retire_current_shadow_statement, unlink_window_shadows_statement, volume_folders,
    window_shadows,
};
use super::{
    Checkpoint, CheckpointVersion, CommandWindowId, CommandWindowOpening,
    insert_checkpoint_statement, insert_restore_statement, insert_version_statement,
    open_command_window_statement, read_restore, versions_after,
};
use crate::checkpoints::schema::{
    CheckpointVersionContent, CheckpointVersionLeg, NotKeptReason, schema_parts,
};

/// A database on the checkpoint schema, the writer every write of the test goes through, which
/// holds the schema's references, and the session and run its checkpoints name.
struct Fixture {
    database: TestDatabase,
    writer: DatabaseWriter,
    session_id: SessionId,
    run_id: RunId,
}

impl Fixture {
    async fn new() -> Self {
        let database = TestDatabase::new(schema_parts());
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
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
    fn checkpoint(&self, message_sequence: u64) -> Checkpoint {
        Checkpoint {
            checkpoint_id: SnapshotId::new(mint_uuid_v7().to_string()).expect("a snapshot id"),
            session_id: self.session_id,
            message_sequence: sequence(message_sequence),
            run_id: self.run_id,
            turn: EpochPosition {
                epoch: SourceEpoch(SafeInt::ZERO),
                position: SourcePosition(sequence(message_sequence)),
            },
        }
    }

    /// Writes a checkpoint before the prompt at `message_sequence` holding `versions`, in order,
    /// and returns its id.
    async fn record(&self, message_sequence: u64, versions: &[CheckpointVersion]) -> SnapshotId {
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
    }
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

/// A copy whose hash is `digit` repeated.
fn copy(digit: char) -> CheckpointVersionContent {
    CheckpointVersionContent::Copy {
        hash: Sha256Hex::new(digit.to_string().repeat(64)).expect("a test hash"),
        mode: 0o755,
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
        .record(2, &[version("/repo/a.txt", copy('a'))])
        .await;
    let second = fixture
        .record(6, &[version("/repo/a.txt", copy('b'))])
        .await;
    fixture
        .record(10, &[version("/repo/a.txt", copy('c'))])
        .await;
    let reader = fixture.database.reader();

    // A point inside the first prompt's turn, and a point just before the second prompt.
    for before_sequence in [3, 6] {
        let versions = versions_after(&reader, fixture.session_id, sequence(before_sequence))
            .expect("the versions read");
        assert_eq!(versions.len(), 1, "one version per path");
        assert_eq!(versions[0].checkpoint_id, second);
        assert_eq!(versions[0].version.content, copy('b'));
    }
}

// Kills: a reason or kind word mapped to another, and the shadow id or a copy's mode dropped on
// write or read.
#[tokio::test]
async fn each_kind_of_version_comes_back_as_recorded() {
    let fixture = Fixture::new().await;
    let large = shadow(fixture.session_id, "/repo/large.bin", failed(), None);
    let not_kept = |reason| CheckpointVersionContent::NotKept { reason };
    let recorded = [
        ("/repo/copied.txt", copy('a')),
        ("/repo/failed.bin", not_kept(NotKeptReason::Failed)),
        (
            "/repo/large.bin",
            CheckpointVersionContent::Shadow {
                shadow_id: large.shadow_id,
            },
        ),
        ("/repo/new.txt", CheckpointVersionContent::Created),
        (
            "/repo/no-place.bin",
            not_kept(NotKeptReason::NoPlaceOnVolume),
        ),
        ("/repo/too-large.bin", not_kept(NotKeptReason::TooLarge)),
    ];
    let versions: Vec<_> = recorded
        .iter()
        .map(|(path, content)| version(path, content.clone()))
        .collect();
    fixture
        .record_after(vec![insert_current_shadow_statement(&large)], 2, &versions)
        .await;

    let read = versions_after(&fixture.database.reader(), fixture.session_id, sequence(0))
        .expect("the versions read");
    let contents: Vec<_> = read
        .iter()
        .map(|stored| (stored.version.path.as_str(), stored.version.content.clone()))
        .collect();
    assert_eq!(contents, recorded);
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
                window_id,
                checkpoint_id: checkpoint.checkpoint_id.clone(),
                tree_before: None,
                head_before: None,
                commit_before: None,
                command: "make large.bin".to_owned(),
                tool_call_id: None,
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

// Kills: a missing `ON CONFLICT` and the session filter dropped.
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
        .write(vec![insert_volume_folder_statement(
            other_session,
            &folder("other"),
        )])
        .await
        .expect("another session's folder is written");

    assert_eq!(
        volume_folders(&fixture.database.reader(), fixture.session_id).expect("the folders read"),
        [own]
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
